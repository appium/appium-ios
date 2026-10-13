/**
 * One native HEVC access unit as produced by `appium-ios-remotexpc`'s `ScreenStreamCapture`
 * (structural, so this package has no dependency on it): bare NAL units, no start codes.
 */
export interface NalAccessUnit {
  nals: Buffer[];
  isKeyFrame: boolean;
  /** Raw 32-bit RTP media-clock timestamp. */
  timestamp: number;
  /** Host receive time in ms (`performance.now()`); used when the RTP clock rate is unknown. */
  receivedAt?: number;
}

/** An access unit already in Annex-B form (start-code delimited NAL units). */
export interface AnnexBAccessUnit {
  data: Buffer;
  isKeyFrame: boolean;
  timestamp: number;
  receivedAt?: number;
}

export type InputAccessUnit = NalAccessUnit | AnnexBAccessUnit;

export interface TranscoderInputOptions {
  /** Codec of the incoming stream. Defaults to `'hevc'`. */
  codec?: 'hevc' | 'h264';
  /**
   * Ticks/sec of `timestamp` (defaults to 90000, the RTP video clock), or `'receivedAt'` to
   * derive timing from the host receive time instead.
   */
  clockRate?: number | 'receivedAt';
}

export interface H264OutputOptions {
  codec: 'h264';
  /** Max output frames/sec (upper bound, input is variable-rate). Defaults to 60. */
  fps?: number;
  /** Target bitrate in bits/sec. Defaults to 4,000,000. */
  bitrate?: number;
  /** Frame scale as a percentage of the source, (0, 100]. Defaults to 100. */
  scale?: number;
}

export interface MjpegOutputOptions {
  codec: 'mjpeg';
  /** Max output frames/sec. Defaults to 60. */
  fps?: number;
  /** JPEG quality, 1-100. Defaults to 80. */
  quality?: number;
  /** Frame scale as a percentage of the source, (0, 100]. Defaults to 100. */
  scale?: number;
}

export type OutputOptions = H264OutputOptions | MjpegOutputOptions;

export type HardwareAcceleration = 'auto' | 'off' | 'required';

export interface TranscoderOptions<O extends OutputOptions = OutputOptions> {
  input?: TranscoderInputOptions;
  output: O;
  /** Defaults to `'auto'`: prefer hardware codecs, fall back to software. */
  hardwareAcceleration?: HardwareAcceleration;
}

/**
 * One H.264 unit; same shape as coresim's `VideoAccessUnit` (video track only) plus Android's
 * `isConfig`. Annex-B, 4-byte start codes. A keyframe carries SPS/PPS inline; `isConfig` units
 * (SPS+PPS only) are additionally emitted on start and after a resolution change.
 */
export interface VideoAccessUnit {
  track: 'video';
  data: Buffer;
  isKeyFrame: boolean;
  isConfig: boolean;
  /** Monotonically increasing, starting at 0. */
  sequence: number;
  /** Microseconds since the stream started. */
  timestampMicros: number;
}

/** One standalone JPEG; same shape as coresim's/Android's `JpegFrame`. */
export interface JpegFrame {
  data: Buffer;
  sequence: number;
  timestampMicros: number;
}

export interface TranscoderStats {
  unitsIn: number;
  unitsOut: number;
  /** Dropped on input-queue overflow or fps decimation. */
  unitsDropped: number;
  decodeMsP50: number;
  decodeMsP99: number;
  encodeMsP50: number;
  encodeMsP99: number;
}

/** Raw unit from the native side, before the JS layer assigns `sequence`. */
export interface NativeUnit {
  data: Buffer;
  isKeyFrame: boolean;
  isConfig: boolean;
  timestampMicros: number;
}

export interface NativeConfig {
  inputCodec: 'hevc' | 'h264';
  outputCodec: 'h264' | 'mjpeg';
  fps: number;
  bitrate: number;
  quality: number;
  scale: number;
  hardwareAcceleration: HardwareAcceleration;
  /** Directory holding the runtime-downloaded OpenH264 library, if enabled. */
  openh264Path?: string;
}

export interface NativeTranscoderHandle {
  readonly encoderName: string;
  readonly hardware: boolean;
  /** `annexB`: chunks are start-code delimited; otherwise each chunk is one bare NAL unit. */
  push(chunks: Buffer[], timestampMicros: number, isKeyFrame: boolean, annexB: boolean): void;
  requestKeyFrame(): void;
  stats(): TranscoderStats;
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
