#pragma once

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include <functional>
#include <memory>

#include "video_encoder.h"

namespace coresim {

// File recording via this addon's own encoders — independent of StartVideoRecording's private
// CoreSimulator recorder (sim_video_recording.h), which has no per-frame hook to mux audio into
// and no `fps` knob. Drives a VideoFrameEncoder and, when `captureAudio` is set, an
// AudioTapSession+AudioEncoder too, on one shared PTS clock (monotonic_clock.h), muxing the
// already-encoded output into one file via AVAssetWriter passthrough. Without `captureAudio`,
// reached when `fps` alone is requested — see coresim.mm's StartVideoRecording.
//
// IMPORTANT: with `captureAudio`, needs the host's "System Audio Recording Only" TCC permission —
// see sim_audio_tap.h.
class AVRecordingSession {
 public:
  AVRecordingSession(id device, NSString* udid, VideoEncoderOptions videoOptions, NSString* outputFile,
                     bool captureAudio);
  ~AVRecordingSession();

  AVRecordingSession(const AVRecordingSession&) = delete;
  AVRecordingSession& operator=(const AVRecordingSession&) = delete;

  // Resolves the display and starts the video encoder (plus the audio tap + encoder, if
  // `captureAudio`); throws synchronously on setup failure (no callback fires then). `onFirstSample`
  // fires once the AVAssetWriter session has actually started — mirrors StartVideoRecording's
  // "resolves once the first frame is recorded" contract. `onError` covers a later encoder/writer
  // failure, firing at most once; the session tears itself down before calling it, so a following
  // Stop() is always safe (and required, to reclaim the writer/file). `onEnd` fires exactly once,
  // always — after `onError` if it fired, or once Stop() finishes otherwise — the one safe point
  // to release resources tied to this session's lifetime, mirroring VideoStreamSession.
  void Start(std::function<void()> onFirstSample, std::function<void(NSError*)> onError, std::function<void()> onEnd);

  // Finalizes the output file. `onFinished` fires once (non-nil NSError* on failure, including
  // when `onError` already fired earlier — in that case this just reports the same failure rather
  // than attempting to finalize an already-cancelled writer). Safe to call even if no frame was
  // ever captured (reports an error instead of producing an empty file).
  void Stop(std::function<void(NSError*)> onFinished);

 private:
  class Impl;
  std::shared_ptr<Impl> impl_;
};

}  // namespace coresim
