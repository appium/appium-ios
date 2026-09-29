#pragma once

#import <Foundation/Foundation.h>

#include <sys/types.h>

#include <vector>

namespace coresim {

// Locates the Unix-domain socket the device's `com.apple.webinspectord_sim` launchd job listens
// on, for WebKit remote-debugging tools to connect to. No ObjC dispatch here (see CLAUDE.md) —
// CoreSimulator itself has no API for this; it's libproc/sysctl process introspection instead,
// the same mechanism `lsof -aUc launchd_sim` uses.
NSString* FindWebInspectorSocket(NSString* udid, NSError** error);

// Every host process whose environment carries SIMULATOR_UDID=<udid> — that device's SpringBoard
// plus any app currently launched inside it, all inherited from that device's own launchd_sim
// (see CLAUDE.md). No CoreSimulator dispatch — same libproc/sysctl introspection as
// FindWebInspectorSocket. Used to scope a Core Audio process tap to one simulator (sim_audio_tap.h).
std::vector<pid_t> FindGuestProcessPids(NSString* udid);

}  // namespace coresim
