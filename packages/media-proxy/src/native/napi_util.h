#pragma once

#include <napi.h>

#include <string>

namespace media_proxy {

// A JS Error whose `name` is one of the typed errors in src/errors.ts, so wrapNativeError() can re-type it.
inline Napi::Error MakeTypedError(Napi::Env env, const char* name, const std::string& message) {
  Napi::Error err = Napi::Error::New(env, message);
  err.Set("name", Napi::String::New(env, name));
  return err;
}

[[noreturn]] inline void ThrowTyped(Napi::Env env, const char* name, const std::string& message) {
  throw MakeTypedError(env, name, message);
}

}  // namespace media_proxy
