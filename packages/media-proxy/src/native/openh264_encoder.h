#pragma once

#include <memory>

#include "h264_encoder.h"

namespace media_proxy {

// Software H.264 through Cisco's OpenH264, loaded at runtime from the library named by $MEDIA_PROXY_OPENH264_PATH
// (installed by the client package, never bundled). Without that variable OpenH264 is not offered.
// Throws PipelineError (MediaProxyEncoderUnavailableError) if the library is missing, mismatched or fails to open.
std::unique_ptr<H264Encoder> CreateOpenH264Encoder(const H264Params& params, const H264Encoder::Sink& sink);

}  // namespace media_proxy
