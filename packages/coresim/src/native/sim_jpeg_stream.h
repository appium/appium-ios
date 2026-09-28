#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace coresim {

struct JpegStreamOptions {
  NSString* displayId = nil;
  double fps = 60.0;
  // 0-100 percent; same semantics as CaptureScreenshot's jpegQualityPercent (sim_screenshot.h),
  // nil-able for ImageIO's own default (near-lossless, so a much larger frame) — but defaulted to
  // 80 by coresim.mm rather than left nil, since a continuous live stream should default to
  // noticeably smaller frames, unlike a one-off CaptureScreenshot call.
  NSNumber* jpegQualityPercent = @80;
  // 0.0-1.0 fraction of the original frame's width/height; 1.0 (default) performs no scaling.
  // Already normalized from the JS-facing 1-100 percent option by coresim.mm.
  double scale = 1.0;
};

// One JPEG-encoded frame. Unlike VideoAccessUnit, every frame is independently decodable — there's
// no keyframe/interframe distinction, so no resync semantics are needed on the consuming side.
struct JpegFrame {
  std::vector<uint8_t> data;
  uint64_t sequence = 0;
  // Microseconds since the stream started.
  int64_t timestampMicros = 0;
};

// Polls the live display IOSurface (sim_screenshot.h) on a serial queue and JPEG-encodes changed
// frames via ImageIO, delivering each live — see CLAUDE.md for how this relates to
// VideoStreamSession and CaptureScreenshot.
class JpegStreamSession {
 public:
  // `onAbortDelivery`, if set, is invoked by AbortDelivery() below — not called by this class on
  // its own.
  JpegStreamSession(id device, JpegStreamOptions options, std::function<void(JpegFrame)> onFrame,
                    std::function<void(NSError*)> onError, std::function<void()> onEnd,
                    std::function<void()> onAbortDelivery = nullptr);
  ~JpegStreamSession();

  JpegStreamSession(const JpegStreamSession&) = delete;
  JpegStreamSession& operator=(const JpegStreamSession&) = delete;

  // Resolves the display and starts the polling loop; throws synchronously on resolution/setup
  // failure (`onEnd` never called then). Later failures go to `onError`, then `onEnd`.
  void Start();

  // Idempotent; blocks until the loop has fully stopped. Never call from inside onFrame/onError/
  // onEnd — same queue this blocks on, so it would deadlock.
  void Stop();

  // Runs the constructor's `onAbortDelivery` (if any) — e.g. aborting a bounded delivery queue so
  // a producer thread blocked pushing into it unblocks. Call before Stop() when the caller can't
  // rely on anything else draining that queue concurrently (e.g. process-exit cleanup running
  // synchronously on the same thread `Stop()` would otherwise wait on) — a normal Stop() doesn't
  // need this. Safe from any thread; a no-op if unset.
  void AbortDelivery();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace coresim
