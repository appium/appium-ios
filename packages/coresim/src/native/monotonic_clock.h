#pragma once

#include <ctime>

namespace coresim {

// CFAbsoluteTimeGetCurrent()/gettimeofday() are wall time — subject to backward NTP/manual clock
// corrections, which would violate encoders' requirement of strictly increasing presentation
// timestamps. CLOCK_MONOTONIC_RAW never goes backward and isn't adjusted by NTP. Shared by
// video_encoder.mm, audio_encoder.mm, and av_recording.mm/av_stream.mm — the latter two capture
// one value from this up front and hand it to both encoders as their common PTS-zero reference,
// so a combined recording/stream's video and audio tracks stay in sync instead of each measuring
// elapsed time from its own, independently-timed setup completion.
inline double MonotonicSeconds() {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC_RAW, &ts);
  return static_cast<double>(ts.tv_sec) + static_cast<double>(ts.tv_nsec) / 1e9;
}

}  // namespace coresim
