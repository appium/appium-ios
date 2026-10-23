#include "nserror_bridge.h"

#include "screenshot_errors.h"

namespace coresim {

Napi::Error NSErrorExceptionToJsError(Napi::Env env, const NSErrorException& error) {
  Napi::Error jsError = Napi::Error::New(env, error.what());
  const bool isDisplayResolutionError =
      error.domain == kScreenshotErrorDomain &&
      (error.code == kScreenshotDisplayNotFound || error.code == kScreenshotNoRenderableDisplay);
  jsError.Set("name", isDisplayResolutionError ? "NativeSimDisplayResolutionError" : "NativeSimOperationError");
  jsError.Set("domain", error.domain);
  jsError.Set("code", static_cast<double>(error.code));
  return jsError;
}

Napi::Error UnavailableToJsError(Napi::Env env, const NativeSimUnavailableError& error) {
  Napi::Error jsError = Napi::Error::New(env, error.what());
  jsError.Set("name", "NativeSimUnavailableError");
  jsError.Set("kind", error.kind);
  jsError.Set("missing", error.name);
  jsError.Set("frameworkVersion", error.detail);
  return jsError;
}

Napi::Error ObjCExceptionToJsError(Napi::Env env, const ObjCException& error) {
  Napi::Error jsError = Napi::Error::New(env, error.what());
  jsError.Set("name", "NativeSimDispatchError");
  jsError.Set("exceptionName", error.name);
  jsError.Set("reason", error.reason);
  return jsError;
}

}  // namespace coresim
