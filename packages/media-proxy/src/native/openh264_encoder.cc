#include "openh264_encoder.h"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <dlfcn.h>
#endif

#include "vendor/openh264/codec_api.h"
#include "vendor/openh264/codec_ver.h"

extern "C" {
#include <libavutil/frame.h>
}

namespace media_proxy {

namespace {

constexpr const char* kPathVariable = "MEDIA_PROXY_OPENH264_PATH";

using CreateFn = int (*)(ISVCEncoder**);
using DestroyFn = void (*)(ISVCEncoder*);
using VersionFn = void (*)(OpenH264Version*);

struct Library {
  CreateFn create = nullptr;
  DestroyFn destroy = nullptr;
};

std::mutex g_mutex;
Library g_library;  // loaded once, never unloaded: encoders may outlive any single caller

PipelineError Unavailable(const std::string& message) { return {kEncoderUnavailableError, message}; }

void* OpenLibrary(const std::string& path) {
#ifdef _WIN32
  const int length = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
  if (length <= 0) {
    return nullptr;
  }
  std::wstring wide(static_cast<size_t>(length), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wide.data(), length);
  return reinterpret_cast<void*>(LoadLibraryW(wide.c_str()));
#else
  return dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
#endif
}

void* Symbol(void* handle, const char* name) {
#ifdef _WIN32
  return reinterpret_cast<void*>(GetProcAddress(static_cast<HMODULE>(handle), name));
#else
  return dlsym(handle, name);
#endif
}

void CloseLibrary(void* handle) {
#ifdef _WIN32
  FreeLibrary(static_cast<HMODULE>(handle));
#else
  dlclose(handle);
#endif
}

// Same major.minor as the vendored headers: the C++ vtable layout is only stable within one.
Library Bind(void* handle, const std::string& path) {
  Library library;
  library.create = reinterpret_cast<CreateFn>(Symbol(handle, "WelsCreateSVCEncoder"));
  library.destroy = reinterpret_cast<DestroyFn>(Symbol(handle, "WelsDestroySVCEncoder"));
  const auto version = reinterpret_cast<VersionFn>(Symbol(handle, "WelsGetCodecVersionEx"));
  if (library.create == nullptr || library.destroy == nullptr || version == nullptr) {
    throw Unavailable(path + " is not an OpenH264 library");
  }
  OpenH264Version found{};
  version(&found);
  if (found.uMajor != OPENH264_MAJOR || found.uMinor != OPENH264_MINOR) {
    throw Unavailable("Unsupported OpenH264 " + std::to_string(found.uMajor) + "." + std::to_string(found.uMinor) +
                      " (expected " + std::to_string(OPENH264_MAJOR) + "." + std::to_string(OPENH264_MINOR) + ")");
  }
  return library;
}

// Loads the library named by $MEDIA_PROXY_OPENH264_PATH once; a rejected one is closed again.
Library LoadLibraryOnce() {
  const std::scoped_lock lock(g_mutex);
  if (g_library.create != nullptr) {
    return g_library;
  }
  const char* env = std::getenv(kPathVariable);
  if (env == nullptr || *env == '\0') {
    throw Unavailable(std::string("OpenH264 is not configured: set ") + kPathVariable + " to its library");
  }
  const std::string path = env;
  void* handle = OpenLibrary(path);
  if (handle == nullptr) {
    throw Unavailable("Could not load OpenH264 from " + path);
  }
  try {
    g_library = Bind(handle, path);
  } catch (...) {
    CloseLibrary(handle);  // keep nothing loaded (and no DLL locked) for a library we reject
    throw;
  }
  return g_library;
}

// OpenH264 only takes planar input, so the NV12 chroma is de-interleaved.
class OpenH264Encoder final : public H264Encoder {
 public:
  OpenH264Encoder(const H264Params& params, Sink sink)
      : width_(params.width), height_(params.height), sink_(std::move(sink)), library_(LoadLibraryOnce()) {
    if (library_.create(&encoder_) != 0 || encoder_ == nullptr) {
      throw Unavailable("OpenH264 could not create an encoder");
    }
    try {
      Open(params);
    } catch (...) {
      library_.destroy(encoder_);
      throw;
    }
  }

  ~OpenH264Encoder() override {
    encoder_->Uninitialize();
    library_.destroy(encoder_);
  }

  void Encode(const AVFrame& nv12, bool forceKeyFrame) override {
    if (forceKeyFrame) {
      encoder_->ForceIntraFrame(true);
    }
    SSourcePicture picture{};
    picture.iColorFormat = videoFormatI420;
    picture.iPicWidth = width_;
    picture.iPicHeight = height_;
    PackPlanes(nv12, picture);
    picture.uiTimeStamp = nv12.pts / kMicrosPerMilli;

    SFrameBSInfo info{};
    if (encoder_->EncodeFrame(&picture, &info) != cmResultSuccess) {
      throw PipelineError{"MediaProxyError", "OpenH264 failed to encode a frame"};
    }
    if (info.eFrameType == videoFrameTypeSkip || info.eFrameType == videoFrameTypeInvalid) {
      return;
    }
    EncodedUnit unit;
    unit.isKeyFrame = info.eFrameType == videoFrameTypeIDR;
    unit.timestampMicros = nv12.pts;
    for (int layer = 0; layer < info.iLayerNum; ++layer) {
      const SLayerBSInfo& bs = info.sLayerInfo[layer];
      size_t size = 0;
      for (int nal = 0; nal < bs.iNalCount; ++nal) {
        size += static_cast<size_t>(bs.pNalLengthInByte[nal]);
      }
      unit.data.insert(unit.data.end(), bs.pBsBuf, bs.pBsBuf + size);
    }
    if (!unit.data.empty()) {
      sink_(std::move(unit));
    }
  }

  void Flush() override {}  // synchronous: nothing is held back

 private:
  static constexpr int64_t kMicrosPerMilli = 1000;
  static constexpr int kMaxThreads = 4;

  // One slice per worker thread: OpenH264 can only parallelise across slices.
  static int SliceThreads() {
    return static_cast<int>(
        std::clamp(std::thread::hardware_concurrency(), 1U, static_cast<unsigned int>(kMaxThreads)));
  }

  void Open(const H264Params& params) {
    int logLevel = WELS_LOG_QUIET;
    encoder_->SetOption(ENCODER_OPTION_TRACE_LEVEL, &logLevel);
    SEncParamExt ext{};
    if (encoder_->GetDefaultParams(&ext) != cmResultSuccess) {
      throw Unavailable("OpenH264 rejected its default parameters");
    }
    const int bitrate = static_cast<int>(std::min<int64_t>(params.bitrate, std::numeric_limits<int>::max()));
    ext.iUsageType = SCREEN_CONTENT_REAL_TIME;
    ext.iPicWidth = width_;
    ext.iPicHeight = height_;
    ext.iTargetBitrate = bitrate;
    ext.iMaxBitrate = bitrate;
    ext.iRCMode = RC_BITRATE_MODE;
    ext.fMaxFrameRate = static_cast<float>(params.fps);
    ext.uiIntraPeriod = static_cast<unsigned int>(params.gopFrames);
    ext.iTemporalLayerNum = 1;
    ext.iSpatialLayerNum = 1;
    ext.iComplexityMode = LOW_COMPLEXITY;
    ext.eSpsPpsIdStrategy = CONSTANT_ID;
    ext.bEnableFrameSkip = false;
    ext.bEnableDenoise = false;
    const int threads = SliceThreads();
    ext.iMultipleThreadIdc = static_cast<unsigned short>(threads);
    SSpatialLayerConfig& layer = ext.sSpatialLayers[0];
    layer.iVideoWidth = width_;
    layer.iVideoHeight = height_;
    layer.fFrameRate = static_cast<float>(params.fps);
    layer.iSpatialBitrate = bitrate;
    layer.iMaxSpatialBitrate = bitrate;
    layer.sSliceArgument.uiSliceMode = threads > 1 ? SM_FIXEDSLCNUM_SLICE : SM_SINGLE_SLICE;
    layer.sSliceArgument.uiSliceNum = static_cast<unsigned int>(threads);
    if (encoder_->InitializeExt(&ext) != cmResultSuccess) {
      throw Unavailable("OpenH264 rejected the encoder parameters");
    }
  }

  void PackPlanes(const AVFrame& nv12, SSourcePicture& picture) {
    const size_t chromaWidth = (static_cast<size_t>(width_) + 1) / 2;
    const size_t chromaHeight = (static_cast<size_t>(height_) + 1) / 2;
    planes_.resize(chromaWidth * chromaHeight * 2);
    uint8_t* u = planes_.data();
    uint8_t* v = u + (chromaWidth * chromaHeight);
    for (size_t row = 0; row < chromaHeight; ++row) {
      const uint8_t* src = nv12.data[1] + (row * static_cast<size_t>(nv12.linesize[1]));
      uint8_t* dstU = u + (row * chromaWidth);
      uint8_t* dstV = v + (row * chromaWidth);
      for (size_t col = 0; col < chromaWidth; ++col) {
        dstU[col] = src[col * 2];
        dstV[col] = src[(col * 2) + 1];
      }
    }
    picture.pData[0] = nv12.data[0];
    picture.pData[1] = u;
    picture.pData[2] = v;
    picture.iStride[0] = nv12.linesize[0];
    picture.iStride[1] = static_cast<int>(chromaWidth);
    picture.iStride[2] = static_cast<int>(chromaWidth);
  }

  int width_;
  int height_;
  Sink sink_;
  Library library_;
  ISVCEncoder* encoder_ = nullptr;
  std::vector<uint8_t> planes_;
};

}  // namespace

std::unique_ptr<H264Encoder> CreateOpenH264Encoder(const H264Params& params, const H264Encoder::Sink& sink) {
  return std::make_unique<OpenH264Encoder>(params, sink);
}

}  // namespace media_proxy
