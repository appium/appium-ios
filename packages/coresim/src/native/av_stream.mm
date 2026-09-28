#include "av_stream.h"

#include <atomic>
#include <mutex>

#include "audio_encoder.h"
#include "monotonic_clock.h"
#include "sim_audio_tap.h"

namespace coresim {

class AVStreamSession::Impl {
 public:
  Impl(id device, NSString* udid, VideoEncoderOptions videoOptions, std::function<void(AVAccessUnit)> onAccessUnit,
       std::function<void(NSError*)> onError, std::function<void()> onEnd, std::function<void()> onAbortDelivery)
      : device_(device),
        udid_(udid),
        videoOptions_(videoOptions),
        onAccessUnit_(std::move(onAccessUnit)),
        onError_(std::move(onError)),
        onEnd_(std::move(onEnd)),
        onAbortDelivery_(std::move(onAbortDelivery)) {}

  ~Impl() { StopInternal(); }

  void Start() {
    clockOrigin_ = MonotonicSeconds();
    running_ = true;
    try {
      audioTap_ = std::make_unique<AudioTapSession>(
          udid_, [this](const AudioBufferList* data, const AudioTimeStamp* time) { HandleAudioPCM(data, time); },
          [this](NSError* error) {
            // A failed process-list refresh (kAudioTapNonFatalProcessListRefreshErrorCode) isn't
            // fatal — the tap keeps running. Everything else is.
            if ([error.domain isEqualToString:kAudioTapErrorDomain] &&
                error.code == kAudioTapNonFatalProcessListRefreshErrorCode) {
              return;
            }
            Fail(error, /*fromVideo=*/false);
          },
          [] {});
      audioTap_->Start();

      // Start() can invoke HandleAudioPCM before returning, so audioEncoder_ is written under
      // audioEncoderMutex_ (same lock HandleAudioPCM reads it under) to avoid a torn/racy read.
      auto encoder = std::make_unique<AudioEncoder>(
          audioTap_->Format(), [this](CMSampleBufferRef sampleBuffer) { HandleAudioSample(sampleBuffer); },
          &clockOrigin_);
      {
        std::lock_guard<std::mutex> lock(audioEncoderMutex_);
        audioEncoder_ = std::move(encoder);
      }

      videoEncoder_ = std::make_unique<VideoFrameEncoder>(
          device_, videoOptions_, [this](CMSampleBufferRef sampleBuffer) { HandleVideoSample(sampleBuffer); },
          [this](NSError* error) { Fail(error, /*fromVideo=*/true); }, [] {}, &clockOrigin_);
      videoEncoder_->Start();
    } catch (...) {
      running_ = false;
      StopInternal();
      throw;
    }
  }

  void Stop() { StopInternal(); }

  void AbortDelivery() {
    if (onAbortDelivery_) {
      onAbortDelivery_();
    }
  }

  void RequestKeyFrame() {
    if (videoEncoder_) {
      videoEncoder_->RequestKeyFrame();
    }
  }

 private:
  // Runs on AudioTapSession's own queue; audioEncoder_ is guarded by audioEncoderMutex_ (see
  // Start()). A throw from EncodePCM is left to propagate — AudioTapSession::HandleBuffer catches
  // it and self-stops (see sim_audio_tap.h's onBuffer doc) — never call audioTap_->Stop() here.
  void HandleAudioPCM(const AudioBufferList* data, const AudioTimeStamp* time) {
    AudioEncoder* encoder;
    {
      std::lock_guard<std::mutex> lock(audioEncoderMutex_);
      if (!running_) {
        return;
      }
      encoder = audioEncoder_.get();
    }
    if (encoder != nullptr) {
      encoder->EncodePCM(data, time);
    }
  }

  void HandleVideoSample(CMSampleBufferRef sampleBuffer) {
    if (!running_) {
      return;
    }
    bool isKeyFrame = IsKeyFrame(sampleBuffer);
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    AVAccessUnit unit;
    unit.track = AVTrack::kVideo;
    unit.isKeyFrame = isKeyFrame;
    unit.sequence = videoSequence_++;
    unit.timestampMicros = pts.timescale != 0 ? (pts.value * 1000000 / pts.timescale) : 0;
    RepackAsAnnexB(unit.data, sampleBuffer, isKeyFrame, videoOptions_.codec);
    if (onAccessUnit_) {
      onAccessUnit_(std::move(unit));
    }
  }

  void HandleAudioSample(CMSampleBufferRef sampleBuffer) {
    if (!running_) {
      return;
    }
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (block == nullptr) {
      return;
    }
    size_t length = CMBlockBufferGetDataLength(block);
    AVAccessUnit unit;
    unit.track = AVTrack::kAudio;
    unit.isKeyFrame = true;  // every AAC-LC packet is independently decodable
    unit.sequence = audioSequence_++;
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    unit.timestampMicros = pts.timescale != 0 ? (pts.value * 1000000 / pts.timescale) : 0;
    // ADTS-framed (not bare AAC) so each packet self-describes its sample rate/channel count — a
    // streaming consumer has no other way to learn those, unlike the muxed-file recording path
    // (av_recording.h), which hands AVAssetWriter the format directly.
    PrependADTSHeader(unit.data, length, audioTap_->Format());
    size_t headerSize = unit.data.size();
    unit.data.resize(headerSize + length);
    if (CMBlockBufferCopyDataBytes(block, 0, length, unit.data.data() + headerSize) != kCMBlockBufferNoErr) {
      return;
    }
    if (onAccessUnit_) {
      onAccessUnit_(std::move(unit));
    }
  }

  // Called from either encoder's onError. Stops only the OTHER (still-running) one — the failing
  // one is already tearing itself down on its own error path, and calling its own blocking Stop()
  // from within its own callback would deadlock.
  void Fail(NSError* error, bool fromVideo) {
    if (!running_.exchange(false)) {
      return;  // already stopping/stopped
    }
    if (fromVideo) {
      if (audioTap_) {
        audioTap_->Stop();
      }
    } else {
      if (videoEncoder_) {
        videoEncoder_->Stop();
      }
    }
    if (onError_) {
      onError_(error);
    }
    if (onEnd_) {
      onEnd_();
    }
  }

  void StopInternal() {
    if (!running_.exchange(false)) {
      return;  // idempotent
    }
    if (videoEncoder_) {
      videoEncoder_->Stop();
    }
    if (audioTap_) {
      audioTap_->Stop();
    }
    if (onEnd_) {
      onEnd_();
    }
  }

  id device_;
  NSString* udid_;
  VideoEncoderOptions videoOptions_;
  std::function<void(AVAccessUnit)> onAccessUnit_;
  std::function<void(NSError*)> onError_;
  std::function<void()> onEnd_;
  std::function<void()> onAbortDelivery_;

  double clockOrigin_ = 0;
  std::unique_ptr<VideoFrameEncoder> videoEncoder_;
  std::unique_ptr<AudioTapSession> audioTap_;
  std::mutex audioEncoderMutex_;  // guards audioEncoder_ — see HandleAudioPCM/Start()
  std::unique_ptr<AudioEncoder> audioEncoder_;

  std::atomic<uint64_t> videoSequence_{0};
  std::atomic<uint64_t> audioSequence_{0};
  std::atomic<bool> running_{false};
};

AVStreamSession::AVStreamSession(id device, NSString* udid, VideoEncoderOptions videoOptions,
                                 std::function<void(AVAccessUnit)> onAccessUnit, std::function<void(NSError*)> onError,
                                 std::function<void()> onEnd, std::function<void()> onAbortDelivery)
    : impl_(std::make_unique<Impl>(device, udid, videoOptions, std::move(onAccessUnit), std::move(onError),
                                   std::move(onEnd), std::move(onAbortDelivery))) {}

AVStreamSession::~AVStreamSession() = default;

void AVStreamSession::Start() { impl_->Start(); }

void AVStreamSession::Stop() { impl_->Stop(); }

void AVStreamSession::AbortDelivery() { impl_->AbortDelivery(); }

void AVStreamSession::RequestKeyFrame() { impl_->RequestKeyFrame(); }

}  // namespace coresim
