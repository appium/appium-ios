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

// Syncs the device pasteboard with the host's general one in both directions until stopped or the
// device disconnects. Idempotent; throws NativeSimUnavailableError without SimPasteboardPlus.
void StartPasteboardSync(id device);

// Ends the session started by StartPasteboardSync. Does nothing if there is none.
void StopPasteboardSync(id device);

}  // namespace coresim
