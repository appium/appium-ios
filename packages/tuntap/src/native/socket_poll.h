#pragma once

#ifdef _WIN32
#include <winsock2.h>
#else
#include <poll.h>
#endif

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>

namespace tuntap {

#ifdef _WIN32
constexpr short kPollIn = POLLRDNORM;
constexpr short kPollOut = POLLWRNORM;
#else
constexpr short kPollIn = POLLIN;
constexpr short kPollOut = POLLOUT;
#endif

enum class PollResult : std::uint8_t { Ready, Timeout, Hangup, Stopped };

/**
 * Waits for `events` on socket `fd` until `deadline`, polling in 200ms slices so a
 * cleared `running` flag (when given) stops the wait promptly. A negative `fd` or a
 * failed poll reports Timeout.
 */
inline PollResult PollSocket(int fd, short events, std::chrono::steady_clock::time_point deadline,
                             const std::atomic<bool>* running = nullptr) {
  if (fd < 0) {
    return PollResult::Timeout;
  }
#ifdef _WIN32
  WSAPOLLFD pfd{};
  pfd.fd = static_cast<SOCKET>(fd);
#else
  struct pollfd pfd {};
  pfd.fd = fd;
#endif
  pfd.events = events;
  using Clock = std::chrono::steady_clock;
  for (;;) {
    if (running != nullptr && !running->load()) {
      return PollResult::Stopped;
    }
    const Clock::time_point now = Clock::now();
    if (now >= deadline) {
      return PollResult::Timeout;
    }
    const auto remaining_ms = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now).count();
    const int timeout_ms = remaining_ms > 200 ? 200 : static_cast<int>(remaining_ms);
#ifdef _WIN32
    const int rc = WSAPoll(&pfd, 1, timeout_ms);
#else
    const int rc = poll(&pfd, 1, timeout_ms);
#endif
    if (rc > 0) {
      if ((pfd.revents & (POLLERR | POLLHUP
#ifndef _WIN32
                          | POLLNVAL
#endif
                          )) != 0) {
        return PollResult::Hangup;
      }
      return (pfd.revents & events) != 0 ? PollResult::Ready : PollResult::Timeout;
    }
    if (rc == 0) {
      continue;
    }
#ifdef _WIN32
    if (WSAGetLastError() == WSAEINTR) {
#else
    if (errno == EINTR) {
#endif
      continue;
    }
    return PollResult::Timeout;
  }
}

}  // namespace tuntap
