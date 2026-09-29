import {EventEmitter} from 'node:events';

import {logger} from '@appium/support';

import type {NativeSimctl} from '../native-simctl.js';
import type {JpegFrame, JpegStreamOptions, NativeJpegStreamHandle} from '../types.js';
import {runCatchingAsync, toTypedError} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    startJpegStream(udid: string, options?: JpegStreamOptions): Promise<JpegStream>;
  }
}

const log = logger.getLogger('CoreSim');

// Matches the native side's own ThreadSafeFunction queue bound (see coresim.mm's kFrameQueueSize).
const MAX_BUFFERED_FRAMES = 60;

const SINGLE_CONSUMER_ERROR =
  'JpegStream.frames() supports only one active consumer at a time — a second concurrent call rejects.';

/**
 * Single-consumer FIFO between native's per-frame callback and `frames()`. Simpler than
 * `AccessUnitQueue` (video-stream.ts): every JPEG frame is independently decodable, so there's no
 * reference chain to protect — overflow just drops the oldest buffered frame(s), keeping delivery
 * as close to real time as possible instead of falling further behind.
 */
class JpegFrameQueue {
  private readonly buffer: JpegFrame[] = [];
  private waiter: {resolve: (result: IteratorResult<JpegFrame>) => void; reject: (err: unknown) => void} | undefined;
  private ended = false;
  private error: unknown;

  push(frame: JpegFrame): void {
    if (this.ended) {
      return;
    }
    if (this.waiter) {
      const {resolve} = this.waiter;
      this.waiter = undefined;
      resolve({value: frame, done: false});
      return;
    }
    this.buffer.push(frame);
    if (this.buffer.length > MAX_BUFFERED_FRAMES) {
      this.buffer.shift();
    }
  }

  /** Ends the queue with an error — any pending or future `next()` rejects with it. */
  fail(err: unknown): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.error = err;
    this.buffer.length = 0;
    if (this.waiter) {
      const {reject} = this.waiter;
      this.waiter = undefined;
      reject(err);
    }
  }

  /** Ends the queue cleanly — any pending or future `next()` resolves `done`. */
  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.buffer.length = 0;
    if (this.waiter) {
      const {resolve} = this.waiter;
      this.waiter = undefined;
      resolve({value: undefined, done: true});
    }
  }

  /**
   * Resolves `done` (not rejects) if `signal` aborts while waiting, mirroring `events.on()`.
   * Checks cancellation/end *before* dequeuing, so an already-aborted signal or an already-ended
   * queue never hands out a stale buffered frame.
   */
  next(signal: AbortSignal): Promise<IteratorResult<JpegFrame>> {
    if (signal.aborted) {
      return Promise.resolve({value: undefined, done: true});
    }
    if (this.ended) {
      return this.error ? Promise.reject(this.error) : Promise.resolve({value: undefined, done: true});
    }
    const buffered = this.buffer.shift();
    if (buffered !== undefined) {
      return Promise.resolve({value: buffered, done: false});
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined;
        resolve({value: undefined, done: true});
      };
      signal.addEventListener('abort', onAbort, {once: true});
      this.waiter = {
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        reject: (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      };
    });
  }
}

/**
 * A live JPEG frame stream from `NativeSimctl.startJpegStream` — polls the device's display and
 * delivers each changed frame as a standalone JPEG image, at a configurable fps/quality. Unlike
 * `startVideoStream`, this produces no video codec bitstream — it's meant for callers that want to
 * build their own MJPEG (`multipart/x-mixed-replace`) HTTP stream, or otherwise just want a plain
 * sequence of images, out of `frames()` themselves.
 */
export class JpegStream extends EventEmitter {
  private handle: NativeJpegStreamHandle | undefined;
  private readonly stopController = new AbortController();
  private stopPromise: Promise<void> | undefined;
  private readonly queue = new JpegFrameQueue();
  private activeConsumers = 0;

  /** @internal */
  _handleFrame(frame: JpegFrame): void {
    this.queue.push(frame);
  }

  /**
   * @internal
   * An active `frames()` consumer receives the error via the queue itself (thrown out of its
   * `for await` loop, per that method's contract) rather than the `'error'` event, so `emit` is
   * only used for an explicit external listener; with neither, it's logged instead of lost.
   */
  _handleError(err: unknown): void {
    const error = toTypedError(err);
    this.queue.fail(error);
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    } else if (this.activeConsumers === 0) {
      log.error(`Unhandled JpegStream error: ${error.stack ?? error}`);
    }
  }

  /** @internal */
  _attachHandle(handle: NativeJpegStreamHandle): void {
    this.handle = handle;
  }

  /**
   * Yields each JPEG frame as it's produced, until {@link stop} is called or the stream errors (in
   * which case the error is thrown out of the loop). Pass `signal` to stop iterating without
   * treating that as an error.
   *
   * Only one active consumer is supported at a time — a second concurrent call rejects rather than
   * silently sharing (and corrupting) the first one's single internal waiter slot.
   */
  async *frames(signal?: AbortSignal): AsyncGenerator<JpegFrame> {
    if (this.activeConsumers > 0) {
      throw new Error(SINGLE_CONSUMER_ERROR);
    }
    const combined = signal ? AbortSignal.any([signal, this.stopController.signal]) : this.stopController.signal;
    this.activeConsumers++;
    try {
      for (;;) {
        const result = await this.queue.next(combined);
        if (result.done) {
          return;
        }
        yield result.value;
      }
    } finally {
      this.activeConsumers--;
    }
  }

  /** Stops the stream and releases the underlying encoder. Idempotent, including concurrently. */
  async stop(): Promise<void> {
    this.stopPromise ??= (async () => {
      this.stopController.abort();
      this.queue.end();
      await this.handle?.stop();
    })();
    return this.stopPromise;
  }
}

/**
 * Starts polling the device's display and JPEG-encoding each changed frame in real time. Resolves
 * once the encoder has actually started; the returned {@link JpegStream}'s `frames()` then yields
 * each frame as it arrives. Independent of `startVideoStream`/`startVideoRecording` — any number of
 * concurrent streams/recordings can run on the same device at once.
 *
 * @param udid — UDID of the device to stream; must be booted
 * @param options — `displayId`, `fps`, `quality`, `scale` — see {@link JpegStreamOptions}
 */
export async function startJpegStream(
  this: NativeSimctl,
  udid: string,
  options: JpegStreamOptions = {},
): Promise<JpegStream> {
  // The native poller clamps below 1 fps to 1 fps rather than actually polling that slowly, so a
  // sub-1 value here would silently poll far more often than requested — rejected instead.
  if (options.fps !== undefined && (!Number.isFinite(options.fps) || options.fps < 1)) {
    throw new RangeError(`fps must be a finite number >= 1, got ${options.fps}`);
  }
  if (
    options.quality !== undefined &&
    (!Number.isFinite(options.quality) || options.quality < 0 || options.quality > 100)
  ) {
    throw new RangeError(`quality must be a number between 0 and 100, got ${options.quality}`);
  }
  if (options.scale !== undefined && (!Number.isFinite(options.scale) || options.scale <= 0 || options.scale > 100)) {
    throw new RangeError(`scale must be a number greater than 0 and no greater than 100, got ${options.scale}`);
  }
  const device = await runCatchingAsync(() => this._findDevice(udid));
  const stream = new JpegStream();
  const handle = await runCatchingAsync(() =>
    device.startJpegStream(
      options,
      (frame) => stream._handleFrame(frame),
      (err) => stream._handleError(err),
    ),
  );
  stream._attachHandle(handle);
  return stream;
}
