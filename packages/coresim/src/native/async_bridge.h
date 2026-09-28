#pragma once

#include <napi.h>

#include <functional>
#include <memory>

#include "nserror_bridge.h"
#include "objc_runtime.h"
#include "safe_dispatch.h"

namespace coresim {

// Runs `work` on a libuv threadpool thread (Napi::AsyncWorker::Execute) and resolves/rejects the
// returned Promise from its result, converting it to a JS value via `toValue` — which, like every
// other Napi call, must run on the main thread, hence OnOK rather than Execute. This is what
// keeps Node's event loop responsive regardless of whether the underlying CoreSimulator call is
// itself async (has a completion-block variant) or a plain blocking objc_msgSend: either way, the
// blocking happens off the main thread.
//
// `T` must be safe to hold as a plain default-constructed class member with no ARC-ownership
// wrapper needed beyond what the type already provides on its own — plain C++ types (bool, int,
// long long, std::string) work as expected; `id`/`NSString*`/`NSArray*`/`NSDictionary*`/... also
// work here because this header is only ever included from an Objective-C++ (.mm) translation
// unit compiled with ARC, where a bare ObjC-pointer-typed class member already gets correct
// retain/release semantics, same as every other such member in this addon (e.g. NativeDevice's
// `device_`). `toValue` runs in OnOK (main thread), so it's the right — and only safe — place to
// do any Napi-consuming conversion (NSObjectToJsValue, building a NativeDevice, ...), even though
// the raw ObjC object it receives was produced by `work` on a background thread. `toValue` takes
// `T` by value, not `T&`: for an ObjC pointer T, a reference parameter's ARC ownership qualifier
// (implicitly `__strong`) has to match the callable's declared parameter type exactly, which a
// plain `NSString*&`-style lambda parameter doesn't — by-value sidesteps that entirely, and every
// T here (primitives, std::string, ObjC pointers) is cheap to copy/retain anyway.
template <typename T>
class ValueAsyncWorker : public Napi::AsyncWorker {
 public:
  ValueAsyncWorker(Napi::Env env, std::function<T()> work, std::function<Napi::Value(Napi::Env, T)> toValue)
      : Napi::AsyncWorker(env),
        work_(std::move(work)),
        toValue_(std::move(toValue)),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    // libuv threadpool threads are persistent and reused across many Execute() calls, with no
    // implicit per-iteration autorelease pool the way the main thread gets from a run loop —
    // without one here, every autoreleased Foundation temporary `work_`/its callees produce (e.g.
    // -stringWithFormat:, -pipe) would sit until the thread itself exits, growing without bound.
    // `result_`/the caught exceptions below are real (retained) members, not autoreleased
    // temporaries, so assigning into them before the pool drains keeps them alive regardless.
    @autoreleasepool {
      try {
        result_ = work_();
      } catch (const NativeSimUnavailableError& error) {
        unavailable_ = std::make_unique<NativeSimUnavailableError>(error);
      } catch (const NSErrorException& error) {
        nsError_ = std::make_unique<NSErrorException>(error);
      } catch (const ObjCException& error) {
        objcException_ = std::make_unique<ObjCException>(error);
      } catch (const std::exception& error) {
        SetError(error.what());
      }
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (unavailable_) {
      deferred_.Reject(UnavailableToJsError(env, *unavailable_).Value());
    } else if (nsError_) {
      deferred_.Reject(NSErrorExceptionToJsError(env, *nsError_).Value());
    } else if (objcException_) {
      deferred_.Reject(ObjCExceptionToJsError(env, *objcException_).Value());
    } else {
      deferred_.Resolve(toValue_(env, result_));
    }
  }

  void OnError(const Napi::Error& error) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(error.Value());
  }

 private:
  std::function<T()> work_;
  std::function<Napi::Value(Napi::Env, T)> toValue_;
  T result_{};
  std::unique_ptr<NativeSimUnavailableError> unavailable_;
  std::unique_ptr<NSErrorException> nsError_;
  std::unique_ptr<ObjCException> objcException_;
  Napi::Promise::Deferred deferred_;
};

// Same as ValueAsyncWorker but for work with no result to convert — resolves with undefined.
class VoidAsyncWorker : public Napi::AsyncWorker {
 public:
  VoidAsyncWorker(Napi::Env env, std::function<void()> work)
      : Napi::AsyncWorker(env), work_(std::move(work)), deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override {
    // See ValueAsyncWorker::Execute() above for why this pool is needed on a reused threadpool
    // thread.
    @autoreleasepool {
      try {
        work_();
      } catch (const NativeSimUnavailableError& error) {
        unavailable_ = std::make_unique<NativeSimUnavailableError>(error);
      } catch (const NSErrorException& error) {
        nsError_ = std::make_unique<NSErrorException>(error);
      } catch (const ObjCException& error) {
        objcException_ = std::make_unique<ObjCException>(error);
      } catch (const std::exception& error) {
        SetError(error.what());
      }
    }
  }

  void OnOK() override {
    Napi::Env env = Env();
    Napi::HandleScope scope(env);
    if (unavailable_) {
      deferred_.Reject(UnavailableToJsError(env, *unavailable_).Value());
    } else if (nsError_) {
      deferred_.Reject(NSErrorExceptionToJsError(env, *nsError_).Value());
    } else if (objcException_) {
      deferred_.Reject(ObjCExceptionToJsError(env, *objcException_).Value());
    } else {
      deferred_.Resolve(env.Undefined());
    }
  }

  void OnError(const Napi::Error& error) override {
    Napi::HandleScope scope(Env());
    deferred_.Reject(error.Value());
  }

 private:
  std::function<void()> work_;
  std::unique_ptr<NativeSimUnavailableError> unavailable_;
  std::unique_ptr<NSErrorException> nsError_;
  std::unique_ptr<ObjCException> objcException_;
  Napi::Promise::Deferred deferred_;
};

template <typename T>
Napi::Promise RunAsync(Napi::Env env, std::function<T()> work, std::function<Napi::Value(Napi::Env, T)> toValue) {
  auto* worker = new ValueAsyncWorker<T>(env, std::move(work), std::move(toValue));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

inline Napi::Promise RunAsyncVoid(Napi::Env env, std::function<void()> work) {
  auto* worker = new VoidAsyncWorker(env, std::move(work));
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

}  // namespace coresim
