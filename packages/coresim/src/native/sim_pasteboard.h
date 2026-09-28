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

}  // namespace coresim
