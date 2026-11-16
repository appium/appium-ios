#pragma once

#include <cstddef>
#include <cstdint>
#include <openssl/ssl.h>

#include <string>
#include <vector>

/** SSL_connect and CDTunnel handshake I/O deadline (milliseconds). */
inline constexpr int kTunnelHandshakeTimeoutMs = 15000;

/** Duplicates `tcp_fd` into a descriptor the caller owns; -1 and `error` on failure. */
int AcquireOwnedFd(int tcp_fd, std::string& error);

/** Closes a descriptor returned by AcquireOwnedFd. */
void ReleaseOwnedFd(int fd);

/** TLS client for lockdown (PEM cert) or Apple TV Remote Pairing (TLS-PSK). */
class TunnelSslClient {
 public:
  TunnelSslClient() = default;
  ~TunnelSslClient();

  TunnelSslClient(const TunnelSslClient&) = delete;
  TunnelSslClient& operator=(const TunnelSslClient&) = delete;

  /**
   * With a `device_cert_pem`, fails unless the peer presents exactly it. The match is enforced
   * inside the handshake, so a peer with another certificate never receives the host certificate.
   * With an empty `device_cert_pem` the peer is not authenticated.
   */
  bool Connect(int tcp_fd, const std::string& cert_pem, const std::string& key_pem, const std::string& device_cert_pem,
               int timeout_ms, std::string& error);

  bool ConnectPsk(int tcp_fd, const uint8_t* psk, size_t psk_len, const std::string& identity, int timeout_ms,
                  std::string& error);

  void Close();

  [[nodiscard]] SSL* ssl() const { return ssl_; }

 private:
  static unsigned int PskClientCallback(SSL* ssl, const char* /*hint*/, char* identity, unsigned int max_identity_len,
                                        unsigned char* psk, unsigned int max_psk_len);

  bool ConnectTls(int timeout_ms, std::string& error);

  SSL_CTX* ctx_ = nullptr;
  SSL* ssl_ = nullptr;
  /** Pinned device certificate, kept for the session because a renegotiation verifies the peer again. */
  X509* device_cert_ = nullptr;
  int owned_fd_ = -1;
  std::vector<uint8_t> psk_key_;
  std::string psk_identity_;
};
