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
bool Usable(Backend& backend, std::string* reason = nullptr) {
  if (backend.create == nullptr) {
    return false;
  }
  if (backend.usable.load()) {
    return true;
  }
  constexpr H264Params kProbe{320, 240, 30, 1'000'000, 60};
  try {
    backend.usable.store(backend.create(kProbe, [](EncodedUnit&&) {}) != nullptr);
  } catch (const PipelineError& err) {
    if (reason != nullptr) {
      *reason = std::string(backend.name) + ": " + err.message;
    }
    return false;
  }
  return backend.usable.load();
}

constexpr const char* kOverrideVariable = "MEDIA_PROXY_H264_ENCODER";

// The override restricts every lookup to one backend (diagnostics).
bool Selected(const Backend& backend) {
  const char* forced = std::getenv(kOverrideVariable);
  return backend.create != nullptr && (forced == nullptr || std::string(forced) == backend.name);
}

constexpr const char* kDocsUrl =
    "https://github.com/appium/appium-ios/tree/main/packages/media-proxy#software-h264-openh264";

PipelineError Unavailable(std::vector<std::string> reasons) {
  const char* forced = std::getenv(kOverrideVariable);
  if (forced != nullptr) {
    std::string known;
    for (const Backend& backend : g_backends) {
      known += backend.create == nullptr ? "" : (known.empty() ? "" : ", ") + std::string(backend.name);
    }
    reasons.insert(reasons.begin(), std::string(kOverrideVariable) + "='" + forced +
                                        "' restricts the choice to that encoder (known: " + known + ")");
  }
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

void RequireH264Encoder() {
  std::vector<std::string> reasons;
  for (Backend& backend : g_backends) {
    std::string reason;
    if (!Selected(backend)) {
      continue;
    }
    if (Usable(backend, &reason)) {
      return;
    }
    reasons.push_back(std::move(reason));
  }
  throw Unavailable(std::move(reasons));
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
