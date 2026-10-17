#include "h264_encoder.h"

#ifdef __APPLE__
#include "videotoolbox_encoder.h"
#endif

namespace media_proxy {

#ifdef __APPLE__
namespace {

// Opening a throwaway session is the only reliable test (VMs and some Macs have no usable encoder); done once.
bool VideoToolboxUsable() {
  static const bool usable = [] {
    constexpr H264Params kProbe{320, 240, 30, 1'000'000, 60};
    try {
      return CreateVideoToolboxEncoder(kProbe, [](EncodedUnit&&) {}) != nullptr;
    } catch (const PipelineError&) {
      return false;
    }
  }();
  return usable;
}

}  // namespace
#endif

std::vector<std::string> H264EncoderNames() {
#ifdef __APPLE__
  return VideoToolboxUsable() ? std::vector<std::string>{"h264_videotoolbox"} : std::vector<std::string>{};
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
  throw PipelineError{kEncoderUnavailableError, "No H.264 encoder is available on this platform"};
#endif
}

}  // namespace media_proxy
