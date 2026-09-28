#pragma once

#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>

#include <functional>
#include <memory>

namespace coresim {

// Domain of every NSError AudioTapSession reports via its `onError` callback.
extern NSString* const kAudioTapErrorDomain;

// The one `onError` code that does NOT mean the session stopped itself: a failed attempt to
// refresh the tapped process list — it keeps running on the stale set and retries next poll tick.
// Every other code means the session already tore itself down. Callers that otherwise treat every
// `onError` as fatal must special-case this one.
constexpr NSInteger kAudioTapNonFatalProcessListRefreshErrorCode = 9;

// Captures one simulator's audio via macOS's public Core Audio "process tap" API
// (CATapDescription + AudioHardwareCreateProcessTap, macOS 14.2+), scoped to the live set of host
// PIDs belonging to that device's guest process tree (SpringBoard + any launched app — see
// sim_process.h's FindGuestProcessPids). CoreSimulator itself has no audio *capture* API at all
// (see CLAUDE.md) — this taps the guest's own processes directly, isolating one simulator's audio
// from other simulators and from unrelated Mac apps.
//
// IMPORTANT — host TCC permission required, not obtainable programmatically: creating a process
// tap for another process's audio requires the host's "System Audio Recording Only" permission
// (kTCCServiceAudioCapture), granted once via System Settings > Privacy & Security. Unlike every
// other permission this addon handles, this one is keyed to the host Node process's code-signing
// identity, lives in the host's SIP-protected system TCC database (no direct-write workaround like
// tcc_privacy.mm's), and has no query API — a denial isn't a catchable error, it's silent
// all-zero PCM. See CLAUDE.md for the full writeup; this is a documented limitation, not a bug.
class AudioTapSession {
 public:
  // `onBuffer` delivers each IO cycle's tapped PCM, in the tap's own AudioStreamBasicDescription
  // (query via Format() after Start()) — valid only for the duration of the call, copy out
  // anything needed beyond it. If it throws, the session catches it, reports via `onError`, and
  // stops itself — no try/catch needed in `onBuffer`, and it must never call this session's own
  // Stop() (runs on the session's internal queue — would deadlock). `onError`/`onEnd` mirror
  // VideoFrameEncoder's contract, except `onError` can also fire non-fatally — see
  // kAudioTapNonFatalProcessListRefreshErrorCode.
  AudioTapSession(NSString* udid, std::function<void(const AudioBufferList*, const AudioTimeStamp*)> onBuffer,
                  std::function<void(NSError*)> onError, std::function<void()> onEnd);
  ~AudioTapSession();

  AudioTapSession(const AudioTapSession&) = delete;
  AudioTapSession& operator=(const AudioTapSession&) = delete;

  // Resolves the device's current guest process set, creates the tap + aggregate device, and
  // starts IO. Throws synchronously on failure (`onEnd` never called then) — including
  // NativeSimUnavailableError if this macOS predates process taps (< 14.2), and a plain
  // NSErrorException if the guest process set is empty (device not really booted).
  void Start();

  // Idempotent; blocks until IO has fully stopped and the tap/aggregate device are destroyed.
  void Stop();

  // The tap's live PCM format — valid only after Start() returns.
  const AudioStreamBasicDescription& Format() const;

 private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace coresim
