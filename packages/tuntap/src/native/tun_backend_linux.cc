#ifdef __linux__

#include "tun_backend.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

#include <linux/if_link.h>
#include <linux/if_tun.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>

#include <algorithm>
#include <array>
#include <shared_mutex>
#include <utility>
#include <vector>

#include "file_descriptor.h"
#include "posix_tun_backend.h"

namespace {

constexpr const char* kTunDevicePath = "/dev/net/tun";

struct NetlinkGetLinkRequest {
  struct nlmsghdr nlh {};
  struct ifinfomsg ifi {};
};

constexpr size_t AlignNetlink(size_t len) {
  constexpr size_t kAlign = 4U;
  return (len + (kAlign - 1U)) & ~(kAlign - 1U);
}

class LinuxTunBackend : public PosixTunBackend {
 public:
  bool OpenDevice(const std::string& requested_name, std::string& out_interface_name, TunError& error) override {
    struct stat statbuf {};
    if (stat(kTunDevicePath, &statbuf) != 0) {
      error.sys_errno = errno;
      error.message =
          "TUN/TAP device not available: /dev/net/tun does not exist. "
          "Please ensure the TUN/TAP kernel module is loaded (modprobe tun).";
      return false;
    }

    FileDescriptor temp_fd(open(kTunDevicePath, O_RDWR | O_CLOEXEC));
    if (!temp_fd.is_valid()) {
      error.sys_errno = errno;
      error.message = std::string("Failed to open ") + kTunDevicePath + ": " + strerror(error.sys_errno);
      if (error.sys_errno == EACCES || error.sys_errno == EPERM) {
        error.message += ". Try running with sudo or add your user to the 'tun' group.";
      }
      return false;
    }

    struct ifreq ifr {};
    memset(&ifr, 0, sizeof(ifr));
    ifr.ifr_flags = IFF_TUN | IFF_NO_PI;

    if (!requested_name.empty()) {
      strncpy(ifr.ifr_name, requested_name.c_str(), IFNAMSIZ - 1);
      ifr.ifr_name[IFNAMSIZ - 1] = '\0';
    }

    if (ioctl(temp_fd.get(), TUNSETIFF, &ifr) < 0) {
      error.sys_errno = errno;
      error.message = std::string("Failed to configure TUN device: ") + strerror(error.sys_errno);
      return false;
    }

    if (!SetNonBlocking(temp_fd.get(), error.message)) {
      return false;
    }

    fd_ = std::move(temp_fd);
    interface_name_ = std::string(ifr.ifr_name);
    out_interface_name = interface_name_;
    return true;
  }

  ReadPacketStatus ReadPacket(size_t max_payload_size, std::vector<uint8_t>& out, std::string& error) override {
    std::shared_lock lock(fd_mutex_);
    if (!fd_.is_valid()) {
      error = "Device not open";
      return ReadPacketStatus::Error;
    }

    out.resize(max_payload_size);
    ssize_t bytes_read = read(fd_.get(), out.data(), out.size());
    if (bytes_read < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) {
        out.clear();
        return ReadPacketStatus::NoData;
      }
      error = std::string("Read error: ") + strerror(errno);
      return ReadPacketStatus::Error;
    }
    if (bytes_read == 0) {
      out.clear();
      return ReadPacketStatus::Closed;
    }

    out.resize(static_cast<size_t>(bytes_read));
    return ReadPacketStatus::Data;
  }

  ssize_t WritePacket(const uint8_t* data, size_t length, std::string& error) override {
    std::shared_lock lock(fd_mutex_);
    if (!fd_.is_valid()) {
      error = "Device not open";
      return -1;
    }
    ssize_t bytes_written = write(fd_.get(), data, length);
    if (bytes_written < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) {
        return 0;
      }
      error = std::string("Write error: ") + strerror(errno);
      return -1;
    }
    return bytes_written;
  }
};

template <typename StatsT>
void CopyLinkStats(const StatsT& src, TunInterfaceStats& dst) {
  dst.rx_packets = src.rx_packets;
  dst.rx_errors = src.rx_errors;
  dst.rx_bytes = src.rx_bytes;
  dst.tx_packets = src.tx_packets;
  dst.tx_errors = src.tx_errors;
  dst.tx_bytes = src.tx_bytes;
}

bool ResolveInterfaceIndex(const std::string& interface_name, unsigned int& out_ifindex, std::string& error) {
  if (interface_name.empty()) {
    error = "Interface name must not be empty";
    return false;
  }
  if (interface_name.size() >= IFNAMSIZ || interface_name.find('/') != std::string::npos) {
    error = "Invalid interface name: " + interface_name;
    return false;
  }

  out_ifindex = if_nametoindex(interface_name.c_str());
  if (out_ifindex == 0) {
    error = "Interface not found: " + interface_name;
    return false;
  }
  return true;
}

bool OpenNetlinkRouteSocket(FileDescriptor& out_fd, std::string& error) {
  FileDescriptor nl_fd(socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE));
  if (!nl_fd.is_valid()) {
    error = std::string("Failed to create netlink socket: ") + strerror(errno);
    return false;
  }

  struct timeval rcv_timeout {};
  rcv_timeout.tv_sec = 2;
  rcv_timeout.tv_usec = 0;
  if (setsockopt(nl_fd.get(), SOL_SOCKET, SO_RCVTIMEO, &rcv_timeout, sizeof(rcv_timeout)) < 0) {
    error = std::string("Failed to set SO_RCVTIMEO on netlink socket: ") + strerror(errno);
    return false;
  }

  out_fd = std::move(nl_fd);
  return true;
}

bool SendGetLinkRequest(int nl_fd, unsigned int ifindex, std::string& error) {
  NetlinkGetLinkRequest req{};
  req.nlh.nlmsg_len = static_cast<uint32_t>(sizeof(req));
  req.nlh.nlmsg_type = RTM_GETLINK;
  req.nlh.nlmsg_flags = NLM_F_REQUEST;
  req.nlh.nlmsg_seq = 1;
  req.ifi.ifi_family = AF_UNSPEC;
  req.ifi.ifi_index = static_cast<int>(ifindex);

  ssize_t sent = 0;
  do {
    sent = send(nl_fd, &req, sizeof(req), 0);
  } while (sent < 0 && errno == EINTR);
  if (sent < 0) {
    error = std::string("Failed to send RTM_GETLINK request: ") + strerror(errno);
    return false;
  }
  return true;
}

bool ReceiveNetlinkResponse(int nl_fd, const std::string& interface_name, std::vector<uint8_t>& out_buf,
                            std::string& error) {
  ssize_t peek_len = 0;
  do {
    peek_len = recv(nl_fd, nullptr, 0, MSG_PEEK | MSG_TRUNC);
  } while (peek_len < 0 && errno == EINTR);
  if (peek_len <= 0) {
    error =
        std::string("Failed to receive RTM_GETLINK response: ") + (peek_len < 0 ? strerror(errno) : "empty response");
    return false;
  }

  out_buf.resize(std::max<size_t>(static_cast<size_t>(peek_len), 8192U));
  ssize_t recv_len = 0;
  do {
    recv_len = recv(nl_fd, out_buf.data(), out_buf.size(), MSG_TRUNC);
  } while (recv_len < 0 && errno == EINTR);
  if (recv_len <= 0) {
    error =
        std::string("Failed to receive RTM_GETLINK response: ") + (recv_len < 0 ? strerror(errno) : "empty response");
    return false;
  }
  if (static_cast<size_t>(recv_len) > out_buf.size()) {
    error = "RTM_GETLINK response truncated for " + interface_name;
    return false;
  }

  out_buf.resize(static_cast<size_t>(recv_len));
  return true;
}

bool ExtractStatsFromNewLinkAttrs(const uint8_t* attr_data, size_t attrs_len, TunInterfaceStats& out) {
  constexpr size_t kRtaHdrLen = AlignNetlink(sizeof(struct rtattr));
  size_t attr_offset = 0;
  bool has_stats32 = false;
  TunInterfaceStats fallback_stats{};

  while (attr_offset + sizeof(struct rtattr) <= attrs_len) {
    struct rtattr rta {};
    memcpy(&rta, attr_data + attr_offset, sizeof(rta));
    if (rta.rta_len < sizeof(struct rtattr) || attr_offset + rta.rta_len > attrs_len) {
      break;
    }

    const size_t payload_offset = attr_offset + kRtaHdrLen;
    const size_t payload_len = rta.rta_len >= kRtaHdrLen ? rta.rta_len - kRtaHdrLen : 0U;

    if (rta.rta_type == IFLA_STATS64 && payload_len >= sizeof(struct rtnl_link_stats64)) {
      struct rtnl_link_stats64 stats64 {};
      memcpy(&stats64, attr_data + payload_offset, sizeof(stats64));
      CopyLinkStats(stats64, out);
      return true;
    }

    if (rta.rta_type == IFLA_STATS && payload_len >= sizeof(struct rtnl_link_stats)) {
      struct rtnl_link_stats stats32 {};
      memcpy(&stats32, attr_data + payload_offset, sizeof(stats32));
      CopyLinkStats(stats32, fallback_stats);
      has_stats32 = true;
    }

    attr_offset += AlignNetlink(rta.rta_len);
  }

  if (has_stats32) {
    out = fallback_stats;
    return true;
  }
  return false;
}

bool ParseNetlinkLinkStats(const std::vector<uint8_t>& buf, const std::string& interface_name, TunInterfaceStats& out,
                           std::string& error) {
  constexpr size_t kNlhHdrLen = AlignNetlink(sizeof(struct nlmsghdr));
  constexpr size_t kIfiHdrLen = AlignNetlink(sizeof(struct ifinfomsg));
  constexpr size_t kNewLinkHdrLen = kNlhHdrLen + kIfiHdrLen;

  size_t offset = 0;
  while (offset + sizeof(struct nlmsghdr) <= buf.size()) {
    struct nlmsghdr nlh {};
    memcpy(&nlh, buf.data() + offset, sizeof(nlh));
    if (nlh.nlmsg_len < sizeof(struct nlmsghdr) || offset + nlh.nlmsg_len > buf.size()) {
      break;
    }

    if (nlh.nlmsg_type == NLMSG_ERROR) {
      if (nlh.nlmsg_len >= kNlhHdrLen + sizeof(struct nlmsgerr)) {
        struct nlmsgerr nlerr {};
        memcpy(&nlerr, buf.data() + offset + kNlhHdrLen, sizeof(nlerr));
        const int err_code = nlerr.error < 0 ? -nlerr.error : nlerr.error;
        error = std::string("RTM_GETLINK failed for ") + interface_name + ": " + strerror(err_code);
      } else {
        error = "RTM_GETLINK returned NLMSG_ERROR for " + interface_name;
      }
      return false;
    }

    if (nlh.nlmsg_type == RTM_NEWLINK && nlh.nlmsg_len >= kNewLinkHdrLen) {
      const uint8_t* attr_data = buf.data() + offset + kNewLinkHdrLen;
      const size_t attrs_len = nlh.nlmsg_len - kNewLinkHdrLen;
      if (ExtractStatsFromNewLinkAttrs(attr_data, attrs_len, out)) {
        return true;
      }
    }

    offset += AlignNetlink(nlh.nlmsg_len);
  }

  error = "IFLA_STATS64 not found in RTM_GETLINK response for " + interface_name;
  return false;
}

}  // namespace

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend() { return std::make_unique<LinuxTunBackend>(); }

bool GetInterfaceStats(const std::string& interface_name, TunInterfaceStats& out, std::string& error) {
  unsigned int ifindex = 0;
  if (!ResolveInterfaceIndex(interface_name, ifindex, error)) {
    return false;
  }

  FileDescriptor nl_fd;
  if (!OpenNetlinkRouteSocket(nl_fd, error)) {
    return false;
  }
  if (!SendGetLinkRequest(nl_fd.get(), ifindex, error)) {
    return false;
  }

  std::vector<uint8_t> response;
  if (!ReceiveNetlinkResponse(nl_fd.get(), interface_name, response, error)) {
    return false;
  }

  return ParseNetlinkLinkStats(response, interface_name, out, error);
}

#endif
