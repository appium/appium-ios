#pragma once

#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

namespace coresim {

// maskPolicy for a non-rectangular display. 0/1/2 = ignored/alpha/black, confirmed empirically —
// alpha renders identically to black (see CLAUDE.md).
enum class VideoMaskPolicy : long long {
  kIgnored = 0,
  kAlpha = 1,
  kBlack = 2,
};

// Starts recording `displayId` (nil = primary) to `outputFile`, an absolute path, not a URL (see
// CLAUDE.md). Returns NO+*error on synchronous resolution failure (`handler` never called then);
// otherwise `handler` fires once the first frame is recorded, non-nil NSError on failure. Throws
// NativeSimUnavailableError instead if this CoreSimulator has no video capture service at all.
BOOL StartVideoRecording(id device, NSString* displayId, VideoMaskPolicy mask, NSDictionary* assetWriterOutputSettings,
                         NSString* outputFile, dispatch_queue_t queue, void (^handler)(NSError*), NSError** error);

// Stops the recording started by StartVideoRecording. Must not be called before its `handler` has
// already fired — see CLAUDE.md for the race that otherwise causes a silent empty-file failure.
BOOL StopVideoRecording(id device, dispatch_queue_t queue, void (^handler)(NSError*), NSError** error);

}  // namespace coresim
