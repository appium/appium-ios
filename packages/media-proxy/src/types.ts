/**
 * One native HEVC access unit as produced by `appium-ios-remotexpc`'s `ScreenStreamCapture`
 * (structural, so this package has no dependency on it): bare NAL units, no start codes.
 */
export interface NalAccessUnit {
  nals: Buffer[];
  isKeyFrame: boolean;
  /** Raw 32-bit RTP media-clock timestamp (90 kHz). */
  timestamp: number;
  /** `performance.now()` when the unit arrived; aligns video with audio. Defaults to the push time. */
  receivedAt?: number;
}

/**
 * One native AAC-ELD access unit as produced by `appium-ios-remotexpc`'s `AudioStreamCapture`
 * (structural): 480 samples (10 ms) of 48 kHz stereo.
 */
export interface AudioAccessUnit {
  data: Buffer;
  /** Raw 32-bit RTP media-clock timestamp (48 kHz). */
  timestamp: number;
  /** `performance.now()` when the unit arrived; aligns audio with video. Defaults to the push time. */
  receivedAt?: number;
}

/** Mirrors coresim's `VideoStreamOptions` (minus `displayId`/`codec`/`audio`). */
export interface VideoStreamOptions {
  /**
   * Max frames/sec — the input is variable-rate, so this is an upper bound, not a guarantee.
   * Must be a finite number >= 1. Defaults to 60.
   */
  fps?: number;
  /** Target average bitrate, in bits/sec. Defaults to 4,000,000 (4 Mbps). */
  bitrate?: number;
}

/** Mirrors coresim's `JpegStreamOptions` (minus `displayId`). */
export interface JpegStreamOptions {
  /** Max frames/sec; must be a finite number >= 1. Defaults to 60. */
  fps?: number;
  /** JPEG quality as a percentage, 0 (smallest) to 100 (largest). Defaults to 80. */
  quality?: number;
  /** Frame scale as a percentage of the source, greater than 0 and at most 100. Defaults to 100. */
  scale?: number;
}

export interface H264Options extends VideoStreamOptions {
  codec: 'h264';
  /**
   * Also transcode the device audio (AAC-ELD, fed through `pushAudio()` or the `audioSource` of
   * `transcode()`) to ADTS-framed AAC-LC units interleaved into `units()`, like coresim. Defaults to false.
   */
  audio?: boolean;
  /**
   * `AudioSpecificConfig` of the pushed audio. Defaults to the device's stream, which must be given
   * its true 480-sample frame length (remotexpc's `AudioStreamCapture.format.audioSpecificConfig`).
   */
  audioSpecificConfig?: Buffer;
}

export interface MjpegOptions extends JpegStreamOptions {
  codec: 'mjpeg';
}

export type TranscoderOptions = H264Options | MjpegOptions;

/**
 * One H.264 unit; same shape as coresim's `VideoAccessUnit` (video track only). Annex-B, 4-byte
 * start codes; a keyframe carries SPS/PPS inline, so it is self-decodable alone.
 */
export interface VideoAccessUnit {
  track: 'video' | 'audio';
  data: Buffer;
  /** Always true for audio: every ADTS unit decodes on its own. */
  isKeyFrame: boolean;
  /** Monotonically increasing per track, starting at 0. */
  sequence: number;
  /** Microseconds since the stream started, on one clock shared by both tracks. */
  timestampMicros: number;
}

/** One standalone JPEG; same shape as coresim's `JpegFrame`. */
export interface JpegFrame {
  data: Buffer;
  sequence: number;
  timestampMicros: number;
}

/** Raw unit from the native side, before the JS layer assigns `sequence`. */
export interface NativeUnit {
  data: Buffer;
  isKeyFrame: boolean;
  timestampMicros: number;
  /** Set on audio units. */
  audio?: boolean;
}

export interface NativeConfig {
  outputCodec: 'h264' | 'mjpeg';
  fps: number;
  bitrate: number;
  quality: number;
  scale: number;
  audio: boolean;
  audioSpecificConfig: Buffer;
  audioBitratePerChannel: number;
}

export interface NativeTranscoderHandle {
  /** Each chunk is one bare HEVC NAL unit (no start code). */
  push(chunks: Buffer[], timestampMicros: number, isKeyFrame: boolean): void;
  /** One AAC-ELD access unit (only with `audio`). */
  pushAudio(data: Buffer, timestampMicros: number): void;
  /** Forces the next H.264 output to be an IDR frame (used to resync after an overflow). */
  requestKeyFrame(): void;
  /** Flushes pending frames through `onUnit`, releases resources, then resolves (no callbacks after). */
  close(): Promise<void>;
}

export interface NativeModule {
  createTranscoder(
    config: NativeConfig,
    onUnit: (unit: NativeUnit) => void,
    onError: (err: Error) => void,
  ): NativeTranscoderHandle;
  /** Encoders/decoders compiled into this build, e.g. `['h264_videotoolbox', 'mjpeg']`. */
  capabilities(): {decoders: string[]; encoders: string[]};
}
