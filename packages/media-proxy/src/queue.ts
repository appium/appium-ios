export const MAX_BUFFERED_UNITS = 60;

/**
 * Single-consumer FIFO between the native callback and `units()`. Bounded: on overflow the backlog
 * is cleared and, while `dropsDuringResync` says so, further units are discarded until `endsResync`
 * sees a self-decodable one — dropping an arbitrary P-frame would corrupt every later one.
 */
export class UnitQueue<T> {
  private readonly buffer: T[] = [];
  private waiter: {resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void} | undefined;
  private ended = false;
  private draining = false;
  private error: unknown;
  private resyncing = false;

  constructor(
    private readonly opts: {
      dropsDuringResync: (unit: T) => boolean;
      endsResync: (unit: T) => boolean;
      onOverflow?: () => void;
      capacity?: number;
    },
  ) {}

  push(unit: T): void {
    if (this.ended) {
      return;
    }
    if (this.resyncing) {
      if (this.opts.dropsDuringResync(unit)) {
        return;
      }
      if (this.opts.endsResync(unit)) {
        this.resyncing = false;
      }
    }
    if (this.waiter) {
      const {resolve} = this.waiter;
      this.waiter = undefined;
      resolve({value: unit, done: false});
      return;
    }
    this.buffer.push(unit);
    if (this.buffer.length > (this.opts.capacity ?? MAX_BUFFERED_UNITS)) {
      this.buffer.length = 0;
      this.resyncing = true;
      this.opts.onOverflow?.();
    }
  }

  fail(err: unknown): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.draining = false;
    this.error = err;
    this.buffer.length = 0;
    if (this.waiter) {
      const {reject} = this.waiter;
      this.waiter = undefined;
      reject(err);
    }
  }

  /**
   * Ends the queue. With `drain`, already buffered units are still delivered before `next()`
   * resolves `done`; otherwise they are discarded.
   */
  end(opts: {drain?: boolean} = {}): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (opts.drain && this.buffer.length > 0) {
      this.draining = true;
      return;
    }
    this.buffer.length = 0;
    if (this.waiter) {
      const {resolve} = this.waiter;
      this.waiter = undefined;
      resolve({value: undefined, done: true});
    }
  }

  /** Resolves `done` if `signal` aborts or the queue has ended; never serves stale units after that. */
  next(signal: AbortSignal): Promise<IteratorResult<T>> {
    if (signal.aborted) {
      return Promise.resolve({value: undefined, done: true});
    }
    if (this.ended && !this.draining) {
      return this.error ? Promise.reject(this.error) : Promise.resolve({value: undefined, done: true});
    }
    const buffered = this.buffer.shift();
    if (this.draining && this.buffer.length === 0) {
      this.draining = false;
    }
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
