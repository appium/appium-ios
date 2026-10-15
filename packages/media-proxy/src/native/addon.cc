// N-API entry point: wraps the FFmpeg pipeline (pipeline.cc) for the TS layer in src/native.ts.
#include <napi.h>

#include <array>
#include <atomic>
#include <memory>
#include <optional>
#include <utility>
#include <vector>

#include "napi_util.h"
#include "pipeline.h"

namespace {

using media_proxy::EncodedUnit;
using media_proxy::Pipeline;
using media_proxy::PipelineConfig;
using media_proxy::PipelineError;

constexpr std::array<uint8_t, 4> kStartCode{0, 0, 0, 1};
// Encoded units waiting for the JS thread; beyond this new ones are dropped so a stalled loop can't grow memory.
constexpr size_t kMaxPendingUnits = 60;

// JS-thread-only state shared with in-flight events, so late events never touch a dead session.
struct JsState {
  Napi::FunctionReference onError;
  std::optional<Napi::Promise::Deferred> deferred;
  std::atomic<size_t> pendingUnits{0};  // the only member the worker thread touches
};

struct Event {
  enum class Kind : uint8_t { kUnit, kError, kDone };
  Kind kind = Kind::kUnit;
  EncodedUnit unit;
  PipelineError error;
  std::shared_ptr<JsState> state;
};

// Owns one transcoder: the pipeline (worker thread) plus the thread-safe bridge back to JS.
class Session {
 public:
  Session(Napi::Env env, const PipelineConfig& config, const Napi::Function& onUnit, const Napi::Function& onError)
      : state_(std::make_shared<JsState>()) {
    state_->onError = Napi::Persistent(onError);
    tsfn_ = Napi::ThreadSafeFunction::New(env, onUnit, "media-proxy", 0, 1);
    // An abandoned transcoder must not keep the process alive; close() re-refs while it flushes.
    tsfn_.Unref(env);
    try {
      pipeline_ = std::make_unique<Pipeline>(
          config, [this](EncodedUnit&& unit) { PostUnit(std::move(unit)); },
          [this](PipelineError&& err) { Post(Event::Kind::kError, {}, std::move(err)); });
    } catch (...) {
      ReleaseBridge();  // the destructor won't run for a half-built Session
      throw;
    }
  }

  ~Session() {
    pipeline_.reset();  // joins the worker before the bridge goes away
    ReleaseBridge();
  }
  Session(const Session&) = delete;
  Session& operator=(const Session&) = delete;

  void Push(const Napi::CallbackInfo& info) {
    const Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsArray() || !info[1].IsNumber() || !info[2].IsBoolean()) {
      throw Napi::TypeError::New(env, "push(chunks: Buffer[], timestampMicros: number, isKeyFrame: boolean)");
    }
    const auto chunks = info[0].As<Napi::Array>();
    std::vector<uint8_t> unit;
    for (uint32_t i = 0; i < chunks.Length(); ++i) {
      const Napi::Value chunk = chunks.Get(i);
      if (!chunk.IsBuffer()) {
        throw Napi::TypeError::New(env, "chunks must be Buffers");
      }
      const auto buffer = chunk.As<Napi::Buffer<uint8_t>>();
      unit.insert(unit.end(), kStartCode.begin(), kStartCode.end());
      unit.insert(unit.end(), buffer.Data(), buffer.Data() + buffer.Length());
    }
    if (closing_ || unit.empty()) {
      return;
    }
    pipeline_->Push(std::move(unit), info[1].As<Napi::Number>().Int64Value(), info[2].As<Napi::Boolean>().Value());
  }

  Napi::Value Close(const Napi::Env& env) {
    if (!closing_) {
      closing_ = true;
      state_->deferred = Napi::Promise::Deferred::New(env);
      closePromise_ = Napi::Persistent(state_->deferred->Promise());
      tsfn_.Ref(env);
      pipeline_->Finish([this] {
        Post(Event::Kind::kDone, {}, {});
        ReleaseBridge();
      });
    }
    return closePromise_.Value();
  }

 private:
  void ReleaseBridge() {
    if (!released_.exchange(true)) {
      tsfn_.Release();
    }
  }

  void PostUnit(EncodedUnit&& unit) {
    if (state_->pendingUnits.load() >= kMaxPendingUnits) {
      return;
    }
    ++state_->pendingUnits;
    Post(Event::Kind::kUnit, std::move(unit), {});
  }

  void Post(Event::Kind kind, EncodedUnit&& unit, PipelineError&& error) {
    auto* event = new Event{kind, std::move(unit), std::move(error), state_};
    if (tsfn_.NonBlockingCall(event, Deliver) != napi_ok) {
      if (kind == Event::Kind::kUnit) {
        --state_->pendingUnits;
      }
      delete event;
    }
  }

  static void Deliver(Napi::Env env, Napi::Function onUnit, Event* raw) {
    const std::unique_ptr<Event> event(raw);
    switch (event->kind) {
      case Event::Kind::kUnit: {
        --event->state->pendingUnits;
        // Hand the bytes over without a copy; NewOrCopy copies (and frees at once) where external buffers are banned.
        auto* bytes = new std::vector<uint8_t>(std::move(event->unit.data));
        Napi::Object unit = Napi::Object::New(env);
        unit.Set("data", Napi::Buffer<uint8_t>::NewOrCopy(
                             env, bytes->data(), bytes->size(),
                             [](Napi::Env, uint8_t*, std::vector<uint8_t>* owned) { delete owned; }, bytes));
        unit.Set("isKeyFrame", Napi::Boolean::New(env, event->unit.isKeyFrame));
        unit.Set("timestampMicros", Napi::Number::New(env, static_cast<double>(event->unit.timestampMicros)));
        onUnit.Call({unit});
        break;
      }
      case Event::Kind::kError:
        event->state->onError.Call(
            {media_proxy::MakeTypedError(env, event->error.name.c_str(), event->error.message).Value()});
        event->state->onError.Reset();  // one error per pipeline; dropping the root breaks the GC cycle
        break;
      case Event::Kind::kDone:
        event->state->onError.Reset();
        if (event->state->deferred) {
          event->state->deferred->Resolve(env.Undefined());
        }
        break;
    }
  }

  std::shared_ptr<JsState> state_;
  Napi::ThreadSafeFunction tsfn_;
  Napi::Reference<Napi::Promise> closePromise_;
  std::atomic<bool> released_{false};
  bool closing_ = false;
  std::unique_ptr<Pipeline> pipeline_;  // last: destroyed (and joined) first
};

double ReadNumber(const Napi::Object& config, const char* key) {
  return config.Get(key).As<Napi::Number>().DoubleValue();
}

Napi::Value Capabilities(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object caps = Napi::Object::New(env);
  Napi::Array decoders = Napi::Array::New(env, 1);
  decoders.Set(0U, "hevc");
  Napi::Array encoders = Napi::Array::New(env, 1);
  encoders.Set(0U, "mjpeg");
  caps.Set("decoders", decoders);
  caps.Set("encoders", encoders);
  return caps;
}

Napi::Value CreateTranscoder(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsObject() || !info[1].IsFunction() || !info[2].IsFunction()) {
    throw Napi::TypeError::New(env, "createTranscoder(config, onUnit, onError)");
  }
  const auto config = info[0].As<Napi::Object>();
  PipelineConfig pipelineConfig;
  pipelineConfig.outputCodec = config.Get("outputCodec").As<Napi::String>().Utf8Value();
  pipelineConfig.fps = ReadNumber(config, "fps");
  pipelineConfig.bitrate = ReadNumber(config, "bitrate");
  pipelineConfig.quality = ReadNumber(config, "quality");
  pipelineConfig.scale = ReadNumber(config, "scale");

  std::shared_ptr<Session> session;
  try {
    session =
        std::make_shared<Session>(env, pipelineConfig, info[1].As<Napi::Function>(), info[2].As<Napi::Function>());
  } catch (const PipelineError& err) {
    media_proxy::ThrowTyped(env, err.name.c_str(), err.message);
  }

  Napi::Object handle = Napi::Object::New(env);
  handle.Set("push", Napi::Function::New(env, [session](const Napi::CallbackInfo& call) { session->Push(call); }));
  handle.Set("requestKeyFrame",
             Napi::Function::New(env, [](const Napi::CallbackInfo&) {}));  // MJPEG: every frame is a key frame
  handle.Set("close", Napi::Function::New(
                          env, [session](const Napi::CallbackInfo& call) { return session->Close(call.Env()); }));
  return handle;
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
