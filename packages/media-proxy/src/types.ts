/**
 * One native HEVC access unit as produced by `appium-ios-remotexpc`'s `ScreenStreamCapture`
 * (structural, so this package has no dependency on it): bare NAL units, no start codes.
 */
export interface NalAccessUnit {
  nals: Buffer[];
  isKeyFrame: boolean;
  /** Raw 32-bit RTP media-clock timestamp (90 kHz). */
  timestamp: number;
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
  track: 'video';
  data: Buffer;
  isKeyFrame: boolean;
  /** Monotonically increasing, starting at 0. */
  sequence: number;
  /** Microseconds since the stream started. */
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
}

export interface NativeConfig {
  outputCodec: 'h264' | 'mjpeg';
  fps: number;
  bitrate: number;
  quality: number;
  scale: number;
}

export interface NativeTranscoderHandle {
  /** Each chunk is one bare HEVC NAL unit (no start code). */
  push(chunks: Buffer[], timestampMicros: number, isKeyFrame: boolean): void;
  /** Forces the next H.264 output to be an IDR frame (used to resync after an overflow). */
  requestKeyFrame(): void;
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
