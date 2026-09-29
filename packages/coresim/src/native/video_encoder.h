#pragma once

#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace coresim {

enum class VideoStreamCodec { kH264, kHEVC };

struct VideoEncoderOptions {
  VideoStreamCodec codec = VideoStreamCodec::kH264;
  NSString* displayId = nil;
  double fps = 60.0;
  int bitrate = 4000000;

  // Freezes the encoded frame size at whatever it is on the first frame, forever — a rotation
  // afterward letterboxes into that size instead of resizing the session to match. Internal-only
  // (not JS-configurable): AVRecordingSession forces this on, since its AVAssetWriter track's
  // dimensions are fixed for the file's life (see CLAUDE.md); a live stream has no such constraint
  // and keeps the default (false), matching its own decoded dimensions to the actual rotation.
  bool fixedFrameSize = false;
};

// Polls the live display IOSurface (sim_screenshot.h) on a serial queue and encodes changed
// frames via the public VideoToolbox API, delivering each encoded `CMSampleBufferRef` live.
// Extracted from VideoStreamSession (video_stream.h) so both it and the combined AV
// recording/streaming sessions (av_recording.h/av_stream.h) share one VTCompressionSession driver
// instead of each re-deriving IOSurface-poll + compression-session setup from scratch. Callers
// that need Annex-B-framed access units (VideoAccessUnit's wire format) repack the delivered
// sample buffers themselves (see RepackAsAnnexB below) — this class only drives the encoder.
class VideoFrameEncoder {
 public:
  // `onSample`'s CMSampleBufferRef is only valid for the duration of the call (VideoToolbox owns
  // it) — a caller that needs the data beyond that must copy it out (or CFRetain it) before
  // returning, never stash the raw pointer.
  //
  // `sharedClockOrigin`, if non-null, is used as this encoder's PTS-zero instant (from
  // monotonic_clock.h) instead of capturing its own at Start() — pass the same pointer to an
  // AudioEncoder started around the same time so both tracks' presentation timestamps measure
  // elapsed time from one common reference (av_recording.h/av_stream.h do this; the standalone
  // VideoStreamSession, video-only, has no such peer and leaves this null).
  VideoFrameEncoder(id device, VideoEncoderOptions options, std::function<void(CMSampleBufferRef)> onSample,
                    std::function<void(NSError*)> onError, std::function<void()> onEnd,
                    const double* sharedClockOrigin = nullptr);
  ~VideoFrameEncoder();

  VideoFrameEncoder(const VideoFrameEncoder&) = delete;
  VideoFrameEncoder& operator=(const VideoFrameEncoder&) = delete;

  // Resolves the display and starts the polling loop; throws synchronously on resolution/setup
  // failure (`onEnd` never called then). Later failures go to `onError`, then `onEnd`.
  void Start();

  // Idempotent; blocks until the loop has fully stopped. Never call from inside onSample/onError/
  // onEnd — same queue this blocks on, so it would deadlock.
  void Stop();

  // Forces the next encoded frame to be a keyframe (self-decodable, parameter sets included) —
  // e.g. so a consumer that just resynced after dropping frames can resume cleanly instead of
  // waiting for the next periodic one. Safe from any thread; just sets a flag.
  void RequestKeyFrame();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

// Whether `sampleBuffer` is a sync (key) frame, from its sample attachments.
bool IsKeyFrame(CMSampleBufferRef sampleBuffer);

// VideoToolbox's compressed output is AVCC-framed (a 4-byte big-endian length prefix per NAL, no
// start codes) — rewrites `sampleBuffer` into Annex-B, appending to `out`. A keyframe's format
// description (SPS/PPS, or VPS/SPS/PPS for HEVC) is prepended first when `isKeyFrame`, so every
// keyframe is self-decodable alone. Shared by VideoStreamSession and the AV streaming path so both
// produce byte-identical framing for the same encoder output.
void RepackAsAnnexB(std::vector<uint8_t>& out, CMSampleBufferRef sampleBuffer, bool isKeyFrame, VideoStreamCodec codec);

}  // namespace coresim
