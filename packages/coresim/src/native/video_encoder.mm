#include "video_encoder.h"

#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#import <IOSurface/IOSurface.h>
#import <VideoToolbox/VideoToolbox.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>

#include "monotonic_clock.h"
#include "nserror_bridge.h"
#include "safe_dispatch.h"
#include "sim_orientation.h"
#include "sim_screenshot.h"

namespace coresim {

namespace {

NSString* const kVideoEncoderErrorDomain = @"io.appium.coresim.VideoEncoder";

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kVideoEncoderErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

NSError* MakeStatusError(NSInteger code, NSString* what, OSStatus status) {
  return MakeError(code, [NSString stringWithFormat:@"%@ (OSStatus %d)", what, static_cast<int>(status)]);
}

void AppendAnnexB(std::vector<uint8_t>& out, const uint8_t* nal, size_t length) {
  static const uint8_t kStartCode[4] = {0, 0, 0, 1};
  out.insert(out.end(), kStartCode, kStartCode + 4);
  out.insert(out.end(), nal, nal + length);
}

// CMBlockBufferGetDataPointer's pointer only covers the contiguous region starting at the given
// offset, which for a segmented buffer (multiple backing memory blocks — CoreMedia's documented
// contract, not just a VideoToolbox implementation detail) can be far shorter than totalLength;
// reading up to totalLength through it would run past that region. CopyDataBytes stitches
// segments together into a caller-owned, guaranteed-contiguous copy instead.
void AppendSampleBufferNALs(std::vector<uint8_t>& out, CMSampleBufferRef sampleBuffer) {
  CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sampleBuffer);
  if (block == nullptr) {
    return;
  }
  size_t totalLength = CMBlockBufferGetDataLength(block);
  if (totalLength == 0) {
    return;
  }
  std::vector<uint8_t> data(totalLength);
  if (CMBlockBufferCopyDataBytes(block, 0, totalLength, data.data()) != kCMBlockBufferNoErr) {
    return;
  }
  const uint8_t* dataPointer = data.data();
  size_t offset = 0;
  while (offset + 4 <= totalLength) {
    uint32_t nalLength = (static_cast<uint32_t>(dataPointer[offset]) << 24) |
                         (static_cast<uint32_t>(dataPointer[offset + 1]) << 16) |
                         (static_cast<uint32_t>(dataPointer[offset + 2]) << 8) | dataPointer[offset + 3];
    offset += 4;
    if (nalLength == 0 || offset + nalLength > totalLength) {
      break;
    }
    AppendAnnexB(out, dataPointer + offset, nalLength);
    offset += nalLength;
  }
}

using ParameterSetAtIndexFn = OSStatus (*)(CMFormatDescriptionRef, size_t, const uint8_t**, size_t*, size_t*, int*);

void AppendParameterSets(std::vector<uint8_t>& out, CMFormatDescriptionRef format, ParameterSetAtIndexFn getAtIndex) {
  size_t count = 0;
  if (getAtIndex(format, 0, nullptr, nullptr, &count, nullptr) != noErr) {
    return;
  }
  for (size_t i = 0; i < count; i++) {
    const uint8_t* bytes = nullptr;
    size_t size = 0;
    if (getAtIndex(format, i, &bytes, &size, nullptr, nullptr) == noErr) {
      AppendAnnexB(out, bytes, size);
    }
  }
}

// Clockwise degrees to visually rotate a captured frame to correct for `orientation` — verified
// empirically against a live device, not assumed from the enum names (see CLAUDE.md).
int RotationDegreesForOrientation(int32_t orientation) {
  switch (orientation) {
    case 2:
      return 180;
    case 3:
      return 270;
    case 4:
      return 90;
    default:
      return 0;
  }
}

// A rotated copy of `surface`'s frame, via CoreImage — the raw surface itself never reflects a live
// rotation (see CLAUDE.md). Caller owns the result (CVPixelBufferRelease). Returns nullptr on any
// (transient) failure.
//
// `canvasWidth`/`canvasHeight` (both 0, or both positive): 0 sizes the output to the rotated
// content itself (swapped at 90/270 — the default, used for streaming). A positive size instead
// freezes the output at that size regardless of rotation, letterboxing the (possibly
// differently-shaped) rotated content into it — required for AVRecordingSession, whose
// AVAssetWriter track's dimensions are fixed for the file's life once the first frame is appended;
// resizing later frames instead of letterboxing them corrupts playback (squashed video — see
// CLAUDE.md).
CVPixelBufferRef RotatedPixelBuffer(IOSurfaceRef surface, int degrees, CIContext* context, int32_t canvasWidth,
                                    int32_t canvasHeight) {
  CIImage* image = [CIImage imageWithIOSurface:surface];
  if (image == nil) {
    return nullptr;
  }
  // CoreImage is Y-up, unlike a raster's Y-down row order, so a visual CW rotation needs a
  // negative angle here (verified against ground truth, not just derived — see CLAUDE.md). The
  // translation afterward re-zeroes the extent's origin so CIContext renders it at (0, 0).
  CGAffineTransform rotate = CGAffineTransformMakeRotation(-degrees * M_PI / 180.0);
  CIImage* rotated = [image imageByApplyingTransform:rotate];
  CIImage* normalized = [rotated
      imageByApplyingTransform:CGAffineTransformMakeTranslation(-rotated.extent.origin.x, -rotated.extent.origin.y)];

  BOOL letterbox = canvasWidth > 0 && canvasHeight > 0;
  size_t width =
      letterbox ? static_cast<size_t>(canvasWidth) : static_cast<size_t>(std::lround(normalized.extent.size.width));
  size_t height =
      letterbox ? static_cast<size_t>(canvasHeight) : static_cast<size_t>(std::lround(normalized.extent.size.height));
  if (width == 0 || height == 0) {
    return nullptr;
  }

  CIImage* fitted = normalized;
  CGRect bounds = normalized.extent;
  if (letterbox) {
    double scale = std::min(width / normalized.extent.size.width, height / normalized.extent.size.height);
    CIImage* scaled = [normalized imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
    double dx = (width - scaled.extent.size.width) / 2.0 - scaled.extent.origin.x;
    double dy = (height - scaled.extent.size.height) / 2.0 - scaled.extent.origin.y;
    CIImage* centered = [scaled imageByApplyingTransform:CGAffineTransformMakeTranslation(dx, dy)];
    bounds = CGRectMake(0, 0, width, height);
    // Composited over black so the letterboxed margins render as black bars, not undefined content
    // (a fresh CVPixelBuffer's contents aren't otherwise guaranteed zeroed).
    fitted = [centered imageByCompositingOverImage:[CIImage imageWithColor:[CIColor colorWithRed:0 green:0 blue:0]]];
  }

  CVPixelBufferRef pixelBuffer = nullptr;
  CVReturn status =
      CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, nullptr, &pixelBuffer);
  if (status != kCVReturnSuccess || pixelBuffer == nullptr) {
    return nullptr;
  }
  [context render:fitted toCVPixelBuffer:pixelBuffer bounds:bounds colorSpace:nil];
  return pixelBuffer;
}

}  // namespace

bool IsKeyFrame(CMSampleBufferRef sampleBuffer) {
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, false);
  if (attachments == nullptr || CFArrayGetCount(attachments) == 0) {
    return true;
  }
  CFDictionaryRef attachment = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
  return !CFDictionaryContainsKey(attachment, kCMSampleAttachmentKey_NotSync);
}

void RepackAsAnnexB(std::vector<uint8_t>& out, CMSampleBufferRef sampleBuffer, bool isKeyFrame,
                    VideoStreamCodec codec) {
  if (isKeyFrame) {
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (format != nullptr) {
      if (codec == VideoStreamCodec::kHEVC) {
        AppendParameterSets(out, format, CMVideoFormatDescriptionGetHEVCParameterSetAtIndex);
      } else {
        AppendParameterSets(out, format, CMVideoFormatDescriptionGetH264ParameterSetAtIndex);
      }
    }
  }
  AppendSampleBufferNALs(out, sampleBuffer);
}

class VideoFrameEncoder::Impl {
 public:
  Impl(id device, VideoEncoderOptions options, std::function<void(CMSampleBufferRef)> onSample,
       std::function<void(NSError*)> onError, std::function<void()> onEnd, const double* sharedClockOrigin)
      : device_(device),
        options_(options),
        onSample_(std::move(onSample)),
        onError_(std::move(onError)),
        onEnd_(std::move(onEnd)),
        sharedClockOrigin_(sharedClockOrigin) {
    queue_ = dispatch_queue_create("io.appium.coresim.videoEncoder", DISPATCH_QUEUE_SERIAL);
    // Persistent, like JpegStreamSession's own (see sim_jpeg_stream.mm) — a continuous stream, not
    // CaptureScreenshot's deliberately one-shot context.
    ciContext_ = [CIContext contextWithOptions:nil];
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
      throw NSErrorException(MakeError(4, @"The device's display surface is not available yet"));
    }
    IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObj;
    // One-time blocking read so the first frame is already correctly oriented, before the
    // periodic poll below even starts.
    int32_t orientation = BlockingReadOrientation();
    polledOrientation_->store(orientation, std::memory_order_relaxed);
    // Set up synchronously (not lazily on the first Tick()) so a setup failure rejects Start()
    // directly rather than only reaching onError, which the caller may not be listening for yet.
    NSError* setupError = nil;
    if (!SetUpSession(surface, orientation, &setupError)) {
      throw NSErrorException(setupError);
    }
    // Must be set before EncodeSurface below — both it and HandleEncodedSample measure elapsed
    // time from this. A caller-supplied origin (see the constructor) is used as-is, not offset
    // further — the gap between it being captured and this line running is itself the correct,
    // meaningful startup latency to bake into this encoder's PTS zero, for sync with a peer
    // AudioEncoder given the same origin (av_recording.h/av_stream.h).
    startTime_ = sharedClockOrigin_ != nullptr ? *sharedClockOrigin_ : MonotonicSeconds();
    // Encode immediately rather than waiting for a *changed* seed on the first tick, or the
    // stream would stay silent until the display changes again. running_ is set true before this
    // call (not after), since VTCompressionSessionEncodeFrame's output callback can in principle
    // fire on another thread before this one returns — HandleEncodedSample discards samples while
    // running_ is false, which would otherwise silently drop the stream's very first (keyframe)
    // sample. A failure resets it and tears session_ down itself here, rather than going through
    // Stop()/onEnd_ (see coresim.mm — onEnd_ firing this early would double-release its
    // ThreadSafeFunctions).
    running_ = true;
    bool encoded = false;
    try {
      encoded = EncodeSurface(surface, orientation);
    } catch (...) {
      running_ = false;
      VTCompressionSessionInvalidate(session_);
      CFRelease(session_);
      session_ = nullptr;
      throw;
    }
    // Only commit the seed once a frame was actually submitted — a transient pixel-buffer
    // creation failure (EncodeSurface returning false) otherwise leaves lastSeed_/
    // hasEncodedSinceSetup_ at their defaults, so the first Tick() sees this as still needing a
    // frame and retries automatically instead of the stream going silent forever on a display
    // that never changes again.
    if (encoded) {
      lastSeed_ = IOSurfaceGetSeed(surface);
      hasEncodedSinceSetup_ = true;
    }

    double interval = 1.0 / std::max(options_.fps, 1.0);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue_);
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 0),
                              static_cast<uint64_t>(interval * NSEC_PER_SEC),
                              static_cast<uint64_t>(interval * NSEC_PER_SEC / 10));
    // `this` outlives the timer: Stop()/StopFromQueue() always drain or outrun it before `this`
    // can be destroyed (see their comments below).
    dispatch_source_set_event_handler(timer, ^{
      Tick();
    });
    timer_ = timer;
    dispatch_resume(timer_);
    StartOrientationPoll();
  }

  // Callable from any thread except `queue_` itself (would deadlock on the dispatch_sync below).
  void Stop() {
    if (!running_.exchange(false)) {
      return;  // idempotent
    }
    StopOrientationPoll();
    if (timer_ != nullptr) {
      dispatch_source_cancel(timer_);
      // Blocks until any in-flight Tick() finishes — by then running_ is already false, so it
      // won't touch session_ again.
      dispatch_sync(queue_, ^{
                    });
      timer_ = nullptr;
    }
    TearDownSessionAndFireEnd();
  }

  void RequestKeyFrame() { forceKeyFrame_ = true; }

 private:
  int32_t BlockingReadOrientation() {
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    __block int32_t result = 1;
    ReadGuestOrientation(device_, ^(int32_t orientation) {
      result = orientation;
      dispatch_semaphore_signal(sema);
    });
    dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
    return result;
  }

  // Keeps polledOrientation_ fresh against a rotation from any source (see CLAUDE.md). Off queue_ by
  // design, not because it's slow — Tick() must stay cheap regardless.
  void StartOrientationPoll() {
    std::shared_ptr<std::atomic<int32_t>> cell = polledOrientation_;
    id device = device_;
    dispatch_queue_t pollQueue =
        dispatch_queue_create("io.appium.coresim.videoEncoder.orientationPoll", DISPATCH_QUEUE_SERIAL);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, pollQueue);
    constexpr int64_t kPollIntervalSeconds = 3;
    // Starts one interval out — Start() already seeded polledOrientation_ synchronously.
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, kPollIntervalSeconds * NSEC_PER_SEC),
                              kPollIntervalSeconds * NSEC_PER_SEC, NSEC_PER_SEC);
    // `cell`, not `this` — see polledOrientation_'s own comment.
    dispatch_source_set_event_handler(timer, ^{
      ReadGuestOrientation(device, ^(int32_t orientation) {
        cell->store(orientation, std::memory_order_relaxed);
      });
    });
    orientationPollTimer_ = timer;
    dispatch_resume(orientationPollTimer_);
  }

  void StopOrientationPoll() {
    if (orientationPollTimer_ != nullptr) {
      dispatch_source_cancel(orientationPollTimer_);
      orientationPollTimer_ = nullptr;
    }
  }

  // Same as Stop() minus the dispatch_sync barrier — only safe from within Tick() itself, already
  // serialized on `queue_`; would race a concurrent Tick() from any other thread.
  void StopFromQueue() {
    if (!running_.exchange(false)) {
      return;  // idempotent — e.g. an external Stop() already won this race
    }
    StopOrientationPoll();
    if (timer_ != nullptr) {
      dispatch_source_cancel(timer_);
      timer_ = nullptr;
    }
    TearDownSessionAndFireEnd();
  }

  void TearDownSessionAndFireEnd() {
    if (session_ != nullptr) {
      // Flushes and blocks until every already-submitted frame's callback has returned — without
      // this, a frame submitted just before Stop() could fire after onEnd_ releases whatever
      // resources the caller tied to it (e.g. ThreadSafeFunctions — see CLAUDE.md).
      VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
      VTCompressionSessionInvalidate(session_);
      CFRelease(session_);
      session_ = nullptr;
    }
    if (onEnd_) {
      onEnd_();
    }
  }

  void Tick() {
    if (!running_) {
      return;
    }
    if (pendingErrorTeardown_) {
      // HandleEncodedSample (below) can run on VideoToolbox's own callback thread, where it's
      // unsafe to tear down directly — StopFromQueue()/CompleteFrames() are only safe already
      // serialized on `queue_` (here), and CompleteFrames specifically would deadlock waiting on
      // its own still-executing callback. It sets this flag instead; picked up on the very next
      // tick (queue_-serialized, safe) rather than via a raw cross-thread dispatch, since nothing
      // here can outlive `this` the way a block captured on another thread otherwise could.
      StopFromQueue();
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
          return;  // transient — the connection may not have a frame ready yet, try again next tick
        }
        IOSurfaceRef surface = (__bridge IOSurfaceRef)surfaceObj;
        int32_t orientation = polledOrientation_->load(std::memory_order_relaxed);
        int32_t rawWidth = static_cast<int32_t>(IOSurfaceGetWidth(surface));
        int32_t rawHeight = static_cast<int32_t>(IOSurfaceGetHeight(surface));
        if (options_.fixedFrameSize) {
          // The session's encoded size is frozen at whatever it was on the first frame (see
          // VideoEncoderOptions) — EncodeSurface letterboxes into it below, so a raw resize or
          // rotation just needs this bookkeeping updated, never a session rebuild. But the raw
          // surface's seed alone doesn't change on a rotation of an otherwise-static screen (see
          // CLAUDE.md) — force one frame through below despite the seed-equality skip, or a
          // rotation could go uncorrected until the screen's content happens to change on its own.
          if (rawWidth != rawSurfaceWidth_ || rawHeight != rawSurfaceHeight_ || orientation != sessionOrientation_) {
            hasEncodedSinceSetup_ = false;
          }
          rawSurfaceWidth_ = rawWidth;
          rawSurfaceHeight_ = rawHeight;
          sessionOrientation_ = orientation;
        } else if (rawWidth != rawSurfaceWidth_ || rawHeight != rawSurfaceHeight_ ||
                   orientation != sessionOrientation_) {
          // Raw resize (some CoreSimulator versions) or an orientation change — either needs the
          // session rebuilt for the new effective dimensions.
          NSError* resizeError = nil;
          if (!RecreateSessionForResize(surface, orientation, &resizeError)) {
            if (onError_) {
              onError_(resizeError);
            }
            StopFromQueue();
            return;
          }
        }
        uint32_t seed = IOSurfaceGetSeed(surface);
        // A differently-shaped replacement surface can collide with the old seed value (confirmed
        // empirically), so a just-rebuilt session must submit one frame before this skip applies.
        if (seed == lastSeed_ && hasEncodedSinceSetup_) {
          return;  // unchanged since the last tick (see CLAUDE.md)
        }
        // Leave lastSeed_/hasEncodedSinceSetup_ stale on a transient EncodeSurface failure so the
        // next tick retries.
        if (EncodeSurface(surface, orientation)) {
          lastSeed_ = seed;
          hasEncodedSinceSetup_ = true;
        }
      } catch (const std::exception& e) {
        // Without this, an exception here (e.g. a dropped display-proxy connection) would escape
        // this bare GCD timer handler uncaught and crash the whole process (see CLAUDE.md).
        if (onError_) {
          onError_(MakeError(3, [NSString stringWithFormat:@"Video encoding failed: %s", e.what()]));
        }
        StopFromQueue();
      }
    }
  }

  // Tears down `session_` (if any) and recreates it for `surface`'s current dimensions, rotated
  // for `orientation`. No explicit RequestKeyFrame() needed — a fresh session's first frame is a
  // keyframe regardless.
  bool RecreateSessionForResize(IOSurfaceRef surface, int32_t orientation, NSError** error) {
    if (session_ != nullptr) {
      VTCompressionSessionCompleteFrames(session_, kCMTimeInvalid);
      VTCompressionSessionInvalidate(session_);
      CFRelease(session_);
      session_ = nullptr;
    }
    return SetUpSession(surface, orientation, error);
  }

  bool SetUpSession(IOSurfaceRef surface, int32_t orientation, NSError** error) {
    int32_t rawWidth = static_cast<int32_t>(IOSurfaceGetWidth(surface));
    int32_t rawHeight = static_cast<int32_t>(IOSurfaceGetHeight(surface));
    rawSurfaceWidth_ = rawWidth;
    rawSurfaceHeight_ = rawHeight;
    sessionOrientation_ = orientation;
    // A fresh/rebuilt session hasn't sent VideoToolbox a frame yet — Tick()'s own seed-equality
    // skip must not apply until it has (see Tick()'s own comment on why).
    hasEncodedSinceSetup_ = false;
    int degrees = RotationDegreesForOrientation(orientation);
    bool swapped = degrees == 90 || degrees == 270;
    int32_t width = swapped ? rawHeight : rawWidth;
    int32_t height = swapped ? rawWidth : rawHeight;
    sessionWidth_ = width;
    sessionHeight_ = height;
    CMVideoCodecType codecType =
        options_.codec == VideoStreamCodec::kHEVC ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264;
    OSStatus status = VTCompressionSessionCreate(kCFAllocatorDefault, width, height, codecType, nullptr, nullptr,
                                                 kCFAllocatorDefault, OutputCallback, this, &session_);
    if (status != noErr) {
      *error = MakeStatusError(1, @"Failed to create a VTCompressionSession", status);
      return false;
    }
    // Clamped like Start()'s timer interval — an unvalidated 0 here would set MaxKeyFrameInterval
    // to an out-of-spec value.
    double fps = std::max(options_.fps, 1.0);
    status = VTSessionSetProperty(session_, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    if (status == noErr) {
      status = VTSessionSetProperty(session_, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    }
    if (status == noErr) {
      status = VTSessionSetProperty(session_, kVTCompressionPropertyKey_AverageBitRate,
                                    (__bridge CFNumberRef) @(options_.bitrate));
    }
    if (status == noErr) {
      status =
          VTSessionSetProperty(session_, kVTCompressionPropertyKey_ExpectedFrameRate, (__bridge CFNumberRef) @(fps));
    }
    if (status == noErr) {
      status = VTSessionSetProperty(session_, kVTCompressionPropertyKey_MaxKeyFrameInterval,
                                    (__bridge CFNumberRef) @(static_cast<int>(fps * 2)));
    }
    if (status != noErr) {
      *error = MakeStatusError(2, @"Failed to configure the VTCompressionSession", status);
      VTCompressionSessionInvalidate(session_);
      CFRelease(session_);
      session_ = nullptr;
      return false;
    }
    VTCompressionSessionPrepareToEncodeFrames(session_);
    return true;
  }

  // Returns whether a frame was actually submitted to the encoder — false for a transient
  // pixel-buffer creation failure the caller should retry, as opposed to a real encode failure
  // (thrown, not returned, since that tears down the whole session).
  bool EncodeSurface(IOSurfaceRef surface, int32_t orientation) {
    int degrees = RotationDegreesForOrientation(orientation);
    int32_t rawWidth = static_cast<int32_t>(IOSurfaceGetWidth(surface));
    int32_t rawHeight = static_cast<int32_t>(IOSurfaceGetHeight(surface));
    // Zero-copy only applies when the raw surface already matches the session as-is — not just
    // degrees == 0, since fixedFrameSize mode can also need letterboxing at zero rotation (a raw
    // resize with no orientation change).
    bool matchesSessionAsIs = degrees == 0 && rawWidth == sessionWidth_ && rawHeight == sessionHeight_;
    CVPixelBufferRef pixelBuffer = nullptr;
    if (matchesSessionAsIs) {
      // The common case: zero-copy, exactly as before orientation correction existed.
      CVReturn cvStatus = CVPixelBufferCreateWithIOSurface(kCFAllocatorDefault, surface, nullptr, &pixelBuffer);
      if (cvStatus != kCVReturnSuccess || pixelBuffer == nullptr) {
        return false;  // transient — try again next tick rather than tearing down the whole session
      }
    } else {
      int32_t canvasWidth = options_.fixedFrameSize ? sessionWidth_ : 0;
      int32_t canvasHeight = options_.fixedFrameSize ? sessionHeight_ : 0;
      pixelBuffer = RotatedPixelBuffer(surface, degrees, ciContext_, canvasWidth, canvasHeight);
      if (pixelBuffer == nullptr) {
        return false;  // transient, same contract as the zero-copy path above
      }
    }
    CMTime pts = CMTimeMake(static_cast<int64_t>((MonotonicSeconds() - startTime_) * 1000000), 1000000);
    NSDictionary* frameProperties = nil;
    if (forceKeyFrame_.exchange(false)) {
      frameProperties = @{(__bridge NSString*)kVTEncodeFrameOptionKey_ForceKeyFrame : @YES};
    }
    OSStatus status = VTCompressionSessionEncodeFrame(session_, pixelBuffer, pts, kCMTimeInvalid,
                                                      (__bridge CFDictionaryRef)frameProperties, nullptr, nullptr);
    CVPixelBufferRelease(pixelBuffer);
    if (status != noErr) {
      throw std::runtime_error([[NSString stringWithFormat:@"VTCompressionSessionEncodeFrame failed (OSStatus %d)",
                                                           static_cast<int>(status)] UTF8String]);
    }
    return true;
  }

  static void OutputCallback(void* outputCallbackRefCon, void* /*sourceFrameRefCon*/, OSStatus status,
                             VTEncodeInfoFlags /*infoFlags*/, CMSampleBufferRef sampleBuffer) {
    static_cast<Impl*>(outputCallbackRefCon)->HandleEncodedSample(status, sampleBuffer);
  }

  void HandleEncodedSample(OSStatus status, CMSampleBufferRef sampleBuffer) {
    if (!running_) {
      return;
    }
    if (status != noErr) {
      // Only the first failure is reported — pendingErrorTeardown_ doubles as the report-once
      // gate, since Tick() (the only place that consumes it) only ever needs to see it once too.
      if (!pendingErrorTeardown_.exchange(true)) {
        if (onError_) {
          onError_(MakeStatusError(3, @"VideoToolbox reported an encoding failure", status));
        }
      }
      return;
    }
    if (sampleBuffer == nullptr) {
      return;
    }
    if (onSample_) {
      onSample_(sampleBuffer);
    }
  }

  id device_;
  VideoEncoderOptions options_;
  std::function<void(CMSampleBufferRef)> onSample_;
  std::function<void(NSError*)> onError_;
  std::function<void()> onEnd_;
  const double* sharedClockOrigin_;

  dispatch_queue_t queue_ = nullptr;
  dispatch_source_t timer_ = nullptr;
  VTCompressionSessionRef session_ = nullptr;
  CIContext* ciContext_ = nil;
  // The session's own post-rotation encode dimensions (what VTCompressionSessionCreate got).
  int32_t sessionWidth_ = 0;
  int32_t sessionHeight_ = 0;
  // The raw IOSurface's dimensions as of the last SetUpSession — kept separate from
  // sessionWidth_/sessionHeight_ so a rotation intentionally making them differ isn't mistaken for
  // a raw resize.
  int32_t rawSurfaceWidth_ = 0;
  int32_t rawSurfaceHeight_ = 0;
  // Orientation last baked into session_ — Tick() rebuilds when polledOrientation_ moves past this.
  int32_t sessionOrientation_ = 1;
  uint32_t lastSeed_ = 0;
  // Whether session_ has submitted a frame yet — see Tick()'s seed-equality skip.
  bool hasEncodedSinceSetup_ = false;
  double startTime_ = 0;
  std::atomic<bool> running_{false};
  // Set by HandleEncodedSample (possibly off queue_) on an encoder failure, consumed by the next
  // Tick() (on queue_) — see both for why teardown can't just happen inline there.
  std::atomic<bool> pendingErrorTeardown_{false};
  std::atomic<bool> forceKeyFrame_{false};

  // Last orientation StartOrientationPoll read; Tick() only ever reads this cheaply. A shared_ptr
  // (not a plain member) since a poll's guest spawn can still be in flight when Stop()/~Impl runs
  // — its completion must never touch a possibly-dead `this` (see CLAUDE.md).
  std::shared_ptr<std::atomic<int32_t>> polledOrientation_ = std::make_shared<std::atomic<int32_t>>(1);
  dispatch_source_t orientationPollTimer_ = nullptr;
};

VideoFrameEncoder::VideoFrameEncoder(id device, VideoEncoderOptions options,
                                     std::function<void(CMSampleBufferRef)> onSample,
                                     std::function<void(NSError*)> onError, std::function<void()> onEnd,
                                     const double* sharedClockOrigin)
    : impl_(std::make_unique<Impl>(device, options, std::move(onSample), std::move(onError), std::move(onEnd),
                                   sharedClockOrigin)) {}

VideoFrameEncoder::~VideoFrameEncoder() = default;

void VideoFrameEncoder::Start() { impl_->Start(); }

void VideoFrameEncoder::Stop() { impl_->Stop(); }

void VideoFrameEncoder::RequestKeyFrame() { impl_->RequestKeyFrame(); }

}  // namespace coresim
