#pragma once

#include <array>
#include <memory>
#include <string>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/error.h>
#include <libavutil/frame.h>
}

#include "pipeline.h"

namespace media_proxy {

struct CodecContextDeleter {
  void operator()(AVCodecContext* ctx) const { avcodec_free_context(&ctx); }
};
struct FrameDeleter {
  void operator()(AVFrame* frame) const { av_frame_free(&frame); }
};
struct PacketDeleter {
  void operator()(AVPacket* pkt) const { av_packet_free(&pkt); }
};

using CodecContext = std::unique_ptr<AVCodecContext, CodecContextDeleter>;
using Frame = std::unique_ptr<AVFrame, FrameDeleter>;
using Packet = std::unique_ptr<AVPacket, PacketDeleter>;

inline PipelineError Fatal(const std::string& what, int code) {
  std::array<char, AV_ERROR_MAX_STRING_SIZE> text{};
  av_strerror(code, text.data(), text.size());
  return {"MediaProxyError", what + ": " + text.data()};
}

}  // namespace media_proxy
