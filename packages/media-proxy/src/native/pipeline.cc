#include "pipeline.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <exception>
#include <utility>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

namespace media_proxy {

namespace {

constexpr const char* kEncoderUnavailable = "MediaProxyEncoderUnavailableError";
constexpr int kMaxCodecThreads = 4;
constexpr int kMaxJpegQscale = 31;
constexpr int kMinJpegQscale = 2;
// Frames closer than this fraction of 1/fps to the previous one are dropped (fps is an upper bound).
constexpr double kMinIntervalFraction = 0.8;

struct CodecContextDeleter {
  void operator()(AVCodecContext* ctx) const { avcodec_free_context(&ctx); }
};
struct FrameDeleter {
  void operator()(AVFrame* frame) const { av_frame_free(&frame); }
};
struct PacketDeleter {
  void operator()(AVPacket* pkt) const { av_packet_free(&pkt); }
};
struct SwsDeleter {
  void operator()(SwsContext* sws) const { sws_free_context(&sws); }
};

using CodecContext = std::unique_ptr<AVCodecContext, CodecContextDeleter>;
using Frame = std::unique_ptr<AVFrame, FrameDeleter>;
using Packet = std::unique_ptr<AVPacket, PacketDeleter>;
using Sws = std::unique_ptr<SwsContext, SwsDeleter>;

PipelineError MakeError(const char* name, const std::string& what, int code) {
  std::array<char, AV_ERROR_MAX_STRING_SIZE> text{};
  av_strerror(code, text.data(), text.size());
  return {name, what + ": " + text.data()};
}

PipelineError Fatal(const std::string& what, int code) { return MakeError("MediaProxyError", what, code); }

int CodecThreads() {
  const auto cores = static_cast<int>(std::thread::hardware_concurrency());
  return std::clamp(cores, 1, kMaxCodecThreads);
}

// libjpeg-style quality (1-100) to the MJPEG encoder's qscale (2 best .. 31 worst).
int JpegQscale(double quality) {
  const double t = (100.0 - std::clamp(quality, 1.0, 100.0)) / 99.0;
  return kMinJpegQscale + static_cast<int>(std::lround(t * (kMaxJpegQscale - kMinJpegQscale)));
}

}  // namespace

// FFmpeg state; touched only by the worker thread after construction.
class Pipeline::Impl {
 public:
  Impl(const PipelineConfig& config, UnitCallback onUnit)
      : config_(config),
        onUnit_(std::move(onUnit)),
        minIntervalMicros_(static_cast<int64_t>(1e6 / std::max(config.fps, 1.0) * kMinIntervalFraction)) {
    if (config.outputCodec != "mjpeg") {
      throw PipelineError{kEncoderUnavailable, "No H.264 encoder is compiled into this build; use mjpeg"};
    }
    const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_HEVC);
    encoder_ = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    if (decoder == nullptr || encoder_ == nullptr) {
      throw PipelineError{kEncoderUnavailable, "The HEVC decoder or MJPEG encoder is missing from this build"};
    }
    av_log_set_level(AV_LOG_QUIET);
    decoder_.reset(avcodec_alloc_context3(decoder));
    decoder_->flags |= AV_CODEC_FLAG_LOW_DELAY;
    decoder_->thread_type = FF_THREAD_SLICE;
    decoder_->thread_count = CodecThreads();
    if (const int ret = avcodec_open2(decoder_.get(), decoder, nullptr); ret < 0) {
      throw Fatal("Could not open the HEVC decoder", ret);
    }
    packet_.reset(av_packet_alloc());
    decoded_.reset(av_frame_alloc());
    converted_.reset(av_frame_alloc());
    sws_.reset(sws_alloc_context());
  }

  void Decode(const Input& input) {
    if (const int ret = av_new_packet(packet_.get(), static_cast<int>(input.data.size())); ret < 0) {
      throw Fatal("Could not allocate a packet", ret);
    }
    std::copy(input.data.begin(), input.data.end(), packet_->data);
    packet_->pts = input.timestampMicros;
    packet_->dts = input.timestampMicros;
    const int ret = avcodec_send_packet(decoder_.get(), packet_.get());
    av_packet_unref(packet_.get());
    // Corrupt or undecodable units (e.g. before the first IRAP) are skipped, not fatal.
    if (ret < 0 && ret != AVERROR_INVALIDDATA && ret != AVERROR(EAGAIN)) {
      throw Fatal("HEVC decode failed", ret);
    }
    DrainDecoder();
  }

  void Flush() {
    avcodec_send_packet(decoder_.get(), nullptr);
    DrainDecoder();
    FlushEncoder();
  }

 private:
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
        throw Fatal("HEVC decode failed", ret);
      }
      Encode(decoded_.get());
      av_frame_unref(decoded_.get());
    }
  }

  void Encode(const AVFrame* decoded) {
    const int64_t pts = decoded->pts;
    if (lastEmittedMicros_ >= 0 && pts - lastEmittedMicros_ < minIntervalMicros_) {
      return;
    }
    lastEmittedMicros_ = pts;
    const int width = ScaledSize(decoded->width);
    const int height = ScaledSize(decoded->height);
    OpenEncoder(width, height);

    // A fresh buffer per frame: the encoder may still reference the previous one.
    AllocateConverted(width, height);
    if (const int ret = sws_scale_frame(sws_.get(), converted_.get(), decoded); ret < 0) {
      throw Fatal("Could not convert the decoded frame", ret);
    }
    converted_->pts = pts;
    converted_->quality = encoderCtx_->global_quality;
    if (const int ret = avcodec_send_frame(encoderCtx_.get(), converted_.get()); ret < 0) {
      throw Fatal("MJPEG encode failed", ret);
    }
    DrainEncoder();
  }

  // Keeps the aspect ratio; both sides stay even for 4:2:0.
  [[nodiscard]] int ScaledSize(int side) const {
    const auto scaled = static_cast<int>(std::lround(side * config_.scale / 100.0));
    return std::max(2, scaled & ~1);
  }

  void OpenEncoder(int width, int height) {
    if (encoderCtx_ && encoderCtx_->width == width && encoderCtx_->height == height) {
      return;
    }
    FlushEncoder();
    encoderCtx_.reset(avcodec_alloc_context3(encoder_));
    encoderCtx_->width = width;
    encoderCtx_->height = height;
    encoderCtx_->pix_fmt = AV_PIX_FMT_YUVJ420P;
    encoderCtx_->color_range = AVCOL_RANGE_JPEG;
    encoderCtx_->time_base = {1, 1000000};
    encoderCtx_->framerate = av_d2q(config_.fps, 1000000);
    encoderCtx_->flags |= AV_CODEC_FLAG_QSCALE;
    encoderCtx_->global_quality = FF_QP2LAMBDA * JpegQscale(config_.quality);
    encoderCtx_->thread_type = FF_THREAD_SLICE;
    encoderCtx_->thread_count = CodecThreads();
    // Default Huffman tables: the optimal ones need a second pass over every frame.
    av_opt_set(encoderCtx_->priv_data, "huffman", "default", 0);
    if (const int ret = avcodec_open2(encoderCtx_.get(), encoder_, nullptr); ret < 0) {
      throw Fatal("Could not open the MJPEG encoder", ret);
    }
  }

  void AllocateConverted(int width, int height) {
    av_frame_unref(converted_.get());
    converted_->format = AV_PIX_FMT_YUVJ420P;
    converted_->width = width;
    converted_->height = height;
    converted_->color_range = AVCOL_RANGE_JPEG;
    if (const int ret = av_frame_get_buffer(converted_.get(), 0); ret < 0) {
      throw Fatal("Could not allocate the output frame", ret);
    }
  }

  void FlushEncoder() {
    if (encoderCtx_) {
      avcodec_send_frame(encoderCtx_.get(), nullptr);
      DrainEncoder();
    }
  }

  void DrainEncoder() {
    for (;;) {
      const int ret = avcodec_receive_packet(encoderCtx_.get(), packet_.get());
      if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        return;
      }
      if (ret < 0) {
        throw Fatal("MJPEG encode failed", ret);
      }
      EncodedUnit unit;
      unit.data.assign(packet_->data, packet_->data + packet_->size);
      unit.isKeyFrame = (packet_->flags & AV_PKT_FLAG_KEY) != 0;
      unit.timestampMicros = packet_->pts;
      av_packet_unref(packet_.get());
      onUnit_(std::move(unit));
    }
  }

  PipelineConfig config_;
  UnitCallback onUnit_;
  int64_t minIntervalMicros_;
  int64_t lastEmittedMicros_ = -1;
  const AVCodec* encoder_ = nullptr;
  CodecContext decoder_;
  CodecContext encoderCtx_;
  Packet packet_;
  Frame decoded_;
  Frame converted_;
  Sws sws_;
};

Pipeline::Pipeline(const PipelineConfig& config, UnitCallback onUnit, ErrorCallback onError)
    : onError_(std::move(onError)), impl_(std::make_unique<Impl>(config, std::move(onUnit))) {
  worker_ = std::thread([this] { Run(); });
}

Pipeline::~Pipeline() {
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    aborting_ = true;
  }
  wake_.notify_all();
  if (worker_.joinable()) {
    worker_.join();
  }
}

void Pipeline::Push(std::vector<uint8_t> accessUnit, int64_t timestampMicros, bool isKeyFrame) {
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    if (finishing_ || aborting_) {
      return;
    }
    if (awaitingKeyFrame_) {
      if (!isKeyFrame) {
        return;
      }
      awaitingKeyFrame_ = false;
    }
    if (queue_.size() >= kMaxQueuedUnits) {
      // Falling behind: drop the backlog and resume at the next key frame (P-frames can't decode alone).
      queue_.clear();
      if (!isKeyFrame) {
        awaitingKeyFrame_ = true;
        return;
      }
    }
    queue_.push_back({std::move(accessUnit), timestampMicros, isKeyFrame});
  }
  wake_.notify_one();
}

void Pipeline::Finish(DoneCallback onDone) {
  {
    const std::scoped_lock<std::mutex> lock(mutex_);
    onDone_ = std::move(onDone);
    finishing_ = true;
  }
  wake_.notify_all();
}

void Pipeline::Run() {
  bool failed = false;
  const auto fail = [&](PipelineError&& err) {
    failed = true;
    onError_(std::move(err));
  };
  // Nothing may escape the worker: an uncaught exception would terminate the whole process.
  const auto attempt = [&](const auto& body) {
    try {
      body();
    } catch (PipelineError& err) {
      fail(std::move(err));
    } catch (const std::exception& err) {
      fail({"MediaProxyError", err.what()});
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
    if (failed) {
      continue;
    }
    attempt([&] { impl_->Decode(input); });
  }
  if (!failed) {
    attempt([&] { impl_->Flush(); });
  }
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
