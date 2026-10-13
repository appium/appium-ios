import {MediaProxyOptionError, wrapNativeError} from './errors.js';
import {loadNative} from './native.js';
import {UnitQueue} from './queue.js';
import type {
  H264OutputOptions,
  InputAccessUnit,
  JpegFrame,
  MjpegOutputOptions,
  NativeConfig,
  NativeModule,
  NativeTranscoderHandle,
  NativeUnit,
  TranscoderOptions,
  TranscoderStats,
  VideoAccessUnit,
} from './types.js';

export const DEFAULT_FPS = 60;
export const DEFAULT_BITRATE = 4_000_000;
export const DEFAULT_QUALITY = 80;
export const DEFAULT_SCALE = 100;
export const DEFAULT_CLOCK_RATE = 90_000;

const MAX_BITRATE = 2 ** 31 - 1;

export interface ResolvedOptions {
  config: NativeConfig;
  clockRate: number | 'receivedAt';
}

/** Validates `opts` and fills in the defaults shared with coresim/Android. */
export function resolveOptions(opts: TranscoderOptions): ResolvedOptions {
  if (!opts?.output) {
    throw new MediaProxyOptionError('output is required');
  }
  const {output} = opts;
  if (output.codec !== 'h264' && output.codec !== 'mjpeg') {
    throw new MediaProxyOptionError(
      `output.codec must be 'h264' or 'mjpeg', got ${String((output as {codec: unknown}).codec)}`,
    );
  }
  const inputCodec = opts.input?.codec ?? 'hevc';
  if (inputCodec !== 'hevc' && inputCodec !== 'h264') {
    throw new MediaProxyOptionError(`input.codec must be 'hevc' or 'h264', got ${String(inputCodec)}`);
  }
  const clockRate = opts.input?.clockRate ?? DEFAULT_CLOCK_RATE;
  if (clockRate !== 'receivedAt') {
    if (!Number.isFinite(clockRate) || clockRate <= 0) {
      throw new RangeError(`input.clockRate must be a positive number or 'receivedAt', got ${clockRate}`);
    }
  }
  const hardwareAcceleration = opts.hardwareAcceleration ?? 'auto';
  if (!['auto', 'off', 'required'].includes(hardwareAcceleration)) {
    throw new MediaProxyOptionError(`hardwareAcceleration must be auto|off|required, got ${hardwareAcceleration}`);
  }
  // Same rules and error type as coresim's startVideoStream/startJpegStream.
  const fps = output.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps < 1) {
    throw new RangeError(`fps must be a finite number >= 1, got ${fps}`);
  }
  let bitrate = DEFAULT_BITRATE;
  let quality = DEFAULT_QUALITY;
  let scale = DEFAULT_SCALE;
  if (output.codec === 'h264') {
    bitrate = output.bitrate ?? DEFAULT_BITRATE;
    if (!Number.isFinite(bitrate) || bitrate <= 0 || bitrate > MAX_BITRATE) {
      throw new RangeError(`bitrate must be a positive number no greater than ${MAX_BITRATE}, got ${bitrate}`);
    }
  } else {
    quality = output.quality ?? DEFAULT_QUALITY;
    if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
      throw new RangeError(`quality must be a number between 0 and 100, got ${quality}`);
    }
    scale = output.scale ?? DEFAULT_SCALE;
    if (!Number.isFinite(scale) || scale <= 0 || scale > 100) {
      throw new RangeError(`scale must be a number greater than 0 and no greater than 100, got ${scale}`);
    }
  }
  return {
    clockRate,
    config: {
      inputCodec,
      outputCodec: output.codec,
      fps,
      bitrate,
      quality,
      scale,
      hardwareAcceleration,
    },
  };
}

/**
 * Converts input timestamps to microseconds since the first unit, unwrapping the 32-bit RTP
 * counter. With `'receivedAt'` uses the host receive time (ms) instead.
 */
export class TimestampConverter {
  private base: number | undefined;
  private last = 0;
  private ticks = 0;

  constructor(private readonly clockRate: number | 'receivedAt') {}

  toMicros(unit: {timestamp: number; receivedAt?: number}): number {
    if (this.clockRate === 'receivedAt') {
      const now = unit.receivedAt ?? performance.now();
      this.base ??= now;
      return Math.max(0, Math.round((now - this.base) * 1000));
    }
    if (this.base === undefined) {
      this.base = unit.timestamp;
      this.last = unit.timestamp;
    } else {
      // Signed 32-bit delta handles wrap-around and small reorderings.
      this.ticks += (unit.timestamp - this.last) | 0;
      this.last = unit.timestamp;
    }
    return Math.max(0, Math.round((this.ticks * 1_000_000) / this.clockRate));
  }
}

type OutputUnit = VideoAccessUnit | JpegFrame;

/** A running transcoder. Single `units()` consumer at a time. */
export class Transcoder<U extends OutputUnit = OutputUnit> {
  private readonly handle: NativeTranscoderHandle;
  private readonly queue: UnitQueue<U>;
  private readonly clock: TimestampConverter;
  private readonly isVideo: boolean;
  private readonly stopController = new AbortController();
  private sequence = 0;
  private closePromise: Promise<void> | undefined;
  private consuming = false;

  /** @internal use {@link createTranscoder}; `backend` is injectable for tests. */
  constructor(opts: TranscoderOptions, backend?: NativeModule) {
    // Validate before touching the addon, so bad options are reported even where it's unavailable.
    const {config, clockRate} = resolveOptions(opts);
    const native = backend ?? loadNative();
    this.isVideo = config.outputCodec === 'h264';
    this.clock = new TimestampConverter(clockRate);
    this.queue = new UnitQueue<U>(
      this.isVideo
        ? {
            dropsDuringResync: (u) => !(u as VideoAccessUnit).isKeyFrame,
            endsResync: (u) => (u as VideoAccessUnit).isKeyFrame,
            onOverflow: () => this.handle?.requestKeyFrame(),
          }
        : {dropsDuringResync: () => false, endsResync: () => true},
    );
    try {
      this.handle = native.createTranscoder(
        config,
        (unit) => this.onUnit(unit),
        (err) => this.queue.fail(wrapNativeError(err)),
      );
    } catch (err) {
      throw wrapNativeError(err);
    }
  }

  /** Name of the selected encoder, e.g. `h264_videotoolbox`, `libopenh264`, `mjpeg`. */
  get encoderName(): string {
    return this.handle.encoderName;
  }

  /** Whether the selected encoder is hardware-accelerated. */
  get hardware(): boolean {
    return this.handle.hardware;
  }

  get stats(): TranscoderStats {
    return this.handle.stats();
  }

  /** Feeds one access unit (non-blocking; the native side queues and may drop to the next keyframe). */
  push(au: InputAccessUnit): void {
    if (this.closePromise) {
      return;
    }
    const annexB = 'data' in au;
    const chunks = annexB ? [au.data] : au.nals;
    try {
      this.handle.push(chunks, this.clock.toMicros(au), au.isKeyFrame, annexB);
    } catch (err) {
      throw wrapNativeError(err);
    }
  }

  /** Forces the next H.264 output to be an IDR frame (no-op for MJPEG). */
  requestKeyFrame(): void {
    this.handle.requestKeyFrame();
  }

  async *units(signal?: AbortSignal): AsyncGenerator<U> {
    if (this.consuming) {
      throw new MediaProxyOptionError('units() supports only one active consumer at a time');
    }
    this.consuming = true;
    const combined = signal ? AbortSignal.any([signal, this.stopController.signal]) : this.stopController.signal;
    try {
      for (;;) {
        const result = await this.queue.next(combined);
        if (result.done) {
          return;
        }
        yield result.value;
      }
    } finally {
      this.consuming = false;
    }
  }

  /** Idempotent. Pending `units()` iterators complete. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.stopController.abort();
      this.queue.end();
      await this.handle.close();
    })();
    return this.closePromise;
  }

  private onUnit(unit: NativeUnit): void {
    const sequence = this.sequence++;
    const out: OutputUnit = this.isVideo
      ? {
          track: 'video',
          data: unit.data,
          isKeyFrame: unit.isKeyFrame,
          sequence,
          timestampMicros: unit.timestampMicros,
        }
      : {data: unit.data, sequence, timestampMicros: unit.timestampMicros};
    this.queue.push(out as U);
  }
}

/** Creates a transcoder; throws `MediaProxyUnavailableError` if the addon can't be loaded here. */
export function createTranscoder(opts: TranscoderOptions<H264OutputOptions>): Transcoder<VideoAccessUnit>;
export function createTranscoder(opts: TranscoderOptions<MjpegOutputOptions>): Transcoder<JpegFrame>;
export function createTranscoder(opts: TranscoderOptions): Transcoder;
export function createTranscoder(opts: TranscoderOptions): Transcoder<VideoAccessUnit> | Transcoder<JpegFrame> {
  return new Transcoder<VideoAccessUnit | JpegFrame>(opts) as Transcoder<VideoAccessUnit> | Transcoder<JpegFrame>;
}

/**
 * Pipes `source` (e.g. remotexpc's `ScreenStreamCapture.accessUnits()`) through a transcoder.
 * The transcoder is closed when the source ends, errors, or the consumer stops iterating.
 */
export function transcode(
  source: AsyncIterable<InputAccessUnit>,
  opts: TranscoderOptions<H264OutputOptions>,
  signal?: AbortSignal,
): AsyncGenerator<VideoAccessUnit>;
export function transcode(
  source: AsyncIterable<InputAccessUnit>,
  opts: TranscoderOptions<MjpegOutputOptions>,
  signal?: AbortSignal,
): AsyncGenerator<JpegFrame>;
export async function* transcode(
  source: AsyncIterable<InputAccessUnit>,
  opts: TranscoderOptions,
  signal?: AbortSignal,
): AsyncGenerator<OutputUnit> {
  const transcoder = createTranscoder(opts);
  let stopped = false;
  let pumpError: unknown;
  const pump = (async () => {
    try {
      for await (const au of source) {
        if (stopped || signal?.aborted) {
          break;
        }
        transcoder.push(au);
      }
    } catch (err) {
      pumpError = err;
    } finally {
      await transcoder.close();
    }
  })();
  try {
    yield* transcoder.units(signal);
  } finally {
    stopped = true;
    await transcoder.close();
  }
  // Reached only when the units ended on their own: the source finished or failed.
  await pump;
  if (pumpError) {
    throw pumpError;
  }
}
