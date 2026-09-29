#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "video_encoder.h"

namespace coresim {

enum class AVTrack { kVideo, kAudio };

// One encoded unit from AVStreamSession::onAccessUnit — either an Annex-B video access unit
// (same wire format as VideoAccessUnit) or a raw AAC-LC packet, discriminated by `track`.
// `isKeyFrame` is video-only (always true for audio — every AAC-LC packet is independently
// decodable); `sequence` counts per track, not globally, since interleaving order between the two
// tracks carries no meaning of its own — only `timestampMicros`, on the shared session clock
// (monotonic_clock.h), does.
struct AVAccessUnit {
  AVTrack track = AVTrack::kVideo;
  std::vector<uint8_t> data;
  bool isKeyFrame = false;
  uint64_t sequence = 0;
  int64_t timestampMicros = 0;
};

// Combined audio+video real-time streaming — the streaming counterpart to AVRecordingSession
// (av_recording.h). Drives the same VideoFrameEncoder/AudioTapSession/AudioEncoder trio on one
// shared PTS clock, but delivers each encoded unit live via `onAccessUnit` (interleaved, in
// production order) instead of muxing into a file.
//
// IMPORTANT: needs the host's "System Audio Recording Only" TCC permission — see sim_audio_tap.h.
class AVStreamSession {
 public:
  // `onAbortDelivery`, if set, is invoked by AbortDelivery() below — not called by this class on
  // its own. See VideoStreamSession's identical parameter for why it exists.
  AVStreamSession(id device, NSString* udid, VideoEncoderOptions videoOptions,
                  std::function<void(AVAccessUnit)> onAccessUnit, std::function<void(NSError*)> onError,
                  std::function<void()> onEnd, std::function<void()> onAbortDelivery = nullptr);
  ~AVStreamSession();

  AVStreamSession(const AVStreamSession&) = delete;
  AVStreamSession& operator=(const AVStreamSession&) = delete;

  // Resolves the display and starts the audio tap + both encoders; throws synchronously on setup
  // failure (`onAccessUnit`/`onError`/`onEnd` never called then). Later failures from either
  // encoder go to `onError`, then `onEnd` — mirrors VideoStreamSession's contract.
  void Start();

  // Idempotent; blocks until both encoders have fully stopped. Never call from inside
  // onAccessUnit/onError/onEnd — same queues this blocks on, so it would deadlock.
  void Stop();

  // See VideoStreamSession::AbortDelivery — same contract, call before Stop() only when nothing
  // else will drain the delivery queue concurrently.
  void AbortDelivery();

  // Forces the next encoded video frame to be a keyframe — see VideoFrameEncoder::RequestKeyFrame.
  // No audio equivalent (every AAC-LC packet already self-decodable).
  void RequestKeyFrame();

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace coresim
