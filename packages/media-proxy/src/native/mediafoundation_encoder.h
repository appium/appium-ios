#pragma once

#include <memory>

#include "h264_encoder.h"

namespace media_proxy {

// Windows Media Foundation H.264 encoder MFT (synchronous ones: Microsoft's own, always present). FFmpeg's h264_mf
// buffers frames; calling the MFT directly returns each frame from the same Encode(). Throws PipelineError
// (MediaProxyEncoderUnavailableError) if no encoder opens.
std::unique_ptr<H264Encoder> CreateMediaFoundationEncoder(const H264Params& params, const H264Encoder::Sink& sink);

}  // namespace media_proxy
