#include "h264_encoder.h"

#ifdef __APPLE__
#include "videotoolbox_encoder.h"
#endif

namespace media_proxy {

std::vector<std::string> H264EncoderNames() {
#ifdef __APPLE__
  return {"h264_videotoolbox"};
#else
  return {};
#endif
}

std::unique_ptr<H264Encoder> CreateH264Encoder(const H264Params& params, const H264Encoder::Sink& sink) {
#ifdef __APPLE__
  return CreateVideoToolboxEncoder(params, sink);
#else
  (void)params;
  (void)sink;
  throw PipelineError{"MediaProxyEncoderUnavailableError", "No H.264 encoder is available on this platform"};
#endif
}

}  // namespace media_proxy
