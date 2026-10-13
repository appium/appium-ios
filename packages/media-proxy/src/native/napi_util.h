#pragma once

#include <napi.h>

#include <string>

namespace media_proxy {

// Throws a JS Error whose `name` is one of the typed errors in src/errors.ts, so wrapNativeError() can re-type it.
[[noreturn]] inline void ThrowTyped(Napi::Env env, const char* name, const std::string& message) {
  Napi::Error err = Napi::Error::New(env, message);
  err.Set("name", Napi::String::New(env, name));
  throw err;
}

}  // namespace media_proxy
