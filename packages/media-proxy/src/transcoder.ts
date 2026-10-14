import {MediaProxyOptionError, wrapNativeError} from './errors.js';
import {loadNative} from './native.js';
import {UnitQueue} from './queue.js';
import type {
  H264Options,
  JpegFrame,
  MjpegOptions,
  NalAccessUnit,
  NativeConfig,
  NativeModule,
  NativeTranscoderHandle,
  NativeUnit,
  TranscoderOptions,
  VideoAccessUnit,
} from './types.js';

export const DEFAULT_FPS = 60;
export const DEFAULT_BITRATE = 4_000_000;
export const DEFAULT_QUALITY = 80;
export const DEFAULT_SCALE = 100;
/** RTP video clock; remotexpc doesn't define it, so this is an assumption to confirm on a device. */
const CLOCK_RATE = 90_000;

const MAX_BITRATE = 2 ** 31 - 1;

/** Validates `opts` and fills in the defaults, with the same rules and error type as coresim. */
export function resolveOptions(opts: TranscoderOptions): NativeConfig {
  if (opts?.codec !== 'h264' && opts?.codec !== 'mjpeg') {
    throw new MediaProxyOptionError(
      `codec must be 'h264' or 'mjpeg', got ${String((opts as {codec?: unknown})?.codec)}`,
    );
  }
  const fps = opts.fps ?? DEFAULT_FPS;
  if (!Number.isFinite(fps) || fps < 1) {
    throw new RangeError(`fps must be a finite number >= 1, got ${fps}`);
  }
  let bitrate = DEFAULT_BITRATE;
  let quality = DEFAULT_QUALITY;
  let scale = DEFAULT_SCALE;
  if (opts.codec === 'h264') {
    bitrate = opts.bitrate ?? DEFAULT_BITRATE;
    if (!Number.isFinite(bitrate) || bitrate <= 0 || bitrate > MAX_BITRATE) {
      throw new RangeError(`bitrate must be a positive number no greater than ${MAX_BITRATE}, got ${bitrate}`);
    }
  } else {
    quality = opts.quality ?? DEFAULT_QUALITY;
    if (!Number.isFinite(quality) || quality < 0 || quality > 100) {
      throw new RangeError(`quality must be a number between 0 and 100, got ${quality}`);
    }
    scale = opts.scale ?? DEFAULT_SCALE;
    if (!Number.isFinite(scale) || scale <= 0 || scale > 100) {
      throw new RangeError(`scale must be a number greater than 0 and no greater than 100, got ${scale}`);
    }
  }
  return {outputCodec: opts.codec, fps, bitrate, quality, scale};
}

/** Converts 32-bit RTP timestamps to microseconds since the first unit, unwrapping the counter. */
export class TimestampConverter {
  private base: number | undefined;
  private last = 0;
  private ticks = 0;

  constructor(private readonly clockRate: number = CLOCK_RATE) {}

  toMicros(timestamp: number): number {
    if (this.base === undefined) {
      this.base = timestamp;
    } else {
      // Signed 32-bit delta handles wrap-around and small reorderings.
      this.ticks += (timestamp - this.last) | 0;
    }
    this.last = timestamp;
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
    const config = resolveOptions(opts);
    const native = backend ?? loadNative();
    this.isVideo = config.outputCodec === 'h264';
    this.clock = new TimestampConverter();
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

  /** Feeds one access unit (non-blocking; the native side queues and may drop to the next keyframe). */
  push(au: NalAccessUnit): void {
    if (this.closePromise) {
      return;
    }
    try {
      this.handle.push(au.nals, this.clock.toMicros(au.timestamp), au.isKeyFrame);
    } catch (err) {
      throw wrapNativeError(err);
    }
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

  /**
   * Finishes the stream: flushes the pipeline, so `units()` yields everything already produced and
   * then completes. Idempotent; a no-op after {@link close}.
   */
  end(): Promise<void> {
    this.closePromise ??= (async () => {
      await this.handle.close();
      this.queue.end({drain: true});
    })();
    return this.closePromise;
  }

  /** Stops immediately, discarding unconsumed units. Idempotent; pending `units()` iterators complete. */
  close(): Promise<void> {
    if (!this.closePromise) {
      // Stop consumers first: native close() may still flush units that nobody wants.
      this.stopController.abort();
      this.queue.end();
    }
    this.closePromise ??= this.handle.close();
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
export function createTranscoder(opts: H264Options): Transcoder<VideoAccessUnit>;
export function createTranscoder(opts: MjpegOptions): Transcoder<JpegFrame>;
export function createTranscoder(opts: TranscoderOptions): Transcoder<VideoAccessUnit> | Transcoder<JpegFrame>;
export function createTranscoder(opts: TranscoderOptions): Transcoder<VideoAccessUnit> | Transcoder<JpegFrame> {
  return new Transcoder<VideoAccessUnit | JpegFrame>(opts) as Transcoder<VideoAccessUnit> | Transcoder<JpegFrame>;
}

/**
 * Pipes `source` (e.g. remotexpc's `ScreenStreamCapture.accessUnits()`) through a transcoder. When
 * the source finishes, everything already produced is still yielded; if it fails, that error is
 * thrown after the remaining units. Stopping early (`break`, `signal`) closes the transcoder and asks
 * the source to stop via `return()`; a source blocked on an idle read can only finish once it
 * yields or honours its own abort signal, which is not awaited.
 */
export function transcode(
  source: AsyncIterable<NalAccessUnit>,
  opts: H264Options,
  signal?: AbortSignal,
): AsyncGenerator<VideoAccessUnit>;
export function transcode(
  source: AsyncIterable<NalAccessUnit>,
  opts: MjpegOptions,
  signal?: AbortSignal,
): AsyncGenerator<JpegFrame>;
export async function* transcode(
  source: AsyncIterable<NalAccessUnit>,
  opts: TranscoderOptions,
  signal?: AbortSignal,
): AsyncGenerator<OutputUnit> {
  yield* pipeThrough(createTranscoder(opts), source, signal);
}

/** @internal `transcode()` with an already-created transcoder (injectable backend for tests). */
export async function* pipeThrough(
  transcoder: Transcoder<VideoAccessUnit> | Transcoder<JpegFrame>,
  source: AsyncIterable<NalAccessUnit>,
  signal?: AbortSignal,
): AsyncGenerator<OutputUnit> {
  const iterator = source[Symbol.asyncIterator]();
  let stopped = false;
  let sourceDone = false;
  let failed = false;
  let pumpError: unknown;
  const pump = (async () => {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done || stopped) {
          break;
        }
        transcoder.push(result.value);
      }
    } catch (err) {
      failed = true;
      pumpError = err;
    }
    sourceDone = true;
    if (!stopped) {
      await transcoder.end();
    }
  })();
  try {
    yield* transcoder.units(signal);
  } finally {
    stopped = true;
    await transcoder.close();
    if (!sourceDone) {
      // Don't await: an idle source may not settle until its next item.
      iterator.return?.()?.catch(() => {});
    }
  }
  if (signal?.aborted) {
    return;
  }
  await pump;
  if (failed) {
    throw pumpError;
  }
}
