import assert from 'node:assert';
import {describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {setFlagsFromString} from 'node:v8';
import {runInNewContext} from 'node:vm';

import {MediaProxyEncoderUnavailableError} from '../../src/errors.js';
import {createTranscoder, transcode} from '../../src/transcoder.js';
import type {JpegFrame, MjpegOptions, NalAccessUnit} from '../../src/types.js';
import {jpegSize, readHevcFixture} from '../helpers/annexb.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-360x640-30f.h265', import.meta.url));
const FRAMES = 30;
const FRAME_MICROS = 1e6 / 60;

// The pipeline treats input as a live stream and drops to the next key frame when it falls behind,
// so tests pace their input like a device instead of pushing everything at once.
const PACE_MS = 10;

async function* asyncUnits(startTimestamp: number): AsyncGenerator<NalAccessUnit> {
  for (const au of readHevcFixture(FIXTURE, startTimestamp)) {
    yield au;
    await sleep(PACE_MS);
  }
}

async function run(opts: MjpegOptions, startTimestamp = 0): Promise<JpegFrame[]> {
  const out: JpegFrame[] = [];
  for await (const frame of transcode(asyncUnits(startTimestamp), opts)) {
    out.push(frame);
  }
  return out;
}

describe('HEVC -> MJPEG', () => {
  it('splits the fixture into 30 access units with key frames', () => {
    const units = readHevcFixture(FIXTURE);
    assert.strictEqual(units.length, FRAMES);
    assert.ok(units[0].isKeyFrame);
    assert.ok(units.filter((u) => u.isKeyFrame).length >= 2);
  });

  it('produces one standalone JPEG per frame with monotonic sequence and timestamps', async () => {
    const frames = await run({codec: 'mjpeg'});
    assert.strictEqual(frames.length, FRAMES);
    frames.forEach((frame, i) => {
      assert.strictEqual(frame.sequence, i);
      assert.deepStrictEqual([...frame.data.subarray(0, 2)], [0xff, 0xd8]);
      assert.deepStrictEqual([...frame.data.subarray(-2)], [0xff, 0xd9]);
      assert.deepStrictEqual(jpegSize(frame.data), {width: 360, height: 640});
    });
    assert.strictEqual(frames[0].timestampMicros, 0);
    assert.ok(Math.abs(frames[FRAMES - 1].timestampMicros - (FRAMES - 1) * FRAME_MICROS) < 2);
  });

  it('rebases a non-zero RTP start to zero and survives the 32-bit wrap', async () => {
    const frames = await run({codec: 'mjpeg'}, 0xffffffff - 10 * 1500);
    assert.strictEqual(frames.length, FRAMES);
    assert.strictEqual(frames[0].timestampMicros, 0);
    assert.ok(frames[FRAMES - 1].timestampMicros > frames[FRAMES - 2].timestampMicros);
  });

  it('applies scale and quality', async () => {
    const half = await run({codec: 'mjpeg', scale: 50});
    assert.deepStrictEqual(jpegSize(half[0].data), {width: 180, height: 320});
    const low = await run({codec: 'mjpeg', quality: 20});
    const high = await run({codec: 'mjpeg', quality: 95});
    assert.ok(low[0].data.length < high[0].data.length, `${low[0].data.length} < ${high[0].data.length}`);
  });

  it('keeps fractional scale values instead of truncating them', async () => {
    const frames = await run({codec: 'mjpeg', scale: 33.3});
    assert.deepStrictEqual(jpegSize(frames[0].data), {width: 120, height: 212});
  });

  it('treats fps as an upper bound', async () => {
    const frames = await run({codec: 'mjpeg', fps: 30});
    assert.strictEqual(frames.length, FRAMES / 2);
  });

  it('flushes on end() and discards on close()', async () => {
    const t = createTranscoder({codec: 'mjpeg'});
    for (const au of readHevcFixture(FIXTURE)) {
      t.push(au);
      await sleep(PACE_MS);
    }
    await t.end();
    let count = 0;
    for await (const _ of t.units()) {
      count++;
    }
    assert.strictEqual(count, FRAMES);

    const c = createTranscoder({codec: 'mjpeg'});
    c.push(readHevcFixture(FIXTURE)[0]);
    await c.close();
    assert.strictEqual((await c.units().next()).done, true);
  });

  it('lets closed transcoders be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let finalized = 0;
    const registry = new FinalizationRegistry(() => void finalized++);
    const count = 10;
    for (let i = 0; i < count; i++) {
      const t = createTranscoder({codec: 'mjpeg'});
      registry.register(t, i);
      t.push(readHevcFixture(FIXTURE)[0]);
      await t.close();
    }
    for (let attempt = 0; attempt < 50 && finalized < count - 1; attempt++) {
      await sleep(20);
      gc();
    }
    // The newest one can still be pinned by this frame; before the fix none were ever collected.
    assert.ok(finalized >= count - 1, `finalized ${finalized}/${count}`);
  });

  it('survives garbage input and reports H.264 as unavailable', async () => {
    const t = createTranscoder({codec: 'mjpeg'});
    t.push({nals: [Buffer.from([0x26, 0x01, 0xde, 0xad, 0xbe, 0xef])], isKeyFrame: true, timestamp: 0});
    await t.end();
    assert.strictEqual((await t.units().next()).done, true);
    assert.throws(() => createTranscoder({codec: 'h264'}), MediaProxyEncoderUnavailableError);
  });
});
