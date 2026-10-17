// N-API entry point: wraps the FFmpeg pipeline (pipeline.cc) for the TS layer in src/native.ts.
#include <napi.h>

#include <array>
#include <atomic>
#include <memory>
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
// Fine for MJPEG (every frame stands alone); H.264 must resync to the next key frame instead.
constexpr size_t kMaxPendingUnits = 60;

// Shared with in-flight events, so late events never touch a dead session. JS-thread-only, except the counter.
// The callbacks are weak: the handle's `callbacks` array owns them, so an abandoned transcoder stays collectable.
struct JsState {
  Napi::FunctionReference onUnit;
  Napi::FunctionReference onError;
  napi_deferred deferred = nullptr;  // resolved on the JS thread when close() finishes
  std::shared_ptr<void> keepAlive;   // the Session itself, held while close() drains so GC can't abort it
  std::atomic<size_t> pendingUnits{0};
};

struct Event {
  enum class Kind : uint8_t { kUnit, kError, kDone };
  Kind kind = Kind::kUnit;
  EncodedUnit unit;
  PipelineError error;
  std::shared_ptr<JsState> state;
};

// Owns one transcoder: the pipeline (worker thread) plus the thread-safe bridge back to JS.
class Session : public std::enable_shared_from_this<Session> {
 public:
  Session(Napi::Env env, const PipelineConfig& config, const Napi::Function& onUnit, const Napi::Function& onError)
      : env_(env), state_(std::make_shared<JsState>()) {
    state_->onUnit = Napi::Weak(onUnit);
    state_->onError = Napi::Weak(onError);
    // The bridge's own function is a no-op: it must not keep JS objects alive.
    tsfn_ = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
                                          "media-proxy", 0, 1);
    // An abandoned transcoder must not keep the process alive; close() re-refs while it flushes.
    tsfn_.Unref(env);
    // Registered after the tsfn, so at environment teardown this runs first (see Shutdown()).
    napi_add_env_cleanup_hook(env_, &Session::OnEnvCleanup, this);
    try {
      pipeline_ = std::make_unique<Pipeline>(
          config, [this](EncodedUnit&& unit) { PostUnit(std::move(unit)); },
          [this](PipelineError&& err) { Post(Event::Kind::kError, {}, std::move(err)); });
    } catch (...) {
      napi_remove_env_cleanup_hook(env_, &Session::OnEnvCleanup, this);
      ReleaseBridge();  // the destructor won't run for a half-built Session
      throw;
    }
  }

  ~Session() {
    if (!shutdown_) {
      napi_remove_env_cleanup_hook(env_, &Session::OnEnvCleanup, this);
    }
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
    if (closing_) {
      return;
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
    if (unit.empty()) {
      return;
    }
    pipeline_->Push(std::move(unit), info[1].As<Napi::Number>().Int64Value(), info[2].As<Napi::Boolean>().Value());
  }

  Napi::Value Close(const Napi::Env& env) {
    if (!closing_) {
      closing_ = true;
      napi_value promise = nullptr;
      if (napi_create_promise(env, &state_->deferred, &promise) != napi_ok) {
        throw Napi::Error::New(env, "Could not create the close() promise");
      }
      closePromise_ = Napi::Persistent(Napi::Promise(env, promise));
      state_->keepAlive = shared_from_this();
      tsfn_.Ref(env);
      // Safe even if Deliver destroys *this meanwhile: ~Session joins this worker before members die.
      pipeline_->Finish([this] {
        Post(Event::Kind::kDone, {}, {});
        ReleaseBridge();
      });
    }
    return closePromise_.Value();
  }

 private:
  static void OnEnvCleanup(void* self) { static_cast<Session*>(self)->Shutdown(); }

  // Environment teardown: stop the worker now and leave the tsfn to Node. Releasing it later from a
  // finalizer (which runs while Node holds the tsfn's lock) would deadlock.
  void Shutdown() {
    shutdown_ = true;
    pipeline_.reset();
    released_.store(true);
    // A close() interrupted here would otherwise keep the session alive forever (done is never posted).
    const auto self = std::move(state_->keepAlive);
    // `self` may be the last owner: nothing below this line may touch *this.
  }

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

  // Runs on the JS thread, called from C. Raw N-API on purpose: while a worker is being terminated these calls
  // fail, and node-addon-api would abort the process building its C++ Error for the failure. A failure just
  // drops the event (a pending JS exception is left for Node to report).
  static void Deliver(Napi::Env env, Napi::Function /*bridge*/, Event* raw) {
    const std::unique_ptr<Event> event(raw);
    JsState& state = *event->state;
    switch (event->kind) {
      case Event::Kind::kUnit:
        --state.pendingUnits;
        DeliverUnit(env, state, *event);
        break;
      case Event::Kind::kError:
        DeliverError(env, state, *event);
        break;
      case Event::Kind::kDone:
        if (state.deferred != nullptr) {
          napi_value undefined = nullptr;
          if (napi_get_undefined(env, &undefined) == napi_ok) {
            napi_resolve_deferred(env, state.deferred, undefined);
          }
          state.deferred = nullptr;
        }
        state.keepAlive.reset();  // may destroy the Session (and join its finished worker) right here
        break;
    }
  }

  static void CallWithArgument(napi_env env, napi_ref callbackRef, napi_value argument) {
    napi_value callback = nullptr;
    napi_value global = nullptr;
    napi_value ignored = nullptr;
    if (napi_get_reference_value(env, callbackRef, &callback) != napi_ok || callback == nullptr) {
      return;  // the transcoder was garbage collected
    }
    if (napi_get_global(env, &global) == napi_ok) {
      napi_call_function(env, global, callback, 1, &argument, &ignored);
    }
  }

  static void DeliverUnit(napi_env env, JsState& state, Event& event) {
    napi_value unit = nullptr;
    napi_value data = nullptr;
    napi_value isKeyFrame = nullptr;
    napi_value timestamp = nullptr;
    const std::vector<uint8_t>& bytes = event.unit.data;
    if (napi_create_object(env, &unit) != napi_ok ||
        napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &data) != napi_ok ||
        napi_get_boolean(env, event.unit.isKeyFrame, &isKeyFrame) != napi_ok ||
        napi_create_double(env, static_cast<double>(event.unit.timestampMicros), &timestamp) != napi_ok ||
        napi_set_named_property(env, unit, "data", data) != napi_ok ||
        napi_set_named_property(env, unit, "isKeyFrame", isKeyFrame) != napi_ok ||
        napi_set_named_property(env, unit, "timestampMicros", timestamp) != napi_ok) {
      return;
    }
    CallWithArgument(env, state.onUnit, unit);
  }

  static void DeliverError(napi_env env, JsState& state, Event& event) {
    napi_value message = nullptr;
    napi_value name = nullptr;
    napi_value error = nullptr;
    if (napi_create_string_utf8(env, event.error.message.c_str(), NAPI_AUTO_LENGTH, &message) != napi_ok ||
        napi_create_string_utf8(env, event.error.name.c_str(), NAPI_AUTO_LENGTH, &name) != napi_ok ||
        napi_create_error(env, nullptr, message, &error) != napi_ok ||
        napi_set_named_property(env, error, "name", name) != napi_ok) {
      return;
    }
    CallWithArgument(env, state.onError, error);
  }

  napi_env env_;
  std::shared_ptr<JsState> state_;
  Napi::ThreadSafeFunction tsfn_;
  Napi::Reference<Napi::Promise> closePromise_;
  std::atomic<bool> released_{false};
  bool shutdown_ = false;
  bool closing_ = false;
  std::unique_ptr<Pipeline> pipeline_;  // last: destroyed (and joined) first
};

double ReadNumber(const Napi::Object& config, const char* key) {
  return config.Get(key).As<Napi::Number>().DoubleValue();
}

Napi::Array ToArray(const Napi::Env& env, const std::vector<std::string>& names) {
  Napi::Array out = Napi::Array::New(env, names.size());
  for (size_t i = 0; i < names.size(); ++i) {
    out.Set(static_cast<uint32_t>(i), names[i]);
  }
  return out;
}

Napi::Value Capabilities(const Napi::CallbackInfo& info) {
  const Napi::Env env = info.Env();
  const media_proxy::Capabilities probed = Pipeline::Probe();
  Napi::Object caps = Napi::Object::New(env);
  caps.Set("decoders", ToArray(env, probed.decoders));
  caps.Set("encoders", ToArray(env, probed.encoders));
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
  // The session only holds the callbacks weakly; keeping them on the handle ties their lifetime to it.
  Napi::Array callbacks = Napi::Array::New(env, 2);
  callbacks.Set(0U, info[1]);
  callbacks.Set(1U, info[2]);
  handle.Set("callbacks", callbacks);
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
