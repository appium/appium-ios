#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "pipeline.h"

namespace media_proxy {

struct AudioConfig {
  // MPEG-4 AudioSpecificConfig of the input (AAC-ELD from the device).
  std::vector<uint8_t> audioSpecificConfig;
  // Output AAC-LC bitrate per channel, in bits/sec.
  double bitratePerChannel = 64000;
};

// AAC-ELD access units in, ADTS-framed AAC-LC units out, on a dedicated worker thread. Pure C++/FFmpeg: no N-API.
class AudioPipeline {
 public:
  using UnitCallback = std::function<void(EncodedUnit&&)>;
  using ErrorCallback = std::function<void(PipelineError&&)>;
  using DoneCallback = std::function<void()>;

  // Throws PipelineError when the AAC decoder/encoder is missing from this build or the config is rejected.
  AudioPipeline(const AudioConfig& config, UnitCallback onUnit, ErrorCallback onError);
  ~AudioPipeline();
  AudioPipeline(const AudioPipeline&) = delete;
  AudioPipeline& operator=(const AudioPipeline&) = delete;

  // Non-blocking; beyond kMaxQueuedUnits the oldest unit is dropped (the gap is later filled with silence).
  void Push(std::vector<uint8_t> accessUnit, int64_t timestampMicros);
  // Drains queued input, flushes the codecs, then calls `onDone` from the worker thread (once).
  void Finish(DoneCallback onDone);

  static constexpr size_t kMaxQueuedUnits = 500;

 private:
  struct Input {
    std::vector<uint8_t> data;
    int64_t timestampMicros = 0;
  };
  class Impl;

  void Run();

  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<Input> queue_;
  bool finishing_ = false;
  bool aborting_ = false;
  DoneCallback onDone_;
  ErrorCallback onError_;
  std::unique_ptr<Impl> impl_;
  std::thread worker_;
};

}  // namespace media_proxy
