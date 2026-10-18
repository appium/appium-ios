#include "h264_encoder.h"

#include <atomic>

#ifdef __APPLE__
#include "videotoolbox_encoder.h"
#elif defined(_WIN32)
#include "mediafoundation_encoder.h"
#endif

namespace media_proxy {

#if defined(__APPLE__) || defined(_WIN32)
namespace {

#ifdef __APPLE__
constexpr const char* kEncoderName = "h264_videotoolbox";
constexpr auto CreatePlatformEncoder = CreateVideoToolboxEncoder;
#else
constexpr const char* kEncoderName = "h264_mf";
constexpr auto CreatePlatformEncoder = CreateMediaFoundationEncoder;
#endif

// Opening a throwaway session is the only reliable test (VMs and some machines have no usable encoder). Only a
// success is cached: a failure may be transient (media-service reset), so the next call tries again.
bool PlatformEncoderUsable() {
  static std::atomic<bool> usable{false};
  if (usable.load()) {
    return true;
  }
  constexpr H264Params kProbe{320, 240, 30, 1'000'000, 60};
  try {
    usable.store(CreatePlatformEncoder(kProbe, [](EncodedUnit&&) {}) != nullptr);
  } catch (const PipelineError&) {
    return false;
  }
  return usable.load();
}

}  // namespace
#endif

std::vector<std::string> H264EncoderNames() {
#if defined(__APPLE__) || defined(_WIN32)
  return PlatformEncoderUsable() ? std::vector<std::string>{kEncoderName} : std::vector<std::string>{};
#else
  return {};
#endif
}

std::unique_ptr<H264Encoder> CreateH264Encoder(const H264Params& params, const H264Encoder::Sink& sink) {
#if defined(__APPLE__) || defined(_WIN32)
  return CreatePlatformEncoder(params, sink);
#else
  (void)params;
  (void)sink;
  throw PipelineError{kEncoderUnavailableError, "No H.264 encoder is available on this platform"};
#endif
}

}  // namespace media_proxy
