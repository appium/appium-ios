#include "sim_process.h"

#include <libproc.h>
#include <sys/socket.h>
#include <sys/sysctl.h>
#include <sys/un.h>

#include <cstring>
#include <string>
#include <vector>

namespace coresim {

namespace {

NSString* const kProcessErrorDomain = @"io.appium.coresim.Process";
NSString* const kWebInspectorSocketSuffix = @"com.apple.webinspectord_sim.socket";

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kProcessErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

NSString* ExecutablePath(pid_t pid) {
  char pathBuf[PROC_PIDPATHINFO_MAXSIZE] = {};
  int size = proc_pidpath(pid, pathBuf, sizeof(pathBuf));
  return size > 0 ? [NSString stringWithUTF8String:pathBuf] : nil;
}

// Layout: argc, exec path, NUL padding, then argv[0..argc-1], then envp[...], each NUL-terminated
// (envp has no guaranteed empty-string sentinel within the buffer — just runs to `size`).
std::vector<char> ProcArgs2(pid_t pid) {
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(mib, 3, nullptr, &size, nullptr, 0) != 0 || size < sizeof(int)) {
    return {};
  }
  std::vector<char> buffer(size);
  if (sysctl(mib, 3, buffer.data(), &size, nullptr, 0) != 0) {
    return {};
  }
  return buffer;
}

const char* SkipExecPathAndPadding(const char* cursor, const char* end) {
  cursor += strnlen(cursor, static_cast<size_t>(end - cursor));  // skip the exec path
  while (cursor < end && *cursor == '\0') cursor++;              // skip the NUL padding
  return cursor;
}

// Advances past `count` further NUL-terminated entries (e.g. argv), landing just after the last
// one's terminator — or at `end` if there weren't that many.
const char* SkipEntries(const char* cursor, const char* end, int count) {
  for (int i = 0; i < count && cursor < end; i++) {
    cursor += strnlen(cursor, static_cast<size_t>(end - cursor));
    if (cursor < end) cursor++;
  }
  return cursor;
}

// argv[1] via the unprivileged KERN_PROCARGS2 sysctl (same as `ps`/`lsof`) — for `launchd_sim`
// that's its bootstrap plist path, which embeds the device's UDID.
NSString* FirstArgument(pid_t pid) {
  std::vector<char> buffer = ProcArgs2(pid);
  if (buffer.empty()) {
    return nil;
  }
  int argc = 0;
  std::memcpy(&argc, buffer.data(), sizeof(argc));
  const char* end = buffer.data() + buffer.size();
  const char* cursor = SkipEntries(SkipExecPathAndPadding(buffer.data() + sizeof(argc), end), end, 1);
  if (argc < 2 || cursor >= end) {
    return nil;
  }
  return [NSString stringWithUTF8String:cursor];
}

// The value of `key=...` in `pid`'s environment, past the end of its argv — same sysctl as
// FirstArgument, walked further.
NSString* FindEnvValue(pid_t pid, NSString* key) {
  std::vector<char> buffer = ProcArgs2(pid);
  if (buffer.empty()) {
    return nil;
  }
  int argc = 0;
  std::memcpy(&argc, buffer.data(), sizeof(argc));
  const char* end = buffer.data() + buffer.size();
  const char* cursor = SkipEntries(SkipExecPathAndPadding(buffer.data() + sizeof(argc), end), end, argc);
  std::string prefix = std::string(key.UTF8String) + "=";
  while (cursor < end && *cursor != '\0') {
    size_t entryLen = strnlen(cursor, static_cast<size_t>(end - cursor));
    if (entryLen > prefix.size() && std::memcmp(cursor, prefix.data(), prefix.size()) == 0) {
      return [NSString stringWithUTF8String:cursor + prefix.size()];
    }
    cursor += entryLen;
    if (cursor < end) cursor++;
  }
  return nil;
}

// Every live pid on the system, via the unprivileged proc_listpids sysctl.
std::vector<pid_t> AllPids() {
  int neededBytes = proc_listpids(PROC_ALL_PIDS, 0, nullptr, 0);
  if (neededBytes <= 0) {
    return {};
  }
  // Headroom for processes started between the sizing call above and the listing call below.
  std::vector<pid_t> pids(neededBytes / sizeof(pid_t) + 64);
  int bytes = proc_listpids(PROC_ALL_PIDS, 0, pids.data(), static_cast<int>(pids.size() * sizeof(pid_t)));
  if (bytes <= 0) {
    return {};
  }
  pids.resize(static_cast<size_t>(bytes) / sizeof(pid_t));
  return pids;
}

// Each booted simulator has its own `launchd_sim`; finds the one owning `udid`.
pid_t FindLaunchdSimPid(NSString* udid) {
  for (pid_t pid : AllPids()) {
    if (pid <= 0) {
      continue;
    }
    NSString* path = ExecutablePath(pid);
    if (![path hasSuffix:@"/launchd_sim"]) {
      continue;
    }
    NSString* arg = FirstArgument(pid);
    if (arg != nil && [arg rangeOfString:udid options:NSCaseInsensitiveSearch].location != NSNotFound) {
      return pid;
    }
  }
  return -1;
}

// Scans `pid`'s open Unix-domain socket fds for one bound to a path ending in `suffix`.
NSString* FindUnixSocketPath(pid_t pid, NSString* suffix) {
  int neededBytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nullptr, 0);
  if (neededBytes <= 0) {
    return nil;
  }
  std::vector<uint8_t> buffer(static_cast<size_t>(neededBytes) + 64 * sizeof(struct proc_fdinfo));
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, buffer.data(), static_cast<int>(buffer.size()));
  if (bytes <= 0) {
    return nil;
  }
  auto* fdInfoList = reinterpret_cast<struct proc_fdinfo*>(buffer.data());
  int fdCount = bytes / static_cast<int>(sizeof(struct proc_fdinfo));
  for (int i = 0; i < fdCount; i++) {
    if (fdInfoList[i].proc_fdtype != PROX_FDTYPE_SOCKET) {
      continue;
    }
    struct socket_fdinfo socketInfo;
    int socketInfoBytes =
        proc_pidfdinfo(pid, fdInfoList[i].proc_fd, PROC_PIDFDSOCKETINFO, &socketInfo, sizeof(socketInfo));
    if (socketInfoBytes != sizeof(socketInfo) || socketInfo.psi.soi_kind != SOCKINFO_UN) {
      continue;
    }
    const char* sunPath = socketInfo.psi.soi_proto.pri_un.unsi_addr.ua_sun.sun_path;
    if (sunPath[0] == '\0') {
      continue;
    }
    NSString* path = [NSString stringWithUTF8String:sunPath];
    if ([path hasSuffix:suffix]) {
      return path;
    }
  }
  return nil;
}

}  // namespace

NSString* FindWebInspectorSocket(NSString* udid, NSError** error) {
  pid_t launchdSimPid = FindLaunchdSimPid(udid);
  if (launchdSimPid <= 0) {
    if (error) {
      *error = MakeError(1, [NSString stringWithFormat:@"No launchd_sim process was found for device '%@' — "
                                                       @"is it booted?",
                                                       udid]);
    }
    return nil;
  }
  NSString* socketPath = FindUnixSocketPath(launchdSimPid, kWebInspectorSocketSuffix);
  if (socketPath == nil && error) {
    *error = MakeError(2, [NSString stringWithFormat:@"No WebInspector socket was found for device '%@'", udid]);
  }
  return socketPath;
}

std::vector<pid_t> FindGuestProcessPids(NSString* udid) {
  std::vector<pid_t> result;
  for (pid_t pid : AllPids()) {
    if (pid <= 0) {
      continue;
    }
    NSString* value = FindEnvValue(pid, @"SIMULATOR_UDID");
    if (value != nil && [value caseInsensitiveCompare:udid] == NSOrderedSame) {
      result.push_back(pid);
    }
  }
  return result;
}

}  // namespace coresim
