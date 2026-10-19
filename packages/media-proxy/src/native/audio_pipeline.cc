#include "audio_pipeline.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <exception>
#include <optional>
#include <string>
#include <utility>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/channel_layout.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/mem.h>
#include <libavutil/samplefmt.h>
}

#include "ffmpeg_util.h"

namespace media_proxy {

namespace {

constexpr int64_t kMicrosPerSecond = 1000000;
// RTP timestamps are exact, so anything beyond this between units is a real gap (lost packets).
constexpr int64_t kGapToleranceMicros = 5000;
// Longer gaps restart the timeline instead of being padded with silence.
constexpr int64_t kMaxSilenceMicros = 1000000;
constexpr int kMaxChannels = 6;
constexpr size_t kAdtsHeaderSize = 7;
constexpr int kAdtsLcProfile = 1;  // object type 2 (AAC-LC) minus one
constexpr std::array<int, 13> kAdtsSampleRates = {96000, 88200, 64000, 48000, 44100, 32000, 24000,
                                                  22050, 16000, 12000, 11025, 8000,  7350};

struct FifoDeleter {
  void operator()(AVAudioFifo* fifo) const { av_audio_fifo_free(fifo); }
};
using Fifo = std::unique_ptr<AVAudioFifo, FifoDeleter>;

constexpr int kEscapeObjectType = 31;
constexpr int kEscapeSampleRate = 15;
constexpr std::array<int, 8> kChannelsByConfig = {0, 1, 2, 3, 4, 5, 6, 8};

// Reads the leading fields of an MPEG-4 AudioSpecificConfig: the decoder is not told them by a demuxer here.
struct AscFormat {
  int sampleRate = 0;
  int channels = 0;
};

std::optional<AscFormat> ParseAsc(const std::vector<uint8_t>& asc) {
  size_t bit = 0;
  bool ok = true;
  const auto read = [&](int count) {
    int value = 0;
    for (int i = 0; i < count; ++i, ++bit) {
      if (bit / 8 >= asc.size()) {
        ok = false;
        return 0;
      }
      value = (value << 1) | ((asc[bit / 8] >> (7 - (bit % 8))) & 1);
    }
    return value;
  };
  if (read(5) == kEscapeObjectType) {
    read(6);
  }
  const int rateIndex = read(4);
  int rate = 0;
  if (rateIndex == kEscapeSampleRate) {
    rate = read(24);
  } else if (rateIndex < static_cast<int>(kAdtsSampleRates.size())) {
    rate = kAdtsSampleRates[rateIndex];
  }
  const int config = read(4);
  if (!ok || rate <= 0 || config < 1 || config >= static_cast<int>(kChannelsByConfig.size())) {
    return std::nullopt;
  }
  return AscFormat{rate, kChannelsByConfig[config]};
}

int64_t SamplesToMicros(int64_t samples, int rate) { return ((samples * kMicrosPerSecond) + (rate / 2)) / rate; }

int AdtsRateIndex(int rate) {
  const auto* const it = std::find(kAdtsSampleRates.begin(), kAdtsSampleRates.end(), rate);
  return it == kAdtsSampleRates.end() ? -1 : static_cast<int>(it - kAdtsSampleRates.begin());
}

std::array<uint8_t, kAdtsHeaderSize> AdtsHeader(size_t payloadSize, int rateIndex, int channels) {
  const size_t length = kAdtsHeaderSize + payloadSize;
  return {
      0xFF,  // syncword
      0xF1,  // MPEG-4, layer 0, no CRC
      static_cast<uint8_t>((kAdtsLcProfile << 6) | (rateIndex << 2) | ((channels >> 2) & 1)),
      static_cast<uint8_t>(((channels & 3) << 6) | ((length >> 11) & 3)),
      static_cast<uint8_t>((length >> 3) & 0xFF),
      static_cast<uint8_t>(((length & 7) << 5) | 0x1F),  // buffer fullness: VBR
      0xFC,
  };
}

}  // namespace

// FFmpeg state; touched only by the worker thread after construction.
class AudioPipeline::Impl {
 public:
  Impl(const AudioConfig& config, UnitCallback onUnit) : config_(config), onUnit_(std::move(onUnit)) {
    const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_AAC);
    encoder_ = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (decoder == nullptr || encoder_ == nullptr) {
      throw PipelineError{kEncoderUnavailableError, "The AAC decoder or encoder is missing from this build"};
    }
    if (config.audioSpecificConfig.empty()) {
      throw PipelineError{"MediaProxyOptionError", "audioSpecificConfig must not be empty"};
    }
    const std::optional<AscFormat> format = ParseAsc(config.audioSpecificConfig);
    if (!format) {
      throw PipelineError{"MediaProxyOptionError", "audioSpecificConfig is not a usable AudioSpecificConfig"};
    }
    decoder_.reset(avcodec_alloc_context3(decoder));
    decoder_->sample_rate = format->sampleRate;
    av_channel_layout_default(&decoder_->ch_layout, format->channels);
    const size_t size = config.audioSpecificConfig.size();
    decoder_->extradata = static_cast<uint8_t*>(av_mallocz(size + AV_INPUT_BUFFER_PADDING_SIZE));
    if (decoder_->extradata == nullptr) {
      throw PipelineError{"MediaProxyError", "Out of memory"};
    }
    std::memcpy(decoder_->extradata, config.audioSpecificConfig.data(), size);
    decoder_->extradata_size = static_cast<int>(size);
    decoder_->flags |= AV_CODEC_FLAG_LOW_DELAY;
    if (const int ret = avcodec_open2(decoder_.get(), decoder, nullptr); ret < 0) {
      throw Fatal("Could not open the AAC decoder", ret);
    }
    packet_.reset(av_packet_alloc());
    decoded_.reset(av_frame_alloc());
    chunk_.reset(av_frame_alloc());
  }

  void Process(const Input& input) {
    if (input.data.empty()) {
      return;
    }
    if (!AlignTimeline(input.timestampMicros)) {
      return;
    }
    if (const int ret = av_new_packet(packet_.get(), static_cast<int>(input.data.size())); ret < 0) {
      throw Fatal("Could not allocate a packet", ret);
    }
    std::copy(input.data.begin(), input.data.end(), packet_->data);
    const int ret = avcodec_send_packet(decoder_.get(), packet_.get());
    av_packet_unref(packet_.get());
    // A corrupt unit is skipped; the gap it leaves is padded with silence by the next one.
    if (ret < 0 && ret != AVERROR_INVALIDDATA && ret != AVERROR(EAGAIN)) {
      throw Fatal("AAC decode failed", ret);
    }
    DrainDecoder();
    EncodeAvailable();
  }

  void Flush() {
    avcodec_send_packet(decoder_.get(), nullptr);
    DrainDecoder();
    EncodeAvailable();
    if (fifo_ && av_audio_fifo_size(fifo_.get()) > 0) {
      WriteSilence(chunkSize_ - av_audio_fifo_size(fifo_.get()));  // pad the tail to a whole AAC frame
      EncodeAvailable();
    }
    if (encoderCtx_) {
      avcodec_send_frame(encoderCtx_.get(), nullptr);
      DrainEncoder();
    }
  }

 private:
  [[nodiscard]] int64_t QueuedSamples() const { return readSamples_ + (fifo_ ? av_audio_fifo_size(fifo_.get()) : 0); }

  // Keeps the output on the input's clock: pads gaps with silence, restarts after a long one, drops late repeats.
  bool AlignTimeline(int64_t timestampMicros) {
    if (!anchored_ || sampleRate_ == 0) {
      anchorMicros_ = timestampMicros;
      anchored_ = true;
      return true;
    }
    const int64_t gap = timestampMicros - (anchorMicros_ + SamplesToMicros(QueuedSamples(), sampleRate_));
    if (gap < -kGapToleranceMicros) {
      return false;
    }
    if (gap > kMaxSilenceMicros) {
      av_audio_fifo_reset(fifo_.get());
      anchorMicros_ = timestampMicros;
      readSamples_ = 0;
      frameStarts_.clear();
    } else if (gap > kGapToleranceMicros) {
      WriteSilence(gap * sampleRate_ / kMicrosPerSecond);
    }
    return true;
  }

  void DrainDecoder() {
    for (;;) {
      const int ret = avcodec_receive_frame(decoder_.get(), decoded_.get());
      if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        return;
      }
      if (ret == AVERROR_INVALIDDATA) {
        continue;
      }
      if (ret < 0) {
        throw Fatal("AAC decode failed", ret);
      }
      OpenEncoder(*decoded_);
      if (const int written =
              av_audio_fifo_write(fifo_.get(), reinterpret_cast<void**>(decoded_->extended_data), decoded_->nb_samples);
          written < decoded_->nb_samples) {
        throw Fatal("Could not buffer decoded audio", written < 0 ? written : AVERROR(ENOMEM));
      }
      av_frame_unref(decoded_.get());
    }
  }

  void OpenEncoder(const AVFrame& first) {
    if (encoderCtx_) {
      return;
    }
    const int channels = first.ch_layout.nb_channels;
    const int rateIndex = AdtsRateIndex(first.sample_rate);
    if (first.format != AV_SAMPLE_FMT_FLTP || channels < 1 || channels > kMaxChannels || rateIndex < 0) {
      throw PipelineError{"MediaProxyError", "Unsupported audio format: " + std::to_string(first.sample_rate) +
                                                 " Hz, " + std::to_string(channels) + " channels"};
    }
    encoderCtx_.reset(avcodec_alloc_context3(encoder_));
    encoderCtx_->sample_fmt = AV_SAMPLE_FMT_FLTP;
    encoderCtx_->sample_rate = first.sample_rate;
    encoderCtx_->time_base = {1, first.sample_rate};
    encoderCtx_->bit_rate = static_cast<int64_t>(config_.bitratePerChannel) * channels;
    encoderCtx_->profile = AV_PROFILE_AAC_LOW;
    av_channel_layout_default(&encoderCtx_->ch_layout, channels);
    if (const int ret = avcodec_open2(encoderCtx_.get(), encoder_, nullptr); ret < 0) {
      throw Fatal("Could not open the AAC encoder", ret);
    }
    sampleRate_ = first.sample_rate;
    channels_ = channels;
    rateIndex_ = rateIndex;
    chunkSize_ = encoderCtx_->frame_size;
    fifo_.reset(av_audio_fifo_alloc(AV_SAMPLE_FMT_FLTP, channels, chunkSize_));
    if (!fifo_) {
      throw PipelineError{"MediaProxyError", "Out of memory"};
    }
  }

  void WriteSilence(int64_t samples) {
    constexpr int kSilenceChunk = 4096;
    const std::vector<float> zeros(kSilenceChunk, 0.0F);
    std::vector<void*> planes(channels_, const_cast<float*>(zeros.data()));
    while (samples > 0) {
      const int count = static_cast<int>(std::min<int64_t>(samples, kSilenceChunk));
      if (av_audio_fifo_write(fifo_.get(), planes.data(), count) < count) {
        throw PipelineError{"MediaProxyError", "Could not buffer silence"};
      }
      samples -= count;
    }
  }

  void EncodeAvailable() {
    while (fifo_ && av_audio_fifo_size(fifo_.get()) >= chunkSize_) {
      av_frame_unref(chunk_.get());
      chunk_->nb_samples = chunkSize_;
      chunk_->format = AV_SAMPLE_FMT_FLTP;
      chunk_->sample_rate = sampleRate_;
      av_channel_layout_copy(&chunk_->ch_layout, &encoderCtx_->ch_layout);
      if (const int ret = av_frame_get_buffer(chunk_.get(), 0); ret < 0) {
        throw Fatal("Could not allocate an audio frame", ret);
      }
      av_audio_fifo_read(fifo_.get(), reinterpret_cast<void**>(chunk_->extended_data), chunkSize_);
      chunk_->pts = readSamples_;
      frameStarts_.push_back(anchorMicros_ + SamplesToMicros(readSamples_, sampleRate_));
      readSamples_ += chunkSize_;
      if (const int ret = avcodec_send_frame(encoderCtx_.get(), chunk_.get()); ret < 0) {
        throw Fatal("AAC encode failed", ret);
      }
      DrainEncoder();
    }
  }

  // Each packet takes the start time of the frame it was encoded from (so it includes the encoder's own delay).
  void DrainEncoder() {
    for (;;) {
      const int ret = avcodec_receive_packet(encoderCtx_.get(), packet_.get());
      if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        return;
      }
      if (ret < 0) {
        throw Fatal("AAC encode failed", ret);
      }
      EncodedUnit unit;
      unit.isKeyFrame = true;
      const auto header = AdtsHeader(static_cast<size_t>(packet_->size), rateIndex_, channels_);
      unit.data.reserve(header.size() + static_cast<size_t>(packet_->size));
      unit.data.assign(header.begin(), header.end());
      unit.data.insert(unit.data.end(), packet_->data, packet_->data + packet_->size);
      if (!frameStarts_.empty()) {
        lastStart_ = frameStarts_.front();
        frameStarts_.pop_front();
      } else {
        lastStart_ += SamplesToMicros(chunkSize_, sampleRate_);  // the encoder's delayed tail on flush
      }
      unit.timestampMicros = lastStart_;
      av_packet_unref(packet_.get());
      onUnit_(std::move(unit));
    }
  }

  AudioConfig config_;
  UnitCallback onUnit_;
  const AVCodec* encoder_ = nullptr;
  CodecContext decoder_;
  CodecContext encoderCtx_;
  Packet packet_;
  Frame decoded_;
  Frame chunk_;
  Fifo fifo_;
  std::deque<int64_t> frameStarts_;
  int64_t anchorMicros_ = 0;
  int64_t readSamples_ = 0;
  int64_t lastStart_ = 0;
  bool anchored_ = false;
  int sampleRate_ = 0;
  int channels_ = 0;
  int rateIndex_ = 0;
  int chunkSize_ = 0;
};

AudioPipeline::AudioPipeline(const AudioConfig& config, UnitCallback onUnit, ErrorCallback onError)
    : onError_(std::move(onError)), impl_(std::make_unique<Impl>(config, std::move(onUnit))) {
  worker_ = std::thread([this] { Run(); });
}

AudioPipeline::~AudioPipeline() {
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    aborting_ = true;
  }
  wake_.notify_all();
  if (worker_.joinable()) {
    worker_.join();
  }
}

void AudioPipeline::Push(std::vector<uint8_t> accessUnit, int64_t timestampMicros) {
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    if (finishing_ || aborting_) {
      return;
    }
    if (queue_.size() >= kMaxQueuedUnits) {
      queue_.pop_front();
    }
    queue_.push_back({std::move(accessUnit), timestampMicros});
  }
  wake_.notify_one();
}

void AudioPipeline::Finish(DoneCallback onDone) {
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    onDone_ = std::move(onDone);
    finishing_ = true;
  }
  wake_.notify_all();
}

void AudioPipeline::Run() {
  bool failed = false;
  // Nothing may escape the worker: an uncaught exception would terminate the whole process.
  const auto attempt = [&](const auto& body) {
    try {
      body();
    } catch (PipelineError& err) {
      failed = true;
      onError_(std::move(err));
    } catch (const std::exception& err) {
      failed = true;
      onError_({"MediaProxyError", err.what()});
    }
  };
  for (;;) {
    Input input;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      wake_.wait(lock, [this] { return aborting_ || finishing_ || !queue_.empty(); });
      if (aborting_) {
        return;
      }
      if (queue_.empty()) {
        break;
      }
      input = std::move(queue_.front());
      queue_.pop_front();
    }
    if (!failed) {
      attempt([&] { impl_->Process(input); });
    }
  }
  if (!failed) {
    attempt([&] { impl_->Flush(); });
  }
  impl_.reset();
  DoneCallback done;
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    done = std::move(onDone_);
  }
  if (done) {
    done();
  }
}

}  // namespace media_proxy
