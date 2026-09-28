// N-API glue: exposes SimServiceContext/SimDeviceSet/SimDevice as JS-facing classes. All actual
// dynamic dispatch lives in native/*.mm (safe_dispatch-guarded); this file only translates
// JS <-> Objective-C values, decides sync vs. async exposure, and reports errors/results back to
// Node.
//
// Every method that can trigger a CoreSimulator dispatch (i.e. everything except the handful of
// trivial in-memory property getters below) is async: work runs in a RunAsync/RunAsyncVoid
// worker on a libuv threadpool thread (async_bridge.h), so a slow install/erase/create/etc. never
// blocks Node's event loop, matching how boot already worked before this file's rewrite.

#include <napi.h>

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

#include "native/async_bridge.h"
#include "native/av_recording.h"
#include "native/av_stream.h"
#include "native/nserror_bridge.h"
#include "native/objc_runtime.h"
#include "native/sim_device.h"
#include "native/sim_device_set.h"
#include "native/sim_jpeg_stream.h"
#include "native/sim_orientation.h"
#include "native/sim_pasteboard.h"
#include "native/sim_process.h"
#include "native/sim_screenshot.h"
#include "native/sim_service_context.h"
#include "native/sim_video_recording.h"
#include "native/sim_video_stream.h"
#include "native/tcc_privacy.h"
#include "native/value_bridge.h"

namespace coresim {

namespace {

// Boxes an `id` behind a Napi::External so it survives the single synchronous call into an
// ObjectWrap constructor (see NewInstance below in each class).
Napi::Object WrapExternalId(Napi::Env env, const Napi::FunctionReference& ctor, id value) {
  __unsafe_unretained id boxed = value;
  return ctor.New({Napi::External<void>::New(env, &boxed)});
}

id UnwrapExternalId(const Napi::CallbackInfo& info) {
  return *static_cast<__unsafe_unretained id*>(info[0].As<Napi::External<void>>().Data());
}

NSDictionary* OptionsArg(const Napi::CallbackInfo& info, size_t index) {
  if (info.Length() <= index || info[index].IsUndefined() || info[index].IsNull()) {
    return @{};
  }
  return (NSDictionary*)JsValueToNSObject(info.Env(), info[index]);
}

// Throws if `!ok && error`, for the common BOOL-returning NSError**-out-param shape — called from
// inside a RunAsync/RunAsyncVoid work lambda (background thread), never from the main thread.
void ThrowIfFailed(BOOL ok, NSError* error) {
  if (!ok && error != nil) {
    throw NSErrorException(error);
  }
}

// Mirrors coresim::TCCAuthStatus (tcc_privacy.h) as the string enum getPermission() resolves with
// — a plain string, not a raw int, since JS callers have no header to interpret the int against.
const char* TCCAuthStatusToString(TCCAuthStatus status) {
  switch (status) {
    case kTCCAuthDenied:
      return "denied";
    case kTCCAuthGranted:
      return "granted";
    case kTCCAuthLimited:
      return "limited";
    case kTCCAuthNotDetermined:
    default:
      return "unset";
  }
}

// dup() failure (e.g. EMFILE — the process fd table is full) — surfaced as a normal catchable
// error via ThrowIfFailed's own throw path, rather than an fd of -1 silently reaching JS.
NSError* MakeDescriptorError(NSString* which, int savedErrno) {
  return [NSError errorWithDomain:NSPOSIXErrorDomain
                             code:savedErrno
                         userInfo:@{
                           NSLocalizedDescriptionKey : [NSString
                               stringWithFormat:@"Failed to duplicate the spawned process's %@ file descriptor: %s",
                                                which, strerror(savedErrno)]
                         }];
}

NSError* MakeSpawnPathError(NSString* message) {
  return [NSError errorWithDomain:@"io.appium.coresim.spawn" code:1 userInfo:@{NSLocalizedDescriptionKey : message}];
}

// Standard bin dirs to search, in order, when `path` is a bare command name (no `/`) — mirrors
// the guest's default $PATH. There's no way to query the guest's actual $PATH (no shell, no env
// to read before a process even exists), so this is a fixed best-effort list, not a real PATH
// search — a binary installed somewhere else won't be found this way.
NSArray<NSString*>* BareCommandSearchDirs() { return @[ @"usr/bin", @"bin", @"usr/sbin", @"sbin", @"usr/local/bin" ]; }

// Resolves a bare command name (e.g. "launchctl") against BareCommandSearchDirs() under
// `runtimeRoot`, mirroring how `simctl spawn` resolves a bare name against the guest's $PATH —
// CoreSimulator's own spawn API takes only a literal path, so it does no such resolution itself.
NSString* ResolveBareCommand(NSString* runtimeRoot, NSString* name, NSError** error) {
  NSFileManager* fm = [NSFileManager defaultManager];
  for (NSString* dir in BareCommandSearchDirs()) {
    NSString* candidate = [runtimeRoot stringByAppendingPathComponent:[dir stringByAppendingPathComponent:name]];
    BOOL isDirectory = NO;
    if ([fm fileExistsAtPath:candidate isDirectory:&isDirectory] && !isDirectory &&
        [fm isExecutableFileAtPath:candidate]) {
      return candidate;
    }
  }
  *error = MakeSpawnPathError(
      [NSString stringWithFormat:@"'%@' not found in the Simulator runtime's standard bin directories", name]);
  return nil;
}

// `spawnWithPath:options:...` can run anything the host user can execute, so Spawn() confines it
// to the Simulator's own runtime image rather than trusting `path` as a literal host path — a
// deliberately breaking restriction (see CLAUDE.md). A bare name (no `/`) is resolved via
// ResolveBareCommand above instead; otherwise `path` is resolved as relative to the runtime root,
// then re-verified (via -stringByStandardizingPath, which collapses ".."/".") to still fall under
// it, since `path` may come from arbitrary caller input.
NSString* ResolveRuntimeBinaryPath(id device, NSString* path, NSError** error) {
  id runtime = DeviceRuntime(device);
  if (runtime == nil) {
    *error = MakeSpawnPathError(@"Could not resolve the Simulator's runtime to spawn a process inside it");
    return nil;
  }
  NSString* runtimeRoot = coresim::RuntimeRootPath(runtime).stringByStandardizingPath;
  if (![path containsString:@"/"]) {
    return ResolveBareCommand(runtimeRoot, path, error);
  }
  NSString* resolved = [runtimeRoot stringByAppendingPathComponent:path].stringByStandardizingPath;
  if (resolved != runtimeRoot && ![resolved hasPrefix:[runtimeRoot stringByAppendingString:@"/"]]) {
    *error = MakeSpawnPathError(
        [NSString stringWithFormat:@"'%@' resolves outside the Simulator runtime ('%@')", path, runtimeRoot]);
    return nil;
  }
  return resolved;
}

// Plain data Spawn()'s work lambda (background thread) hands to its toValue callback (main
// thread) — see NativeDevice::Spawn below.
struct SpawnResult {
  int pid = 0;
  int stdoutFd = -1;
  int stderrFd = -1;
};

// Plain data for GetBootStatus/SupportedDeviceTypesMethod/SupportedRuntimesMethod's work lambdas
// to hand to their toValue callbacks. toValue always runs on the main thread (OnOK), never
// guarded by Execute()'s try/catch — the node-addon-api completion wrapper only catches
// Napi::Error there unless NODE_ADDON_API_CPP_EXCEPTIONS_ALL is defined (it isn't here), so a
// native accessor call from inside toValue could throw NativeSimUnavailableError/ObjCException
// uncaught and crash the process. Extracting these plain values in `work` instead keeps every
// native call inside the guarded stage; toValue only ever touches already-safe C++/Foundation
// primitives.
struct BootStatusResult {
  bool hasValue = false;
  unsigned int status = 0;
  bool isTerminal = false;
};

struct DeviceTypeEntry {
  std::string identifier;
  std::string name;
};

struct RuntimeEntry {
  std::string identifier;
  std::string name;
  std::string versionString;
};

// Napi::ThreadSafeFunction::Release() and Abort() are two mutually exclusive modes of one
// underlying napi_release_threadsafe_function call — Node's own docs say calling either a second
// time (including calling the other one after the first) is undefined behavior, since the handle
// may already be destroyed. A stream's normal stop-triggered release (onEnd) and
// CleanupActiveSessions's exit-time AbortDelivery can race — a session stays registered until its
// JS wrapper is GC'd, not until Stop() completes, so an already-stopped-but-still-referenced
// stream can still be hit by AbortDelivery() later. This guard makes whichever of Release()/
// Abort() runs first win, and turns the other into a no-op instead of a second, unsafe call.
struct TsfnReleaseGuard {
  std::mutex mutex;
  bool done = false;
};

template <typename Fn>
void ReleaseTsfnOnce(const std::shared_ptr<TsfnReleaseGuard>& guard, Fn&& releaseOrAbort) {
  std::lock_guard<std::mutex> lock(guard->mutex);
  if (guard->done) {
    return;
  }
  guard->done = true;
  releaseOrAbort();
}

// Node-API explicitly prohibits sharing an Environment's data across Environments (e.g. two
// worker_threads instances each `require()`-ing this addon) — each gets its own separate call
// into Init() below. A process-global `static Napi::FunctionReference` per class would let one
// Environment's object construction use a FunctionReference belonging to another (possibly
// already-torn-down) Environment, corrupting state or crashing Node. Storing these via
// Napi::Env::SetInstanceData/GetInstanceData instead keeps each Environment's constructors
// scoped to it, and cleans them up automatically (the default finalizer just `delete`s this) when
// that Environment tears down.
// A registry of live sessions (VideoStreamSession/AVStreamSession/AVRecordingSession) of one
// type, so the env cleanup hook can stop every still-live one — and thus release its
// ThreadSafeFunctions — before Node force-tears-down this Environment's own TSFNs (see Init's
// AddCleanupHook calls for why this ordering matters). `T` must expose a blocking `Stop()`.
template <typename T>
struct ActiveSessionRegistry {
  std::mutex mutex;
  std::vector<std::shared_ptr<T>> sessions;

  void Register(const std::shared_ptr<T>& session) {
    std::lock_guard<std::mutex> lock(mutex);
    sessions.push_back(session);
  }

  void Deregister(const std::shared_ptr<T>& session) {
    std::lock_guard<std::mutex> lock(mutex);
    sessions.erase(std::remove(sessions.begin(), sessions.end(), session), sessions.end());
  }

  // Stops every still-registered session, blocking until each has fully torn down. `stop` invokes
  // each session's own Stop() — a parameter (rather than always calling `Stop()` with no
  // arguments) since AVRecordingSession's Stop() takes a completion callback the others don't.
  template <typename StopFn>
  void StopAll(StopFn stop) {
    std::vector<std::shared_ptr<T>> toStop;
    {
      std::lock_guard<std::mutex> lock(mutex);
      toStop.swap(sessions);
    }
    for (auto& session : toStop) {
      stop(session);
    }
  }
};

struct AddonInstanceData {
  Napi::FunctionReference deviceConstructor;
  Napi::FunctionReference deviceSetConstructor;
  Napi::FunctionReference serviceContextConstructor;
  Napi::FunctionReference videoStreamConstructor;
  Napi::FunctionReference avStreamConstructor;
  Napi::FunctionReference avRecordingConstructor;
  Napi::FunctionReference privateRecordingConstructor;
  Napi::FunctionReference jpegStreamConstructor;
  ActiveSessionRegistry<coresim::VideoStreamSession> activeVideoStreams;
  ActiveSessionRegistry<coresim::AVStreamSession> activeAVStreams;
  ActiveSessionRegistry<coresim::AVRecordingSession> activeAVRecordings;
  ActiveSessionRegistry<coresim::JpegStreamSession> activeJpegStreams;
};

}  // namespace

// Wraps a live coresim::VideoStreamSession. Access units/errors are delivered live via the
// callbacks passed directly to startVideoStream, not through this object — it only exposes `stop()`.
class NativeVideoStream : public Napi::ObjectWrap<NativeVideoStream> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<coresim::VideoStreamSession> session);
  explicit NativeVideoStream(const Napi::CallbackInfo& info);

 private:
  std::shared_ptr<coresim::VideoStreamSession> session_;

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto session = session_;
    return RunAsyncVoid(env, [session]() { session->Stop(); });
  }

  // Trivial in-memory flag set (see sim_video_stream.h) — no CoreSimulator dispatch, so kept
  // synchronous like the other pure accessors in this file.
  Napi::Value RequestKeyFrame(const Napi::CallbackInfo& info) {
    if (session_) {
      session_->RequestKeyFrame();
    }
    return info.Env().Undefined();
  }

  // Hands teardown off to a background queue instead of letting the default finalizer run
  // ~VideoStreamSession()'s blocking Stop() synchronously on whatever thread GC runs on.
  void Finalize(Napi::Env env) override {
    auto session = std::move(session_);
    if (session) {
      env.GetInstanceData<AddonInstanceData>()->activeVideoStreams.Deregister(session);
      dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        session->Stop();
      });
    }
  }
};

NativeVideoStream::NativeVideoStream(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeVideoStream>(info) {
  auto* boxed = info[0].As<Napi::External<std::shared_ptr<coresim::VideoStreamSession>>>().Data();
  session_ = *boxed;
  info.Env().GetInstanceData<AddonInstanceData>()->activeVideoStreams.Register(session_);
}

void NativeVideoStream::Init(Napi::Env env) {
  Napi::Function ctor = DefineClass(env, "NativeVideoStream",
                                    {
                                        InstanceMethod<&NativeVideoStream::Stop>("stop"),
                                        InstanceMethod<&NativeVideoStream::RequestKeyFrame>("requestKeyFrame"),
                                    });
  env.GetInstanceData<AddonInstanceData>()->videoStreamConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeVideoStream::NewInstance(Napi::Env env, std::shared_ptr<coresim::VideoStreamSession> session) {
  auto* boxed = new std::shared_ptr<coresim::VideoStreamSession>(std::move(session));
  Napi::Function ctor = env.GetInstanceData<AddonInstanceData>()->videoStreamConstructor.Value();
  return ctor.New({Napi::External<std::shared_ptr<coresim::VideoStreamSession>>::New(
      env, boxed, [](Napi::Env /*env*/, std::shared_ptr<coresim::VideoStreamSession>* data) { delete data; })});
}

// Wraps a live coresim::JpegStreamSession — same shape as NativeVideoStream minus
// `requestKeyFrame()` (meaningless here: every JPEG frame is already independently decodable, see
// sim_jpeg_stream.h). Frames/errors are delivered live via the callbacks passed directly to
// startJpegStream, not through this object — it only exposes `stop()`.
class NativeJpegStream : public Napi::ObjectWrap<NativeJpegStream> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<coresim::JpegStreamSession> session);
  explicit NativeJpegStream(const Napi::CallbackInfo& info);

 private:
  std::shared_ptr<coresim::JpegStreamSession> session_;

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto session = session_;
    return RunAsyncVoid(env, [session]() { session->Stop(); });
  }

  // See NativeVideoStream::Finalize for why this hands off to a background queue.
  void Finalize(Napi::Env env) override {
    auto session = std::move(session_);
    if (session) {
      env.GetInstanceData<AddonInstanceData>()->activeJpegStreams.Deregister(session);
      dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        session->Stop();
      });
    }
  }
};

NativeJpegStream::NativeJpegStream(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeJpegStream>(info) {
  auto* boxed = info[0].As<Napi::External<std::shared_ptr<coresim::JpegStreamSession>>>().Data();
  session_ = *boxed;
  info.Env().GetInstanceData<AddonInstanceData>()->activeJpegStreams.Register(session_);
}

void NativeJpegStream::Init(Napi::Env env) {
  Napi::Function ctor = DefineClass(env, "NativeJpegStream",
                                    {
                                        InstanceMethod<&NativeJpegStream::Stop>("stop"),
                                    });
  env.GetInstanceData<AddonInstanceData>()->jpegStreamConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeJpegStream::NewInstance(Napi::Env env, std::shared_ptr<coresim::JpegStreamSession> session) {
  auto* boxed = new std::shared_ptr<coresim::JpegStreamSession>(std::move(session));
  Napi::Function ctor = env.GetInstanceData<AddonInstanceData>()->jpegStreamConstructor.Value();
  return ctor.New({Napi::External<std::shared_ptr<coresim::JpegStreamSession>>::New(
      env, boxed, [](Napi::Env /*env*/, std::shared_ptr<coresim::JpegStreamSession>* data) { delete data; })});
}

// Wraps a live coresim::AVStreamSession — the combined-AV counterpart to NativeVideoStream above,
// same shape (only `stop()`/`requestKeyFrame()`; access units/errors are delivered live via the
// callbacks passed directly to startAVStream).
class NativeAVStream : public Napi::ObjectWrap<NativeAVStream> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<coresim::AVStreamSession> session);
  explicit NativeAVStream(const Napi::CallbackInfo& info);

 private:
  std::shared_ptr<coresim::AVStreamSession> session_;

  Napi::Value Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto session = session_;
    return RunAsyncVoid(env, [session]() { session->Stop(); });
  }

  Napi::Value RequestKeyFrame(const Napi::CallbackInfo& info) {
    if (session_) {
      session_->RequestKeyFrame();
    }
    return info.Env().Undefined();
  }

  // See NativeVideoStream::Finalize for why this hands off to a background queue.
  void Finalize(Napi::Env env) override {
    auto session = std::move(session_);
    if (session) {
      env.GetInstanceData<AddonInstanceData>()->activeAVStreams.Deregister(session);
      dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        session->Stop();
      });
    }
  }
};

NativeAVStream::NativeAVStream(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeAVStream>(info) {
  auto* boxed = info[0].As<Napi::External<std::shared_ptr<coresim::AVStreamSession>>>().Data();
  session_ = *boxed;
  info.Env().GetInstanceData<AddonInstanceData>()->activeAVStreams.Register(session_);
}

void NativeAVStream::Init(Napi::Env env) {
  Napi::Function ctor = DefineClass(env, "NativeAVStream",
                                    {
                                        InstanceMethod<&NativeAVStream::Stop>("stop"),
                                        InstanceMethod<&NativeAVStream::RequestKeyFrame>("requestKeyFrame"),
                                    });
  env.GetInstanceData<AddonInstanceData>()->avStreamConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeAVStream::NewInstance(Napi::Env env, std::shared_ptr<coresim::AVStreamSession> session) {
  auto* boxed = new std::shared_ptr<coresim::AVStreamSession>(std::move(session));
  Napi::Function ctor = env.GetInstanceData<AddonInstanceData>()->avStreamConstructor.Value();
  return ctor.New({Napi::External<std::shared_ptr<coresim::AVStreamSession>>::New(
      env, boxed, [](Napi::Env /*env*/, std::shared_ptr<coresim::AVStreamSession>* data) { delete data; })});
}

// Wraps a live coresim::AVRecordingSession, kept alive between startAVRecording and its returned
// handle's stop() — unlike startVideoRecording/stopVideoRecording, which address CoreSimulator's
// own internally-tracked private recorder purely by udid, this session is a real local resource
// (VTCompressionSession + Core Audio tap + AVAssetWriter) with no equivalent server-side handle.
class NativeAVRecording : public Napi::ObjectWrap<NativeAVRecording> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, std::shared_ptr<coresim::AVRecordingSession> session);
  explicit NativeAVRecording(const Napi::CallbackInfo& info);

 private:
  std::shared_ptr<coresim::AVRecordingSession> session_;

  // Resolves once the output file has been finalized on disk and is safe to read — mirrors
  // stopVideoRecording's own contract.
  Napi::Value Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto session = session_;
    return RunAsyncVoid(env, [session]() {
      dispatch_semaphore_t sema = dispatch_semaphore_create(0);
      NSError* capturedError = nil;
      session->Stop([sema, &capturedError](NSError* error) {
        capturedError = error;
        dispatch_semaphore_signal(sema);
      });
      dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
      if (capturedError != nil) {
        throw NSErrorException(capturedError);
      }
    });
  }

  // See NativeVideoStream::Finalize for why this hands off to a background queue — Stop()'s own
  // completion handler here is simply dropped rather than awaited, matching Finalize's existing
  // "GC thread must never block" contract for every session type.
  void Finalize(Napi::Env env) override {
    auto session = std::move(session_);
    if (session) {
      env.GetInstanceData<AddonInstanceData>()->activeAVRecordings.Deregister(session);
      dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
        session->Stop([](NSError*) {});
      });
    }
  }
};

NativeAVRecording::NativeAVRecording(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeAVRecording>(info) {
  auto* boxed = info[0].As<Napi::External<std::shared_ptr<coresim::AVRecordingSession>>>().Data();
  session_ = *boxed;
  info.Env().GetInstanceData<AddonInstanceData>()->activeAVRecordings.Register(session_);
}

void NativeAVRecording::Init(Napi::Env env) {
  Napi::Function ctor = DefineClass(env, "NativeAVRecording",
                                    {
                                        InstanceMethod<&NativeAVRecording::Stop>("stop"),
                                    });
  env.GetInstanceData<AddonInstanceData>()->avRecordingConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeAVRecording::NewInstance(Napi::Env env, std::shared_ptr<coresim::AVRecordingSession> session) {
  auto* boxed = new std::shared_ptr<coresim::AVRecordingSession>(std::move(session));
  Napi::Function ctor = env.GetInstanceData<AddonInstanceData>()->avRecordingConstructor.Value();
  return ctor.New({Napi::External<std::shared_ptr<coresim::AVRecordingSession>>::New(
      env, boxed, [](Napi::Env /*env*/, std::shared_ptr<coresim::AVRecordingSession>* data) { delete data; })});
}

// Wraps a recording started via CoreSimulator's own private recorder (sim_video_recording.h,
// addressed purely by `device` — no client-side live resource, unlike AVRecordingSession above)
// in the same `stop()` shape NativeAVRecording exposes for the `audio: true` path, so
// NativeDevice::StartVideoRecording can return one handle type either way regardless of which
// path it took. No registry/cleanup-hook entry needed: CoreSimulator owns the actual recorder
// state internally, so there's nothing here to force-stop if the JS wrapper is just GC'd.
class NativePrivateRecordingHandle : public Napi::ObjectWrap<NativePrivateRecordingHandle> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, id device);
  explicit NativePrivateRecordingHandle(const Napi::CallbackInfo& info);

 private:
  id device_;

  // Mirrors the previous standalone StopVideoRecording native method.
  Napi::Value Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    id device = device_;
    return RunAsyncVoid(env, [device]() {
      dispatch_semaphore_t sema = dispatch_semaphore_create(0);
      dispatch_queue_t queue = dispatch_queue_create("io.appium.coresim.stopRecordVideo", DISPATCH_QUEUE_SERIAL);
      __block NSError* capturedError = nil;
      NSError* resolveError = nil;
      BOOL ok = coresim::StopVideoRecording(
          device, queue,
          ^(NSError* asyncError) {
            capturedError = asyncError;
            dispatch_semaphore_signal(sema);
          },
          &resolveError);
      ThrowIfFailed(ok, resolveError);
      dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
      if (capturedError != nil) {
        throw NSErrorException(capturedError);
      }
    });
  }
};

NativePrivateRecordingHandle::NativePrivateRecordingHandle(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativePrivateRecordingHandle>(info) {
  device_ = UnwrapExternalId(info);
}

void NativePrivateRecordingHandle::Init(Napi::Env env) {
  Napi::Function ctor = DefineClass(env, "NativePrivateRecordingHandle",
                                    {
                                        InstanceMethod<&NativePrivateRecordingHandle::Stop>("stop"),
                                    });
  env.GetInstanceData<AddonInstanceData>()->privateRecordingConstructor = Napi::Persistent(ctor);
}

Napi::Object NativePrivateRecordingHandle::NewInstance(Napi::Env env, id device) {
  return WrapExternalId(env, env.GetInstanceData<AddonInstanceData>()->privateRecordingConstructor, device);
}

class NativeDevice : public Napi::ObjectWrap<NativeDevice> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, id device);
  explicit NativeDevice(const Napi::CallbackInfo& info);

  id device_;

 private:
  // Trivial in-memory accessors (no CoreSimulator dispatch that could block) — kept synchronous;
  // used internally by native-simctl.ts's toDeviceInfo(), never a slow operation on their own.
  Napi::Value Udid(const Napi::CallbackInfo& info) {
    return CatchToJs(info.Env(), [&]() -> Napi::Value {
      return Napi::String::New(info.Env(), DeviceUDID(device_).UUIDString.UTF8String);
    });
  }
  Napi::Value Name(const Napi::CallbackInfo& info) {
    return CatchToJs(info.Env(),
                     [&]() -> Napi::Value { return Napi::String::New(info.Env(), DeviceName(device_).UTF8String); });
  }
  Napi::Value State(const Napi::CallbackInfo& info) {
    return CatchToJs(info.Env(), [&]() -> Napi::Value {
      return Napi::Number::New(info.Env(), static_cast<double>(DeviceState(device_)));
    });
  }
  // deviceType/runtime are legitimately nil for a device whose runtime profile is no longer
  // installed (shows as "unavailable" in `simctl list devices`) — not an error, just unknown.
  Napi::Value DeviceTypeIdentifier(const Napi::CallbackInfo& info) {
    return CatchToJs(info.Env(), [&]() -> Napi::Value {
      id deviceType = DeviceDeviceType(device_);
      if (deviceType == nil) {
        return Napi::String::New(info.Env(), "");
      }
      return Napi::String::New(info.Env(), coresim::DeviceTypeIdentifier(deviceType).UTF8String);
    });
  }
  Napi::Value RuntimeIdentifier(const Napi::CallbackInfo& info) {
    return CatchToJs(info.Env(), [&]() -> Napi::Value {
      id runtime = DeviceRuntime(device_);
      if (runtime == nil) {
        return Napi::String::New(info.Env(), "");
      }
      return Napi::String::New(info.Env(), coresim::RuntimeIdentifier(runtime).UTF8String);
    });
  }
  Napi::Value RuntimeRootPath(const Napi::CallbackInfo& info) {
    return CatchToJs(info.Env(), [&]() -> Napi::Value {
      id runtime = DeviceRuntime(device_);
      if (runtime == nil) {
        return Napi::String::New(info.Env(), "");
      }
      return Napi::String::New(info.Env(), coresim::RuntimeRootPath(runtime).UTF8String);
    });
  }

  // Bridges SimDevice's GCD-completion-block-based bootAsyncWithOptions:completionQueue:
  // completionHandler: — this is what replaces the CLI's bootstatus poll-until-timeout race with
  // a deterministic completion signal.
  Napi::Value Boot(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    id device = device_;
    NSDictionary* options = OptionsArg(info, 0);
    return RunAsyncVoid(env, [device, options]() {
      dispatch_semaphore_t sema = dispatch_semaphore_create(0);
      dispatch_queue_t queue = dispatch_queue_create("io.appium.coresim.boot", DISPATCH_QUEUE_SERIAL);
      __block NSError* capturedError = nil;
      BootAsync(device, options, queue, ^(NSError* error) {
        capturedError = error;
        dispatch_semaphore_signal(sema);
      });
      dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
      if (capturedError != nil) {
        throw NSErrorException(capturedError);
      }
    });
  }

  // Exposes the same underlying signal `simctl bootstatus` itself monitors (see sim_device.h's
  // DeviceBootStatus) — a separate, more granular progress indicator than `state`. Returns `null`
  // if the device has never been booted; otherwise `{status, isTerminal}`, confirmed empirically
  // to *not* reset on shutdown (see CLAUDE.md) — callers wanting "is this device currently and
  // fully booted" must check `state === Booted` too, not `isTerminal` alone.
  Napi::Value GetBootStatus(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<BootStatusResult>(
        info.Env(),
        [device]() -> BootStatusResult {
          id bootInfo = coresim::DeviceBootStatus(device);
          if (bootInfo == nil) {
            return {};
          }
          return {true, coresim::BootInfoStatus(bootInfo), static_cast<bool>(coresim::BootInfoIsTerminal(bootInfo))};
        },
        [](Napi::Env env, BootStatusResult result) -> Napi::Value {
          if (!result.hasValue) {
            return env.Null();
          }
          Napi::Object obj = Napi::Object::New(env);
          obj.Set("status", static_cast<double>(result.status));
          obj.Set("isTerminal", result.isTerminal);
          return obj;
        });
  }

  Napi::Value Shutdown(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsyncVoid(info.Env(), [device]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::Shutdown(device, &error), error);
    });
  }

  Napi::Value Erase(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsyncVoid(info.Env(), [device]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::Erase(device, &error), error);
    });
  }

  Napi::Value Getenv(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* name = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsync<NSString*>(
        info.Env(),
        [device, name]() -> NSString* {
          NSError* error = nil;
          NSString* result = coresim::Getenv(device, name, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSString* result) -> Napi::Value {
          return Napi::String::New(env, result ? result.UTF8String : "");
        });
  }

  Napi::Value InstallApp(const Napi::CallbackInfo& info) {
    id device = device_;
    NSURL* url = [NSURL fileURLWithPath:@(info[0].As<Napi::String>().Utf8Value().c_str())];
    NSDictionary* options = OptionsArg(info, 1);
    return RunAsyncVoid(info.Env(), [device, url, options]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::InstallApp(device, url, options, &error), error);
    });
  }

  Napi::Value UninstallApp(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* bundleId = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSDictionary* options = OptionsArg(info, 1);
    return RunAsyncVoid(info.Env(), [device, bundleId, options]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::UninstallApp(device, bundleId, options, &error), error);
    });
  }

  Napi::Value LaunchApp(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* bundleId = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSDictionary* options = OptionsArg(info, 1);
    return RunAsync<int>(
        info.Env(),
        [device, bundleId, options]() -> int {
          NSError* error = nil;
          int pid = coresim::LaunchApp(device, bundleId, options, &error);
          ThrowIfFailed(pid > 0, error);
          return pid;
        },
        [](Napi::Env env, int pid) -> Napi::Value { return Napi::Number::New(env, pid); });
  }

  Napi::Value TerminateApp(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* bundleId = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsyncVoid(info.Env(), [device, bundleId]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::TerminateApp(device, bundleId, &error), error);
    });
  }

  Napi::Value PropertiesOfApplication(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* bundleId = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsync<NSDictionary*>(
        info.Env(),
        [device, bundleId]() -> NSDictionary* {
          NSError* error = nil;
          NSDictionary* result = coresim::PropertiesOfApplication(device, bundleId, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSDictionary* result) -> Napi::Value { return NSObjectToJsValue(env, result); });
  }

  Napi::Value InstalledApps(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<NSDictionary*>(
        info.Env(),
        [device]() -> NSDictionary* {
          NSError* error = nil;
          NSDictionary* result = coresim::InstalledApps(device, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSDictionary* result) -> Napi::Value { return NSObjectToJsValue(env, result); });
  }

  Napi::Value OpenUrl(const Napi::CallbackInfo& info) {
    id device = device_;
    NSURL* url = [NSURL URLWithString:@(info[0].As<Napi::String>().Utf8Value().c_str())];
    return RunAsyncVoid(info.Env(), [device, url]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::OpenURL(device, url, &error), error);
    });
  }

  Napi::Value SetLocation(const Napi::CallbackInfo& info) {
    id device = device_;
    double latitude = info[0].As<Napi::Number>().DoubleValue();
    double longitude = info[1].As<Napi::Number>().DoubleValue();
    return RunAsyncVoid(info.Env(), [device, latitude, longitude]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::SetLocation(device, latitude, longitude, &error), error);
    });
  }

  Napi::Value ClearLocation(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsyncVoid(info.Env(), [device]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::ClearLocation(device, &error), error);
    });
  }

  Napi::Value SetOrientation(const Napi::CallbackInfo& info) {
    id device = device_;
    int32_t orientation = info[0].As<Napi::Number>().Int32Value();
    return RunAsyncVoid(info.Env(), [device, orientation]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::SetDeviceOrientation(device, orientation, &error), error);
    });
  }

  Napi::Value SendPushNotification(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* bundleId = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSDictionary* payload = (NSDictionary*)JsValueToNSObject(info.Env(), info[1]);
    return RunAsyncVoid(info.Env(), [device, bundleId, payload]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::SendPushNotification(device, bundleId, payload, &error), error);
    });
  }

  Napi::Value AddCertificate(const Napi::CallbackInfo& info) {
    id device = device_;
    NSURL* url = [NSURL fileURLWithPath:@(info[0].As<Napi::String>().Utf8Value().c_str())];
    BOOL trustAsRoot = info.Length() > 1 && info[1].As<Napi::Boolean>().Value();
    return RunAsyncVoid(info.Env(), [device, url, trustAsRoot]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::AddCertificate(device, url, trustAsRoot, &error), error);
    });
  }

  Napi::Value ResetKeychain(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsyncVoid(info.Env(), [device]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::ResetKeychain(device, &error), error);
    });
  }

  Napi::Value GetUIAppearance(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<long long>(
        info.Env(), [device]() -> long long { return CurrentUIInterfaceStyle(device); },
        [](Napi::Env env, long long style) -> Napi::Value {
          return Napi::Number::New(env, static_cast<double>(style));
        });
  }

  Napi::Value SetUIAppearance(const Napi::CallbackInfo& info) {
    id device = device_;
    long long style = info[0].As<Napi::Number>().Int64Value();
    return RunAsyncVoid(info.Env(), [device, style]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::SetUIInterfaceStyle(device, style, &error), error);
    });
  }

  Napi::Value GetIncreaseContrast(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<long long>(
        info.Env(), [device]() -> long long { return CurrentIncreaseContrastMode(device); },
        [](Napi::Env env, long long mode) -> Napi::Value { return Napi::Number::New(env, static_cast<double>(mode)); });
  }

  Napi::Value SetIncreaseContrast(const Napi::CallbackInfo& info) {
    id device = device_;
    BOOL enabled = info[0].As<Napi::Boolean>().Value();
    return RunAsyncVoid(info.Env(), [device, enabled]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::SetIncreaseContrastEnabled(device, enabled, &error), error);
    });
  }

  Napi::Value GetContentSize(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<long long>(
        info.Env(), [device]() -> long long { return CurrentContentSizeCategory(device); },
        [](Napi::Env env, long long category) -> Napi::Value {
          return Napi::Number::New(env, static_cast<double>(category));
        });
  }

  Napi::Value SetContentSize(const Napi::CallbackInfo& info) {
    id device = device_;
    long long category = info[0].As<Napi::Number>().Int64Value();
    return RunAsyncVoid(info.Env(), [device, category]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::SetContentSizeCategory(device, category, &error), error);
    });
  }

  // `grantPermission`'s optional 3rd JS argument is a status override ("limited"), used only for
  // kTCCServicePhotos's "selected photos" access — see commands/permissions.ts.
  Napi::Value GrantPermission(const Napi::CallbackInfo& info) {
    TCCAuthStatus desiredStatus = kTCCAuthGranted;
    if (info.Length() > 2 && info[2].IsString() && info[2].As<Napi::String>().Utf8Value() == "limited") {
      desiredStatus = kTCCAuthLimited;
    }
    return SetPermission(info, desiredStatus);
  }
  Napi::Value RevokePermission(const Napi::CallbackInfo& info) { return SetPermission(info, kTCCAuthDenied); }

  // Writes directly to the simulator's own TCC.db instead of calling CoreSimulator's
  // setPrivacyAccessForService:bundleID:granted:error: — that private method requires the calling
  // process to hold an entitlement no ordinary npm package can obtain (see CLAUDE.md).
  Napi::Value SetPermission(const Napi::CallbackInfo& info, TCCAuthStatus desiredStatus) {
    id device = device_;
    NSString* service = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSString* bundleId = @(info[1].As<Napi::String>().Utf8Value().c_str());
    return RunAsyncVoid(info.Env(), [device, service, bundleId, desiredStatus]() {
      NSError* error = nil;
      NSString* dataPath = coresim::DeviceDataPath(device);
      ThrowIfFailed(coresim::SetTCCAccess(dataPath, service, bundleId, desiredStatus, &error), error);
    });
  }

  Napi::Value ResetPermission(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* service = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSString* bundleId = @(info[1].As<Napi::String>().Utf8Value().c_str());
    return RunAsyncVoid(info.Env(), [device, service, bundleId]() {
      NSError* error = nil;
      NSString* dataPath = coresim::DeviceDataPath(device);
      ThrowIfFailed(coresim::ResetTCCAccess(dataPath, service, bundleId, &error), error);
    });
  }

  // Reads directly from the same TCC.db SetPermission/ResetPermission write to — no
  // CoreSimulator getter for privacy-access state exists (see tcc_privacy.h).
  Napi::Value GetPermission(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* service = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSString* bundleId = @(info[1].As<Napi::String>().Utf8Value().c_str());
    return RunAsync<TCCAuthStatus>(
        info.Env(),
        [device, service, bundleId]() -> TCCAuthStatus {
          NSError* error = nil;
          TCCAuthStatus status = kTCCAuthNotDetermined;
          NSString* dataPath = coresim::DeviceDataPath(device);
          ThrowIfFailed(coresim::GetTCCAccess(dataPath, service, bundleId, &status, &error), error);
          return status;
        },
        [](Napi::Env env, TCCAuthStatus status) -> Napi::Value {
          return Napi::String::New(env, TCCAuthStatusToString(status));
        });
  }

  Napi::Value DarwinNotificationGetState(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* name = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsync<unsigned long long>(
        info.Env(),
        [device, name]() -> unsigned long long {
          unsigned long long state = 0;
          NSError* error = nil;
          ThrowIfFailed(coresim::DarwinNotificationGetState(device, &state, name, &error), error);
          return state;
        },
        // A JS `number` (double) only has 53 bits of integer precision — this state is a full
        // 64-bit value any process can stuff an arbitrary counter or bit field into (see
        // commands/darwin-notification.ts), so it's exposed as a bigint instead, via the matching
        // Node-API uint64 conversion, rather than silently rounding it on the way out.
        [](Napi::Env env, unsigned long long state) -> Napi::Value { return Napi::BigInt::New(env, state); });
  }

  Napi::Value DarwinNotificationSetState(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* name = @(info[0].As<Napi::String>().Utf8Value().c_str());
    bool lossless = false;
    unsigned long long state = info[1].As<Napi::BigInt>().Uint64Value(&lossless);
    // Checked inside the async lambda (not thrown synchronously here) so an out-of-range bigint
    // rejects the returned promise like every other failure this method can have, instead of
    // throwing synchronously and behaving inconsistently with the rest of the async API surface.
    return RunAsyncVoid(info.Env(), [device, name, state, lossless]() {
      if (!lossless) {
        throw std::invalid_argument("state must fit in an unsigned 64-bit integer (0 to 2^64-1)");
      }
      NSError* error = nil;
      ThrowIfFailed(coresim::DarwinNotificationSetState(device, state, name, &error), error);
    });
  }

  Napi::Value PostDarwinNotification(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* name = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsyncVoid(info.Env(), [device, name]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::PostDarwinNotification(device, name, &error), error);
    });
  }

  Napi::Value AddMedia(const Napi::CallbackInfo& info) {
    id device = device_;
    Napi::Array paths = info[0].As<Napi::Array>();
    NSMutableArray<NSURL*>* fileURLs = [NSMutableArray arrayWithCapacity:paths.Length()];
    for (uint32_t i = 0; i < paths.Length(); i++) {
      Napi::Value path = paths.Get(i);
      [fileURLs addObject:[NSURL fileURLWithPath:@(path.As<Napi::String>().Utf8Value().c_str())]];
    }
    return RunAsyncVoid(info.Env(), [device, fileURLs]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::AddMedia(device, fileURLs, &error), error);
    });
  }

  Napi::Value AddPhoto(const Napi::CallbackInfo& info) {
    id device = device_;
    NSURL* url = [NSURL fileURLWithPath:@(info[0].As<Napi::String>().Utf8Value().c_str())];
    return RunAsyncVoid(info.Env(), [device, url]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::AddPhoto(device, url, &error), error);
    });
  }

  Napi::Value AddVideo(const Napi::CallbackInfo& info) {
    id device = device_;
    NSURL* url = [NSURL fileURLWithPath:@(info[0].As<Napi::String>().Utf8Value().c_str())];
    return RunAsyncVoid(info.Env(), [device, url]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::AddVideo(device, url, &error), error);
    });
  }

  Napi::Value GetPasteboard(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<NSString*>(
        info.Env(),
        [device]() -> NSString* {
          NSError* error = nil;
          NSString* result = coresim::PullPasteboardString(device, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSString* result) -> Napi::Value {
          return Napi::String::New(env, result ? result.UTF8String : "");
        });
  }

  Napi::Value SetPasteboard(const Napi::CallbackInfo& info) {
    id device = device_;
    NSString* content = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsyncVoid(info.Env(), [device, content]() {
      NSError* error = nil;
      ThrowIfFailed(coresim::PushPasteboardString(device, content, &error), error);
    });
  }

  // See native/sim_process.h.
  Napi::Value GetWebInspectorSocket(const Napi::CallbackInfo& info) {
    NSString* udid = DeviceUDID(device_).UUIDString;
    return RunAsync<NSString*>(
        info.Env(),
        [udid]() -> NSString* {
          NSError* error = nil;
          NSString* result = coresim::FindWebInspectorSocket(udid, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSString* result) -> Napi::Value {
          return Napi::String::New(env, result ? result.UTF8String : "");
        });
  }

  // `format`/`displayId`/`quality` are this addon's own options, not a CoreSimulator options
  // dictionary — the TS layer (commands/screenshot.ts) already constrains `format` to
  // 'png'/'jpeg' and `quality` to a finite 0-100, so anything else (including absent) is just
  // defaulted here rather than validated again.
  Napi::Value Screenshot(const Napi::CallbackInfo& info) {
    id device = device_;
    coresim::ScreenshotFormat format = coresim::ScreenshotFormat::kPNG;
    NSString* displayId = nil;
    NSNumber* jpegQualityPercent = nil;
    if (info.Length() > 0 && info[0].IsObject()) {
      Napi::Object options = info[0].As<Napi::Object>();
      if (options.Has("format") && options.Get("format").IsString() &&
          options.Get("format").As<Napi::String>().Utf8Value() == "jpeg") {
        format = coresim::ScreenshotFormat::kJPEG;
      }
      if (options.Has("displayId") && options.Get("displayId").IsString()) {
        displayId = @(options.Get("displayId").As<Napi::String>().Utf8Value().c_str());
      }
      if (options.Has("quality") && options.Get("quality").IsNumber()) {
        jpegQualityPercent = @(options.Get("quality").As<Napi::Number>().DoubleValue());
      }
    }
    return RunAsync<NSData*>(
        info.Env(),
        [device, displayId, format, jpegQualityPercent]() -> NSData* {
          NSError* error = nil;
          NSData* result = coresim::CaptureScreenshot(device, displayId, format, jpegQualityPercent, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSData* result) -> Napi::Value {
          return Napi::Buffer<uint8_t>::Copy(env, static_cast<const uint8_t*>(result.bytes), result.length);
        });
  }

  Napi::Value GetDisplays(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<NSArray*>(
        info.Env(),
        [device]() -> NSArray* {
          NSError* error = nil;
          NSArray* result = coresim::ListDisplays(device, &error);
          ThrowIfFailed(result != nil, error);
          return result;
        },
        [](Napi::Env env, NSArray* result) -> Napi::Value { return NSObjectToJsValue(env, result); });
  }

  Napi::Value GetOrientation(const Napi::CallbackInfo& info) {
    id device = device_;
    return RunAsync<int32_t>(
        info.Env(),
        [device]() -> int32_t {
          dispatch_semaphore_t sema = dispatch_semaphore_create(0);
          __block int32_t result = 1;
          coresim::ReadGuestOrientation(device, ^(int32_t orientation) {
            result = orientation;
            dispatch_semaphore_signal(sema);
          });
          dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
          return result;
        },
        [](Napi::Env env, int32_t result) -> Napi::Value { return Napi::Number::New(env, result); });
  }

  // Shared by StartVideoRecording (audio path)/StartVideoStream — `argIndex` is where the options
  // object (if any) sits in `info`.
  static coresim::VideoEncoderOptions ParseVideoEncoderOptions(const Napi::CallbackInfo& info, size_t argIndex) {
    NSString* displayId = nil;
    coresim::VideoStreamCodec codec = coresim::VideoStreamCodec::kH264;
    double fps = 60.0;
    int bitrate = 4000000;
    if (info.Length() > argIndex && info[argIndex].IsObject()) {
      Napi::Object options = info[argIndex].As<Napi::Object>();
      if (options.Has("displayId") && options.Get("displayId").IsString()) {
        displayId = @(options.Get("displayId").As<Napi::String>().Utf8Value().c_str());
      }
      if (options.Has("codec") && options.Get("codec").IsString() &&
          options.Get("codec").As<Napi::String>().Utf8Value() == "hevc") {
        codec = coresim::VideoStreamCodec::kHEVC;
      }
      if (options.Has("fps") && options.Get("fps").IsNumber()) {
        fps = options.Get("fps").As<Napi::Number>().DoubleValue();
      }
      if (options.Has("bitrate") && options.Get("bitrate").IsNumber()) {
        bitrate = options.Get("bitrate").As<Napi::Number>().Int32Value();
      }
    }
    return coresim::VideoEncoderOptions{codec, displayId, fps, bitrate};
  }

  // `quality`/`displayId`/`fps` are this addon's own options, not a CoreSimulator options
  // dictionary — the TS layer (commands/jpeg-stream.ts) already constrains them, so anything else
  // (including absent) is just defaulted here rather than validated again (mirrors Screenshot's
  // identical comment above).
  static coresim::JpegStreamOptions ParseJpegStreamOptions(const Napi::CallbackInfo& info, size_t argIndex) {
    NSString* displayId = nil;
    double fps = 60.0;
    // Defaults to 80, not ImageIO's own (near-lossless, much larger) default — see
    // JpegStreamOptions's own comment (sim_jpeg_stream.h) for why.
    NSNumber* jpegQualityPercent = @80;
    double scale = 1.0;
    if (info.Length() > argIndex && info[argIndex].IsObject()) {
      Napi::Object options = info[argIndex].As<Napi::Object>();
      if (options.Has("displayId") && options.Get("displayId").IsString()) {
        displayId = @(options.Get("displayId").As<Napi::String>().Utf8Value().c_str());
      }
      if (options.Has("fps") && options.Get("fps").IsNumber()) {
        fps = options.Get("fps").As<Napi::Number>().DoubleValue();
      }
      if (options.Has("quality") && options.Get("quality").IsNumber()) {
        jpegQualityPercent = @(options.Get("quality").As<Napi::Number>().DoubleValue());
      }
      // JS-facing `scale` is a 1-100 percent (commands/jpeg-stream.ts already validates the
      // range), converted here to the 0.0-1.0 fraction JpegStreamSession actually applies.
      if (options.Has("scale") && options.Get("scale").IsNumber()) {
        scale = options.Get("scale").As<Napi::Number>().DoubleValue() / 100.0;
      }
    }
    return coresim::JpegStreamOptions{displayId, fps, jpegQualityPercent, scale};
  }

  static bool OptionsWantAudio(const Napi::CallbackInfo& info, size_t argIndex) {
    return info.Length() > argIndex && info[argIndex].IsObject() && info[argIndex].As<Napi::Object>().Has("audio") &&
           info[argIndex].As<Napi::Object>().Get("audio").IsBoolean() &&
           info[argIndex].As<Napi::Object>().Get("audio").As<Napi::Boolean>().Value();
  }

  static bool OptionsHasFps(const Napi::CallbackInfo& info, size_t argIndex) {
    return info.Length() > argIndex && info[argIndex].IsObject() && info[argIndex].As<Napi::Object>().Has("fps") &&
           info[argIndex].As<Napi::Object>().Get("fps").IsNumber();
  }

  // Mirrors `simctl io <udid> recordVideo` by default — CoreSimulator's own private, video-only
  // recorder (see sim_video_recording.mm), which supports `mask`/`bitrate` but has no polling loop
  // for `fps` to cap. With `options.audio` OR an explicit `options.fps` (which only means something
  // against a real polling loop), drives this addon's own encoders instead (av_recording.h) — video
  // only when `fps` was the sole reason, video+audio when `audio` was set too — since the private
  // recorder has no per-frame hook to mux audio into and no `fps` knob either way. `mask` is not
  // supported on this path. Either way returns a handle (NativePrivateRecordingHandle or
  // NativeAVRecording — see their own doc comments) exposing the identical `stop()` shape, so the
  // caller never needs to know which path it took.
  Napi::Value StartVideoRecording(const Napi::CallbackInfo& info) {
    NSString* outputFile = @(info[0].As<Napi::String>().Utf8Value().c_str());
    bool wantsAudio = OptionsWantAudio(info, 1);
    if (wantsAudio || OptionsHasFps(info, 1)) {
      return StartAVRecording(info, outputFile, wantsAudio);
    }
    return StartPrivateVideoRecording(info, outputFile);
  }

  // Resolves once the first frame is recorded — see CLAUDE.md for the race hit by calling this
  // handle's own stop() any earlier.
  Napi::Value StartPrivateVideoRecording(const Napi::CallbackInfo& info, NSString* outputFile) {
    Napi::Env env = info.Env();
    id device = device_;
    NSString* displayId = nil;
    coresim::VideoMaskPolicy mask = coresim::VideoMaskPolicy::kIgnored;
    NSMutableDictionary* assetWriterOutputSettings = [NSMutableDictionary dictionary];
    if (info.Length() > 1 && info[1].IsObject()) {
      Napi::Object options = info[1].As<Napi::Object>();
      if (options.Has("displayId") && options.Get("displayId").IsString()) {
        displayId = @(options.Get("displayId").As<Napi::String>().Utf8Value().c_str());
      }
      if (options.Has("mask") && options.Get("mask").IsString()) {
        std::string maskValue = options.Get("mask").As<Napi::String>().Utf8Value();
        if (maskValue == "alpha") {
          mask = coresim::VideoMaskPolicy::kAlpha;
        } else if (maskValue == "black") {
          mask = coresim::VideoMaskPolicy::kBlack;
        }
      }
      if (options.Has("codec") && options.Get("codec").IsString()) {
        std::string codecValue = options.Get("codec").As<Napi::String>().Utf8Value();
        assetWriterOutputSettings[AVVideoCodecKey] = codecValue == "hevc" ? AVVideoCodecTypeHEVC : AVVideoCodecTypeH264;
      }
      if (options.Has("bitrate") && options.Get("bitrate").IsNumber()) {
        int bitrate = options.Get("bitrate").As<Napi::Number>().Int32Value();
        assetWriterOutputSettings[AVVideoCompressionPropertiesKey] = @{AVVideoAverageBitRateKey : @(bitrate)};
      }
    }
    return RunAsync<id>(
        env,
        [device, displayId, mask, assetWriterOutputSettings, outputFile]() -> id {
          dispatch_semaphore_t sema = dispatch_semaphore_create(0);
          dispatch_queue_t queue = dispatch_queue_create("io.appium.coresim.recordVideo", DISPATCH_QUEUE_SERIAL);
          __block NSError* capturedError = nil;
          NSError* resolveError = nil;
          BOOL ok = coresim::StartVideoRecording(
              device, displayId, mask, assetWriterOutputSettings, outputFile, queue,
              ^(NSError* asyncError) {
                capturedError = asyncError;
                dispatch_semaphore_signal(sema);
              },
              &resolveError);
          ThrowIfFailed(ok, resolveError);
          dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
          if (capturedError != nil) {
            throw NSErrorException(capturedError);
          }
          return device;
        },
        [](Napi::Env env, id device) -> Napi::Value { return NativePrivateRecordingHandle::NewInstance(env, device); });
  }

  // Recording via this addon's own encoders — see av_recording.h. Combined audio+video when
  // `captureAudio` is set, video-only (via the same VideoFrameEncoder, just no audio tap/track)
  // when it's not — reached with `captureAudio == false` when `fps` was requested without `audio`
  // (see StartVideoRecording). Resolves once the first sample (video, or whichever of video/audio
  // comes first when both are captured) is written.
  Napi::Value StartAVRecording(const Napi::CallbackInfo& info, NSString* outputFile, bool captureAudio) {
    Napi::Env env = info.Env();
    id device = device_;
    NSString* udid = DeviceUDID(device).UUIDString;
    coresim::VideoEncoderOptions videoOptions = ParseVideoEncoderOptions(info, 1);
    Napi::Function onError = info[2].As<Napi::Function>();

    // Released either from within onEnd_ (a live failure, which fires at most once per session —
    // see av_recording.h) or, if the recording fails before ever starting, right below instead
    // (onEnd_ never fires for a Start() that never got past its own setup).
    Napi::ThreadSafeFunction errorTsfn =
        Napi::ThreadSafeFunction::New(env, onError, "coresim AV recording error", 0, 1);

    return RunAsync<std::shared_ptr<coresim::AVRecordingSession>>(
        env,
        [device, udid, videoOptions, outputFile, captureAudio,
         errorTsfn]() mutable -> std::shared_ptr<coresim::AVRecordingSession> {
          auto session =
              std::make_shared<coresim::AVRecordingSession>(device, udid, videoOptions, outputFile, captureAudio);
          dispatch_semaphore_t sema = dispatch_semaphore_create(0);
          auto resolved = std::make_shared<std::atomic<bool>>(false);
          // Only ever written before `sema` is signaled on the "failed before starting" path
          // below, so `work`'s frame (and this variable) is always still alive when it happens.
          NSError* startupError = nil;
          try {
            session->Start(
                [sema, resolved]() mutable {
                  resolved->store(true);
                  dispatch_semaphore_signal(sema);
                },
                [errorTsfn, resolved, sema, &startupError](NSError* error) mutable {
                  if (!resolved->exchange(true)) {
                    // Failed before ever starting — reported via this call's own rejection below,
                    // not the live error channel (nothing has "started" yet to report a live
                    // failure for).
                    startupError = error;
                    dispatch_semaphore_signal(sema);
                    return;
                  }
                  NSErrorException exception(error);
                  errorTsfn.BlockingCall([exception](Napi::Env env, Napi::Function jsCallback) {
                    // See StartVideoStream's identical comment on why this is wrapped in try/catch.
                    try {
                      jsCallback.Call({NSErrorExceptionToJsError(env, exception).Value()});
                    } catch (...) {
                    }
                  });
                },
                [errorTsfn]() mutable { errorTsfn.Release(); });
          } catch (...) {
            errorTsfn.Release();
            throw;
          }
          dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
          if (startupError != nil) {
            throw NSErrorException(startupError);
          }
          return session;
        },
        [](Napi::Env env, std::shared_ptr<coresim::AVRecordingSession> session) -> Napi::Value {
          return NativeAVRecording::NewInstance(env, session);
        });
  }

  // Real-time encoding via public VideoToolbox APIs (see sim_video_stream.mm) — no private API,
  // no file. With `options.audio`, also drives this addon's Core Audio + AudioToolbox encoder
  // (av_stream.h), interleaving audio units into the same delivered sequence (each tagged
  // `track`). `onAccessUnit`/`onError` are invoked live for as long as the stream runs; the
  // returned handle (NativeVideoStream or NativeAVStream — identical `stop()`/`requestKeyFrame()`
  // shape either way) is all the caller needs, regardless of which path it took.
  Napi::Value StartVideoStream(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    id device = device_;
    coresim::VideoEncoderOptions options = ParseVideoEncoderOptions(info, 0);
    Napi::Function onAccessUnit = info[1].As<Napi::Function>();
    Napi::Function onError = info[2].As<Napi::Function>();

    // Must be constructed on the main thread, like Spawn's own exitTsfn above; released exactly
    // once each, via onEnd (see sim_video_stream.h/av_stream.h).
    //
    // accessUnitTsfn's queue is bounded, unlike every other one-shot-callback ThreadSafeFunction
    // in this addon — a slow-draining consumer would otherwise let queued frame buffers grow
    // unbounded; BlockingCall below naturally throttles the encoder(s) once this fills instead.
    static constexpr size_t kAccessUnitQueueSize = 60;
    Napi::ThreadSafeFunction accessUnitTsfn =
        Napi::ThreadSafeFunction::New(env, onAccessUnit, "coresim video stream access unit", kAccessUnitQueueSize, 1);
    Napi::ThreadSafeFunction errorTsfn =
        Napi::ThreadSafeFunction::New(env, onError, "coresim video stream error", 0, 1);
    // See TsfnReleaseGuard's own comment — shared between onEnd's release and AbortDelivery's
    // abort below so exactly one of them ever actually runs.
    auto tsfnGuard = std::make_shared<TsfnReleaseGuard>();

    if (OptionsWantAudio(info, 0)) {
      NSString* udid = DeviceUDID(device).UUIDString;
      return RunAsync<std::shared_ptr<coresim::AVStreamSession>>(
          env,
          [device, udid, options, accessUnitTsfn, errorTsfn,
           tsfnGuard]() mutable -> std::shared_ptr<coresim::AVStreamSession> {
            auto session = std::make_shared<coresim::AVStreamSession>(
                device, udid, options,
                [accessUnitTsfn](coresim::AVAccessUnit unit) mutable {
                  accessUnitTsfn.BlockingCall(
                      [unit = std::move(unit)](Napi::Env env, Napi::Function jsCallback) mutable {
                        // See the audio-less branch's identical comment on why this is wrapped in
                        // try/catch.
                        try {
                          Napi::Object obj = Napi::Object::New(env);
                          obj.Set("track",
                                  Napi::String::New(env, unit.track == coresim::AVTrack::kVideo ? "video" : "audio"));
                          obj.Set("data", Napi::Buffer<uint8_t>::Copy(env, unit.data.data(), unit.data.size()));
                          obj.Set("isKeyFrame", Napi::Boolean::New(env, unit.isKeyFrame));
                          obj.Set("sequence", Napi::Number::New(env, static_cast<double>(unit.sequence)));
                          obj.Set("timestampMicros", Napi::Number::New(env, static_cast<double>(unit.timestampMicros)));
                          jsCallback.Call({obj});
                        } catch (...) {
                        }
                      });
                },
                [errorTsfn](NSError* error) mutable {
                  NSErrorException exception(error);
                  errorTsfn.BlockingCall([exception](Napi::Env env, Napi::Function jsCallback) {
                    try {
                      jsCallback.Call({NSErrorExceptionToJsError(env, exception).Value()});
                    } catch (...) {
                    }
                  });
                },
                [accessUnitTsfn, errorTsfn, tsfnGuard]() mutable {
                  ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                    accessUnitTsfn.Release();
                    errorTsfn.Release();
                  });
                },
                [accessUnitTsfn, errorTsfn, tsfnGuard]() mutable {
                  // See ActiveSessionRegistry::StopAll's use of AbortDelivery — unblocks a
                  // producer thread stuck pushing into a full queue so Stop() doesn't deadlock
                  // waiting on it.
                  ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                    accessUnitTsfn.Abort();
                    errorTsfn.Abort();
                  });
                });
            try {
              session->Start();
            } catch (...) {
              ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                accessUnitTsfn.Release();
                errorTsfn.Release();
              });
              throw;
            }
            return session;
          },
          [](Napi::Env env, std::shared_ptr<coresim::AVStreamSession> session) -> Napi::Value {
            return NativeAVStream::NewInstance(env, session);
          });
    }

    return RunAsync<std::shared_ptr<coresim::VideoStreamSession>>(
        env,
        [device, options, accessUnitTsfn, errorTsfn,
         tsfnGuard]() mutable -> std::shared_ptr<coresim::VideoStreamSession> {
          auto session = std::make_shared<coresim::VideoStreamSession>(
              device, options,
              [accessUnitTsfn](coresim::VideoAccessUnit unit) mutable {
                accessUnitTsfn.BlockingCall([unit = std::move(unit)](Napi::Env env, Napi::Function jsCallback) mutable {
                  // The Environment can already be mid-teardown by the time a queued callback
                  // like this one actually runs (e.g. worker.terminate() while frames were still
                  // piling up) — node-addon-api's own WrapVoidCallback would otherwise re-throw
                  // whatever escapes here as a JS exception, which itself aborts the process on a
                  // torn-down env instead of just failing to deliver a frame nothing can receive
                  // anymore. See CLAUDE.md.
                  try {
                    Napi::Object obj = Napi::Object::New(env);
                    obj.Set("track", Napi::String::New(env, "video"));
                    obj.Set("data", Napi::Buffer<uint8_t>::Copy(env, unit.data.data(), unit.data.size()));
                    obj.Set("isKeyFrame", Napi::Boolean::New(env, unit.isKeyFrame));
                    obj.Set("sequence", Napi::Number::New(env, static_cast<double>(unit.sequence)));
                    obj.Set("timestampMicros", Napi::Number::New(env, static_cast<double>(unit.timestampMicros)));
                    jsCallback.Call({obj});
                  } catch (...) {
                  }
                });
              },
              [errorTsfn](NSError* error) mutable {
                NSErrorException exception(error);
                errorTsfn.BlockingCall([exception](Napi::Env env, Napi::Function jsCallback) {
                  // See accessUnitTsfn's callback above.
                  try {
                    jsCallback.Call({NSErrorExceptionToJsError(env, exception).Value()});
                  } catch (...) {
                  }
                });
              },
              [accessUnitTsfn, errorTsfn, tsfnGuard]() mutable {
                ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                  accessUnitTsfn.Release();
                  errorTsfn.Release();
                });
              },
              [accessUnitTsfn, errorTsfn, tsfnGuard]() mutable {
                // See the audio branch's identical comment above.
                ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                  accessUnitTsfn.Abort();
                  errorTsfn.Abort();
                });
              });
          try {
            session->Start();
          } catch (...) {
            ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
              accessUnitTsfn.Release();
              errorTsfn.Release();
            });
            throw;
          }
          return session;
        },
        [](Napi::Env env, std::shared_ptr<coresim::VideoStreamSession> session) -> Napi::Value {
          return NativeVideoStream::NewInstance(env, session);
        });
  }

  // Real-time JPEG frame stream via ImageIO (see sim_jpeg_stream.mm) — a client-side MJPEG stream
  // is just this frame sequence multipart-boundary-framed over HTTP, which coresim itself has no
  // opinion about. Same TSFN/registry/teardown shape as StartVideoStream's audio-less branch,
  // minus keyframes/resync (every JPEG frame is independently decodable).
  Napi::Value StartJpegStream(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    id device = device_;
    coresim::JpegStreamOptions options = ParseJpegStreamOptions(info, 0);
    Napi::Function onFrame = info[1].As<Napi::Function>();
    Napi::Function onError = info[2].As<Napi::Function>();

    // See StartVideoStream's identical comment on accessUnitTsfn — bounded so a slow-draining
    // consumer throttles the encoder via BlockingCall instead of letting queued frames grow
    // unbounded.
    static constexpr size_t kFrameQueueSize = 60;
    Napi::ThreadSafeFunction frameTsfn =
        Napi::ThreadSafeFunction::New(env, onFrame, "coresim jpeg stream frame", kFrameQueueSize, 1);
    Napi::ThreadSafeFunction errorTsfn = Napi::ThreadSafeFunction::New(env, onError, "coresim jpeg stream error", 0, 1);
    auto tsfnGuard = std::make_shared<TsfnReleaseGuard>();

    return RunAsync<std::shared_ptr<coresim::JpegStreamSession>>(
        env,
        [device, options, frameTsfn, errorTsfn, tsfnGuard]() mutable -> std::shared_ptr<coresim::JpegStreamSession> {
          auto session = std::make_shared<coresim::JpegStreamSession>(
              device, options,
              [frameTsfn](coresim::JpegFrame frame) mutable {
                frameTsfn.BlockingCall([frame = std::move(frame)](Napi::Env env, Napi::Function jsCallback) mutable {
                  // See StartVideoStream's identical comment on why this is wrapped in try/catch.
                  try {
                    Napi::Object obj = Napi::Object::New(env);
                    obj.Set("data", Napi::Buffer<uint8_t>::Copy(env, frame.data.data(), frame.data.size()));
                    obj.Set("sequence", Napi::Number::New(env, static_cast<double>(frame.sequence)));
                    obj.Set("timestampMicros", Napi::Number::New(env, static_cast<double>(frame.timestampMicros)));
                    jsCallback.Call({obj});
                  } catch (...) {
                  }
                });
              },
              [errorTsfn](NSError* error) mutable {
                NSErrorException exception(error);
                errorTsfn.BlockingCall([exception](Napi::Env env, Napi::Function jsCallback) {
                  try {
                    jsCallback.Call({NSErrorExceptionToJsError(env, exception).Value()});
                  } catch (...) {
                  }
                });
              },
              [frameTsfn, errorTsfn, tsfnGuard]() mutable {
                ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                  frameTsfn.Release();
                  errorTsfn.Release();
                });
              },
              [frameTsfn, errorTsfn, tsfnGuard]() mutable {
                ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
                  frameTsfn.Abort();
                  errorTsfn.Abort();
                });
              });
          try {
            session->Start();
          } catch (...) {
            ReleaseTsfnOnce(tsfnGuard, [&]() mutable {
              frameTsfn.Release();
              errorTsfn.Release();
            });
            throw;
          }
          return session;
        },
        [](Napi::Env env, std::shared_ptr<coresim::JpegStreamSession> session) -> Napi::Value {
          return NativeJpegStream::NewInstance(env, session);
        });
  }

  // Option dictionary keys for `spawnWithPath:options:...` aren't part of the ObjC runtime
  // metadata this addon resolves selectors from (they're string literals inside CoreSimulator's
  // own implementation) — confirmed by resolving each `SimDeviceSpawnKey*` symbol at runtime via
  // `dlsym` against the already-loaded framework (see CLAUDE.md).
  // `stdout`/`stderr` are always set here, internally, to a pipe we own — never passed through
  // from `options` (SpawnOptions, src/types.ts, deliberately has no such keys: a wrong value type
  // there crashes the whole process uncatchably, see CLAUDE.md).
  Napi::Value Spawn(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    id device = device_;
    NSString* path = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSDictionary* userOptions = OptionsArg(info, 1);
    Napi::Function onExit = info[2].As<Napi::Function>();

    // Must be constructed on the main thread; released exactly once — either below (if the spawn
    // call never actually starts a process) or inside terminationHandler once CoreSimulator
    // invokes it (which it does exactly once per successfully spawned process).
    Napi::ThreadSafeFunction exitTsfn = Napi::ThreadSafeFunction::New(env, onExit, "coresim spawn exit", 0, 1);

    return RunAsync<SpawnResult>(
        env,
        [device, path, userOptions, exitTsfn]() -> SpawnResult {
          // stdout/stderr must be raw fd numbers (NSNumber), not NSFileHandle objects — see
          // CLAUDE.md. Our own copy of the write end still closes right after spawning (below) so
          // EOF reaches the read end once the child exits.
          NSPipe* stdoutPipe = [NSPipe pipe];
          NSPipe* stderrPipe = [NSPipe pipe];

          // dup() the read ends — and check both results — before ever starting the process, so a
          // descriptor-table exhaustion (EMFILE) is reported as a normal catchable error instead of
          // either leaving an untracked spawned process behind or handing JS an fd of -1 (which
          // would only surface later, as an opaque failure to wrap it in a net.Socket). The dup()'d
          // fds must outlive these NSFileHandle/NSPipe objects' own ARC lifetime, which would
          // otherwise close the original fd out from under Node once nothing in this function
          // references them anymore (verified empirically necessary).
          int stdoutFd = dup(stdoutPipe.fileHandleForReading.fileDescriptor);
          if (stdoutFd < 0) {
            int savedErrno = errno;
            // No process has started at this point, so terminationHandler (the only other place
            // that releases exitTsfn) will never run — release it here too, or the still-referenced
            // ThreadSafeFunction keeps Node's event loop alive after the caller handles the
            // rejection.
            exitTsfn.Release();
            throw NSErrorException(MakeDescriptorError(@"stdout", savedErrno));
          }
          int stderrFd = dup(stderrPipe.fileHandleForReading.fileDescriptor);
          if (stderrFd < 0) {
            int savedErrno = errno;
            close(stdoutFd);
            exitTsfn.Release();
            throw NSErrorException(MakeDescriptorError(@"stderr", savedErrno));
          }

          NSError* resolveError = nil;
          NSString* resolvedPath = ResolveRuntimeBinaryPath(device, path, &resolveError);
          if (resolvedPath == nil) {
            [stdoutPipe.fileHandleForWriting closeFile];
            [stderrPipe.fileHandleForWriting closeFile];
            close(stdoutFd);
            close(stderrFd);
            exitTsfn.Release();
            throw NSErrorException(resolveError);
          }

          NSMutableDictionary* options = [userOptions mutableCopy];
          options[@"stdout"] = @(stdoutPipe.fileHandleForWriting.fileDescriptor);
          options[@"stderr"] = @(stderrPipe.fileHandleForWriting.fileDescriptor);
          // kSimDeviceSpawnStandalone — see CLAUDE.md. Always NO: `path` always resolves inside
          // the Simulator runtime now (above), so every spawn needs to stay attached to the
          // guest's launchd bootstrap namespace to have its effects observed / function at all.
          // Not caller-configurable — there's no longer a legitimate reason to detach it.
          options[@"standalone"] = @NO;

          void (^terminationHandler)(int) = ^(int status) {
            // Confirmed empirically (see CLAUDE.md): `status` is a raw wait(2)-style status, not a
            // plain exit code — a normal exit(127) arrived here as 32512 (127 << 8), and a
            // SIGTERM kill arrived as the bare signal number 15. Decode to Node child_process-
            // style (code, signal), exactly one of which is set.
            exitTsfn.BlockingCall([status](Napi::Env env, Napi::Function jsCallback) {
              Napi::Value code = env.Null();
              Napi::Value signal = env.Null();
              if (WIFEXITED(status)) {
                code = Napi::Number::New(env, WEXITSTATUS(status));
              } else if (WIFSIGNALED(status)) {
                signal = Napi::Number::New(env, WTERMSIG(status));
              }
              jsCallback.Call({code, signal});
            });
            exitTsfn.Release();
          };

          NSError* error = nil;
          int pid;
          try {
            pid = coresim::Spawn(device, resolvedPath, options, dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0),
                                 terminationHandler, &error);
          } catch (...) {
            [stdoutPipe.fileHandleForWriting closeFile];
            [stderrPipe.fileHandleForWriting closeFile];
            close(stdoutFd);
            close(stderrFd);
            exitTsfn.Release();
            throw;
          }
          // Our own copies of the write ends must close regardless of outcome: on failure, so
          // they don't dangle open in this process; on success, so EOF ever reaches the read ends
          // once the child (the only remaining writer) exits.
          [stdoutPipe.fileHandleForWriting closeFile];
          [stderrPipe.fileHandleForWriting closeFile];
          if (pid <= 0) {
            // terminationHandler will never fire for a process that never started.
            exitTsfn.Release();
            close(stdoutFd);
            close(stderrFd);
          }
          ThrowIfFailed(pid > 0, error);

          SpawnResult result;
          result.pid = pid;
          result.stdoutFd = stdoutFd;
          result.stderrFd = stderrFd;
          return result;
        },
        [](Napi::Env env, SpawnResult result) -> Napi::Value {
          Napi::Object obj = Napi::Object::New(env);
          obj.Set("pid", result.pid);
          obj.Set("stdoutFd", result.stdoutFd);
          obj.Set("stderrFd", result.stderrFd);
          return obj;
        });
  }
};

NativeDevice::NativeDevice(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeDevice>(info) {
  device_ = UnwrapExternalId(info);
}

void NativeDevice::Init(Napi::Env env) {
  Napi::Function ctor =
      DefineClass(env, "NativeDevice",
                  {
                      InstanceMethod<&NativeDevice::Udid>("udid"),
                      InstanceMethod<&NativeDevice::Name>("name"),
                      InstanceMethod<&NativeDevice::State>("state"),
                      InstanceMethod<&NativeDevice::DeviceTypeIdentifier>("deviceTypeIdentifier"),
                      InstanceMethod<&NativeDevice::RuntimeIdentifier>("runtimeIdentifier"),
                      InstanceMethod<&NativeDevice::RuntimeRootPath>("runtimeRootPath"),
                      InstanceMethod<&NativeDevice::Boot>("boot"),
                      InstanceMethod<&NativeDevice::GetBootStatus>("getBootStatus"),
                      InstanceMethod<&NativeDevice::Shutdown>("shutdown"),
                      InstanceMethod<&NativeDevice::Erase>("erase"),
                      InstanceMethod<&NativeDevice::Getenv>("getenv"),
                      InstanceMethod<&NativeDevice::InstallApp>("installApp"),
                      InstanceMethod<&NativeDevice::UninstallApp>("uninstallApp"),
                      InstanceMethod<&NativeDevice::LaunchApp>("launchApp"),
                      InstanceMethod<&NativeDevice::TerminateApp>("terminateApp"),
                      InstanceMethod<&NativeDevice::PropertiesOfApplication>("propertiesOfApplication"),
                      InstanceMethod<&NativeDevice::InstalledApps>("installedApps"),
                      InstanceMethod<&NativeDevice::OpenUrl>("openUrl"),
                      InstanceMethod<&NativeDevice::SetLocation>("setLocation"),
                      InstanceMethod<&NativeDevice::ClearLocation>("clearLocation"),
                      InstanceMethod<&NativeDevice::SetOrientation>("setOrientation"),
                      InstanceMethod<&NativeDevice::SendPushNotification>("sendPushNotification"),
                      InstanceMethod<&NativeDevice::AddCertificate>("addCertificate"),
                      InstanceMethod<&NativeDevice::ResetKeychain>("resetKeychain"),
                      InstanceMethod<&NativeDevice::GetUIAppearance>("getUIAppearance"),
                      InstanceMethod<&NativeDevice::SetUIAppearance>("setUIAppearance"),
                      InstanceMethod<&NativeDevice::GetIncreaseContrast>("getIncreaseContrast"),
                      InstanceMethod<&NativeDevice::SetIncreaseContrast>("setIncreaseContrast"),
                      InstanceMethod<&NativeDevice::GetContentSize>("getContentSize"),
                      InstanceMethod<&NativeDevice::SetContentSize>("setContentSize"),
                      InstanceMethod<&NativeDevice::GrantPermission>("grantPermission"),
                      InstanceMethod<&NativeDevice::RevokePermission>("revokePermission"),
                      InstanceMethod<&NativeDevice::ResetPermission>("resetPermission"),
                      InstanceMethod<&NativeDevice::GetPermission>("getPermission"),
                      InstanceMethod<&NativeDevice::DarwinNotificationGetState>("darwinNotificationGetState"),
                      InstanceMethod<&NativeDevice::DarwinNotificationSetState>("darwinNotificationSetState"),
                      InstanceMethod<&NativeDevice::PostDarwinNotification>("postDarwinNotification"),
                      InstanceMethod<&NativeDevice::AddMedia>("addMedia"),
                      InstanceMethod<&NativeDevice::AddPhoto>("addPhoto"),
                      InstanceMethod<&NativeDevice::AddVideo>("addVideo"),
                      InstanceMethod<&NativeDevice::GetPasteboard>("getPasteboard"),
                      InstanceMethod<&NativeDevice::SetPasteboard>("setPasteboard"),
                      InstanceMethod<&NativeDevice::GetWebInspectorSocket>("getWebInspectorSocket"),
                      InstanceMethod<&NativeDevice::Screenshot>("screenshot"),
                      InstanceMethod<&NativeDevice::GetDisplays>("getDisplays"),
                      InstanceMethod<&NativeDevice::GetOrientation>("getOrientation"),
                      InstanceMethod<&NativeDevice::StartVideoRecording>("startVideoRecording"),
                      InstanceMethod<&NativeDevice::StartVideoStream>("startVideoStream"),
                      InstanceMethod<&NativeDevice::StartJpegStream>("startJpegStream"),
                      InstanceMethod<&NativeDevice::Spawn>("spawn"),
                  });
  env.GetInstanceData<AddonInstanceData>()->deviceConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeDevice::NewInstance(Napi::Env env, id device) {
  return WrapExternalId(env, env.GetInstanceData<AddonInstanceData>()->deviceConstructor, device);
}

class NativeDeviceSet : public Napi::ObjectWrap<NativeDeviceSet> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, id deviceSet, id serviceContext);
  explicit NativeDeviceSet(const Napi::CallbackInfo& info);

 private:
  id deviceSet_;
  id serviceContext_;

  Napi::Value GetDevices(const Napi::CallbackInfo& info) {
    id deviceSet = deviceSet_;
    return RunAsync<NSArray*>(
        info.Env(), [deviceSet]() -> NSArray* { return Devices(deviceSet); },
        [](Napi::Env env, NSArray* devices) -> Napi::Value {
          Napi::Array result = Napi::Array::New(env, devices.count);
          for (NSUInteger i = 0; i < devices.count; i++) {
            result[static_cast<uint32_t>(i)] = NativeDevice::NewInstance(env, devices[i]);
          }
          return result;
        });
  }

  Napi::Value CreateDeviceMethod(const Napi::CallbackInfo& info) {
    id deviceSet = deviceSet_;
    id serviceContext = serviceContext_;
    NSString* typeId = @(info[0].As<Napi::String>().Utf8Value().c_str());
    NSString* runtimeId = @(info[1].As<Napi::String>().Utf8Value().c_str());
    NSString* name = @(info[2].As<Napi::String>().Utf8Value().c_str());
    return RunAsync<id>(
        info.Env(),
        [deviceSet, serviceContext, typeId, runtimeId, name]() -> id {
          id deviceType = SupportedDeviceTypesByIdentifier(serviceContext)[typeId];
          id runtime = SupportedRuntimesByIdentifier(serviceContext)[runtimeId];
          if (deviceType == nil) {
            throw std::invalid_argument("Unknown device type identifier: " + std::string(typeId.UTF8String));
          }
          if (runtime == nil) {
            throw std::invalid_argument("Unknown runtime identifier: " + std::string(runtimeId.UTF8String));
          }
          NSError* error = nil;
          id device = CreateDevice(deviceSet, deviceType, runtime, name, &error);
          ThrowIfFailed(device != nil, error);
          return device;
        },
        [](Napi::Env env, id device) -> Napi::Value { return NativeDevice::NewInstance(env, device); });
  }

  Napi::Value DeleteDeviceMethod(const Napi::CallbackInfo& info) {
    id deviceSet = deviceSet_;
    // Napi::ObjectWrap::Unwrap must run on the main thread, so this stays outside the work lambda.
    NativeDevice* device = Napi::ObjectWrap<NativeDevice>::Unwrap(info[0].As<Napi::Object>());
    id rawDevice = device->device_;
    return RunAsyncVoid(info.Env(), [deviceSet, rawDevice]() {
      NSError* error = nil;
      ThrowIfFailed(DeleteDevice(deviceSet, rawDevice, &error), error);
    });
  }
};

NativeDeviceSet::NativeDeviceSet(const Napi::CallbackInfo& info) : Napi::ObjectWrap<NativeDeviceSet>(info) {
  deviceSet_ = UnwrapExternalId(info);
  serviceContext_ = *static_cast<__unsafe_unretained id*>(info[1].As<Napi::External<void>>().Data());
}

void NativeDeviceSet::Init(Napi::Env env) {
  Napi::Function ctor = DefineClass(env, "NativeDeviceSet",
                                    {
                                        InstanceMethod<&NativeDeviceSet::GetDevices>("devices"),
                                        InstanceMethod<&NativeDeviceSet::CreateDeviceMethod>("createDevice"),
                                        InstanceMethod<&NativeDeviceSet::DeleteDeviceMethod>("deleteDevice"),
                                    });
  env.GetInstanceData<AddonInstanceData>()->deviceSetConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeDeviceSet::NewInstance(Napi::Env env, id deviceSet, id serviceContext) {
  __unsafe_unretained id boxedDeviceSet = deviceSet;
  __unsafe_unretained id boxedServiceContext = serviceContext;
  return env.GetInstanceData<AddonInstanceData>()->deviceSetConstructor.New(
      {Napi::External<void>::New(env, &boxedDeviceSet), Napi::External<void>::New(env, &boxedServiceContext)});
}

class NativeServiceContext : public Napi::ObjectWrap<NativeServiceContext> {
 public:
  static void Init(Napi::Env env);
  static Napi::Object NewInstance(Napi::Env env, id serviceContext);
  explicit NativeServiceContext(const Napi::CallbackInfo& info);

 private:
  id serviceContext_;

  Napi::Value DefaultDeviceSetMethod(const Napi::CallbackInfo& info) {
    id serviceContext = serviceContext_;
    return RunAsync<id>(
        info.Env(),
        [serviceContext]() -> id {
          NSError* error = nil;
          id deviceSet = DefaultDeviceSet(serviceContext, &error);
          ThrowIfFailed(deviceSet != nil, error);
          return deviceSet;
        },
        [serviceContext](Napi::Env env, id deviceSet) -> Napi::Value {
          return NativeDeviceSet::NewInstance(env, deviceSet, serviceContext);
        });
  }

  Napi::Value DeviceSetWithPathMethod(const Napi::CallbackInfo& info) {
    id serviceContext = serviceContext_;
    NSString* path = @(info[0].As<Napi::String>().Utf8Value().c_str());
    return RunAsync<id>(
        info.Env(),
        [serviceContext, path]() -> id {
          NSError* error = nil;
          id deviceSet = DeviceSetWithPath(serviceContext, path, &error);
          ThrowIfFailed(deviceSet != nil, error);
          return deviceSet;
        },
        [serviceContext](Napi::Env env, id deviceSet) -> Napi::Value {
          return NativeDeviceSet::NewInstance(env, deviceSet, serviceContext);
        });
  }

  Napi::Value SupportedDeviceTypesMethod(const Napi::CallbackInfo& info) {
    id serviceContext = serviceContext_;
    return RunAsync<std::vector<DeviceTypeEntry>>(
        info.Env(),
        [serviceContext]() -> std::vector<DeviceTypeEntry> {
          NSArray* types = coresim::SupportedDeviceTypes(serviceContext);
          std::vector<DeviceTypeEntry> result;
          result.reserve(types.count);
          for (NSUInteger i = 0; i < types.count; i++) {
            result.push_back({DeviceTypeIdentifier(types[i]).UTF8String, DeviceTypeName(types[i]).UTF8String});
          }
          return result;
        },
        [](Napi::Env env, std::vector<DeviceTypeEntry> types) -> Napi::Value {
          Napi::Array result = Napi::Array::New(env, types.size());
          for (size_t i = 0; i < types.size(); i++) {
            Napi::Object entry = Napi::Object::New(env);
            entry.Set("identifier", types[i].identifier);
            entry.Set("name", types[i].name);
            result[static_cast<uint32_t>(i)] = entry;
          }
          return result;
        });
  }

  Napi::Value SupportedRuntimesMethod(const Napi::CallbackInfo& info) {
    id serviceContext = serviceContext_;
    return RunAsync<std::vector<RuntimeEntry>>(
        info.Env(),
        [serviceContext]() -> std::vector<RuntimeEntry> {
          NSArray* runtimes = coresim::SupportedRuntimes(serviceContext);
          std::vector<RuntimeEntry> result;
          result.reserve(runtimes.count);
          for (NSUInteger i = 0; i < runtimes.count; i++) {
            result.push_back({RuntimeIdentifier(runtimes[i]).UTF8String, RuntimeName(runtimes[i]).UTF8String,
                              RuntimeVersionString(runtimes[i]).UTF8String});
          }
          return result;
        },
        [](Napi::Env env, std::vector<RuntimeEntry> runtimes) -> Napi::Value {
          Napi::Array result = Napi::Array::New(env, runtimes.size());
          for (size_t i = 0; i < runtimes.size(); i++) {
            Napi::Object entry = Napi::Object::New(env);
            entry.Set("identifier", runtimes[i].identifier);
            entry.Set("name", runtimes[i].name);
            entry.Set("versionString", runtimes[i].versionString);
            result[static_cast<uint32_t>(i)] = entry;
          }
          return result;
        });
  }
};

NativeServiceContext::NativeServiceContext(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<NativeServiceContext>(info) {
  serviceContext_ = UnwrapExternalId(info);
}

void NativeServiceContext::Init(Napi::Env env) {
  Napi::Function ctor =
      DefineClass(env, "NativeServiceContext",
                  {
                      InstanceMethod<&NativeServiceContext::DefaultDeviceSetMethod>("defaultDeviceSet"),
                      InstanceMethod<&NativeServiceContext::DeviceSetWithPathMethod>("deviceSetWithPath"),
                      InstanceMethod<&NativeServiceContext::SupportedDeviceTypesMethod>("supportedDeviceTypes"),
                      InstanceMethod<&NativeServiceContext::SupportedRuntimesMethod>("supportedRuntimes"),
                  });
  env.GetInstanceData<AddonInstanceData>()->serviceContextConstructor = Napi::Persistent(ctor);
}

Napi::Object NativeServiceContext::NewInstance(Napi::Env env, id serviceContext) {
  return WrapExternalId(env, env.GetInstanceData<AddonInstanceData>()->serviceContextConstructor, serviceContext);
}

Napi::Value SharedServiceContextBinding(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  NSString* developerDir = @(info[0].As<Napi::String>().Utf8Value().c_str());
  return RunAsync<id>(
      env,
      [developerDir]() -> id {
        NSError* error = nil;
        id context = SharedServiceContext(developerDir, &error);
        ThrowIfFailed(context != nil, error);
        return context;
      },
      [](Napi::Env env, id context) -> Napi::Value { return NativeServiceContext::NewInstance(env, context); });
}

Napi::Value FrameworkVersionBinding(const Napi::CallbackInfo& info) {
  return RunAsync<std::string>(
      info.Env(), []() -> std::string { return CoreSimulatorFrameworkVersion(); },
      [](Napi::Env env, std::string version) -> Napi::Value { return Napi::String::New(env, version); });
}

// Node force-releases any ThreadSafeFunctions still outstanding when an Environment (e.g. a
// worker_threads Worker) tears down — racing our own release of the same TSFNs (fired
// asynchronously from NativeVideoStream/NativeAVStream/NativeAVRecording::Finalize, or never, if
// a running session's JS wrapper was never explicitly stopped) crashes the process. Cleanup hooks
// are guaranteed to run before that automatic TSFN teardown, so stopping every active session
// here — synchronously, blocking until each has released its own TSFNs — establishes the
// ordering Node itself doesn't.
//
// Also called directly (not just as a cleanup hook) by FlushActiveSessionsBinding below — cleanup
// hooks are confirmed (empirically, not just per docs) to NOT run at all for a `process.exit()`
// on the main process/thread (unlike a Worker's `worker.terminate()`, or the main thread's own
// natural empty-event-loop exit, both of which do invoke them). Without a second, JS-`'exit'`-
// event-triggered path to this same function, a forgotten (never explicitly stopped) AV recording
// silently loses its AVAssetWriter-buffered data — the file is left with no moov atom — the
// instant a caller force-exits via `process.exit()`, since nothing ever calls finishWriting.
void CleanupActiveSessions(AddonInstanceData* instanceData) {
  // AbortDelivery() first: this runs on the main JS thread with the event loop not being pumped
  // (a cleanup hook, or the synchronous process.on('exit') path below), so nothing else can drain
  // accessUnitTsfn's bounded queue — a producer thread already blocked pushing into a full queue
  // would otherwise deadlock against Stop()'s own wait on that same producer thread.
  auto stopStream = [](auto& session) {
    session->AbortDelivery();
    session->Stop();
  };
  instanceData->activeVideoStreams.StopAll(stopStream);
  instanceData->activeAVStreams.StopAll(stopStream);
  instanceData->activeJpegStreams.StopAll(stopStream);
  instanceData->activeAVRecordings.StopAll([](auto& session) {
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    session->Stop([sema](NSError*) { dispatch_semaphore_signal(sema); });
    dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
  });
}

// Deliberately synchronous (not RunAsync/Promise-returning) — meant to be called from a JS-level
// `process.on('exit', ...)` listener (native-simctl.ts), which per Node's own contract may only
// run synchronous code, but that includes a plain blocking native call like this one (it isn't
// scheduling new async JS work, just blocking the calling thread on GCD semaphores that are
// serviced by GCD's own independent thread pool — unaffected by anything happening to Node's own
// event loop or threadpool during exit). See CleanupActiveSessions's own comment for why this
// second call path exists at all.
Napi::Value FlushActiveSessionsBinding(const Napi::CallbackInfo& info) {
  CleanupActiveSessions(info.Env().GetInstanceData<AddonInstanceData>());
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Runs once per Environment (see AddonInstanceData above) — never shared across a
  // worker_threads instance also `require()`-ing this addon.
  auto* instanceData = new AddonInstanceData();
  env.SetInstanceData(instanceData);
  env.AddCleanupHook(CleanupActiveSessions, instanceData);
  NativeDevice::Init(env);
  NativeDeviceSet::Init(env);
  NativeServiceContext::Init(env);
  NativeVideoStream::Init(env);
  NativeAVStream::Init(env);
  NativeAVRecording::Init(env);
  NativePrivateRecordingHandle::Init(env);
  NativeJpegStream::Init(env);
  exports.Set("sharedServiceContext", Napi::Function::New(env, SharedServiceContextBinding));
  exports.Set("frameworkVersion", Napi::Function::New(env, FrameworkVersionBinding));
  exports.Set("flushActiveSessions", Napi::Function::New(env, FlushActiveSessionsBinding));
  return exports;
}

}  // namespace coresim

namespace {
Napi::Object InitCoreSimModule(Napi::Env env, Napi::Object exports) { return coresim::Init(env, exports); }
}  // namespace

NODE_API_MODULE(coresim, InitCoreSimModule)
