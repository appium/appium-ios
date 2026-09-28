#include "sim_jpeg_stream.h"

#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>

#include <algorithm>
#include <atomic>
#include <cmath>

#include "monotonic_clock.h"
#include "nserror_bridge.h"
#include "sim_screenshot.h"

namespace coresim {

namespace {

NSString* const kJpegStreamErrorDomain = @"io.appium.coresim.JpegStream";

// A scale this close to 1.0 (from a 1-100 percent option divided by 100.0 — never exactly 1.0
// except at 100%) is treated as "no scaling" — comparing doubles for exact equality is unreliable.
constexpr double kScaleEpsilon = 1e-9;

// If no frame can be produced for this long — the display surface staying unavailable, or the
// CIImage/CGImage render failing — for that whole stretch, something is genuinely wrong (a
// permanently dropped connection, say) rather than a one-off transient hiccup; escalate to a real
// error instead of polling forever with nothing to show for it and no error ever reported.
constexpr double kMaxStallSeconds = 10.0;

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kJpegStreamErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

}  // namespace

class JpegStreamSession::Impl {
 public:
  Impl(id device, JpegStreamOptions options, std::function<void(JpegFrame)> onFrame,
       std::function<void(NSError*)> onError, std::function<void()> onEnd, std::function<void()> onAbortDelivery)
      : device_(device),
        options_(options),
        onFrame_(std::move(onFrame)),
        onError_(std::move(onError)),
        onEnd_(std::move(onEnd)),
        onAbortDelivery_(std::move(onAbortDelivery)) {
    queue_ = dispatch_queue_create("io.appium.coresim.jpegStream", DISPATCH_QUEUE_SERIAL);
    // Persistent, unlike CaptureScreenshot's own one-shot CIContext (see sim_screenshot.mm) — that
    // file's comment calls this out as exactly the tradeoff a continuous streaming path should
    // make instead.
    context_ = [CIContext contextWithOptions:nil];
  }

  ~Impl() { Stop(); }

  void Start() {
    NSError* error = nil;
    id descriptor = ResolveCaptureDisplay(device_, options_.displayId, &error);
    if (descriptor == nil) {
      throw NSErrorException(error);
    }
    id surfaceObj = CurrentDisplaySurface(descriptor);
    if (surfaceObj == nil) {
      throw NSErrorException(MakeError(1, @"The device's display surface is not available yet"));
    }
    IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObj;

    startTime_ = MonotonicSeconds();
    // Set before the initial encode below — EmitFrame measures elapsed time from it, and running_
    // gates whether a frame is delivered at all (see Tick()'s own check).
    running_ = true;
    // Encode immediately rather than waiting for a *changed* seed on the first tick, or the stream
    // would stay silent until the display changes again — unlike Tick(), this doesn't check
    // lastSeed_ first (it's still its default 0), so EncodeCurrentSeedAndEmit always runs once here.
    NSError* encodeError = nil;
    EncodeCurrentSeedAndEmit(surface, &encodeError);
    if (encodeError != nil) {
      running_ = false;
      throw NSErrorException(encodeError);
    }

    double interval = 1.0 / std::max(options_.fps, 1.0);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue_);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0),
                              static_cast<uint64_t>(interval * NSEC_PER_SEC),
                              static_cast<uint64_t>(interval * NSEC_PER_SEC / 10));
    // `this` outlives the timer: Stop()/StopFromQueue() always cancel or outrun it before `this`
    // can be destroyed (see their comments below).
    dispatch_source_set_event_handler(timer, ^{
      Tick();
    });
    timer_ = timer;
    dispatch_resume(timer_);
  }

  // Callable from any thread except `queue_` itself (would deadlock on the dispatch_sync below).
  void Stop() {
    if (!running_.exchange(false)) {
      return;  // idempotent
    }
    if (timer_ != nullptr) {
      dispatch_source_cancel(timer_);
      // dispatch_source_cancel doesn't preempt a currently-executing handler — an already-running
      // Tick() (past its own `running_` check) can still run to completion and emit one last frame
      // via onFrame_ before this returns. This blocks until that happens, so onEnd_ below (which
      // the caller uses to release resources onFrame_ needs, e.g. a ThreadSafeFunction) never races
      // a still-in-flight emit — not, as such, a guarantee that no further frame is ever emitted.
      dispatch_sync(queue_, ^{
                    });
      timer_ = nullptr;
    }
    if (onEnd_) {
      onEnd_();
    }
  }

  void AbortDelivery() {
    if (onAbortDelivery_) {
      onAbortDelivery_();
    }
  }

 private:
  // Same as Stop() minus the dispatch_sync barrier — only safe from within Tick() itself, already
  // serialized on `queue_`; would race a concurrent Tick() from any other thread.
  void StopFromQueue() {
    if (!running_.exchange(false)) {
      return;  // idempotent — e.g. an external Stop() already won this race
    }
    if (timer_ != nullptr) {
      dispatch_source_cancel(timer_);
      timer_ = nullptr;
    }
    if (onEnd_) {
      onEnd_();
    }
  }

  void Tick() {
    if (!running_) {
      return;
    }
    @autoreleasepool {
      try {
        // Re-resolved every tick (like CaptureScreenshot does), not cached once in Start(), so a
        // deleted device or disconnected display surfaces a real error instead of Tick() quietly
        // doing nothing forever.
        NSError* resolveError = nil;
        id descriptor = ResolveCaptureDisplay(device_, options_.displayId, &resolveError);
        if (descriptor == nil) {
          if (onError_) {
            onError_(resolveError);
          }
          StopFromQueue();
          return;
        }
        id surfaceObj = CurrentDisplaySurface(descriptor);
        if (surfaceObj == nil) {
          ReportIfStalledTooLong();  // transient — the connection may not have a frame ready yet
          return;
        }
        IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObj;
        uint32_t seed = IOSurfaceGetSeed(surface);
        if (seed == lastSeed_) {
          // Unchanged since the last tick (mirrors VideoFrameEncoder's own seed check) — the
          // surface itself is fine, just nothing new to encode, so this resolves any stall.
          stalledSince_ = 0;
          return;
        }
        NSError* encodeError = nil;
        bool encoded = EncodeCurrentSeedAndEmit(surface, &encodeError);
        if (encodeError != nil) {
          if (onError_) {
            onError_(encodeError);
          }
          StopFromQueue();
          return;
        }
        if (encoded) {
          stalledSince_ = 0;
        } else {
          ReportIfStalledTooLong();  // transient — e.g. a momentary CIImage/CGImage render failure
        }
      } catch (const std::exception& e) {
        // Without this, an exception here (e.g. a dropped display-proxy connection, which surfaces
        // as NativeSimUnavailableError/ObjCException — both std::exception subtypes — via
        // ResolveCaptureDisplay's own dynamic dispatch) would escape this bare GCD timer handler
        // uncaught and crash the whole process (see CLAUDE.md; mirrors VideoFrameEncoder::Tick()).
        if (onError_) {
          onError_(MakeError(4, [NSString stringWithFormat:@"JPEG streaming failed: %s", e.what()]));
        }
        StopFromQueue();
      }
    }
  }

  // Called from Tick() on a tick that produced nothing but also wasn't a genuine (reported) error —
  // starts a stall timer on the first such tick, and escalates to a real onError_/StopFromQueue()
  // once it's run past kMaxStallSeconds without a single successful tick (a frame, or an unchanged-
  // seed check) in between. Without this, a display surface that never comes back (or a
  // CIImage/CGImage render that never succeeds again) would poll forever with nothing to show for
  // it and no error ever reported (see CLAUDE.md).
  void ReportIfStalledTooLong() {
    double now = MonotonicSeconds();
    if (stalledSince_ == 0) {
      stalledSince_ = now;
      return;
    }
    if (now - stalledSince_ > kMaxStallSeconds) {
      if (onError_) {
        onError_(MakeError(5, @"No JPEG frame could be produced for too long"));
      }
      StopFromQueue();
    }
  }

  // Reads `surface`'s current seed, attempts one encode, and — only on success — commits exactly
  // that pre-encode seed to lastSeed_ and emits the frame. Reading the seed before encoding (never
  // a value re-read afterward) matters: if the display changes again while EncodeSurface() is still
  // running, the pre-encode seed still correctly identifies which content this frame captures, so
  // the next caller sees the surface's now-newer seed as "changed" and retries — reading it after
  // encoding instead would wrongly commit the *newer* seed against the *older* frame just emitted,
  // permanently losing that update (the following unchanged-seed check would then treat it as
  // already delivered, silently, since it looks identical to a genuinely static display). Shared by
  // Start() (always called once, regardless of lastSeed_) and Tick() (only once a changed seed was
  // already observed) so this ordering can't independently drift between the two again.
  //
  // Returns whether a frame was produced. Sets *error only for a genuine encode failure that
  // should end the whole session; a false return with *error left nil means "transient, retry
  // next tick" (mirrors VideoFrameEncoder::EncodeSurface's identical CVPixelBufferCreateWithIOSurface
  // transient-failure contract in video_encoder.mm) — lastSeed_ is deliberately left stale then, so
  // the next attempt retries this same content instead of silently skipping it forever.
  bool EncodeCurrentSeedAndEmit(IOSurfaceRef surface, NSError** error) {
    uint32_t seed = IOSurfaceGetSeed(surface);
    NSData* data = nil;
    bool encoded = EncodeSurface(surface, &data, error);
    if (encoded) {
      lastSeed_ = seed;
      EmitFrame(data);
    }
    return encoded;
  }

  // Returns whether a frame was produced. Sets *error only for a genuine encode failure that
  // should end the whole session; a false return with *error left nil means "transient, retry
  // next tick" (mirrors VideoFrameEncoder::EncodeSurface's identical CVPixelBufferCreateWithIOSurface
  // transient-failure contract in video_encoder.mm).
  bool EncodeSurface(IOSurfaceRef surface, NSData** outData, NSError** error) {
    CIImage* ciImage = [CIImage imageWithIOSurface:surface];
    if (ciImage == nil) {
      return false;
    }
    // Scaling the CIImage before rendering (rather than resizing an already-encoded JPEG
    // afterward) means the CGImage/JPEG below is produced at the target resolution directly — no
    // extra decode/resize/re-encode round trip.
    if (std::fabs(options_.scale - 1.0) > kScaleEpsilon) {
      ciImage = [ciImage imageByApplyingTransform:CGAffineTransformMakeScale(options_.scale, options_.scale)];
    }
    CGImageRef cgImage = [context_ createCGImage:ciImage fromRect:ciImage.extent];
    if (cgImage == nil) {
      return false;
    }
    // Same CGImageDestination-based encode CaptureScreenshot's kJPEG format uses (sim_screenshot.mm).
    NSData* imageData = EncodeImage(cgImage, ScreenshotFormat::kJPEG, options_.jpegQualityPercent, error);
    CGImageRelease(cgImage);
    if (imageData == nil) {
      return false;
    }
    *outData = imageData;
    return true;
  }

  // Called either from Start() (on whichever thread calls it, before the timer/queue_ even starts
  // running) or from Tick() (already serialized on queue_, once the timer is live) — never both at
  // once, since Start() always finishes (and only then resumes the timer) before Tick() can fire.
  // So sequence_ needs no synchronization, unlike VideoStreamSession's (whose encoder callback can
  // run concurrently with the poll loop on a different thread).
  void EmitFrame(NSData* data) {
    JpegFrame frame;
    frame.sequence = sequence_++;
    frame.timestampMicros = static_cast<int64_t>((MonotonicSeconds() - startTime_) * 1000000);
    const uint8_t* bytes = static_cast<const uint8_t*>(data.bytes);
    frame.data.assign(bytes, bytes + data.length);
    if (onFrame_) {
      onFrame_(std::move(frame));
    }
  }

  id device_;
  JpegStreamOptions options_;
  std::function<void(JpegFrame)> onFrame_;
  std::function<void(NSError*)> onError_;
  std::function<void()> onEnd_;
  std::function<void()> onAbortDelivery_;

  dispatch_queue_t queue_ = nullptr;
  dispatch_source_t timer_ = nullptr;
  CIContext* context_ = nil;
  uint32_t lastSeed_ = 0;
  double startTime_ = 0;
  uint64_t sequence_ = 0;
  // 0 means "no stall in progress" — set to MonotonicSeconds() by ReportIfStalledTooLong() on the
  // first unproductive tick of a run, cleared back to 0 by any tick that makes real progress
  // (a produced frame, or an unchanged-seed check confirming the surface itself is still fine).
  double stalledSince_ = 0;
  std::atomic<bool> running_{false};
};

JpegStreamSession::JpegStreamSession(id device, JpegStreamOptions options, std::function<void(JpegFrame)> onFrame,
                                     std::function<void(NSError*)> onError, std::function<void()> onEnd,
                                     std::function<void()> onAbortDelivery)
    : impl_(std::make_unique<Impl>(device, options, std::move(onFrame), std::move(onError), std::move(onEnd),
                                   std::move(onAbortDelivery))) {}

JpegStreamSession::~JpegStreamSession() = default;

void JpegStreamSession::Start() { impl_->Start(); }

void JpegStreamSession::Stop() { impl_->Stop(); }

void JpegStreamSession::AbortDelivery() { impl_->AbortDelivery(); }

}  // namespace coresim
