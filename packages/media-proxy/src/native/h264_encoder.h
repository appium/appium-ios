#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "pipeline.h"

struct AVFrame;

namespace media_proxy {

struct H264Params {
  int width = 0;
  int height = 0;
  double fps = 60;
  int64_t bitrate = 0;
  int gopFrames = 120;
};

// Hardware H.264 encoder fed NV12 (limited range) frames. Output units (Annex-B, 4-byte start codes, parameter
// sets inline on key frames, no B-frames) are handed to the sink synchronously from Encode()/Flush().
class H264Encoder {
 public:
  using Sink = std::function<void(EncodedUnit&&)>;

  virtual ~H264Encoder() = default;
  H264Encoder() = default;
  H264Encoder(const H264Encoder&) = delete;
  H264Encoder& operator=(const H264Encoder&) = delete;

  virtual void Encode(const AVFrame& nv12, bool forceKeyFrame) = 0;
  virtual void Flush() = 0;
};

// Names of the H.264 encoders this platform's build can offer, best first (empty: none).
std::vector<std::string> H264EncoderNames();

// Throws PipelineError (MediaProxyEncoderUnavailableError) unless some encoder opens; the message says why each
// backend failed and how to install OpenH264.
void RequireH264Encoder();

// Opens the best available encoder. Throws PipelineError (MediaProxyEncoderUnavailableError) if none opens.
std::unique_ptr<H264Encoder> CreateH264Encoder(const H264Params& params, const H264Encoder::Sink& sink);

}  // namespace media_proxy
