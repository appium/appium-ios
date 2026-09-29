#include "sim_video_stream.h"

#include <atomic>

#include "video_encoder.h"

namespace coresim {

class VideoStreamSession::Impl {
 public:
  Impl(id device, VideoEncoderOptions options, std::function<void(VideoAccessUnit)> onAccessUnit,
       std::function<void(NSError*)> onError, std::function<void()> onEnd, std::function<void()> onAbortDelivery)
      : options_(options), onAccessUnit_(std::move(onAccessUnit)), onAbortDelivery_(std::move(onAbortDelivery)) {
    encoder_ = std::make_unique<VideoFrameEncoder>(
        device, options, [this](CMSampleBufferRef sampleBuffer) { HandleEncodedSample(sampleBuffer); },
        std::move(onError), std::move(onEnd));
  }

  void Start() { encoder_->Start(); }
  void Stop() { encoder_->Stop(); }
  void AbortDelivery() {
    if (onAbortDelivery_) {
      onAbortDelivery_();
    }
  }
  void RequestKeyFrame() { encoder_->RequestKeyFrame(); }

 private:
  void HandleEncodedSample(CMSampleBufferRef sampleBuffer) {
    bool isKeyFrame = IsKeyFrame(sampleBuffer);
    // From the sample's own presentation timestamp (as submitted to the encoder), not a fresh
    // wall-clock read here — this callback can fire well after encoding actually happened, and
    // resampling "now" would report a later, jittery timestamp than when the frame was captured.
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    VideoAccessUnit unit;
    unit.isKeyFrame = isKeyFrame;
    unit.sequence = sequence_++;
    unit.timestampMicros = pts.timescale != 0 ? (pts.value * 1000000 / pts.timescale) : 0;
    RepackAsAnnexB(unit.data, sampleBuffer, isKeyFrame, options_.codec);
    if (onAccessUnit_) {
      onAccessUnit_(std::move(unit));
    }
  }

  VideoEncoderOptions options_;
  std::function<void(VideoAccessUnit)> onAccessUnit_;
  std::function<void()> onAbortDelivery_;
  std::unique_ptr<VideoFrameEncoder> encoder_;
  // VideoToolbox's output callback isn't documented as single-threaded, so this is read-modify-
  // written atomically rather than assuming HandleEncodedSample never runs concurrently.
  std::atomic<uint64_t> sequence_{0};
};

VideoStreamSession::VideoStreamSession(id device, VideoEncoderOptions options,
                                       std::function<void(VideoAccessUnit)> onAccessUnit,
                                       std::function<void(NSError*)> onError, std::function<void()> onEnd,
                                       std::function<void()> onAbortDelivery)
    : impl_(std::make_unique<Impl>(device, options, std::move(onAccessUnit), std::move(onError), std::move(onEnd),
                                   std::move(onAbortDelivery))) {}

VideoStreamSession::~VideoStreamSession() = default;

void VideoStreamSession::Start() { impl_->Start(); }

void VideoStreamSession::Stop() { impl_->Stop(); }

void VideoStreamSession::AbortDelivery() { impl_->AbortDelivery(); }

void VideoStreamSession::RequestKeyFrame() { impl_->RequestKeyFrame(); }

}  // namespace coresim
