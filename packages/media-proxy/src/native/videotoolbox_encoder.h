#pragma once

#include <memory>

#include "h264_encoder.h"

namespace media_proxy {

// macOS VideoToolbox, called directly: FFmpeg's wrapper only returns a packet on the next send, which costs
// several frames of latency. Throws PipelineError (MediaProxyEncoderUnavailableError) if the session can't open.
std::unique_ptr<H264Encoder> CreateVideoToolboxEncoder(const H264Params& params, const H264Encoder::Sink& sink);

}  // namespace media_proxy
