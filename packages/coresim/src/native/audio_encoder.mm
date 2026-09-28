#include "audio_encoder.h"

#include <algorithm>
#include <cmath>
#include <utility>
#include <vector>

#include "monotonic_clock.h"
#include "nserror_bridge.h"

namespace coresim {

namespace {

NSString* const kAudioEncoderErrorDomain = @"io.appium.coresim.AudioEncoder";

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kAudioEncoderErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

NSError* MakeStatusError(NSInteger code, NSString* what, OSStatus status) {
  return MakeError(code, [NSString stringWithFormat:@"%@ (OSStatus %d)", what, static_cast<int>(status)]);
}

// AAC-LC is spec-mandated at 1024 PCM samples/packet — unlike sample rate/channel count, this
// isn't something the converter needs to be asked for.
constexpr UInt32 kFramesPerAacPacket = 1024;

struct InputProcContext {
  const uint8_t* data;
  UInt32 framesAvailable;
  UInt32 bytesPerFrame;
  UInt32 channelsPerFrame;
};

// AudioConverterFillComplexBuffer's pull callback: hands over whatever of `framesAvailable` is
// left, or signals "nothing more right now" (0 packets, noErr — not an error/EOF condition) once
// exhausted, matching Apple's documented streaming-converter pattern.
OSStatus InputDataProc(AudioConverterRef /*inConverter*/, UInt32* ioNumberDataPackets, AudioBufferList* ioData,
                       AudioStreamPacketDescription** /*outPacketDescription*/, void* inUserData) {
  auto* ctx = static_cast<InputProcContext*>(inUserData);
  UInt32 framesToProvide = std::min(*ioNumberDataPackets, ctx->framesAvailable);
  ioData->mNumberBuffers = 1;
  ioData->mBuffers[0].mNumberChannels = ctx->channelsPerFrame;
  if (framesToProvide == 0) {
    ioData->mBuffers[0].mData = nullptr;
    ioData->mBuffers[0].mDataByteSize = 0;
    *ioNumberDataPackets = 0;
    return noErr;
  }
  ioData->mBuffers[0].mData = const_cast<uint8_t*>(ctx->data);
  ioData->mBuffers[0].mDataByteSize = framesToProvide * ctx->bytesPerFrame;
  ctx->data += framesToProvide * ctx->bytesPerFrame;
  ctx->framesAvailable -= framesToProvide;
  *ioNumberDataPackets = framesToProvide;
  return noErr;
}

}  // namespace

class AudioEncoder::Impl {
 public:
  Impl(const AudioStreamBasicDescription& inputFormat, std::function<void(CMSampleBufferRef)> onSample,
       const double* sharedClockOrigin)
      : inputFormat_(inputFormat), onSample_(std::move(onSample)) {
    outputFormat_ = {};
    outputFormat_.mFormatID = kAudioFormatMPEG4AAC;
    outputFormat_.mFormatFlags = kMPEG4Object_AAC_LC;
    outputFormat_.mSampleRate = inputFormat_.mSampleRate;
    outputFormat_.mChannelsPerFrame = inputFormat_.mChannelsPerFrame;
    outputFormat_.mFramesPerPacket = kFramesPerAacPacket;

    OSStatus status = AudioConverterNew(&inputFormat_, &outputFormat_, &converter_);
    if (status != noErr) {
      throw NSErrorException(MakeStatusError(1, @"AudioConverterNew failed", status));
    }

    UInt32 bitRate = 64000 * std::max<UInt32>(outputFormat_.mChannelsPerFrame, 1);
    // Non-fatal if rejected — the converter's own default bitrate is still a valid AAC-LC config.
    AudioConverterSetProperty(converter_, kAudioConverterEncodeBitRate, sizeof(bitRate), &bitRate);

    UInt32 maxPacketSize = 0;
    UInt32 maxPacketSizeFieldSize = sizeof(maxPacketSize);
    status = AudioConverterGetProperty(converter_, kAudioConverterPropertyMaximumOutputPacketSize,
                                       &maxPacketSizeFieldSize, &maxPacketSize);
    maxOutputPacketSize_ = (status == noErr && maxPacketSize > 0) ? maxPacketSize : 4096;
    outputBuffer_.resize(maxOutputPacketSize_);

    AudioConverterPrimeInfo primeInfo = {};
    UInt32 primeInfoSize = sizeof(primeInfo);
    status = AudioConverterGetProperty(converter_, kAudioConverterPrimeInfo, &primeInfoSize, &primeInfo);
    primingFrames_ = (status == noErr) ? primeInfo.leadingFrames : 0;

    status = CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &outputFormat_, 0, nullptr, 0, nullptr, nullptr,
                                            &formatDescription_);
    if (status != noErr) {
      AudioConverterDispose(converter_);
      converter_ = nullptr;
      throw NSErrorException(MakeStatusError(2, @"CMAudioFormatDescriptionCreate failed", status));
    }

    // How many output frames "ahead" this encoder's PTS zero should start at, so its first
    // packet's timestamp lands at the same point on the shared timeline a peer VideoFrameEncoder
    // (given the same origin) would compute for something starting at this same instant — see the
    // constructor doc comment.
    if (sharedClockOrigin != nullptr) {
      double elapsedSeconds = MonotonicSeconds() - *sharedClockOrigin;
      zeroOffsetFrames_ = static_cast<int64_t>(std::llround(elapsedSeconds * outputFormat_.mSampleRate));
    }
  }

  ~Impl() {
    if (formatDescription_ != nullptr) {
      CFRelease(formatDescription_);
    }
    if (converter_ != nullptr) {
      AudioConverterDispose(converter_);
    }
  }

  void EncodePCM(const AudioBufferList* data, const AudioTimeStamp* /*time*/) {
    if (data->mNumberBuffers == 0) {
      return;
    }
    const AudioBuffer& buf = data->mBuffers[0];
    const uint8_t* bytes = static_cast<const uint8_t*>(buf.mData);
    pcmBuffer_.insert(pcmBuffer_.end(), bytes, bytes + buf.mDataByteSize);

    UInt32 bytesPerFrame = inputFormat_.mBytesPerFrame;
    if (bytesPerFrame == 0) {
      return;  // malformed input format — nothing sane to do
    }
    while (pcmBuffer_.size() / bytesPerFrame >= kFramesPerAacPacket) {
      InputProcContext ctx{pcmBuffer_.data(), static_cast<UInt32>(pcmBuffer_.size() / bytesPerFrame), bytesPerFrame,
                           inputFormat_.mChannelsPerFrame};

      AudioBufferList outputBufferList;
      outputBufferList.mNumberBuffers = 1;
      outputBufferList.mBuffers[0].mNumberChannels = outputFormat_.mChannelsPerFrame;
      outputBufferList.mBuffers[0].mDataByteSize = static_cast<UInt32>(outputBuffer_.size());
      outputBufferList.mBuffers[0].mData = outputBuffer_.data();

      AudioStreamPacketDescription packetDescription = {};
      UInt32 outputPacketCount = 1;
      OSStatus status = AudioConverterFillComplexBuffer(converter_, InputDataProc, &ctx, &outputPacketCount,
                                                        &outputBufferList, &packetDescription);
      UInt32 framesConsumed = static_cast<UInt32>(pcmBuffer_.size() / bytesPerFrame) - ctx.framesAvailable;
      pcmBuffer_.erase(pcmBuffer_.begin(), pcmBuffer_.begin() + framesConsumed * bytesPerFrame);

      if (status != noErr) {
        throw NSErrorException(MakeStatusError(3, @"AudioConverterFillComplexBuffer failed", status));
      }
      if (outputPacketCount == 0) {
        break;  // not enough input actually consumed to complete a packet this round
      }
      EmitSample(packetDescription.mDataByteSize);
    }
  }

  CMFormatDescriptionRef OutputFormatDescription() const { return formatDescription_; }

 private:
  void EmitSample(UInt32 packetByteSize) {
    CMBlockBufferRef blockBuffer = nullptr;
    OSStatus status =
        CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, nullptr, packetByteSize, kCFAllocatorDefault, nullptr,
                                           0, packetByteSize, kCMBlockBufferAssureMemoryNowFlag, &blockBuffer);
    if (status != noErr || blockBuffer == nullptr) {
      return;
    }
    CMBlockBufferReplaceDataBytes(outputBuffer_.data(), blockBuffer, 0, packetByteSize);

    CMTime pts = CMTimeMake(zeroOffsetFrames_ + framesEncoded_, static_cast<int32_t>(outputFormat_.mSampleRate));
    CMSampleTimingInfo timing = {CMTimeMake(kFramesPerAacPacket, static_cast<int32_t>(outputFormat_.mSampleRate)), pts,
                                 kCMTimeInvalid};
    size_t sampleSize = packetByteSize;
    CMSampleBufferRef sampleBuffer = nullptr;
    status = CMSampleBufferCreate(kCFAllocatorDefault, blockBuffer, true, nullptr, nullptr, formatDescription_, 1, 1,
                                  &timing, 1, &sampleSize, &sampleBuffer);
    CFRelease(blockBuffer);
    if (status != noErr || sampleBuffer == nullptr) {
      return;
    }
    framesEncoded_ += kFramesPerAacPacket;

    if (!primingTrimApplied_) {
      primingTrimApplied_ = true;
      if (primingFrames_ > 0) {
        CMTime trimDuration =
            CMTimeMake(static_cast<int64_t>(primingFrames_), static_cast<int32_t>(outputFormat_.mSampleRate));
        CFDictionaryRef trimDict = CMTimeCopyAsDictionary(trimDuration, kCFAllocatorDefault);
        if (trimDict != nullptr) {
          CMSetAttachment(sampleBuffer, kCMSampleBufferAttachmentKey_TrimDurationAtStart, trimDict,
                          kCMAttachmentMode_ShouldPropagate);
          CFRelease(trimDict);
        }
      }
    }

    if (onSample_) {
      onSample_(sampleBuffer);
    }
    CFRelease(sampleBuffer);
  }

  AudioStreamBasicDescription inputFormat_;
  AudioStreamBasicDescription outputFormat_;
  std::function<void(CMSampleBufferRef)> onSample_;

  AudioConverterRef converter_ = nullptr;
  CMAudioFormatDescriptionRef formatDescription_ = nullptr;
  std::vector<uint8_t> pcmBuffer_;
  std::vector<uint8_t> outputBuffer_;
  UInt32 maxOutputPacketSize_ = 0;
  UInt32 primingFrames_ = 0;
  bool primingTrimApplied_ = false;
  int64_t framesEncoded_ = 0;
  int64_t zeroOffsetFrames_ = 0;
};

AudioEncoder::AudioEncoder(const AudioStreamBasicDescription& inputFormat,
                           std::function<void(CMSampleBufferRef)> onSample, const double* sharedClockOrigin)
    : impl_(std::make_unique<Impl>(inputFormat, std::move(onSample), sharedClockOrigin)) {}

AudioEncoder::~AudioEncoder() = default;

void AudioEncoder::EncodePCM(const AudioBufferList* data, const AudioTimeStamp* time) { impl_->EncodePCM(data, time); }

CMFormatDescriptionRef AudioEncoder::OutputFormatDescription() const { return impl_->OutputFormatDescription(); }

namespace {

// ISO/IEC 13818-7 Table 35 — ADTS's 4-bit samplingFrequencyIndex. Falls back to 44.1kHz (index 4)
// for a rate outside this fixed table, which a real Core Audio device format should never hit.
int ADTSSamplingFrequencyIndex(double sampleRate) {
  static constexpr std::pair<int, int> kIndexByRate[] = {{96000, 0},  {88200, 1}, {64000, 2}, {48000, 3}, {44100, 4},
                                                         {32000, 5},  {24000, 6}, {22050, 7}, {16000, 8}, {12000, 9},
                                                         {11025, 10}, {8000, 11}, {7350, 12}};
  int rounded = static_cast<int>(std::lround(sampleRate));
  for (const auto& [rate, index] : kIndexByRate) {
    if (rate == rounded) {
      return index;
    }
  }
  return 4;
}

}  // namespace

void PrependADTSHeader(std::vector<uint8_t>& out, size_t aacFrameLength, const AudioStreamBasicDescription& format) {
  // Field layout/values match FFmpeg's own ADTS writer (libavformat/adtsenc.c): MPEG-4 ID, AAC-LC
  // profile, VBR buffer fullness (all 1s), one raw data block per ADTS frame.
  size_t adtsFrameLength = aacFrameLength + 7;
  int samplingFrequencyIndex = ADTSSamplingFrequencyIndex(format.mSampleRate);
  int channelConfig = std::max<int>(1, static_cast<int>(format.mChannelsPerFrame));
  constexpr int kAacLcProfile = 1;  // ADTS profile field = MPEG-4 Audio Object Type (2 for AAC-LC) minus 1

  uint8_t header[7];
  header[0] = 0xFF;
  header[1] = 0xF1;
  header[2] = static_cast<uint8_t>((kAacLcProfile << 6) | (samplingFrequencyIndex << 2) | ((channelConfig >> 2) & 0x1));
  header[3] = static_cast<uint8_t>(((channelConfig & 0x3) << 6) | ((adtsFrameLength >> 11) & 0x3));
  header[4] = static_cast<uint8_t>((adtsFrameLength >> 3) & 0xFF);
  header[5] = static_cast<uint8_t>(((adtsFrameLength & 0x7) << 5) | 0x1F);
  header[6] = 0xFC;

  out.insert(out.end(), header, header + 7);
}

}  // namespace coresim
