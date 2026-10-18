#include "mediafoundation_encoder.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
// clang-format off
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <codecapi.h>
#include <wrl/client.h>
// clang-format on

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <utility>

extern "C" {
#include <libavutil/frame.h>
#include <libavutil/log.h>
}

namespace media_proxy {

namespace {

using Microsoft::WRL::ComPtr;

constexpr int64_t kHundredNanosPerMicro = 10;
constexpr int64_t kHundredNanosPerSecond = 10'000'000;
constexpr double kRateScale = 1000;
constexpr size_t kLongStartCode = 4;
constexpr size_t kShortStartCode = 3;
constexpr uint8_t kNalTypeMask = 0x1f;
constexpr uint8_t kNalIdr = 5;
constexpr uint8_t kNalSps = 7;
constexpr uint8_t kNalPps = 8;
constexpr uint8_t kNalAud = 9;
constexpr size_t kHexDigits = 8;

PipelineError Failure(const char* what, HRESULT hr) {
  std::array<char, kHexDigits + 1> code{};
  std::snprintf(code.data(), code.size(), "%08lX", static_cast<unsigned long>(hr));
  return {"MediaProxyError", std::string("Media Foundation ") + what + " failed (HRESULT 0x" + code.data() + ")"};
}

void Check(HRESULT hr, const char* what) {
  if (FAILED(hr)) {
    throw Failure(what, hr);
  }
}

// COM is initialised per call: the encoder is created and destroyed on whichever thread the pipeline runs on.
class ComScope {
 public:
  ComScope() : initialized_(SUCCEEDED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {}
  ~ComScope() {
    if (initialized_) {
      CoUninitialize();
    }
  }
  ComScope(const ComScope&) = delete;
  ComScope& operator=(const ComScope&) = delete;

 private:
  bool initialized_;
};

struct NalRange {
  const uint8_t* data;
  size_t size;
};

// Splits an Annex-B stream (3- or 4-byte start codes) into NAL units without their start codes.
std::vector<NalRange> SplitNals(const uint8_t* bytes, size_t size) {
  std::vector<std::pair<size_t, size_t>> starts;  // payload offset, start code length
  for (size_t i = 0; i + kShortStartCode <= size;) {
    if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1) {
      const bool longCode = i > 0 && bytes[i - 1] == 0;
      starts.emplace_back(i + kShortStartCode, longCode ? kLongStartCode : kShortStartCode);
      i += kShortStartCode;
    } else {
      ++i;
    }
  }
  std::vector<NalRange> nals;
  for (size_t n = 0; n < starts.size(); ++n) {
    const size_t begin = starts[n].first;
    size_t end = size;
    if (n + 1 < starts.size()) {
      end = starts[n + 1].first - starts[n + 1].second;
    }
    if (end > begin) {
      nals.push_back({bytes + begin, end - begin});
    }
  }
  return nals;
}

void AppendNal(std::vector<uint8_t>& out, const NalRange& nal) {
  out.insert(out.end(), kAnnexBStartCode.begin(), kAnnexBStartCode.end());
  out.insert(out.end(), nal.data, nal.data + nal.size);
}

VARIANT UInt32Variant(ULONG value) {
  VARIANT var;
  VariantInit(&var);
  var.vt = VT_UI4;
  var.ulVal = value;
  return var;
}

VARIANT BoolVariant(bool value) {
  VARIANT var;
  VariantInit(&var);
  var.vt = VT_BOOL;
  var.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  return var;
}

class MediaFoundationEncoder final : public H264Encoder {
 public:
  MediaFoundationEncoder(const H264Params& params, H264Encoder::Sink sink) : params_(params), sink_(std::move(sink)) {
    const HRESULT started = MFStartup(MF_VERSION, MFSTARTUP_LITE);
    if (FAILED(started)) {
      throw PipelineError{kEncoderUnavailableError, Failure("startup", started).message};
    }
    try {
      const ComScope com;
      Open();
    } catch (...) {
      Release();
      throw;
    }
  }

  ~MediaFoundationEncoder() override { Release(); }
  MediaFoundationEncoder(const MediaFoundationEncoder&) = delete;
  MediaFoundationEncoder& operator=(const MediaFoundationEncoder&) = delete;

  void Encode(const AVFrame& nv12, bool forceKeyFrame) override {
    const ComScope com;
    if (forceKeyFrame) {
      const VARIANT on = UInt32Variant(1);
      Check(codecApi_->SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &on), "forcing a key frame");
    }
    // The MFT needs increasing timestamps even if the source timeline jumped back.
    lastPts_ = std::max(nv12.pts, lastPts_ + 1);
    const ComPtr<IMFSample> sample = MakeSample(nv12, lastPts_);
    HRESULT hr = transform_->ProcessInput(0, sample.Get(), 0);
    if (hr == MF_E_NOTACCEPTING) {
      PullOutput();
      hr = transform_->ProcessInput(0, sample.Get(), 0);
    }
    Check(hr, "input");
    PullOutput();
  }

  void Flush() override {
    const ComScope com;
    Check(transform_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0), "drain");
    PullOutput();
  }

 private:
  void Open() {
    ComPtr<IMFTransform> transform = CreateTransform();
    transform_ = transform;
    Check(transform_.As(&codecApi_), "ICodecAPI");
    Configure();
    SetTypes();
    Check(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "begin streaming");
    Check(transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "start of stream");
    MFT_OUTPUT_STREAM_INFO info{};
    Check(transform_->GetOutputStreamInfo(0, &info), "output stream info");
    providesSamples_ =
        (info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES)) != 0;
    outputSize_ = info.cbSize;
    ReadSequenceHeader();
  }

  // Hardware MFTs are asynchronous (event driven) and left to the vendor encoders; this takes the first synchronous
  // one.
  static ComPtr<IMFTransform> CreateTransform() {
    const MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
    const MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate** activates = nullptr;
    UINT32 count = 0;
    const HRESULT enumerated =
        MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER, &input, &output,
                  &activates, &count);
    if (FAILED(enumerated) || count == 0) {
      throw PipelineError{kEncoderUnavailableError, "No Media Foundation H.264 encoder is installed"};
    }
    ComPtr<IMFTransform> transform;
    for (UINT32 i = 0; i < count && !transform; ++i) {
      activates[i]->ActivateObject(IID_PPV_ARGS(&transform));
    }
    for (UINT32 i = 0; i < count; ++i) {
      activates[i]->Release();
    }
    CoTaskMemFree(activates);
    if (!transform) {
      throw PipelineError{kEncoderUnavailableError, "No Media Foundation H.264 encoder could be created"};
    }
    return transform;
  }

  // Settings that shape the promised output must be accepted; the rest are tuning (rejections are logged).
  void Configure() {
    const auto set = [&](const GUID& key, const char* name, VARIANT value, bool required) {
      const HRESULT hr = codecApi_->SetValue(&key, &value);
      if (SUCCEEDED(hr)) {
        return;
      }
      if (required) {
        throw PipelineError{kEncoderUnavailableError, Failure((std::string("setting ") + name).c_str(), hr).message};
      }
      av_log(nullptr, AV_LOG_WARNING, "Media Foundation rejected %s (HRESULT 0x%lx)\n", name,
             static_cast<unsigned long>(hr));
    };
    set(CODECAPI_AVEncCommonLowLatency, "AVEncCommonLowLatency", BoolVariant(true), false);
    set(CODECAPI_AVEncCommonRealTime, "AVEncCommonRealTime", BoolVariant(true), false);
    set(CODECAPI_AVEncCommonRateControlMode, "AVEncCommonRateControlMode",
        UInt32Variant(eAVEncCommonRateControlMode_CBR), false);
    set(CODECAPI_AVEncMPVDefaultBPictureCount, "AVEncMPVDefaultBPictureCount", UInt32Variant(0), true);
    set(CODECAPI_AVEncCommonMeanBitRate, "AVEncCommonMeanBitRate",
        UInt32Variant(static_cast<ULONG>(std::min<int64_t>(params_.bitrate, UINT32_MAX))), true);
    set(CODECAPI_AVEncMPVGOPSize, "AVEncMPVGOPSize", UInt32Variant(static_cast<ULONG>(params_.gopFrames)), true);
  }

  ComPtr<IMFMediaType> MakeType(const GUID& subtype) const {
    ComPtr<IMFMediaType> type;
    Check(MFCreateMediaType(&type), "media type");
    type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video);
    type->SetGUID(MF_MT_SUBTYPE, subtype);
    MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, static_cast<UINT32>(params_.width),
                       static_cast<UINT32>(params_.height));
    MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, static_cast<UINT32>(std::lround(params_.fps * kRateScale)),
                        static_cast<UINT32>(kRateScale));
    MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
    type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709);
    type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709);
    type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709);
    type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235);
    return type;
  }

  void SetTypes() {
    const ComPtr<IMFMediaType> output = MakeType(MFVideoFormat_H264);
    output->SetUINT32(MF_MT_AVG_BITRATE, static_cast<UINT32>(std::min<int64_t>(params_.bitrate, UINT32_MAX)));
    output->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
    Check(transform_->SetOutputType(0, output.Get(), 0), "output type");
    const ComPtr<IMFMediaType> input = MakeType(MFVideoFormat_NV12);
    Check(transform_->SetInputType(0, input.Get(), 0), "input type");
  }

  // SPS/PPS from the negotiated output type, for key frames the MFT emits without them.
  void ReadSequenceHeader() {
    ComPtr<IMFMediaType> type;
    if (FAILED(transform_->GetOutputCurrentType(0, &type))) {
      return;
    }
    UINT32 size = 0;
    if (FAILED(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size)) || size == 0) {
      return;
    }
    std::vector<uint8_t> blob(size);
    if (FAILED(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, blob.data(), size, nullptr))) {
      return;
    }
    for (const NalRange& nal : SplitNals(blob.data(), blob.size())) {
      const uint8_t type = nal.data[0] & kNalTypeMask;
      if (type == kNalSps || type == kNalPps) {
        AppendNal(sequenceHeader_, nal);
      }
    }
  }

  ComPtr<IMFSample> MakeSample(const AVFrame& nv12, int64_t pts) const {
    const auto width = static_cast<size_t>(params_.width);
    const auto height = static_cast<size_t>(params_.height);
    const size_t lumaSize = width * height;
    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(static_cast<DWORD>(lumaSize + (lumaSize / 2)), &buffer), "input buffer");
    BYTE* dst = nullptr;
    Check(buffer->Lock(&dst, nullptr, nullptr), "input buffer lock");
    for (size_t row = 0; row < height; ++row) {
      std::memcpy(dst + (row * width), nv12.data[0] + (row * static_cast<size_t>(nv12.linesize[0])), width);
    }
    for (size_t row = 0; row < height / 2; ++row) {
      std::memcpy(dst + lumaSize + (row * width), nv12.data[1] + (row * static_cast<size_t>(nv12.linesize[1])), width);
    }
    buffer->Unlock();
    Check(buffer->SetCurrentLength(static_cast<DWORD>(lumaSize + (lumaSize / 2))), "input buffer length");
    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "input sample");
    Check(sample->AddBuffer(buffer.Get()), "input sample buffer");
    Check(sample->SetSampleTime(pts * kHundredNanosPerMicro), "sample time");
    Check(sample->SetSampleDuration(static_cast<LONGLONG>(static_cast<double>(kHundredNanosPerSecond) / params_.fps)),
          "sample duration");
    return sample;
  }

  // Collects every unit the MFT has ready; "needs more input" ends the loop.
  void PullOutput() {
    for (;;) {
      MFT_OUTPUT_DATA_BUFFER out{};
      if (!providesSamples_) {
        EnsureOutputSample();
        out.pSample = outputSample_.Get();
      }
      DWORD status = 0;
      const HRESULT hr = transform_->ProcessOutput(0, 1, &out, &status);
      if (out.pEvents != nullptr) {
        out.pEvents->Release();
      }
      ComPtr<IMFSample> provided;
      if (providesSamples_) {
        provided.Attach(out.pSample);
      }
      if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
        return;
      }
      if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
        ComPtr<IMFMediaType> type;
        Check(transform_->GetOutputAvailableType(0, 0, &type), "output type renegotiation");
        Check(transform_->SetOutputType(0, type.Get(), 0), "output type renegotiation");
        ReadSequenceHeader();
        continue;
      }
      Check(hr, "output");
      Deliver(providesSamples_ ? provided.Get() : outputSample_.Get());
    }
  }

  void EnsureOutputSample() {
    if (outputSample_) {
      outputSample_->GetBufferByIndex(0, &outputBuffer_);
      outputBuffer_->SetCurrentLength(0);
      return;
    }
    Check(MFCreateSample(&outputSample_), "output sample");
    Check(MFCreateMemoryBuffer(std::max<DWORD>(outputSize_, 1), &outputBuffer_), "output buffer");
    Check(outputSample_->AddBuffer(outputBuffer_.Get()), "output sample buffer");
  }

  void Deliver(IMFSample* sample) {
    ComPtr<IMFMediaBuffer> contiguous;
    Check(sample->ConvertToContiguousBuffer(&contiguous), "output buffer");
    BYTE* bytes = nullptr;
    DWORD length = 0;
    Check(contiguous->Lock(&bytes, nullptr, &length), "output buffer lock");
    EncodedUnit unit;
    try {
      unit.data = ToAnnexB(bytes, length, unit.isKeyFrame);
    } catch (...) {
      contiguous->Unlock();
      throw;
    }
    contiguous->Unlock();
    LONGLONG time = 0;
    unit.timestampMicros = SUCCEEDED(sample->GetSampleTime(&time)) ? time / kHundredNanosPerMicro : lastPts_;
    sink_(std::move(unit));
  }

  // Normalises to 4-byte start codes without access unit delimiters, with SPS/PPS ahead of every IDR.
  std::vector<uint8_t> ToAnnexB(const uint8_t* bytes, size_t size, bool& isKeyFrame) const {
    const std::vector<NalRange> nals = SplitNals(bytes, size);
    if (nals.empty()) {
      throw PipelineError{"MediaProxyError", "Media Foundation produced a sample without NAL units"};
    }
    bool hasSps = false;
    for (const NalRange& nal : nals) {
      const uint8_t type = nal.data[0] & kNalTypeMask;
      isKeyFrame = isKeyFrame || type == kNalIdr;
      hasSps = hasSps || type == kNalSps;
    }
    std::vector<uint8_t> out;
    out.reserve(size + sequenceHeader_.size() + kLongStartCode);
    if (isKeyFrame && !hasSps) {
      out = sequenceHeader_;
    }
    for (const NalRange& nal : nals) {
      if ((nal.data[0] & kNalTypeMask) != kNalAud) {
        AppendNal(out, nal);
      }
    }
    return out;
  }

  void Release() {
    {
      const ComScope com;
      outputBuffer_.Reset();
      outputSample_.Reset();
      codecApi_.Reset();
      if (transform_) {
        transform_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
      }
      transform_.Reset();
    }
    MFShutdown();
  }

  H264Params params_;
  H264Encoder::Sink sink_;
  ComPtr<IMFTransform> transform_;
  ComPtr<ICodecAPI> codecApi_;
  ComPtr<IMFSample> outputSample_;
  ComPtr<IMFMediaBuffer> outputBuffer_;
  std::vector<uint8_t> sequenceHeader_;
  DWORD outputSize_ = 0;
  bool providesSamples_ = false;
  int64_t lastPts_ = -1;
};

}  // namespace

std::unique_ptr<H264Encoder> CreateMediaFoundationEncoder(const H264Params& params, const H264Encoder::Sink& sink) {
  return std::make_unique<MediaFoundationEncoder>(params, sink);
}

}  // namespace media_proxy
