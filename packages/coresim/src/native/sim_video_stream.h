#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "video_encoder.h"

namespace coresim {

// One encoded frame — Annex-B NAL units, concatenated. A keyframe's `data` has parameter sets
// (SPS/PPS, or VPS/SPS/PPS for HEVC) prepended, so every keyframe is self-decodable alone.
struct VideoAccessUnit {
  std::vector<uint8_t> data;
  bool isKeyFrame = false;
  uint64_t sequence = 0;
  // Microseconds since the stream started.
  int64_t timestampMicros = 0;
};

// Polls the live display IOSurface (sim_screenshot.h) on a serial queue and encodes changed
// frames via the public VideoToolbox API — unlike StartVideoRecording's private, file-only
// recorder, this delivers access units live. Full thread-safety contract: see CLAUDE.md.
class VideoStreamSession {
 public:
  // `onAbortDelivery`, if set, is invoked by AbortDelivery() below — not called by this class on
  // its own.
  VideoStreamSession(id device, VideoEncoderOptions options, std::function<void(VideoAccessUnit)> onAccessUnit,
                     std::function<void(NSError*)> onError, std::function<void()> onEnd,
                     std::function<void()> onAbortDelivery = nullptr);
  ~VideoStreamSession();

  VideoStreamSession(const VideoStreamSession&) = delete;
  VideoStreamSession& operator=(const VideoStreamSession&) = delete;

  // Resolves the display and starts the polling loop; throws synchronously on resolution/setup
  // failure (`onEnd` never called then). Later failures go to `onError`, then `onEnd`.
  void Start();

  // Idempotent; blocks until the loop has fully stopped. Never call from inside onAccessUnit/
  // onError/onEnd — same queue this blocks on, so it would deadlock.
  void Stop();

  // Runs the constructor's `onAbortDelivery` (if any) — e.g. aborting a bounded delivery queue so
  // a producer thread blocked pushing into it unblocks. Call before Stop() when the caller can't
  // rely on anything else draining that queue concurrently (e.g. process-exit cleanup running
  // synchronously on the same thread `Stop()` would otherwise wait on) — a normal Stop() doesn't
  // need this. Safe from any thread; a no-op if unset.
  void AbortDelivery();

  // Forces the next encoded frame to be a keyframe (self-decodable, parameter sets included) —
  // e.g. so a consumer that just resynced after dropping frames can resume cleanly instead of
  // waiting for the next periodic one. Safe from any thread; just sets a flag.
  void RequestKeyFrame();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace coresim
