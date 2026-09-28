#include "sim_audio_tap.h"

#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>

#include <algorithm>
#include <atomic>

#include "nserror_bridge.h"
#include "sim_process.h"

namespace coresim {

NSString* const kAudioTapErrorDomain = @"io.appium.coresim.AudioTap";

namespace {

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kAudioTapErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

NSError* MakeStatusError(NSInteger code, NSString* what, OSStatus status) {
  return MakeError(code, [NSString stringWithFormat:@"%@ (OSStatus %d)", what, static_cast<int>(status)]);
}

// AudioObjectID for `pid`'s Core Audio process object, or kAudioObjectUnknown (0) if it hasn't
// registered with the audio HAL yet (e.g. a just-launched app that hasn't touched audio) — not an
// error per kAudioHardwarePropertyTranslatePIDToProcessObject's own documented contract.
AudioObjectID TranslatePidToProcessObject(pid_t pid) {
  AudioObjectPropertyAddress address = {kAudioHardwarePropertyTranslatePIDToProcessObject,
                                        kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
  AudioObjectID objectID = kAudioObjectUnknown;
  UInt32 dataSize = sizeof(objectID);
  pid_t qualifierPid = pid;
  OSStatus status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, sizeof(qualifierPid), &qualifierPid,
                                               &dataSize, &objectID);
  return status == noErr ? objectID : kAudioObjectUnknown;
}

// The live, audio-HAL-registered process set for `udid` — skips any guest pid that hasn't
// touched the audio HAL yet. Sorted so two resolutions can be compared with plain `==`.
std::vector<AudioObjectID> ResolveProcessObjects(NSString* udid) {
  std::vector<AudioObjectID> result;
  for (pid_t pid : FindGuestProcessPids(udid)) {
    AudioObjectID objectID = TranslatePidToProcessObject(pid);
    if (objectID != kAudioObjectUnknown) {
      result.push_back(objectID);
    }
  }
  std::sort(result.begin(), result.end());
  return result;
}

NSArray<NSNumber*>* ToNumberArray(const std::vector<AudioObjectID>& objectIDs) {
  NSMutableArray<NSNumber*>* array = [NSMutableArray arrayWithCapacity:objectIDs.size()];
  for (AudioObjectID objectID : objectIDs) {
    [array addObject:@(objectID)];
  }
  return array;
}

}  // namespace

class AudioTapSession::Impl {
 public:
  Impl(NSString* udid, std::function<void(const AudioBufferList*, const AudioTimeStamp*)> onBuffer,
       std::function<void(NSError*)> onError, std::function<void()> onEnd)
      : udid_(udid), onBuffer_(std::move(onBuffer)), onError_(std::move(onError)), onEnd_(std::move(onEnd)) {
    queue_ = dispatch_queue_create("io.appium.coresim.audioTap", DISPATCH_QUEUE_SERIAL);
  }

  ~Impl() { Stop(); }

  void Start() {
    if (@available(macOS 14.2, *)) {
      StartTap();
    } else {
      throw NSErrorException(
          MakeError(1, @"Core Audio process taps require macOS 14.2 or later — this host's macOS predates it"));
    }
  }

  // Callable from any thread except `queue_` itself (would deadlock on the dispatch_sync below).
  void Stop() {
    if (!running_.exchange(false)) {
      return;  // idempotent
    }
    if (pollTimer_ != nullptr) {
      dispatch_source_cancel(pollTimer_);
      // Blocks until any in-flight poll tick finishes — by then running_ is already false.
      dispatch_sync(queue_, ^{
                    });
      pollTimer_ = nullptr;
    }
    TearDown();
    if (onEnd_) {
      onEnd_();
    }
  }

  const AudioStreamBasicDescription& Format() const { return format_; }

 private:
  API_AVAILABLE(macos(14.2))
  void StartTap() {
    // A host with no default audio output device at all can't do any of this — checked up front
    // so that case fails in milliseconds. Doesn't cover every slow-CI-host failure mode: some
    // runners with a real default device still make AudioDeviceStart below block for ~180s before
    // failing with MACH_RCV_TIMED_OUT (a Mach IPC timeout talking to coreaudiod) — see CLAUDE.md.
    // That one isn't predictable/avoidable from here.
    AudioObjectID defaultOutput = kAudioObjectUnknown;
    UInt32 defaultOutputSize = sizeof(defaultOutput);
    AudioObjectPropertyAddress defaultOutputAddress = {
        kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
    OSStatus defaultOutputStatus = AudioObjectGetPropertyData(kAudioObjectSystemObject, &defaultOutputAddress, 0,
                                                              nullptr, &defaultOutputSize, &defaultOutput);
    if (defaultOutputStatus != noErr || defaultOutput == kAudioObjectUnknown) {
      throw NSErrorException(
          MakeError(11, @"This host has no default audio output device — Core Audio process taps need one"));
    }

    lastProcessSet_ = ResolveProcessObjects(udid_);
    if (lastProcessSet_.empty()) {
      throw NSErrorException(MakeError(
          2, [NSString stringWithFormat:@"No audio-capturable guest processes were found for device '%@' — is it "
                                        @"booted, and has it produced any audio yet?",
                                        udid_]));
    }
    NSUUID* uuid = [NSUUID UUID];
    CATapDescription* description =
        [[CATapDescription alloc] initStereoMixdownOfProcesses:ToNumberArray(lastProcessSet_)];
    description.privateTap = YES;
    description.UUID = uuid;
    AudioObjectID tapID = kAudioObjectUnknown;
    OSStatus status = AudioHardwareCreateProcessTap(description, &tapID);
    if (status != noErr) {
      throw NSErrorException(MakeStatusError(3, @"AudioHardwareCreateProcessTap failed", status));
    }
    tapID_ = tapID;
    tapUUID_ = uuid;

    UInt32 formatSize = sizeof(format_);
    AudioObjectPropertyAddress formatAddress = {kAudioTapPropertyFormat, kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};
    status = AudioObjectGetPropertyData(tapID_, &formatAddress, 0, nullptr, &formatSize, &format_);
    if (status != noErr) {
      TearDown();
      throw NSErrorException(MakeStatusError(4, @"Failed to read the tap's audio format", status));
    }

    // UID includes the tap's own per-session UUID, not just udid_ — concurrent sessions on the
    // same device are supported, and a udid_-only UID would let two collide on the same
    // persistent UID, which CoreAudio dedupes rather than erroring.
    NSDictionary* aggregateDescription = @{
      @(kAudioAggregateDeviceNameKey) : [NSString stringWithFormat:@"coresim-audio-%@", udid_],
      @(kAudioAggregateDeviceUIDKey) :
          [NSString stringWithFormat:@"io.appium.coresim.audio.%@.%@", udid_, uuid.UUIDString],
      @(kAudioAggregateDeviceIsPrivateKey) : @YES,
      @(kAudioAggregateDeviceTapAutoStartKey) : @NO,
      @(kAudioAggregateDeviceTapListKey) : @[ @{
        @(kAudioSubTapUIDKey) : uuid.UUIDString,
        @(kAudioSubTapDriftCompensationKey) : @YES,
      } ],
    };
    AudioObjectID aggregateID = kAudioObjectUnknown;
    status = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggregateDescription, &aggregateID);
    if (status != noErr) {
      TearDown();
      throw NSErrorException(MakeStatusError(5, @"AudioHardwareCreateAggregateDevice failed", status));
    }
    aggregateID_ = aggregateID;

    running_ = true;  // before AudioDeviceStart — the IOProc block can fire before it returns
    AudioDeviceIOProcID procID = nullptr;
    status = AudioDeviceCreateIOProcIDWithBlock(
        &procID, aggregateID_, queue_,
        ^(const AudioTimeStamp*, const AudioBufferList* inInputData, const AudioTimeStamp* inInputTime,
          AudioBufferList*, const AudioTimeStamp*) {
          HandleBuffer(inInputData, inInputTime);
        });
    if (status != noErr || procID == nullptr) {
      running_ = false;
      TearDown();
      throw NSErrorException(MakeStatusError(6, @"AudioDeviceCreateIOProcIDWithBlock failed", status));
    }
    procID_ = procID;

    status = AudioDeviceStart(aggregateID_, procID_);
    if (status != noErr) {
      running_ = false;
      TearDown();
      throw NSErrorException(MakeStatusError(7, @"AudioDeviceStart failed", status));
    }

    StartPolling();
  }

  API_AVAILABLE(macos(14.2))
  void StartPolling() {
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue_);
    dispatch_source_set_timer(
        timer, dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(kPollIntervalSeconds * NSEC_PER_SEC)),
        static_cast<uint64_t>(kPollIntervalSeconds * NSEC_PER_SEC),
        static_cast<uint64_t>(kPollIntervalSeconds * NSEC_PER_SEC / 10));
    // `this` outlives the timer: Stop() always drains or outruns it before `this` can be
    // destroyed (see its comment).
    dispatch_source_set_event_handler(timer, ^{
      PollAndRefresh();
    });
    pollTimer_ = timer;
    dispatch_resume(pollTimer_);
  }

  // Refreshes the tapped process set in place via kAudioTapPropertyDescription — no tap/aggregate
  // recreation needed, confirmed by that property's own header comment ("can be used to modify
  // and set the description of an existing tap").
  API_AVAILABLE(macos(14.2))
  void PollAndRefresh() {
    if (!running_) {
      return;
    }
    @autoreleasepool {
      std::vector<AudioObjectID> current = ResolveProcessObjects(udid_);
      if (current.empty()) {
        // The device's guest process tree vanished entirely (shut down/erased mid-capture) — a
        // real, reportable failure, not a transient empty tick.
        if (onError_) {
          onError_(MakeError(8, [NSString stringWithFormat:@"Device '%@' no longer has any audio-capturable guest "
                                                           @"processes — was it shut down?",
                                                           udid_]));
        }
        StopFromQueue();
        return;
      }
      if (current == lastProcessSet_) {
        return;
      }
      CATapDescription* description = [[CATapDescription alloc] initStereoMixdownOfProcesses:ToNumberArray(current)];
      description.privateTap = YES;
      description.UUID = tapUUID_;
      AudioObjectPropertyAddress descAddress = {kAudioTapPropertyDescription, kAudioObjectPropertyScopeGlobal,
                                                kAudioObjectPropertyElementMain};
      // The property value is the CATapDescription* itself — inData must point to a variable
      // holding that pointer, not be the pointer value cast to an address (which reads the
      // object's own memory as if it were the property buffer).
      void* descriptionPtr = (__bridge void*)description;
      OSStatus status =
          AudioObjectSetPropertyData(tapID_, &descAddress, 0, nullptr, sizeof(descriptionPtr), &descriptionPtr);
      if (status != noErr) {
        // Keep running with the stale set rather than tearing down the whole capture over one
        // failed refresh — the next poll tick retries.
        if (onError_) {
          onError_(MakeStatusError(9, @"Failed to update the audio tap's process list", status));
        }
        return;
      }
      lastProcessSet_ = std::move(current);
    }
  }

  void HandleBuffer(const AudioBufferList* data, const AudioTimeStamp* time) {
    if (!running_ || !onBuffer_) {
      return;
    }
    try {
      onBuffer_(data, time);
    } catch (const std::exception& e) {
      // onBuffer_ (e.g. AudioEncoder::EncodePCM) can throw — uncaught, it'd crash the process.
      // Routed through the same onError_/StopFromQueue() path PollAndRefresh's own errors use.
      if (onError_) {
        onError_(MakeError(10, [NSString stringWithFormat:@"Audio buffer consumer failed: %s", e.what()]));
      }
      StopFromQueue();
    }
  }

  // Same as Stop() minus the dispatch_sync barrier — only safe from within a callback already
  // serialized on `queue_` (PollAndRefresh); would deadlock waiting on itself otherwise.
  void StopFromQueue() {
    if (!running_.exchange(false)) {
      return;  // idempotent — e.g. an external Stop() already won this race
    }
    if (pollTimer_ != nullptr) {
      dispatch_source_cancel(pollTimer_);
      pollTimer_ = nullptr;
    }
    TearDown();
    if (onEnd_) {
      onEnd_();
    }
  }

  // Deliberately not API_AVAILABLE-annotated so Stop()/StopFromQueue()/~Impl() can call it
  // unconditionally without themselves needing an availability guard — the guarded body below is
  // a no-op whenever nothing was actually created (Start() never got past the macOS-version gate).
  void TearDown() {
    if (aggregateID_ == kAudioObjectUnknown && tapID_ == kAudioObjectUnknown) {
      return;
    }
    if (@available(macOS 14.2, *)) {
      if (aggregateID_ != kAudioObjectUnknown) {
        if (procID_ != nullptr) {
          AudioDeviceStop(aggregateID_, procID_);
          AudioDeviceDestroyIOProcID(aggregateID_, procID_);
          procID_ = nullptr;
        }
        // Destruction is documented as asynchronous — may complete after this call returns — so
        // this UID isn't assumed immediately reusable.
        AudioHardwareDestroyAggregateDevice(aggregateID_);
        aggregateID_ = kAudioObjectUnknown;
      }
      if (tapID_ != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(tapID_);
        tapID_ = kAudioObjectUnknown;
      }
    }
  }

  static constexpr double kPollIntervalSeconds = 1.0;

  NSString* udid_;
  std::function<void(const AudioBufferList*, const AudioTimeStamp*)> onBuffer_;
  std::function<void(NSError*)> onError_;
  std::function<void()> onEnd_;

  dispatch_queue_t queue_ = nullptr;
  dispatch_source_t pollTimer_ = nullptr;
  AudioObjectID tapID_ = kAudioObjectUnknown;
  AudioObjectID aggregateID_ = kAudioObjectUnknown;
  AudioDeviceIOProcID procID_ = nullptr;
  NSUUID* tapUUID_ = nil;
  AudioStreamBasicDescription format_ = {};
  std::vector<AudioObjectID> lastProcessSet_;
  std::atomic<bool> running_{false};
};

AudioTapSession::AudioTapSession(NSString* udid,
                                 std::function<void(const AudioBufferList*, const AudioTimeStamp*)> onBuffer,
                                 std::function<void(NSError*)> onError, std::function<void()> onEnd)
    : impl_(std::make_unique<Impl>(udid, std::move(onBuffer), std::move(onError), std::move(onEnd))) {}

AudioTapSession::~AudioTapSession() = default;

void AudioTapSession::Start() { impl_->Start(); }

void AudioTapSession::Stop() { impl_->Stop(); }

const AudioStreamBasicDescription& AudioTapSession::Format() const { return impl_->Format(); }

}  // namespace coresim
