#include "h264_encoder.h"

#include <array>
#include <atomic>
#include <cstdlib>
#include <string>
#include <vector>

#include "openh264_encoder.h"
#ifdef __APPLE__
#include "videotoolbox_encoder.h"
#elif defined(_WIN32)
#include "mediafoundation_encoder.h"
#endif

namespace media_proxy {

namespace {

using Factory = std::unique_ptr<H264Encoder> (*)(const H264Params&, const H264Encoder::Sink&);

struct Backend {
  const char* name;
  Factory create;
  std::atomic<bool> usable;
};

// Best first: platform hardware, then OpenH264 (only once its library has been installed).
std::array<Backend, 2> g_backends{{
#ifdef __APPLE__
    {"h264_videotoolbox", CreateVideoToolboxEncoder, false},
#elif defined(_WIN32)
    {"h264_mf", CreateMediaFoundationEncoder, false},
#else
    {"", nullptr, false},
#endif
    {"libopenh264", CreateOpenH264Encoder, false},
}};

// Opening a throwaway session is the only reliable test (VMs and some machines have no usable encoder). Only a
// success is cached: a failure may be transient (media-service reset), so the next call tries again.
bool Usable(Backend& backend) {
  if (backend.create == nullptr) {
    return false;
  }
  if (backend.usable.load()) {
    return true;
  }
  constexpr H264Params kProbe{320, 240, 30, 1'000'000, 60};
  try {
    backend.usable.store(backend.create(kProbe, [](EncodedUnit&&) {}) != nullptr);
  } catch (const PipelineError&) {
    return false;
  }
  return backend.usable.load();
}

// MEDIA_PROXY_H264_ENCODER restricts every lookup to one backend (diagnostics).
bool Selected(const Backend& backend) {
  const char* forced = std::getenv("MEDIA_PROXY_H264_ENCODER");
  return backend.create != nullptr && (forced == nullptr || std::string(forced) == backend.name);
}

constexpr const char* kDocsUrl =
    "https://github.com/appium/appium-ios/tree/main/packages/media-proxy#software-h264-openh264";

PipelineError Unavailable(const std::vector<std::string>& reasons) {
  std::string message = "No H.264 encoder is available";
  for (size_t i = 0; i < reasons.size(); ++i) {
    message += (i == 0 ? " (" : "; ") + reasons[i] + (i + 1 == reasons.size() ? ")" : "");
  }
  message += ". Use codec 'mjpeg', or install Cisco's OpenH264 and set MEDIA_PROXY_OPENH264_PATH to the library; see ";
  message += kDocsUrl;
  return {kEncoderUnavailableError, message};
}

}  // namespace

std::vector<std::string> H264EncoderNames() {
  std::vector<std::string> names;
  for (Backend& backend : g_backends) {
    if (Selected(backend) && Usable(backend)) {
      names.emplace_back(backend.name);
    }
  }
  return names;
}

PipelineError NoH264EncoderError() {
  constexpr H264Params kProbe{320, 240, 30, 1'000'000, 60};
  std::vector<std::string> reasons;
  for (const Backend& backend : g_backends) {
    if (!Selected(backend)) {
      continue;
    }
    try {
      backend.create(kProbe, [](EncodedUnit&&) {});
    } catch (const PipelineError& err) {
      reasons.push_back(std::string(backend.name) + ": " + err.message);
    }
  }
  return Unavailable(reasons);
}

std::unique_ptr<H264Encoder> CreateH264Encoder(const H264Params& params, const H264Encoder::Sink& sink) {
  std::vector<std::string> reasons;
  for (Backend& backend : g_backends) {
    if (!Selected(backend)) {
      continue;
    }
    try {
      return backend.create(params, sink);
    } catch (const PipelineError& err) {
      reasons.push_back(std::string(backend.name) + ": " + err.message);
    }
  }
  throw Unavailable(reasons);
}

}  // namespace media_proxy
