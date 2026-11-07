#pragma once

#import <Foundation/Foundation.h>

namespace coresim {

// Reads the device's current pasteboard content, picking between two private mechanisms at
// runtime depending on which one's classes actually exist (see sim_pasteboard.mm). Throws
// NativeSimUnavailableError if neither is present. Returns "" (not nil) for an empty pasteboard,
// matching `simctl pbpaste`.
NSString* PullPasteboardString(id device, NSError** error);

// Writes `content` as the device's pasteboard content, via the same mechanism selection.
BOOL PushPasteboardString(id device, NSString* content, NSError** error);

// Starts keeping the device's pasteboard in sync with the host's general pasteboard in both
// directions, for as long as this process keeps the session alive. Idempotent per device. Only
// available with the modern SimPasteboardPlus mechanism (throws NativeSimUnavailableError otherwise).
// The session ends on StopPasteboardSync or when the device goes away (e.g. shuts down).
void StartPasteboardSync(id device);

// Ends the session started by StartPasteboardSync. Does nothing if there is none.
void StopPasteboardSync(id device);

}  // namespace coresim
