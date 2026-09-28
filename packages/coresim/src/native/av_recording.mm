#include "av_recording.h"

#include <atomic>
#include <mutex>
#include <vector>

#include "audio_encoder.h"
#include "monotonic_clock.h"
#include "nserror_bridge.h"
#include "sim_audio_tap.h"

namespace coresim {

namespace {

NSString* const kAVRecordingErrorDomain = @"io.appium.coresim.AVRecording";

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kAVRecordingErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

constexpr size_t kMaxPendingAudioSamples = 500;  // a few seconds of AAC packets — see HandleAudioSample

}  // namespace

class AVRecordingSession::Impl : public std::enable_shared_from_this<Impl> {
 public:
  Impl(id device, NSString* udid, VideoEncoderOptions videoOptions, NSString* outputFile, bool captureAudio)
      : device_(device),
        udid_(udid),
        videoOptions_(videoOptions),
        outputFile_(outputFile),
        captureAudio_(captureAudio) {
    // Forced on regardless of what the caller passed — see VideoEncoderOptions::fixedFrameSize.
    videoOptions_.fixedFrameSize = true;
  }

  ~Impl() { TearDownIfNeeded(); }

  void Start(std::function<void()> onFirstSample, std::function<void(NSError*)> onError, std::function<void()> onEnd) {
    onFirstSample_ = std::move(onFirstSample);
    onError_ = std::move(onError);
    onEnd_ = std::move(onEnd);
    clockOrigin_ = MonotonicSeconds();

    [[NSFileManager defaultManager] removeItemAtPath:outputFile_ error:nil];
    NSError* writerError = nil;
    writer_ = [AVAssetWriter assetWriterWithURL:[NSURL fileURLWithPath:outputFile_]
                                       fileType:AVFileTypeMPEG4
                                          error:&writerError];
    if (writer_ == nil) {
      throw NSErrorException(writerError ?: MakeError(1, @"Failed to create an AVAssetWriter"));
    }

    // A weak_ptr (not `this`, and not a strong shared_ptr) captured by every callback handed to a
    // collaborator below: `this` would dangle if a callback fires mid-teardown (see Fail()'s own
    // comment), but a strong self-capture stored in a member `this` itself owns (videoEncoder_,
    // audioTap_) would leak instead, keeping this Impl alive forever via a reference cycle. Locking
    // it at call time gets safety without either problem.
    std::weak_ptr<Impl> weakSelf = weak_from_this();
    try {
      if (captureAudio_) {
        audioTap_ = std::make_unique<AudioTapSession>(
            udid_,
            [weakSelf](const AudioBufferList* data, const AudioTimeStamp* time) {
              if (auto self = weakSelf.lock()) {
                self->HandleAudioPCM(data, time);
              }
            },
            [weakSelf](NSError* error) {
              // A failed process-list refresh (kAudioTapNonFatalProcessListRefreshErrorCode) isn't
              // fatal — the tap keeps running. Everything else is.
              if ([error.domain isEqualToString:kAudioTapErrorDomain] &&
                  error.code == kAudioTapNonFatalProcessListRefreshErrorCode) {
                return;
              }
              if (auto self = weakSelf.lock()) {
                self->Fail(error, /*fromVideo=*/false);
              }
            },
            [] {});
        audioTap_->Start();

        // Start() can invoke HandleAudioPCM before returning, so audioEncoder_ is written under
        // mutex_ (same lock HandleAudioPCM reads it under) to avoid a torn/racy pointer read.
        auto encoder = std::make_unique<AudioEncoder>(
            audioTap_->Format(),
            [weakSelf](CMSampleBufferRef sampleBuffer) {
              if (auto self = weakSelf.lock()) {
                self->HandleAudioSample(sampleBuffer);
              }
            },
            &clockOrigin_);
        {
          std::lock_guard<std::mutex> lock(mutex_);
          audioEncoder_ = std::move(encoder);
        }
        // Audio's format is known immediately (unlike video's, learned from its first sample), so
        // its input can be added to the writer right away — well before startWriting is called.
        audioInput_ = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                                         outputSettings:nil
                                                       sourceFormatHint:audioEncoder_->OutputFormatDescription()];
        audioInput_.expectsMediaDataInRealTime = YES;
        [writer_ addInput:audioInput_];
      }

      videoEncoder_ = std::make_shared<VideoFrameEncoder>(
          device_, videoOptions_,
          [weakSelf](CMSampleBufferRef sampleBuffer) {
            if (auto self = weakSelf.lock()) {
              self->HandleVideoSample(sampleBuffer);
            }
          },
          [weakSelf](NSError* error) {
            if (auto self = weakSelf.lock()) {
              self->Fail(error, /*fromVideo=*/true);
            }
          },
          [] {}, &clockOrigin_);
      videoEncoder_->Start();
    } catch (...) {
      TearDownIfNeeded();
      throw;
    }
  }

  // Must be fully idempotent, including concurrently: the env cleanup hook (coresim.mm) also
  // unconditionally calls Stop() on every still-registered session, including one already stopped
  // moments earlier whose JS wrapper hasn't GC'd yet. Finalizing an already-`.completed`
  // AVAssetWriter throws an uncaught NSException and aborts the process — so only the FIRST call
  // ever touches the writer/encoders; every later (or concurrent) call just replays that outcome.
  void Stop(std::function<void(NSError*)> onFinished) {
    bool isFirstCall;
    bool resultReady;
    NSError* resultError = nil;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      isFirstCall = !stopped_;
      stopped_ = true;
      resultReady = stopResultReady_;
      resultError = stopResultError_;
      if (!isFirstCall && !resultReady) {
        pendingStopCallbacks_.push_back(std::move(onFinished));
        return;
      }
    }
    if (!isFirstCall) {
      if (onFinished) {
        onFinished(resultError);
      }
      return;
    }

    // Blocks until each has fully torn down — safe to finalize the writer afterward without racing
    // a further sample callback, and also the point past which no new Fail() can start (both
    // encoders' onError channels are now silenced) — which is what makes the stopResultReady_
    // check below race-free against a concurrent Fail() (e.g. the audio tap's own poll timer).
    if (videoEncoder_) {
      videoEncoder_->Stop();
    }
    if (audioTap_) {
      audioTap_->Stop();
    }

    bool started;
    bool alreadyFailed;
    NSError* failedError = nil;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      started = writerStarted_;
      alreadyFailed = stopResultReady_;
      failedError = stopResultError_;
      ClearPendingAudioLocked();
    }
    if (alreadyFailed) {
      // A concurrent Fail() already recorded the outcome and (if started) cancelled the writer —
      // replay that outcome instead of touching it again; finishWriting on a cancelled writer
      // throws an uncaught NSException.
      if (onFinished) {
        onFinished(failedError);
      }
      FireEndOnce();
      return;
    }
    if (!started) {
      FinishStop(MakeError(2, @"No audio or video was captured before the recording was stopped"),
                 std::move(onFinished));
      return;
    }
    [videoInput_ markAsFinished];
    [audioInput_ markAsFinished];  // no-op if `captureAudio_` was never set (audioInput_ stays nil)
    AVAssetWriter* writer = writer_;
    [writer finishWritingWithCompletionHandler:^{
      NSError* finishError = (writer.status == AVAssetWriterStatusCompleted) ? nil : writer.error;
      FinishStop(finishError, std::move(onFinished));
    }];
  }

 private:
  void HandleVideoSample(CMSampleBufferRef sampleBuffer) {
    NSError* writingError = nil;
    bool justStarted = false;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopped_) {
        return;
      }
      if (!writerStarted_) {
        CMFormatDescriptionRef format = CMSampleBufferGetFormatDescription(sampleBuffer);
        videoInput_ = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                         outputSettings:nil
                                                       sourceFormatHint:format];
        videoInput_.expectsMediaDataInRealTime = YES;
        [writer_ addInput:videoInput_];
        if ([writer_ startWriting]) {
          [writer_ startSessionAtSourceTime:CMSampleBufferGetPresentationTimeStamp(sampleBuffer)];
          writerStarted_ = true;
          justStarted = true;
          writingError = AppendVideoLocked(sampleBuffer);
          for (CMSampleBufferRef pending : pendingAudio_) {
            AppendAudioLocked(pending);
            CFRelease(pending);
          }
          pendingAudio_.clear();
        } else {
          writingError = writer_.error ?: MakeError(3, @"AVAssetWriter startWriting failed");
        }
      } else {
        writingError = AppendVideoLocked(sampleBuffer);
      }
    }
    if (writingError != nil) {
      // Detected while handling a video callback — see Fail()'s doc comment for why this can only
      // safely stop the audio side directly from here, not video's own encoder.
      Fail(writingError, /*fromVideo=*/true);
      return;
    }
    if (justStarted) {
      FireFirstSampleOnce();
    }
  }

  void HandleAudioSample(CMSampleBufferRef sampleBuffer) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (stopped_) {
      return;
    }
    if (!writerStarted_) {
      // Buffered until video's first sample establishes the writer's format/session (see
      // HandleVideoSample) — capped so a display that never resolves can't grow this unboundedly.
      CFRetain(sampleBuffer);
      pendingAudio_.push_back(sampleBuffer);
      if (pendingAudio_.size() > kMaxPendingAudioSamples) {
        CFRelease(pendingAudio_.front());
        pendingAudio_.erase(pendingAudio_.begin());
      }
      return;
    }
    AppendAudioLocked(sampleBuffer);
  }

  // Runs on AudioTapSession's own queue; audioEncoder_ is guarded by mutex_ (see Start()). A throw
  // from EncodePCM is left to propagate — AudioTapSession::HandleBuffer catches it and self-stops
  // (see sim_audio_tap.h's onBuffer doc) — this method must never call audioTap_->Stop() itself.
  void HandleAudioPCM(const AudioBufferList* data, const AudioTimeStamp* time) {
    AudioEncoder* encoder;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopped_) {
        return;
      }
      encoder = audioEncoder_.get();
    }
    if (encoder != nullptr) {
      encoder->EncodePCM(data, time);
    }
  }

  // Caller holds mutex_. Returns a descriptive error if the append failed (e.g. a mid-recording
  // rotation resizes the encoder but a track's dimensions are fixed for the writer's life), nil otherwise.
  NSError* AppendVideoLocked(CMSampleBufferRef sampleBuffer) {
    if (!videoInput_.isReadyForMoreMediaData) {
      return nil;  // transient backpressure, not a failure
    }
    if ([videoInput_ appendSampleBuffer:sampleBuffer]) {
      return nil;
    }
    return writer_.error ?: MakeError(4, @"Failed to append a video sample to the recording");
  }

  // Caller holds mutex_.
  void AppendAudioLocked(CMSampleBufferRef sampleBuffer) {
    if (audioInput_.isReadyForMoreMediaData) {
      [audioInput_ appendSampleBuffer:sampleBuffer];
    }
  }

  // Caller holds mutex_.
  void ClearPendingAudioLocked() {
    for (CMSampleBufferRef pending : pendingAudio_) {
      CFRelease(pending);
    }
    pendingAudio_.clear();
  }

  void FireFirstSampleOnce() {
    if (!firstSampleFired_.exchange(true)) {
      if (onFirstSample_) {
        onFirstSample_();
      }
    }
  }

  void FireEndOnce() {
    if (!endFired_.exchange(true)) {
      if (onEnd_) {
        onEnd_();
      }
    }
  }

  // Caller holds mutex_. Records the session's single, final outcome — a no-op if already
  // recorded. Returns any Stop() calls queued while the outcome was unknown; caller must invoke
  // each with `error`, unlocked.
  std::vector<std::function<void(NSError*)>> RecordResultLocked(NSError* error) {
    if (stopResultReady_) {
      return {};
    }
    stopResultReady_ = true;
    stopResultError_ = error;
    std::vector<std::function<void(NSError*)>> pending;
    pending.swap(pendingStopCallbacks_);
    return pending;
  }

  // Caller holds mutex_. Returns any queued Stop() calls to flush (see RecordResultLocked).
  std::vector<std::function<void(NSError*)>> FailLocked(NSError* error) {
    if (stopResultReady_) {
      return {};  // already resolved (a prior Fail() or Stop() completion)
    }
    stopped_ = true;
    if (writerStarted_) {
      [writer_ cancelWriting];
    }
    ClearPendingAudioLocked();
    auto pending = RecordResultLocked(error);
    if (onError_) {
      onError_(error);
    }
    return pending;
  }

  // Called from either encoder's onError, or from HandleVideoSample on a writer-level append
  // failure — not holding mutex_ (could deadlock against that encoder's own queue).
  //
  // fromVideo=true also needs videoEncoder_ itself stopped: a writer append failure leaves
  // VideoToolbox otherwise healthy and encoding forever. But videoEncoder_->Stop() dispatch_syncs
  // onto its own queue, and HandleVideoSample (VideoToolbox's own output callback) isn't
  // guaranteed to be off that queue — so it's dispatched async instead, via a shared_ptr `encoder`
  // copy that can outlive this Impl. Stop() can still flush a pending frame into onSample_/onError_
  // synchronously; those hold only a weak_ptr (see Start()), but `self` below keeps it resolvable
  // for the duration of this block. onEnd_ waits until that's done, not fired eagerly here.
  void Fail(NSError* error, bool fromVideo) {
    if (fromVideo) {
      if (audioTap_) {
        audioTap_->Stop();
      }
    } else if (videoEncoder_) {
      videoEncoder_->Stop();
    }
    std::vector<std::function<void(NSError*)>> pending;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending = FailLocked(error);
    }
    for (auto& callback : pending) {
      if (callback) {
        callback(error);
      }
    }
    if (fromVideo && videoEncoder_) {
      std::shared_ptr<VideoFrameEncoder> encoder = videoEncoder_;
      std::shared_ptr<Impl> self = shared_from_this();
      dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
        encoder->Stop();
        self->FireEndOnce();
      });
    } else {
      FireEndOnce();
    }
  }

  // The single point where a real (first-ever) Stop() attempt's outcome becomes known — records
  // it, replies to `onFinished` and any callers that arrived while it was still in flight, then
  // fires onEnd_. Never called a second time for the same session (see Stop()'s own guard).
  void FinishStop(NSError* error, std::function<void(NSError*)> onFinished) {
    std::vector<std::function<void(NSError*)>> pending;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      pending = RecordResultLocked(error);
    }
    if (onFinished) {
      onFinished(error);
    }
    for (auto& callback : pending) {
      if (callback) {
        callback(error);
      }
    }
    FireEndOnce();
  }

  // Best-effort, synchronous cleanup for the destructor path (Start() throwing partway through,
  // or the session being destroyed without an explicit Stop()) — no completion callback, unlike
  // the public Stop().
  void TearDownIfNeeded() {
    if (videoEncoder_) {
      videoEncoder_->Stop();
    }
    if (audioTap_) {
      audioTap_->Stop();
    }
    std::lock_guard<std::mutex> lock(mutex_);
    if (writerStarted_ && writer_ != nil) {
      [writer_ cancelWriting];
    }
    ClearPendingAudioLocked();
  }

  id device_;
  NSString* udid_;
  VideoEncoderOptions videoOptions_;
  NSString* outputFile_;
  bool captureAudio_;

  std::function<void()> onFirstSample_;
  std::function<void(NSError*)> onError_;
  std::function<void()> onEnd_;

  double clockOrigin_ = 0;
  std::shared_ptr<VideoFrameEncoder> videoEncoder_;
  std::unique_ptr<AudioTapSession> audioTap_;
  std::unique_ptr<AudioEncoder> audioEncoder_;

  AVAssetWriter* writer_ = nil;
  AVAssetWriterInput* videoInput_ = nil;
  AVAssetWriterInput* audioInput_ = nil;

  std::mutex mutex_;
  bool writerStarted_ = false;
  bool stopped_ = false;  // true from the first Stop() (or Fail()) call onward
  bool stopResultReady_ = false;
  NSError* stopResultError_ = nil;
  std::vector<std::function<void(NSError*)>> pendingStopCallbacks_;  // Stop() calls awaiting stopResultReady_
  std::vector<CMSampleBufferRef> pendingAudio_;
  std::atomic<bool> firstSampleFired_{false};
  std::atomic<bool> endFired_{false};
};

AVRecordingSession::AVRecordingSession(id device, NSString* udid, VideoEncoderOptions videoOptions,
                                       NSString* outputFile, bool captureAudio)
    : impl_(std::make_shared<Impl>(device, udid, videoOptions, outputFile, captureAudio)) {}

AVRecordingSession::~AVRecordingSession() = default;

void AVRecordingSession::Start(std::function<void()> onFirstSample, std::function<void(NSError*)> onError,
                               std::function<void()> onEnd) {
  impl_->Start(std::move(onFirstSample), std::move(onError), std::move(onEnd));
}

void AVRecordingSession::Stop(std::function<void(NSError*)> onFinished) { impl_->Stop(std::move(onFinished)); }

}  // namespace coresim
