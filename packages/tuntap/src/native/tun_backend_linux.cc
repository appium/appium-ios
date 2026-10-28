#ifdef __linux__

#include "tun_backend.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <linux/if.h>
#include <linux/if_tun.h>

#include <array>
#include <charconv>
#include <shared_mutex>
#include <utility>

#include "file_descriptor.h"
#include "posix_tun_backend.h"

namespace {

constexpr const char* kTunDevicePath = "/dev/net/tun";

bool ReadSysfsCounter(const std::string& ifname, const char* stat_name, uint64_t& value, std::string& error) {
  std::string path = "/sys/class/net/" + ifname + "/statistics/" + stat_name;
  FileDescriptor fd(open(path.c_str(), O_RDONLY | O_CLOEXEC));
  if (!fd.is_valid()) {
    error = "Failed to open " + path + ": " + strerror(errno);
    return false;
  }

  std::array<char, 64> buf{};
  ssize_t bytes_read = read(fd.get(), buf.data(), buf.size() - 1);
  if (bytes_read <= 0) {
    error = "Failed to read " + path + ": " + (bytes_read < 0 ? strerror(errno) : "empty file");
    return false;
  }

  auto [ptr, ec] = std::from_chars(buf.data(), buf.data() + bytes_read, value);
  if (ec != std::errc{} || ptr == buf.data()) {
    error = "Failed to parse counter in " + path;
    return false;
  }
  return true;
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

  bool GetStats(TunInterfaceStats& out, std::string& error) override {
    std::string ifname;
    {
      std::shared_lock lock(fd_mutex_);
      if (!fd_.is_valid() || interface_name_.empty()) {
        error = "Device not open";
        return false;
      }
      ifname = interface_name_;
    }

    return GetInterfaceStats(ifname, out, error);
  }
};

}  // namespace

std::unique_ptr<TunPlatformBackend> CreatePlatformBackend() { return std::make_unique<LinuxTunBackend>(); }

bool GetInterfaceStats(const std::string& interface_name, TunInterfaceStats& out, std::string& error) {
  if (interface_name.empty()) {
    error = "Interface name must not be empty";
    return false;
  }

  return ReadSysfsCounter(interface_name, "rx_packets", out.rx_packets, error) &&
         ReadSysfsCounter(interface_name, "rx_errors", out.rx_errors, error) &&
         ReadSysfsCounter(interface_name, "rx_bytes", out.rx_bytes, error) &&
         ReadSysfsCounter(interface_name, "tx_packets", out.tx_packets, error) &&
         ReadSysfsCounter(interface_name, "tx_errors", out.tx_errors, error) &&
         ReadSysfsCounter(interface_name, "tx_bytes", out.tx_bytes, error);
}

#endif
