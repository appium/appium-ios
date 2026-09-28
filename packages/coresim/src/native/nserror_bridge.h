#pragma once

#import <Foundation/Foundation.h>

#include <napi.h>

#include <string>

#include "objc_runtime.h"
#include "safe_dispatch.h"

namespace coresim {

// Thrown by async work lambdas (see async_bridge.h) when a native call fails via an NSError**
// out-param rather than raising. domain/code/message are captured immediately at throw time
// (never the NSError* itself), since this only ever needs to survive within the same background
// thread's try/catch — it's never constructed on, or crossed onto, the main thread.
class NSErrorException : public std::runtime_error {
 public:
  explicit NSErrorException(NSError* error)
      : std::runtime_error(error.localizedDescription ? error.localizedDescription.UTF8String : "Operation failed"),
        domain(error.domain ? error.domain.UTF8String : ""),
        code(error.code) {}

  std::string domain;
  long long code;
};

// Converts an NSError into a JS Error with {name: 'NativeSimOperationError', domain, code,
// message} — errors.ts wraps this into NativeSimError. Built from an already-caught
// NSErrorException's extracted fields, never a live NSError*: this only ever runs in OnOK (main
// thread), after the exception already crossed out of the background thread's try/catch.
Napi::Error NSErrorExceptionToJsError(Napi::Env env, const NSErrorException& error);

// {name: 'NativeSimUnavailableError', kind, missing, frameworkVersion} — errors.ts wraps this
// into NativeSimUnavailableError.
Napi::Error UnavailableToJsError(Napi::Env env, const NativeSimUnavailableError& error);

// {name: 'NativeSimDispatchError', exceptionName, reason} — errors.ts wraps this into
// NativeSimDispatchError.
Napi::Error ObjCExceptionToJsError(Napi::Env env, const ObjCException& error);

// Runs `fn` (the Napi-facing body of a synchronous exported method) and converts any of the three
// exception types this addon throws into the matching pending JS exception, so a C++/ObjC failure
// always surfaces as a catchable JS Error, never an uncaught native exception. On any exception,
// returns env.Undefined(); the pending JS exception (set via ThrowAsJavaScriptException) is what the
// caller actually sees.
template <typename Fn>
Napi::Value CatchToJs(Napi::Env env, Fn&& fn) {
  try {
    return fn();
  } catch (const NativeSimUnavailableError& error) {
    UnavailableToJsError(env, error).ThrowAsJavaScriptException();
  } catch (const NSErrorException& error) {
    NSErrorExceptionToJsError(env, error).ThrowAsJavaScriptException();
  } catch (const ObjCException& error) {
    ObjCExceptionToJsError(env, error).ThrowAsJavaScriptException();
  } catch (const std::exception& error) {
    Napi::Error::New(env, error.what()).ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

}  // namespace coresim
