#pragma once

#import <AudioToolbox/AudioToolbox.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>

#include <cstddef>
#include <functional>
#include <memory>
#include <vector>

namespace coresim {

// Encodes interleaved PCM (as delivered by AudioTapSession, sim_audio_tap.h) to AAC-LC via
// AudioToolbox's AudioConverterRef — the same role VideoFrameEncoder/VTCompressionSession plays
// for video. Shared by both the AV recording (av_recording.h, muxed into a file via AVAssetWriter
// passthrough) and AV streaming (av_stream.h, raw access units) paths, mirroring how a single
// VideoFrameEncoder backs both video paths.
//
// AAC packets straddle multiple PCM buffers (1024 samples/packet vs. one IO cycle's ~512 or so),
// so this buffers incoming PCM internally and emits a `CMSampleBufferRef` — via `onSample` —
// exactly when a full packet becomes available, not once per EncodePCM call.
class AudioEncoder {
 public:
  // `onSample`'s CMSampleBufferRef is only valid for the duration of the call, same contract as
  // VideoFrameEncoder's onSample (video_encoder.h) — copy out or CFRetain before returning if
  // needed beyond it.
  //
  // `sharedClockOrigin`, if non-null, anchors this encoder's PTS-zero to the same instant given to
  // a peer VideoFrameEncoder — see that class's constructor for the full rationale. Captured once,
  // at construction (when this encoder's audio effectively "starts"), not re-read afterward.
  AudioEncoder(const AudioStreamBasicDescription& inputFormat, std::function<void(CMSampleBufferRef)> onSample,
               const double* sharedClockOrigin = nullptr);
  ~AudioEncoder();

  AudioEncoder(const AudioEncoder&) = delete;
  AudioEncoder& operator=(const AudioEncoder&) = delete;

  // Feeds one IO cycle's interleaved PCM (as delivered directly by AudioTapSession's onBuffer —
  // same AudioBufferList/AudioStreamBasicDescription shape) into the encoder. Must be called from
  // a single thread/queue only — not internally synchronized, same as VideoFrameEncoder's
  // single-queue contract (the caller already serializes tap delivery onto one queue). Throws
  // NSErrorException on an unexpected converter failure — callers should treat it the same as
  // VideoFrameEncoder's EncodeSurface throwing (a fatal error for the whole session), not retry it
  // inline.
  void EncodePCM(const AudioBufferList* data, const AudioTimeStamp* time);

  // The output AAC-LC format — channels/sample rate mirror the input; usable as
  // AVAssetWriterInput's `sourceFormatHint` for passthrough (av_recording.h).
  CMFormatDescriptionRef OutputFormatDescription() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

// Prepends a 7-byte ADTS header (no CRC) describing `aacFrameLength` bytes of raw AAC-LC payload
// at `format`'s sample rate/channel count, appending both to `out`. Makes a streamed packet
// self-describing (decodable without an out-of-band config exchange) — the audio counterpart to
// RepackAsAnnexB's per-keyframe SPS/PPS (video_encoder.h). Not used for the muxed-file recording
// path — AVAssetWriter passthrough wants bare AAC plus AudioEncoder::OutputFormatDescription, not
// ADTS framing.
void PrependADTSHeader(std::vector<uint8_t>& out, size_t aacFrameLength, const AudioStreamBasicDescription& format);

}  // namespace coresim
