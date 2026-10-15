// N-API entry point. The FFmpeg-backed pipeline lands in later milestones; for now the addon only
// reports that no codecs are compiled in, so the TS layer, loader and CI can be exercised end to end.
#include <napi.h>

#include "napi_util.h"

namespace {

Napi::Value Capabilities(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object caps = Napi::Object::New(env);
  caps.Set("decoders", Napi::Array::New(env, 0));
  caps.Set("encoders", Napi::Array::New(env, 0));
  return caps;
}

Napi::Value CreateTranscoder(const Napi::CallbackInfo& info) {
  media_proxy::ThrowTyped(info.Env(), "MediaProxyEncoderUnavailableError",
                          "No encoder available: this build has no codecs compiled in");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("capabilities", Napi::Function::New(env, Capabilities));
  exports.Set("createTranscoder", Napi::Function::New(env, CreateTranscoder));
  return exports;
}

}  // namespace

// NODE_API_MODULE expands to a static registration function that clang-tidy flags; same as tuntap.
// NOLINTNEXTLINE(misc-use-anonymous-namespace)
NODE_API_MODULE(media_proxy, Init)
