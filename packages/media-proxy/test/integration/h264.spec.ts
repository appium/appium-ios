import assert from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {loadNative} from '../../src/native.js';
import {createTranscoder} from '../../src/transcoder.js';
import type {NativeConfig, NativeUnit, NalAccessUnit, VideoAccessUnit} from '../../src/types.js';
import {h264NalTypes, HAS_H264, readHevcFixture} from '../helpers/annexb.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-360x640-30f.h265', import.meta.url));
const BT709_FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-128x128-bt709-10f.h265', import.meta.url));
const FRAMES = 30;
const PACE_MS = 10;
const NAL_IDR = 5;
const NAL_SLICE = 1;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_SEI = 6;
const FRAME_MICROS = 1e6 / 60;

async function encode(opts: {fps?: number; bitrate?: number} = {}, fixture = FIXTURE): Promise<VideoAccessUnit[]> {
  const t = createTranscoder({codec: 'h264', ...opts});
  const out: VideoAccessUnit[] = [];
  const drain = (async () => {
    for await (const unit of t.units()) {
      out.push(unit);
    }
  })();
  for (const au of readHevcFixture(fixture)) {
    t.push(au);
    await sleep(PACE_MS);
  }
  await t.end();
  await drain;
  return out;
}

describe('HEVC -> H.264', {skip: !HAS_H264}, () => {
  it('produces Annex-B units with inline parameter sets on key frames', async () => {
    const units = await encode();
    assert.strictEqual(units.length, FRAMES);
    units.forEach((u, i) => {
      assert.strictEqual(u.track, 'video');
      assert.strictEqual(u.sequence, i);
      assert.deepStrictEqual([...u.data.subarray(0, 4)], [0, 0, 0, 1], 'four-byte start code');
      // A picture may be split into several slices (Media Foundation does); it is still one buffer.
      const types = h264NalTypes(u.data).filter((t) => t !== NAL_SEI);
      const slices = types.filter((t) => t === NAL_IDR || t === NAL_SLICE);
      assert.ok(slices.length >= 1 && new Set(slices).size === 1, `one picture, got ${types}`);
      if (u.isKeyFrame) {
        assert.deepStrictEqual(types.slice(0, 2), [NAL_SPS, NAL_PPS]);
        assert.strictEqual(slices[0], NAL_IDR);
        assert.strictEqual(types.length, 2 + slices.length);
      } else {
        assert.strictEqual(slices[0], NAL_SLICE);
        assert.strictEqual(types.length, slices.length);
      }
      if (i > 0) {
        assert.ok(u.timestampMicros > units[i - 1].timestampMicros, 'timestamps increase (no reordering)');
      }
    });
    assert.ok(units[0].isKeyFrame);
    assert.ok(Math.abs(units[1].timestampMicros - FRAME_MICROS) < 2);
  });

  it('keeps queueing input while the encoder opens instead of dropping to the next key frame', async () => {
    // Everything arrives within the encoder's start-up time, far more than the steady-state queue holds.
    const t = createTranscoder({codec: 'h264'});
    let count = 0;
    const drain = (async () => {
      for await (const _ of t.units()) {
        count++;
      }
    })();
    for (const au of readHevcFixture(FIXTURE)) {
      t.push(au);
    }
    await t.end();
    await drain;
    assert.strictEqual(count, FRAMES);
  });

  it('treats fps as an upper bound', async () => {
    const units = await encode({fps: 30});
    assert.strictEqual(units.length, FRAMES / 2);
  });

  it(
    'is decodable by an independent decoder',
    {skip: spawnSync('ffprobe', ['-version']).error !== undefined},
    async () => {
      const units = await encode();
      const dir = mkdtempSync(join(tmpdir(), 'media-proxy-'));
      try {
        const file = join(dir, 'out.h264');
        writeFileSync(file, Buffer.concat(units.map((u) => u.data)));
        const probe = spawnSync('ffprobe', [
          ...['-v', 'error', '-count_frames', '-select_streams', 'v:0'],
          ...['-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'csv=p=0', file],
        ]);
        assert.strictEqual(probe.stdout.toString().trim(), `h264,360,640,${FRAMES}`, probe.stderr.toString());
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    },
  );

  it(
    'keeps the pixel values of a BT.709 source',
    {skip: spawnSync('ffmpeg', ['-version']).error !== undefined},
    async () => {
      // The fixture is a flat (Y, U, V) = (63, 102, 240) picture tagged BT.709, like the H.264 output.
      const size = 128;
      const units = await encode({}, BT709_FIXTURE);
      const dir = mkdtempSync(join(tmpdir(), 'media-proxy-'));
      try {
        const file = join(dir, 'out.h264');
        writeFileSync(file, Buffer.concat(units.map((u) => u.data)));
        const raw = spawnSync(
          'ffmpeg',
          [...['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-']],
          {maxBuffer: 1 << 24},
        ).stdout;
        const chroma = (size / 2) ** 2;
        const centre = (plane: number, width: number) => raw[plane + (width / 2) * width + width / 2];
        const [y, u, v] = [centre(0, size), centre(size * size, size / 2), centre(size * size + chroma, size / 2)];
        for (const [got, want] of [
          [y, 63],
          [u, 102],
          [v, 240],
        ]) {
          assert.ok(Math.abs(got - want) <= 3, `expected ${want}, got ${got} (Y,U,V = ${y},${u},${v})`);
        }
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    },
  );
});

// Drives the addon directly: these paths (key-frame requests, output overflow) have no public API.
describe('native H.264 key-frame handling', {skip: !HAS_H264}, () => {
  const config: NativeConfig = {outputCodec: 'h264', fps: 60, bitrate: 4_000_000, quality: 80, scale: 100};

  function open() {
    const units: NativeUnit[] = [];
    const errors: Error[] = [];
    const handle = loadNative().createTranscoder(
      config,
      (u) => units.push(u),
      (e) => errors.push(e),
    );
    return {handle, units, errors};
  }
  const push = (handle: ReturnType<typeof open>['handle'], au: NalAccessUnit, index: number) =>
    handle.push(au.nals, Math.round(index * FRAME_MICROS), au.isKeyFrame);

  it('returns each frame without waiting for later input', async () => {
    const aus = readHevcFixture(FIXTURE).slice(0, 6);
    const {handle, units, errors} = open();
    for (const [i, au] of aus.entries()) {
      push(handle, au, i);
      await sleep(PACE_MS);
    }
    await sleep(300); // generous for slow runners; an encoder that holds frames back never catches up
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(units.length, aus.length);
    await handle.close();
  });

  it('emits a key frame on request', async () => {
    const aus = readHevcFixture(FIXTURE);
    // An input unit that is neither a key frame nor follows one directly, so the encoder isn't about to start a GOP.
    const target = aus.findIndex((au, i) => i > 4 && !au.isKeyFrame && !aus[i - 1].isKeyFrame);
    const {handle, units, errors} = open();
    for (const [i, au] of aus.entries()) {
      if (i === target) {
        // On a slow runner the encoder lags the input; let it catch up so the request lands on `target`.
        for (let wait = 0; units.length < target && wait < 500; wait++) {
          await sleep(10);
        }
        handle.requestKeyFrame();
      }
      push(handle, au, i);
      await sleep(PACE_MS);
    }
    await handle.close();
    assert.deepStrictEqual(errors, []);
    const keyAt = units.filter((u) => u.isKeyFrame).map((u) => Math.round(u.timestampMicros / FRAME_MICROS));
    assert.deepStrictEqual(keyAt, [0, target]);
  });

  it('resumes at a key frame after dropping output the consumer was too slow to take', async () => {
    const aus = readHevcFixture(FIXTURE);
    const {handle, units, errors} = open();
    // The JS thread never yields while pushing, so delivered units pile up until the native side drops some.
    let index = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 6; i++, index++) {
        push(handle, aus[index % aus.length], index);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    await sleep(200); // the consumer catches up
    const delivered = units.length;
    assert.ok(delivered < index, `expected drops, got ${delivered} of ${index}`);
    for (let i = 0; i < 6; i++, index++) {
      push(handle, aus[index % aus.length], index);
      await sleep(PACE_MS);
    }
    await handle.close();
    assert.deepStrictEqual(errors, []);
    assert.ok(units.length > delivered, 'output resumed');
    assert.ok(units[delivered].isKeyFrame, 'the first unit after the gap is a key frame');
    const stamps = units.map((u) => u.timestampMicros);
    stamps.forEach((ts, i) => {
      if (i > 0 && ts - stamps[i - 1] > FRAME_MICROS * 1.5) {
        assert.ok(units[i].isKeyFrame, `unit after a gap at ${ts} must be a key frame`);
      }
    });
  });
});
