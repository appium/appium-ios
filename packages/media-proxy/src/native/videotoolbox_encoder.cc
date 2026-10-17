#include "videotoolbox_encoder.h"

#include <CoreFoundation/CoreFoundation.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <mutex>
#include <string>
#include <type_traits>
#include <utility>

extern "C" {
#include <libavutil/frame.h>
}

namespace media_proxy {

namespace {

constexpr const char* kUnavailable = "MediaProxyEncoderUnavailableError";
constexpr std::array<uint8_t, 4> kStartCode = {0, 0, 0, 1};
constexpr int32_t kMicrosTimescale = 1000000;
constexpr size_t kMinNalLengthSize = 1;
constexpr size_t kMaxNalLengthSize = 4;
constexpr size_t kByteBits = 8;
constexpr Boolean kNo = 0;

struct CfDeleter {
  void operator()(CFTypeRef ref) const { CFRelease(ref); }
};
template <typename T>
using Cf = std::unique_ptr<std::remove_pointer_t<T>, CfDeleter>;

PipelineError Failure(const char* what, OSStatus status) {
  return {"MediaProxyError", std::string("VideoToolbox ") + what + " failed (OSStatus " + std::to_string(status) + ")"};
}

Cf<CFNumberRef> Number(int32_t value) { return Cf<CFNumberRef>(CFNumberCreate(nullptr, kCFNumberSInt32Type, &value)); }

Cf<CFNumberRef> Number(double value) { return Cf<CFNumberRef>(CFNumberCreate(nullptr, kCFNumberDoubleType, &value)); }

Cf<CFDictionaryRef> Dictionary(const void* key, const void* value) {
  return Cf<CFDictionaryRef>(
      CFDictionaryCreate(nullptr, &key, &value, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks));
}

bool IsKeyFrame(CMSampleBufferRef sample) {
  CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, kNo);
  if (attachments == nullptr || CFArrayGetCount(attachments) == 0) {
    return true;
  }
  const auto* first = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(attachments, 0));
  const void* notSync = CFDictionaryGetValue(first, kCMSampleAttachmentKey_NotSync);
  return notSync == nullptr || CFBooleanGetValue(static_cast<CFBooleanRef>(notSync)) == 0U;
}

void AppendNal(std::vector<uint8_t>& out, const uint8_t* data, size_t size) {
  out.insert(out.end(), kStartCode.begin(), kStartCode.end());
  out.insert(out.end(), data, data + size);
}

class VideoToolboxEncoder final : public H264Encoder {
 public:
  VideoToolboxEncoder(const H264Params& params, H264Encoder::Sink sink) : params_(params), sink_(std::move(sink)) {
    const Cf<CFDictionaryRef> spec =
        Dictionary(kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder, kCFBooleanTrue);
    const Cf<CFDictionaryRef> pixelAttributes =
        Dictionary(kCVPixelBufferPixelFormatTypeKey, Number(static_cast<int32_t>(kPixelFormat)).get());
    VTCompressionSessionRef session = nullptr;
    const OSStatus status =
        VTCompressionSessionCreate(nullptr, params.width, params.height, kCMVideoCodecType_H264, spec.get(),
                                   pixelAttributes.get(), nullptr, &OnOutput, this, &session);
    if (status != noErr || session == nullptr) {
      throw PipelineError{kUnavailable, Failure("session creation", status).message};
    }
    session_.reset(session);
    Configure();
    if (const OSStatus prepared = VTCompressionSessionPrepareToEncodeFrames(session_.get()); prepared != noErr) {
      Invalidate();
      throw PipelineError{kUnavailable, Failure("prepare", prepared).message};
    }
  }

  ~VideoToolboxEncoder() override { Invalidate(); }
  VideoToolboxEncoder(const VideoToolboxEncoder&) = delete;
  VideoToolboxEncoder& operator=(const VideoToolboxEncoder&) = delete;

  void Encode(const AVFrame& nv12, bool forceKeyFrame) override {
    CVPixelBufferRef raw = nullptr;
    if (const CVReturn created =
            CVPixelBufferCreate(nullptr, params_.width, params_.height, kPixelFormat, nullptr, &raw);
        created != kCVReturnSuccess) {
      throw Failure("pixel buffer allocation", created);
    }
    const Cf<CVPixelBufferRef> buffer(raw);
    CopyPlanes(nv12, raw);

    const CMTime pts = CMTimeMake(nv12.pts, kMicrosTimescale);
    Cf<CFDictionaryRef> properties;
    if (forceKeyFrame) {
      properties = Dictionary(kVTEncodeFrameOptionKey_ForceKeyFrame, kCFBooleanTrue);
    }
    if (const OSStatus status = VTCompressionSessionEncodeFrame(session_.get(), raw, pts, kCMTimeInvalid,
                                                                properties.get(), nullptr, nullptr);
        status != noErr) {
      throw Failure("encode", status);
    }
    // Waits for this frame (no reordering): output leaves in the same call instead of one frame later.
    if (const OSStatus status = VTCompressionSessionCompleteFrames(session_.get(), pts); status != noErr) {
      throw Failure("complete", status);
    }
    Deliver();
  }

  void Flush() override {
    if (const OSStatus status = VTCompressionSessionCompleteFrames(session_.get(), kCMTimeInvalid); status != noErr) {
      throw Failure("flush", status);
    }
    Deliver();
  }

 private:
  static constexpr OSType kPixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;

  struct SessionDeleter {
    void operator()(VTCompressionSessionRef session) const { CFRelease(session); }
  };

  void Configure() {
    const auto set = [&](CFStringRef key, CFTypeRef value) {
      // Optional tuning: a property this macOS version rejects must not stop the stream.
      VTSessionSetProperty(session_.get(), key, value);
    };
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel);
    set(kVTCompressionPropertyKey_AverageBitRate, Number(static_cast<int32_t>(params_.bitrate)).get());
    set(kVTCompressionPropertyKey_ExpectedFrameRate, Number(params_.fps).get());
    set(kVTCompressionPropertyKey_MaxKeyFrameInterval, Number(static_cast<int32_t>(params_.gopFrames)).get());
    set(kVTCompressionPropertyKey_ColorPrimaries, kCMFormatDescriptionColorPrimaries_ITU_R_709_2);
    set(kVTCompressionPropertyKey_TransferFunction, kCMFormatDescriptionTransferFunction_ITU_R_709_2);
    set(kVTCompressionPropertyKey_YCbCrMatrix, kCMFormatDescriptionYCbCrMatrix_ITU_R_709_2);
  }

  void Invalidate() {
    if (session_) {
      VTCompressionSessionInvalidate(session_.get());
      session_.reset();
    }
  }

  static void CopyPlanes(const AVFrame& nv12, CVPixelBufferRef buffer) {
    CVPixelBufferLockBaseAddress(buffer, 0);
    for (size_t plane = 0; plane < 2; ++plane) {
      auto* dst = static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(buffer, plane));
      const size_t dstStride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
      const size_t rows = CVPixelBufferGetHeightOfPlane(buffer, plane);
      const auto srcStride = static_cast<size_t>(nv12.linesize[plane]);
      const size_t rowBytes = std::min(srcStride, dstStride);
      for (size_t row = 0; row < rows; ++row) {
        std::memcpy(dst + (row * dstStride), nv12.data[plane] + (row * srcStride), rowBytes);
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
  }

  // Runs on a VideoToolbox thread; the encoding thread is blocked in CompleteFrames until it returns.
  static void OnOutput(void* self, void* /*frameRefCon*/, OSStatus status, VTEncodeInfoFlags flags,
                       CMSampleBufferRef sample) {
    static_cast<VideoToolboxEncoder*>(self)->Collect(status, flags, sample);
  }

  void Collect(OSStatus status, VTEncodeInfoFlags flags, CMSampleBufferRef sample) {
    const std::scoped_lock<std::mutex> lock(mutex_);
    if (status != noErr) {
      failure_ = status;
      return;
    }
    if (sample == nullptr || (flags & kVTEncodeInfo_FrameDropped) != 0U || CMSampleBufferDataIsReady(sample) == 0U) {
      return;
    }
    try {
      pending_.push_back(ToAnnexB(sample));
    } catch (const PipelineError&) {
      failure_ = kCMSampleBufferError_InvalidMediaFormat;
    }
  }

  // AVCC (length-prefixed) to Annex-B with 4-byte start codes; SPS/PPS are prepended on key frames.
  static EncodedUnit ToAnnexB(CMSampleBufferRef sample) {
    EncodedUnit unit;
    unit.isKeyFrame = IsKeyFrame(sample);
    unit.timestampMicros = CMTimeConvertScale(CMSampleBufferGetPresentationTimeStamp(sample), kMicrosTimescale,
                                              kCMTimeRoundingMethod_Default)
                               .value;
    CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sample);
    size_t parameterSets = 0;
    int lengthSize = 0;
    const uint8_t* first = nullptr;
    size_t firstSize = 0;
    if (format == nullptr ||
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, &first, &firstSize, &parameterSets,
                                                           &lengthSize) != noErr ||
        lengthSize < static_cast<int>(kMinNalLengthSize) || lengthSize > static_cast<int>(kMaxNalLengthSize)) {
      throw PipelineError{"MediaProxyError", "VideoToolbox produced a sample without H.264 parameter sets"};
    }
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    size_t total = 0;
    size_t contiguous = 0;
    char* data = nullptr;
    if (block == nullptr || CMBlockBufferGetDataPointer(block, 0, &contiguous, &total, &data) != noErr ||
        contiguous != total) {
      throw PipelineError{"MediaProxyError", "VideoToolbox produced a fragmented sample"};
    }
    unit.data.reserve(total + 128);
    if (unit.isKeyFrame) {
      for (size_t i = 0; i < parameterSets; ++i) {
        const uint8_t* set = nullptr;
        size_t size = 0;
        if (CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, i, &set, &size, nullptr, nullptr) == noErr) {
          AppendNal(unit.data, set, size);
        }
      }
    }
    const auto* bytes = reinterpret_cast<const uint8_t*>(data);
    const auto prefix = static_cast<size_t>(lengthSize);
    for (size_t offset = 0; offset + prefix <= total;) {
      size_t length = 0;
      for (size_t i = 0; i < prefix; ++i) {
        length = (length << kByteBits) | bytes[offset + i];
      }
      offset += prefix;
      if (length > total - offset) {
        throw PipelineError{"MediaProxyError", "VideoToolbox produced a malformed sample"};
      }
      AppendNal(unit.data, bytes + offset, length);
      offset += length;
    }
    return unit;
  }

  void Deliver() {
    std::vector<EncodedUnit> units;
    OSStatus failure = noErr;
    {
      const std::scoped_lock<std::mutex> lock(mutex_);
      units.swap(pending_);
      failure = std::exchange(failure_, noErr);
    }
    for (EncodedUnit& unit : units) {
      sink_(std::move(unit));
    }
    if (failure != noErr) {
      throw Failure("output", failure);
    }
  }

  H264Params params_;
  H264Encoder::Sink sink_;
  std::mutex mutex_;
  std::vector<EncodedUnit> pending_;
  OSStatus failure_ = noErr;
  std::unique_ptr<std::remove_pointer_t<VTCompressionSessionRef>, SessionDeleter> session_;
};

}  // namespace

std::unique_ptr<H264Encoder> CreateVideoToolboxEncoder(const H264Params& params, const H264Encoder::Sink& sink) {
  return std::make_unique<VideoToolboxEncoder>(params, sink);
}

}  // namespace media_proxy
