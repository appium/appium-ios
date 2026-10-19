import {MediaProxyOptionError, wrapNativeError} from './errors.js';
import {loadNative} from './native.js';
import {MAX_BUFFERED_UNITS, UnitQueue} from './queue.js';
import type {
  AudioAccessUnit,
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
/** AAC-LC output rate per channel (coresim's setting). */
const AUDIO_BITRATE_PER_CHANNEL = 64_000;
/** AAC-ELD, 48 kHz stereo, 480-sample frames: the device's stream as it really is (remotexpc `aac-eld.ts`). */
export const DEFAULT_AUDIO_SPECIFIC_CONFIG = Buffer.from([0xf8, 0xe6, 0x50, 0x00]);
/** RTP video clock; remotexpc doesn't define it, so this is an assumption to confirm on a device. */
const CLOCK_RATE = 90_000;
const AUDIO_CLOCK_RATE = 48_000;

const MAX_BITRATE = 2 ** 31 - 1;
/** About 5 s of 10 ms audio units. */
const MAX_BUFFERED_AUDIO_UNITS = 500;

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
  let audio = false;
  let audioSpecificConfig: Buffer = DEFAULT_AUDIO_SPECIFIC_CONFIG;
  if (opts.codec === 'h264') {
    audio = opts.audio ?? false;
    if (opts.audioSpecificConfig !== undefined) {
      if (!Buffer.isBuffer(opts.audioSpecificConfig) || opts.audioSpecificConfig.length === 0) {
        throw new RangeError('audioSpecificConfig must be a non-empty Buffer');
      }
      audioSpecificConfig = opts.audioSpecificConfig;
    }
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
  return {
    outputCodec: opts.codec,
    fps,
    bitrate,
    quality,
    scale,
    audio,
    audioSpecificConfig,
    audioBitratePerChannel: AUDIO_BITRATE_PER_CHANNEL,
  };
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
  private readonly clock = new TimestampConverter();
  private readonly audioClock = new TimestampConverter(AUDIO_CLOCK_RATE);
  private readonly isVideo: boolean;
  private readonly hasAudio: boolean;
  private readonly stopController = new AbortController();
  private sequence = 0;
  private audioSequence = 0;
  // Arrival time of the very first unit (either track) and each track's offset from it, in µs.
  private originMs: number | undefined;
  private videoOffset: number | undefined;
  private audioOffset: number | undefined;
  private closePromise: Promise<void> | undefined;
  private consuming = false;

  /** @internal use {@link createTranscoder}; `backend` is injectable for tests. */
  constructor(opts: TranscoderOptions, backend?: NativeModule) {
    // Validate before touching the addon, so bad options are reported even where it's unavailable.
    const config = resolveOptions(opts);
    const native = backend ?? loadNative();
    this.isVideo = config.outputCodec === 'h264';
    this.hasAudio = config.audio;
    // Audio units are never dropped and never end a resync: only video frames depend on each other.
    this.queue = new UnitQueue<U>(
      this.isVideo
        ? {
            dropsDuringResync: (u) => (u as VideoAccessUnit).track === 'video' && !(u as VideoAccessUnit).isKeyFrame,
            endsResync: (u) => (u as VideoAccessUnit).track === 'video' && (u as VideoAccessUnit).isKeyFrame,
            onOverflow: () => this.handle?.requestKeyFrame(),
            capacity: MAX_BUFFERED_UNITS + (this.hasAudio ? MAX_BUFFERED_AUDIO_UNITS : 0),
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
      const micros = this.clock.toMicros(au.timestamp);
      this.videoOffset ??= this.offsetFrom(au.receivedAt);
      this.handle.push(au.nals, micros + this.videoOffset, au.isKeyFrame);
    } catch (err) {
      throw wrapNativeError(err);
    }
  }

  /** Feeds one AAC-ELD access unit; needs `audio: true`. Timestamps are aligned with the video by arrival time. */
  pushAudio(au: AudioAccessUnit): void {
    if (!this.hasAudio) {
      throw new MediaProxyOptionError("pushAudio() requires the 'audio' option");
    }
    if (this.closePromise) {
      return;
    }
    try {
      const micros = this.audioClock.toMicros(au.timestamp);
      this.audioOffset ??= this.offsetFrom(au.receivedAt);
      this.handle.pushAudio(au.data, micros + this.audioOffset);
    } catch (err) {
      throw wrapNativeError(err);
    }
  }

  /** Microseconds between the stream's first arrival (either track) and `receivedAt`. */
  private offsetFrom(receivedAt: number | undefined): number {
    const now = receivedAt ?? performance.now();
    this.originMs ??= now;
    return Math.max(0, Math.round((now - this.originMs) * 1000));
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
      try {
        await this.handle.close();
      } catch (err) {
        const wrapped = wrapNativeError(err);
        this.queue.fail(wrapped);
        throw wrapped;
      }
      this.queue.end({drain: true});
    })();
    return this.closePromise;
  }

  /** Stops immediately, discarding unconsumed units. Idempotent; pending `units()` iterators complete. */
  close(): Promise<void> {
    // Stop consumers first, even if end() already started: native close() may still flush units
    // nobody wants, and a draining queue must be discarded.
    this.stopController.abort();
    this.queue.end();
    this.closePromise ??= this.handle.close();
    return this.closePromise;
  }

  private onUnit(unit: NativeUnit): void {
    const out: OutputUnit = this.isVideo
      ? {
          track: unit.audio ? 'audio' : 'video',
          data: unit.data,
          isKeyFrame: unit.isKeyFrame,
          sequence: unit.audio ? this.audioSequence++ : this.sequence++,
          timestampMicros: unit.timestampMicros,
        }
      : {data: unit.data, sequence: this.sequence++, timestampMicros: unit.timestampMicros};
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
  audioSource?: AsyncIterable<AudioAccessUnit>,
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
  audioSource?: AsyncIterable<AudioAccessUnit>,
): AsyncGenerator<OutputUnit> {
  if (audioSource && !(opts.codec === 'h264' && opts.audio)) {
    throw new MediaProxyOptionError("audioSource requires codec 'h264' with audio: true");
  }
  yield* pipeThrough(createTranscoder(opts), source, signal, audioSource);
}

/** @internal `transcode()` with an already-created transcoder (injectable backend for tests). */
export async function* pipeThrough(
  transcoder: Transcoder<VideoAccessUnit> | Transcoder<JpegFrame>,
  source: AsyncIterable<NalAccessUnit>,
  signal?: AbortSignal,
  audioSource?: AsyncIterable<AudioAccessUnit>,
): AsyncGenerator<OutputUnit> {
  let iterator: AsyncIterator<NalAccessUnit>;
  let audioIterator: AsyncIterator<AudioAccessUnit> | undefined;
  try {
    iterator = source[Symbol.asyncIterator]();
    audioIterator = audioSource?.[Symbol.asyncIterator]();
  } catch (err) {
    await transcoder.close().catch(() => {});
    throw err;
  }
  let stopped = false;
  let exhausted = false;
  let returned = false;
  let failed = false;
  let pumpError: unknown;
  // Don't await: an idle source may not settle until its next item.
  const releaseSource = () => {
    if (!exhausted && !returned) {
      returned = true;
      iterator.return?.()?.catch(() => {});
    }
  };
  let audioDone = false;
  const releaseAudio = () => {
    if (audioIterator && !audioDone) {
      audioDone = true;
      audioIterator.return?.()?.catch(() => {});
    }
  };
  const fail = (err: unknown) => {
    if (!failed) {
      failed = true;
      pumpError = err;
    }
  };
  // Audio follows the video: it ends with it, and its failure ends the stream like a video failure.
  // Never awaited: an idle audio read may not settle until its next item, and it can't fail the stream afterwards.
  void (async () => {
    if (!audioIterator) {
      return;
    }
    try {
      for (;;) {
        const result = await audioIterator.next();
        if (result.done) {
          audioDone = true;
          return;
        }
        if (stopped || audioDone) {
          return;
        }
        transcoder.pushAudio(result.value);
      }
    } catch (err) {
      audioDone = true;
      fail(err);
      releaseSource();
      if (!stopped) {
        await transcoder.end().catch(() => {});
      }
    }
  })();
  const pump = (async () => {
    try {
      for (;;) {
        let result: IteratorResult<NalAccessUnit>;
        try {
          result = await iterator.next();
        } catch (err) {
          exhausted = true;
          throw err;
        }
        if (result.done) {
          exhausted = true;
          break;
        }
        if (stopped) {
          break;
        }
        transcoder.push(result.value);
      }
    } catch (err) {
      fail(err);
    }
    releaseSource();
    releaseAudio();
    if (!stopped) {
      // A close failure reaches the consumer through the queue; keep the pump from rejecting.
      await transcoder.end().catch(() => {});
    }
  })();
  try {
    yield* transcoder.units(signal);
  } finally {
    stopped = true;
    try {
      await transcoder.close();
    } finally {
      releaseSource();
      releaseAudio();
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
