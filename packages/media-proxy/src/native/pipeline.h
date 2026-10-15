#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace media_proxy {

struct PipelineConfig {
  std::string outputCodec;  // "mjpeg" (h264 arrives with the encoder milestone)
  // Doubles: the TS layer accepts fractional values (e.g. fps 29.97, scale 33.3).
  double fps = 60;
  double bitrate = 0;
  double quality = 80;
  double scale = 100;
};

struct EncodedUnit {
  std::vector<uint8_t> data;
  bool isKeyFrame = false;
  int64_t timestampMicros = 0;
};

// Error names match the typed errors in src/errors.ts.
struct PipelineError {
  std::string name;
  std::string message;
};

// HEVC access units in, encoded units out, on a dedicated worker thread. Pure C++/FFmpeg: no N-API.
class Pipeline {
 public:
  using UnitCallback = std::function<void(EncodedUnit&&)>;
  using ErrorCallback = std::function<void(PipelineError&&)>;
  using DoneCallback = std::function<void()>;

  // Throws PipelineError when the requested encoder/decoder is unavailable.
  Pipeline(const PipelineConfig& config, UnitCallback onUnit, ErrorCallback onError);
  ~Pipeline();
  Pipeline(const Pipeline&) = delete;
  Pipeline& operator=(const Pipeline&) = delete;

  // One access unit with 4-byte start codes. Non-blocking; overflow drops to the next key frame.
  void Push(std::vector<uint8_t> accessUnit, int64_t timestampMicros, bool isKeyFrame);
  // Drains queued input, flushes the codecs, then calls `onDone` from the worker thread (once).
  void Finish(DoneCallback onDone);

  static constexpr size_t kMaxQueuedUnits = 8;

 private:
  struct Input {
    std::vector<uint8_t> data;
    int64_t timestampMicros = 0;
    bool isKeyFrame = false;
  };
  class Impl;

  void Run();

  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<Input> queue_;
  bool awaitingKeyFrame_ = false;
  bool finishing_ = false;
  bool aborting_ = false;
  DoneCallback onDone_;
  ErrorCallback onError_;
  std::unique_ptr<Impl> impl_;
  std::thread worker_;
};

}  // namespace media_proxy
