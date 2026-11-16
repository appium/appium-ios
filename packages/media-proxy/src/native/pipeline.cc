#include "pipeline.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <exception>
#include <mutex>
#include <utility>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}

#include "ffmpeg_util.h"
#include "h264_encoder.h"

namespace media_proxy {

namespace {

constexpr int kMaxCodecThreads = 4;
constexpr int kMaxJpegQscale = 31;
constexpr double kMaxGopFrames = 1 << 20;  // keeps the int conversion defined for absurd fps
constexpr double kGopSeconds = 2;          // coresim's default key-frame interval
constexpr int kMinJpegQscale = 2;
// Slot-grid frame limiter (see Impl::AcceptFrame): timestamp jitter tolerated, as a fraction of 1/fps.
constexpr int kToleranceDivisor = 4;
// A slot further ahead of the stream than this many intervals means the timeline jumped back.
constexpr int64_t kMaxSlotLeadIntervals = 2;

struct SwsDeleter {
  void operator()(SwsContext* sws) const { sws_free_context(&sws); }
};

using Sws = std::unique_ptr<SwsContext, SwsDeleter>;

int CodecThreads() {
  const auto cores = static_cast<int>(std::thread::hardware_concurrency());
  return std::clamp(cores, 1, kMaxCodecThreads);
}

// libjpeg-style quality (1-100) to the MJPEG encoder's qscale (2 best .. 31 worst).
int JpegQscale(double quality) {
  const double t = (100.0 - std::clamp(quality, 1.0, 100.0)) / 99.0;
  return kMinJpegQscale + static_cast<int>(std::lround(t * (kMaxJpegQscale - kMinJpegQscale)));
}

// Copies one plane turned clockwise by `Degrees`. `T` is one sample: 1 byte, or 2 for NV12's interleaved UV. Works in
// blocks so that both the reads and the writes stay in the cache.
template <typename T, int Degrees>
void RotatePlane(const uint8_t* src, int srcStride, int width, int height, uint8_t* dst, int dstStride) {
  constexpr int kBlock = 32;
  for (int blockY = 0; blockY < height; blockY += kBlock) {
    const int endY = std::min(blockY + kBlock, height);
    for (int blockX = 0; blockX < width; blockX += kBlock) {
      const int endX = std::min(blockX + kBlock, width);
      for (int y = blockY; y < endY; ++y) {
        const T* row = reinterpret_cast<const T*>(src + (static_cast<ptrdiff_t>(y) * srcStride));
        for (int x = blockX; x < endX; ++x) {
          int dstX = 0;
          int dstY = 0;
          if constexpr (Degrees == 90) {
            dstX = height - 1 - y;
            dstY = x;
          } else if constexpr (Degrees == 180) {
            dstX = width - 1 - x;
            dstY = height - 1 - y;
          } else {
            dstX = y;
            dstY = width - 1 - x;
          }
          reinterpret_cast<T*>(dst + (static_cast<ptrdiff_t>(dstY) * dstStride))[dstX] = row[x];
        }
      }
    }
  }
}

template <typename T>
void RotatePlane(const uint8_t* src, int srcStride, int width, int height, uint8_t* dst, int dstStride, int degrees) {
  switch (degrees) {
    case 90:
      RotatePlane<T, 90>(src, srcStride, width, height, dst, dstStride);
      break;
    case 180:
      RotatePlane<T, 180>(src, srcStride, width, height, dst, dstStride);
      break;
    default:
      RotatePlane<T, 270>(src, srcStride, width, height, dst, dstStride);
      break;
  }
}

// Turns `src` clockwise by `degrees` (90, 180 or 270) into `dst`, which must be allocated for the turned size. Only
// the two formats the encoders take are supported.
void RotateFrame(const AVFrame& src, AVFrame& dst, int degrees) {
  const int width = src.width;
  const int height = src.height;
  if (src.format == AV_PIX_FMT_NV12) {
    RotatePlane<uint8_t>(src.data[0], src.linesize[0], width, height, dst.data[0], dst.linesize[0], degrees);
    // Interleaved UV: one sample is a pair
    RotatePlane<uint16_t>(src.data[1], src.linesize[1], width / 2, height / 2, dst.data[1], dst.linesize[1], degrees);
    return;
  }
  RotatePlane<uint8_t>(src.data[0], src.linesize[0], width, height, dst.data[0], dst.linesize[0], degrees);
  for (int plane = 1; plane <= 2; ++plane) {
    RotatePlane<uint8_t>(src.data[plane], src.linesize[plane], width / 2, height / 2, dst.data[plane],
                         dst.linesize[plane], degrees);
  }
}

}  // namespace

// FFmpeg state; touched only by the worker thread after construction.
class Pipeline::Impl {
 public:
  Impl(const PipelineConfig& config, UnitCallback onUnit, std::atomic<bool>& keyFrameRequested, std::atomic<bool>& warm,
       std::atomic<int>& rotation)
      : config_(config),
        isH264_(config.outputCodec == "h264"),
        keyFrameRequested_(keyFrameRequested),
        warm_(warm),
        rotation_(rotation),
        appliedRotation_(config.rotation),
        onUnit_(std::move(onUnit)),
        intervalMicros_(std::max<int64_t>(1, std::llround(1e6 / std::max(config.fps, 1.0)))),
        toleranceMicros_(intervalMicros_ / kToleranceDivisor) {
    if (!isH264_ && config.outputCodec != "mjpeg") {
      throw PipelineError{"MediaProxyOptionError", "outputCodec must be 'h264' or 'mjpeg'"};
    }
    const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_HEVC);
    if (isH264_) {
      RequireH264Encoder();
    } else {
      mjpeg_ = avcodec_find_encoder(AV_CODEC_ID_MJPEG);
    }
    if (decoder == nullptr || (!isH264_ && mjpeg_ == nullptr)) {
      throw PipelineError{kEncoderUnavailableError,
                          "The HEVC decoder or the output encoder is missing from this build"};
    }
    ConfigureLogging();
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
    rotated_.reset(av_frame_alloc());
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

  [[nodiscard]] bool EncoderOpen() const { return h264_ || mjpegCtx_; }

  void Flush() {
    avcodec_send_packet(decoder_.get(), nullptr);
    DrainDecoder();
    FlushEncoder();
  }

 private:
  // MEDIA_PROXY_FFMPEG_LOG=<av log level, e.g. 32 for info> re-enables FFmpeg's own logging for debugging.
  static void ConfigureLogging() {
    static std::once_flag once;
    std::call_once(once, [] {
      const char* text = std::getenv("MEDIA_PROXY_FFMPEG_LOG");
      char* end = nullptr;
      const long parsed = text != nullptr ? std::strtol(text, &end, 10) : AV_LOG_QUIET;
      av_log_set_level(end == text ? AV_LOG_QUIET : static_cast<int>(parsed));
    });
  }

  // fps is an upper bound: output frames fill slots of a 1/fps grid and each frame consumes one, so the
  // long-run rate never exceeds fps while the tolerance absorbs timestamp jitter.
  bool AcceptFrame(int64_t pts) {
    if (nextSlotMicros_ < 0 || nextSlotMicros_ - pts > kMaxSlotLeadIntervals * intervalMicros_) {
      nextSlotMicros_ = pts;
    }
    if (pts + toleranceMicros_ < nextSlotMicros_) {
      return false;
    }
    nextSlotMicros_ += intervalMicros_;
    while (nextSlotMicros_ - toleranceMicros_ <= pts) {
      nextSlotMicros_ += intervalMicros_;  // a gap in the input: don't bank slots for a later burst
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
        throw Fatal("HEVC decode failed", ret);
      }
      Encode(decoded_.get());
      av_frame_unref(decoded_.get());
    }
  }

  void Encode(AVFrame* decoded) {
    const int64_t pts = decoded->pts;
    if (!AcceptFrame(pts)) {
      return;
    }
    ApplyCrop(decoded);
    const int rotation = rotation_.load();
    if (rotation != appliedRotation_) {
      appliedRotation_ = rotation;
      // The picture changes shape: pictures coded before this one are of no use to a decoder that joins now
      keyFrameRequested_.store(true);
    }
    const bool turned = rotation == 90 || rotation == 270;
    const int width = ScaledSize(decoded->width);
    const int height = ScaledSize(decoded->height);
    const int outWidth = turned ? height : width;
    const int outHeight = turned ? width : height;
    OpenEncoder(outWidth, outHeight);

    PrepareConverted(converted_.get(), width, height);
    // Untagged input (the device doesn't tag its stream) is taken as the BT.709 the output is labelled with.
    if (isH264_ && decoded->colorspace == AVCOL_SPC_UNSPECIFIED) {
      decoded->colorspace = AVCOL_SPC_BT709;
    }
    if (const int ret = sws_scale_frame(sws_.get(), converted_.get(), decoded); ret < 0) {
      throw Fatal("Could not convert the decoded frame", ret);
    }
    AVFrame* out = converted_.get();
    if (rotation != 0) {
      PrepareConverted(rotated_.get(), outWidth, outHeight);
      RotateFrame(*converted_, *rotated_, rotation);
      out = rotated_.get();
    }
    out->pts = pts;
    if (isH264_) {
      EncodeH264(outWidth, outHeight, *out);
      return;
    }
    out->quality = mjpegCtx_->global_quality;
    if (const int ret = avcodec_send_frame(mjpegCtx_.get(), out); ret < 0) {
      throw Fatal("MJPEG encode failed", ret);
    }
    DrainEncoder();
  }

  // Keeps the top-left part of the picture, without copying: only the size changes, the rows keep their stride.
  void ApplyCrop(AVFrame* frame) const {
    if (config_.cropWidth <= 0 || config_.cropHeight <= 0) {
      return;
    }
    frame->crop_right = static_cast<size_t>(std::max(0, frame->width - config_.cropWidth));
    frame->crop_bottom = static_cast<size_t>(std::max(0, frame->height - config_.cropHeight));
    av_frame_apply_cropping(frame, AV_FRAME_CROP_UNALIGNED);
  }

  // A hardware session can die mid-stream (media-service reset): reopen once and retry; the new session starts
  // with a key frame. A forced key frame that comes out missing (the encoder dropped it) is requested again.
  void EncodeH264(int width, int height, const AVFrame& frame) {
    const bool forced = keyFrameRequested_.exchange(false);
    sawKeyFrame_ = false;
    try {
      h264_->Encode(frame, forced);
    } catch (const PipelineError&) {
      h264_.reset();
      OpenEncoder(width, height);
      h264_->Encode(frame, true);
    }
    if (forced && !sawKeyFrame_) {
      keyFrameRequested_.store(true);
    }
  }

  // Keeps the aspect ratio; both sides stay even for 4:2:0.
  [[nodiscard]] int ScaledSize(int side) const {
    const auto scaled = static_cast<int>(std::lround(side * config_.scale / 100.0));
    return std::max(2, scaled & ~1);
  }

  void OpenEncoder(int width, int height) {
    if (isH264_) {
      if (!h264_ || width != openWidth_ || height != openHeight_) {
        warm_.store(false);
        FlushEncoder();
        h264_.reset();
        H264Params params;
        params.width = width;
        params.height = height;
        params.fps = config_.fps;
        params.bitrate = static_cast<int64_t>(config_.bitrate);
        params.gopFrames = static_cast<int>(std::lround(std::clamp(config_.fps * kGopSeconds, 1.0, kMaxGopFrames)));
        h264_ = CreateH264Encoder(params, [this](EncodedUnit&& unit) {
          sawKeyFrame_ = sawKeyFrame_ || unit.isKeyFrame;
          onUnit_(std::move(unit));
        });
        openWidth_ = width;
        openHeight_ = height;
      }
      return;
    }
    if (mjpegCtx_ && mjpegCtx_->width == width && mjpegCtx_->height == height) {
      return;
    }
    warm_.store(false);
    FlushEncoder();
    mjpegCtx_.reset(avcodec_alloc_context3(mjpeg_));
    mjpegCtx_->width = width;
    mjpegCtx_->height = height;
    mjpegCtx_->pix_fmt = AV_PIX_FMT_YUVJ420P;
    mjpegCtx_->color_range = AVCOL_RANGE_JPEG;
    mjpegCtx_->time_base = {1, 1000000};
    mjpegCtx_->framerate = av_d2q(config_.fps, 1000000);
    mjpegCtx_->flags |= AV_CODEC_FLAG_QSCALE;
    mjpegCtx_->global_quality = FF_QP2LAMBDA * JpegQscale(config_.quality);
    mjpegCtx_->thread_type = FF_THREAD_SLICE;
    mjpegCtx_->thread_count = CodecThreads();
    // Default Huffman tables: the optimal ones need a second pass over every frame.
    av_opt_set(mjpegCtx_->priv_data, "huffman", "default", 0);
    if (const int ret = avcodec_open2(mjpegCtx_.get(), mjpeg_, nullptr); ret < 0) {
      throw Fatal("Could not open the MJPEG encoder", ret);
    }
  }

  [[nodiscard]] AVPixelFormat EncoderPixelFormat() const { return isH264_ ? AV_PIX_FMT_NV12 : AV_PIX_FMT_YUVJ420P; }

  // Reuses the buffer of `frame` unless the encoder still holds a reference to it (or the size changed).
  void PrepareConverted(AVFrame* frame, int width, int height) const {
    if (frame->buf[0] != nullptr && frame->width == width && frame->height == height &&
        av_frame_is_writable(frame) != 0) {
      return;
    }
    av_frame_unref(frame);
    frame->format = EncoderPixelFormat();
    frame->width = width;
    frame->height = height;
    frame->color_range = isH264_ ? AVCOL_RANGE_MPEG : AVCOL_RANGE_JPEG;
    // The H.264 output is tagged BT.709; an unspecified target would make swscale convert to BT.601.
    frame->colorspace = isH264_ ? AVCOL_SPC_BT709 : AVCOL_SPC_UNSPECIFIED;
    if (const int ret = av_frame_get_buffer(frame, 0); ret < 0) {
      throw Fatal("Could not allocate the output frame", ret);
    }
  }

  void FlushEncoder() {
    if (h264_) {
      h264_->Flush();
    } else if (mjpegCtx_) {
      avcodec_send_frame(mjpegCtx_.get(), nullptr);
      DrainEncoder();
    }
  }

  void DrainEncoder() {
    for (;;) {
      const int ret = avcodec_receive_packet(mjpegCtx_.get(), packet_.get());
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
  bool isH264_;
  std::atomic<bool>& keyFrameRequested_;
  std::atomic<bool>& warm_;
  std::atomic<int>& rotation_;
  int appliedRotation_;
  UnitCallback onUnit_;
  int64_t intervalMicros_;
  int64_t toleranceMicros_;
  int64_t nextSlotMicros_ = -1;
  const AVCodec* mjpeg_ = nullptr;
  std::unique_ptr<H264Encoder> h264_;
  bool sawKeyFrame_ = false;
  int openWidth_ = 0;
  int openHeight_ = 0;
  CodecContext decoder_;
  CodecContext mjpegCtx_;
  Packet packet_;
  Frame decoded_;
  Frame converted_;
  Frame rotated_;
  Sws sws_;
};

Capabilities Pipeline::Probe() {
  Capabilities caps;
  if (const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_HEVC); decoder != nullptr) {
    caps.decoders.emplace_back(decoder->name);
  }
  if (const AVCodec* encoder = avcodec_find_encoder(AV_CODEC_ID_MJPEG); encoder != nullptr) {
    caps.encoders.emplace_back(encoder->name);
  }
  if (const AVCodec* decoder = avcodec_find_decoder(AV_CODEC_ID_AAC); decoder != nullptr) {
    caps.decoders.emplace_back(decoder->name);
  }
  if (const AVCodec* encoder = avcodec_find_encoder(AV_CODEC_ID_AAC); encoder != nullptr) {
    caps.encoders.emplace_back(encoder->name);
  }
  for (std::string& name : H264EncoderNames()) {
    caps.encoders.push_back(std::move(name));
  }
  return caps;
}

Pipeline::Pipeline(const PipelineConfig& config, UnitCallback onUnit, ErrorCallback onError,
                   std::atomic<bool>& keyFrameRequested)
    : rotation_(config.rotation),
      onError_(std::move(onError)),
      impl_(std::make_unique<Impl>(config, std::move(onUnit), keyFrameRequested, warm_, rotation_)) {
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
    // While an encoder is opening (first frame, rotation) nothing is on screen yet: queue more and catch up fast.
    if (queue_.size() >= (warm_.load() ? kMaxQueuedUnits : kMaxWarmupUnits)) {
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
    {
      // Caught up again (the backlog from an encoder start-up is gone): back to the tight steady-state limit.
      const std::scoped_lock<std::mutex> lock(mutex_);
      if (impl_->EncoderOpen() && queue_.size() < kMaxQueuedUnits) {
        warm_.store(true);
      }
    }
  }
  if (!failed) {
    attempt([&] { impl_->Flush(); });
  }
  impl_.reset();  // free the codecs (and their threads) now, not when the owner is garbage collected
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
