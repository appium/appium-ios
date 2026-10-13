import assert from 'node:assert';
import {describe, it} from 'node:test';

import {MediaProxyEncoderUnavailableError, MediaProxyOptionError} from '../../src/errors.js';
import {TimestampConverter, Transcoder, resolveOptions, transcode} from '../../src/transcoder.js';
import type {
  NativeConfig,
  NativeModule,
  NativeTranscoderHandle,
  NativeUnit,
  TranscoderOptions,
  VideoAccessUnit,
} from '../../src/types.js';

interface FakeBackend extends NativeModule {
  config?: NativeConfig;
  pushes: {chunks: Buffer[]; ts: number; key: boolean; annexB: boolean}[];
  emit(unit: Partial<NativeUnit> & {data: Buffer}): void;
  fail(err: Error): void;
  keyFrameRequests: number;
  closed: boolean;
}

function fakeBackend(): FakeBackend {
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
        encoderName: 'fake',
        hardware: false,
        push: (chunks, ts, key, annexB) => backend.pushes.push({chunks, ts, key, annexB}),
        requestKeyFrame: () => void backend.keyFrameRequests++,
        stats: () => ({
          unitsIn: 0,
          unitsOut: 0,
          unitsDropped: 0,
          decodeMsP50: 0,
          decodeMsP99: 0,
          encodeMsP50: 0,
          encodeMsP99: 0,
        }),
        close: async () => {
          backend.closed = true;
        },
      };
      return handle;
    },
    emit: (unit) => onUnit({isKeyFrame: false, timestampMicros: 0, ...unit}),
    fail: (err) => onError(err),
  };
  return backend;
}

const h264: TranscoderOptions = {output: {codec: 'h264'}};
const mjpeg: TranscoderOptions = {output: {codec: 'mjpeg'}};

describe('resolveOptions', () => {
  it('applies the coresim/Android defaults', () => {
    assert.deepStrictEqual(resolveOptions(h264).config, {
      inputCodec: 'hevc',
      outputCodec: 'h264',
      fps: 60,
      bitrate: 4_000_000,
      quality: 80,
      scale: 100,
      hardwareAcceleration: 'auto',
    });
    assert.strictEqual(resolveOptions(mjpeg).config.quality, 80);
  });

  // Same rules as coresim's startVideoStream/startJpegStream, which throw RangeError.
  for (const [name, opts] of Object.entries({
    'fps < 1': {output: {codec: 'h264', fps: 0.5}},
    'non-finite fps': {output: {codec: 'mjpeg', fps: Infinity}},
    'zero bitrate': {output: {codec: 'h264', bitrate: 0}},
    'bitrate > 2^31-1': {output: {codec: 'h264', bitrate: 2 ** 31}},
    'zero scale': {output: {codec: 'mjpeg', scale: 0}},
    'scale > 100': {output: {codec: 'mjpeg', scale: 101}},
    'negative quality': {output: {codec: 'mjpeg', quality: -1}},
    'quality > 100': {output: {codec: 'mjpeg', quality: 101}},
    'bad clock rate': {output: {codec: 'h264'}, input: {clockRate: 0}},
  } as Record<string, unknown>)) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolveOptions(opts as TranscoderOptions), RangeError);
    });
  }

  it('accepts what coresim accepts: no fps cap, fractional values, quality 0', () => {
    assert.strictEqual(resolveOptions({output: {codec: 'h264', fps: 120.5, bitrate: 1.5}}).config.fps, 120.5);
    assert.strictEqual(resolveOptions({output: {codec: 'mjpeg', quality: 0, scale: 12.5}}).config.quality, 0);
  });

  for (const [name, opts] of Object.entries({
    'bad codec': {output: {codec: 'vp9'}},
    'bad input codec': {output: {codec: 'h264'}, input: {codec: 'vp9'}},
    'bad hw mode': {output: {codec: 'h264'}, hardwareAcceleration: 'sometimes'},
  } as Record<string, unknown>)) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolveOptions(opts as TranscoderOptions), MediaProxyOptionError);
    });
  }

  it('requires output', () => {
    assert.throws(() => resolveOptions({} as TranscoderOptions), MediaProxyOptionError);
  });
});

describe('TimestampConverter', () => {
  it('rebases to the first unit and scales ticks to microseconds', () => {
    const c = new TimestampConverter(90_000);
    assert.strictEqual(c.toMicros({timestamp: 1_000_000}), 0);
    assert.strictEqual(c.toMicros({timestamp: 1_000_000 + 1500}), Math.round((1500 * 1e6) / 90_000));
  });

  it('unwraps the 32-bit RTP counter', () => {
    const c = new TimestampConverter(90_000);
    c.toMicros({timestamp: 0xffff_fff0});
    assert.strictEqual(c.toMicros({timestamp: 0x0000_0010}), Math.round((0x20 * 1e6) / 90_000));
  });

  it('can derive timing from receivedAt', () => {
    const c = new TimestampConverter('receivedAt');
    assert.strictEqual(c.toMicros({timestamp: 0, receivedAt: 5000}), 0);
    assert.strictEqual(c.toMicros({timestamp: 0, receivedAt: 5016.5}), 16_500);
  });
});

describe('Transcoder', () => {
  it('forwards NAL lists and Annex-B buffers with rebased timestamps', () => {
    const backend = fakeBackend();
    const t = new Transcoder(h264, backend);
    const nals = [Buffer.from([0x40, 1]), Buffer.from([0x26, 1])];
    t.push({nals, isKeyFrame: true, timestamp: 90_000});
    t.push({data: Buffer.from([0, 0, 0, 1, 2]), isKeyFrame: false, timestamp: 90_000 + 3000});
    assert.deepStrictEqual(
      backend.pushes.map((p) => [p.chunks.length, p.ts, p.key, p.annexB]),
      [
        [2, 0, true, false],
        [1, 33_333, false, true],
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
    t.push({data: Buffer.alloc(1), isKeyFrame: true, timestamp: 0});
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

describe('transcode()', () => {
  it('is exported', () => {
    assert.strictEqual(typeof transcode, 'function');
  });
});
