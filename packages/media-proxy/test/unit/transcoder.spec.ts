import assert from 'node:assert';
import {describe, it} from 'node:test';

import {MediaProxyEncoderUnavailableError, MediaProxyOptionError} from '../../src/errors.js';
import {TimestampConverter, Transcoder, pipeThrough, resolveOptions, transcode} from '../../src/transcoder.js';
import type {
  JpegFrame,
  NativeConfig,
  NativeModule,
  NativeTranscoderHandle,
  NalAccessUnit,
  NativeUnit,
  TranscoderOptions,
  VideoAccessUnit,
} from '../../src/types.js';

interface FakeBackend extends NativeModule {
  config?: NativeConfig;
  pushes: {chunks: Buffer[]; ts: number; key: boolean}[];
  emit(unit: Partial<NativeUnit> & {data: Buffer}): void;
  fail(err: Error): void;
  keyFrameRequests: number;
  closed: boolean;
}

/** `echo`: every push immediately produces one unit. `flushOnClose`: close() flushes one last unit. */
function fakeBackend(opts: {echo?: boolean; flushOnClose?: boolean} = {}): FakeBackend {
  let onUnit!: (u: NativeUnit) => void;
  let onError!: (e: Error) => void;
  const backend: FakeBackend = {
    pushes: [],
    keyFrameRequests: 0,
    closed: false,
    capabilities: () => ({decoders: [], encoders: []}),
    createTranscoder(config, unitCb, errorCb) {
      backend.config = config;
      onUnit = unitCb;
      onError = errorCb;
      const handle: NativeTranscoderHandle = {
        push: (chunks, ts, key) => {
          backend.pushes.push({chunks, ts, key});
          if (opts.echo) {
            onUnit({data: chunks[0], isKeyFrame: key, timestampMicros: ts});
          }
        },
        requestKeyFrame: () => void backend.keyFrameRequests++,
        close: async () => {
          backend.closed = true;
          if (opts.flushOnClose) {
            onUnit({data: Buffer.from('flushed'), isKeyFrame: false, timestampMicros: 999});
          }
        },
      };
      return handle;
    },
    emit: (unit) => onUnit({isKeyFrame: false, timestampMicros: 0, ...unit}),
    fail: (err) => onError(err),
  };
  return backend;
}

const h264: TranscoderOptions = {codec: 'h264'};
const mjpeg: TranscoderOptions = {codec: 'mjpeg'};

describe('resolveOptions', () => {
  it('applies the coresim defaults', () => {
    assert.deepStrictEqual(resolveOptions(h264), {
      outputCodec: 'h264',
      fps: 60,
      bitrate: 4_000_000,
      quality: 80,
      scale: 100,
    });
    assert.strictEqual(resolveOptions(mjpeg).quality, 80);
  });

  // Same rules as coresim's startVideoStream/startJpegStream, which throw RangeError.
  for (const [name, opts] of Object.entries({
    'fps < 1': {codec: 'h264', fps: 0.5},
    'non-finite fps': {codec: 'mjpeg', fps: Infinity},
    'zero bitrate': {codec: 'h264', bitrate: 0},
    'bitrate > 2^31-1': {codec: 'h264', bitrate: 2 ** 31},
    'zero scale': {codec: 'mjpeg', scale: 0},
    'scale > 100': {codec: 'mjpeg', scale: 101},
    'negative quality': {codec: 'mjpeg', quality: -1},
    'quality > 100': {codec: 'mjpeg', quality: 101},
  } as Record<string, unknown>)) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolveOptions(opts as TranscoderOptions), RangeError);
    });
  }

  it('accepts what coresim accepts: no fps cap, fractional values, quality 0', () => {
    assert.strictEqual(resolveOptions({codec: 'h264', fps: 120.5, bitrate: 1.5}).fps, 120.5);
    assert.strictEqual(resolveOptions({codec: 'mjpeg', quality: 0, scale: 12.5}).quality, 0);
  });

  for (const [name, opts] of Object.entries({
    'missing options': undefined,
    'missing codec': {},
    'bad codec': {codec: 'vp9'},
  } as Record<string, unknown>)) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolveOptions(opts as TranscoderOptions), MediaProxyOptionError);
    });
  }
});

describe('TimestampConverter', () => {
  it('rebases to the first unit and scales 90 kHz ticks to microseconds', () => {
    const c = new TimestampConverter();
    assert.strictEqual(c.toMicros(1_000_000), 0);
    assert.strictEqual(c.toMicros(1_000_000 + 1500), Math.round((1500 * 1e6) / 90_000));
  });

  it('unwraps the 32-bit RTP counter', () => {
    const c = new TimestampConverter();
    c.toMicros(0xffff_fff0);
    assert.strictEqual(c.toMicros(0x0000_0010), Math.round((0x20 * 1e6) / 90_000));
  });
});

describe('Transcoder', () => {
  it('forwards NAL lists with rebased timestamps', () => {
    const backend = fakeBackend();
    const t = new Transcoder(h264, backend);
    const nals = [Buffer.from([0x40, 1]), Buffer.from([0x26, 1])];
    t.push({nals, isKeyFrame: true, timestamp: 90_000});
    t.push({nals: [Buffer.from([2, 1])], isKeyFrame: false, timestamp: 90_000 + 3000});
    assert.deepStrictEqual(
      backend.pushes.map((p) => [p.chunks.length, p.ts, p.key]),
      [
        [2, 0, true],
        [1, 33_333, false],
      ],
    );
  });

  it('assigns monotonically increasing sequence numbers to h264 units', async () => {
    const backend = fakeBackend();
    const t = new Transcoder(h264, backend);
    backend.emit({data: Buffer.from('idr'), isKeyFrame: true, timestampMicros: 10});
    backend.emit({data: Buffer.from('p'), timestampMicros: 20});
    const seen = [];
    for await (const u of t.units()) {
      seen.push(u);
      if (seen.length === 2) {
        break;
      }
    }
    assert.deepStrictEqual(
      (seen as VideoAccessUnit[]).map((u) => [u.track, u.sequence, u.isKeyFrame]),
      [
        ['video', 0, true],
        ['video', 1, false],
      ],
    );
    await t.close();
  });

  it('emits plain JpegFrame objects for mjpeg', async () => {
    const backend = fakeBackend();
    const t = new Transcoder(mjpeg, backend);
    backend.emit({data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), timestampMicros: 7});
    const {value} = await t.units().next();
    assert.deepStrictEqual(Object.keys(value as object).sort(), ['data', 'sequence', 'timestampMicros']);
    await t.close();
  });

  it('ends pending iterators on close and ignores later pushes', async () => {
    const backend = fakeBackend();
    const t = new Transcoder(mjpeg, backend);
    const pending = t.units().next();
    await t.close();
    assert.strictEqual((await pending).done, true);
    t.push({nals: [Buffer.alloc(1)], isKeyFrame: true, timestamp: 0});
    assert.strictEqual(backend.pushes.length, 0);
    assert.ok(backend.closed);
    await t.close();
  });

  it('rejects a second concurrent consumer', async () => {
    const t = new Transcoder(mjpeg, fakeBackend());
    const first = t.units().next();
    await assert.rejects(t.units().next(), MediaProxyOptionError);
    await t.close();
    await first;
  });

  it('surfaces native errors through units() with their typed class', async () => {
    const backend = fakeBackend();
    const t = new Transcoder(h264, backend);
    backend.fail(Object.assign(new Error('no encoder'), {name: 'MediaProxyEncoderUnavailableError'}));
    await assert.rejects(t.units().next(), MediaProxyEncoderUnavailableError);
  });

  it('requests a fresh keyframe when the h264 queue overflows, then resyncs on an IDR', async () => {
    const backend = fakeBackend();
    const t = new Transcoder(h264, backend);
    for (let i = 0; i < 70; i++) {
      backend.emit({data: Buffer.from([i]), isKeyFrame: false, timestampMicros: i});
    }
    assert.strictEqual(backend.keyFrameRequests, 1);
    backend.emit({data: Buffer.from('p'), timestampMicros: 100});
    backend.emit({data: Buffer.from('idr'), isKeyFrame: true, timestampMicros: 101});
    const {value} = await t.units().next();
    assert.strictEqual((value as {isKeyFrame: boolean}).isKeyFrame, true);
    await t.close();
  });
});

const au = (ts: number, isKeyFrame = false): NalAccessUnit => ({nals: [Buffer.from([ts])], isKeyFrame, timestamp: ts});

/** Source that yields `items`, then blocks on an idle read; `return()` is recorded but never unblocks it. */
function idleSource(items: NalAccessUnit[], opts: {returnUnblocks?: boolean} = {}) {
  let index = 0;
  let unblock: () => void = () => {};
  const state = {returned: false};
  const iterator: AsyncIterableIterator<NalAccessUnit> = {
    [Symbol.asyncIterator]: () => iterator,
    async next() {
      if (index < items.length) {
        return {value: items[index++], done: false};
      }
      await new Promise<void>((resolve) => (unblock = resolve));
      return {value: undefined, done: true};
    },
    async return() {
      state.returned = true;
      if (opts.returnUnblocks) {
        unblock();
      }
      return {value: undefined, done: true};
    },
  };
  return {iterator, state};
}

const settlesWithin = (promise: Promise<unknown>, ms = 1000) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);

describe('Transcoder.end() / close()', () => {
  it('end() delivers units flushed by the pipeline, close() discards them', async () => {
    for (const [method, expected] of [
      ['end', 2],
      ['close', 0],
    ] as const) {
      const backend = fakeBackend({echo: true, flushOnClose: true});
      const t = new Transcoder<JpegFrame>(mjpeg, backend);
      t.push(au(1));
      await (method === 'end' ? t.end() : t.close());
      const seen: JpegFrame[] = [];
      for await (const u of t.units()) {
        seen.push(u);
      }
      assert.strictEqual(seen.length, expected, method);
    }
  });
});

describe('pipeThrough() / transcode()', () => {
  it('yields every unit of a finite source, including ones not yet consumed when it ends', async () => {
    const t = new Transcoder(mjpeg, fakeBackend({echo: true}));
    async function* source() {
      yield au(0, true);
      yield au(3000);
      yield au(6000);
    }
    const seen = [];
    for await (const u of pipeThrough(t, source())) {
      seen.push(u.sequence);
    }
    assert.deepStrictEqual(seen, [0, 1, 2]);
  });

  it('includes units flushed on source end', async () => {
    const t = new Transcoder(mjpeg, fakeBackend({echo: true, flushOnClose: true}));
    async function* source() {
      yield au(0, true);
    }
    const seen = [];
    for await (const u of pipeThrough(t, source())) {
      seen.push(u.sequence);
    }
    assert.deepStrictEqual(seen, [0, 1]);
  });

  it('does not hang when aborted while the source is idle, and asks the source to stop', async () => {
    const backend = fakeBackend({echo: true});
    const t = new Transcoder(mjpeg, backend);
    const {iterator, state} = idleSource([au(0, true)]);
    const controller = new AbortController();
    const consume = (async () => {
      for await (const _ of pipeThrough(t, {[Symbol.asyncIterator]: () => iterator}, controller.signal)) {
        controller.abort();
      }
    })();
    assert.ok(await settlesWithin(consume), 'consumer finished');
    assert.ok(state.returned, 'source return() was called');
    assert.ok(backend.closed);
  });

  it('stops the source when the consumer breaks early', async () => {
    const t = new Transcoder(mjpeg, fakeBackend({echo: true}));
    const {iterator, state} = idleSource([au(0, true), au(3000)]);
    const consume = (async () => {
      for await (const _ of pipeThrough(t, {[Symbol.asyncIterator]: () => iterator})) {
        break;
      }
    })();
    assert.ok(await settlesWithin(consume));
    assert.ok(state.returned);
  });

  it('yields what was produced, then throws the source error', async () => {
    const t = new Transcoder(mjpeg, fakeBackend({echo: true}));
    async function* source() {
      yield au(0, true);
      throw new Error('device went away');
    }
    const seen: number[] = [];
    await assert.rejects(async () => {
      for await (const u of pipeThrough(t, source())) {
        seen.push(u.sequence);
      }
    }, /device went away/);
    assert.deepStrictEqual(seen, [0]);
  });

  it('transcode() surfaces the typed error when no encoder is compiled in', async () => {
    const source = (async function* () {
      yield au(0, true);
    })();
    // Real addon (or its absence): either way the first iteration rejects with a MediaProxy error.
    await assert.rejects(transcode(source, {codec: 'h264'}).next(), (err: Error) => err.name.startsWith('MediaProxy'));
  });
});
