import assert from 'node:assert';
import {spawnSync} from 'node:child_process';
import {describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {createTranscoder} from '../../src/transcoder.js';
import type {JpegFrame, MjpegOptions, Rotation, VideoAccessUnit} from '../../src/types.js';
import {HAS_H264, h264NalTypes, jpegSize, readHevcFixture} from '../helpers/annexb.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-360x640-30f.h265', import.meta.url));
const WIDTH = 360;
const HEIGHT = 640;
// The pipeline treats input as a live stream, so tests pace their input like a device.
const PACE_MS = 10;

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

async function jpegs(opts: Omit<MjpegOptions, 'codec'>, frames = 1): Promise<JpegFrame[]> {
  const transcoder = createTranscoder({codec: 'mjpeg', ...opts});
  const out: JpegFrame[] = [];
  const consumer = (async () => {
    for await (const frame of transcoder.units()) {
      out.push(frame);
    }
  })();
  for (const au of readHevcFixture(FIXTURE).slice(0, frames)) {
    transcoder.push(au);
    await sleep(PACE_MS);
  }
  await transcoder.end();
  await consumer;
  return out;
}

/** Luma of a JPEG, row by row, decoded by ffmpeg. */
function decodeGray(jpeg: Buffer, width: number, height: number): Buffer {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], {
    input: jpeg,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.strictEqual(result.status, 0, String(result.stderr));
  assert.strictEqual(result.stdout.length, width * height);
  return result.stdout;
}

/** The reference: the same turn, done the obvious way, on a decoded picture. */
function rotateGray(gray: Buffer, width: number, height: number, degrees: Rotation): Buffer {
  const turned = degrees === 90 || degrees === 270;
  const out = Buffer.alloc(gray.length);
  const outWidth = turned ? height : width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [dx, dy] =
        degrees === 0
          ? [x, y]
          : degrees === 90
            ? [height - 1 - y, x]
            : degrees === 180
              ? [width - 1 - x, height - 1 - y]
              : [y, width - 1 - x];
      out[dy * outWidth + dx] = gray[y * width + x];
    }
  }
  return out;
}

const meanAbsDifference = (a: Buffer, b: Buffer): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
};

describe('rotation and crop (MJPEG)', () => {
  it('swaps the width and height for a quarter turn and keeps them for the others', async () => {
    const sizes: Record<number, {width: number; height: number}> = {};
    for (const rotation of [0, 90, 180, 270] as const) {
      const [frame] = await jpegs({rotation});
      sizes[rotation] = jpegSize(frame.data);
    }
    assert.deepStrictEqual(sizes[0], {width: WIDTH, height: HEIGHT});
    assert.deepStrictEqual(sizes[90], {width: HEIGHT, height: WIDTH});
    assert.deepStrictEqual(sizes[180], {width: WIDTH, height: HEIGHT});
    assert.deepStrictEqual(sizes[270], {width: HEIGHT, height: WIDTH});
  });

  it('crops from the top-left corner, before scaling and turning', async () => {
    const [plain] = await jpegs({crop: {width: 300, height: 600}});
    assert.deepStrictEqual(jpegSize(plain.data), {width: 300, height: 600});
    const [scaled] = await jpegs({crop: {width: 300, height: 600}, scale: 50});
    assert.deepStrictEqual(jpegSize(scaled.data), {width: 150, height: 300});
    const [turned] = await jpegs({crop: {width: 300, height: 600}, rotation: 90});
    assert.deepStrictEqual(jpegSize(turned.data), {width: 600, height: 300});
  });

  it('keeps the whole picture when the crop is larger than it', async () => {
    const [frame] = await jpegs({crop: {width: 2000, height: 4000}});
    assert.deepStrictEqual(jpegSize(frame.data), {width: WIDTH, height: HEIGHT});
  });

  describe('turns the picture the right way', {skip: HAS_FFMPEG ? false : 'ffmpeg is not installed'}, () => {
    it('matches an independent rotation of the unrotated output, and not the other three', async () => {
      const [base] = await jpegs({quality: 100});
      const upright = decodeGray(base.data, WIDTH, HEIGHT);
      const all: Rotation[] = [0, 90, 180, 270];
      for (const rotation of all) {
        const [frame] = await jpegs({quality: 100, rotation});
        const {width, height} = jpegSize(frame.data);
        const decoded = decodeGray(frame.data, width, height);
        const distances = all.map((candidate) => {
          const expected = rotateGray(upright, WIDTH, HEIGHT, candidate);
          // Only quarter turns of the same shape can be compared
          return expected.length === decoded.length && candidate % 180 === rotation % 180
            ? meanAbsDifference(decoded, expected)
            : Number.POSITIVE_INFINITY;
        });
        const right = distances[all.indexOf(rotation)];
        assert.ok(right < 6, `rotation ${rotation}: mean difference to the reference is ${right}`);
        if (rotation !== 0) {
          // A picture turned by 180 degrees more must be clearly different, or the test proves nothing
          const opposite = distances[all.indexOf(((rotation + 180) % 360) as Rotation)];
          assert.ok(
            opposite > right * 2,
            `rotation ${rotation}: ${right} is not clearly below the opposite's ${opposite}`,
          );
        }
      }
    });
  });

  it('turns the stream while it runs: the size changes once and stays', async () => {
    const transcoder = createTranscoder({codec: 'mjpeg'});
    const sizes: string[] = [];
    const consumer = (async () => {
      for await (const frame of transcoder.units()) {
        const {width, height} = jpegSize(frame.data);
        sizes.push(`${width}x${height}`);
      }
    })();
    const aus = readHevcFixture(FIXTURE);
    for (const [i, au] of aus.entries()) {
      if (i === 15) {
        transcoder.setRotation(90);
      }
      transcoder.push(au);
      await sleep(PACE_MS);
    }
    await transcoder.end();
    await consumer;
    const changes = sizes.filter((size, i) => i > 0 && size !== sizes[i - 1]);
    assert.deepStrictEqual(changes, [`${HEIGHT}x${WIDTH}`], `sizes: ${sizes.join(' ')}`);
    assert.strictEqual(sizes[0], `${WIDTH}x${HEIGHT}`);
  });
});

describe('rotation (H.264)', {skip: HAS_H264 ? false : 'no H.264 encoder on this platform'}, () => {
  it('starts a new stream with parameter sets and a keyframe when the rotation changes', async () => {
    const transcoder = createTranscoder({codec: 'h264'});
    const units: VideoAccessUnit[] = [];
    const consumer = (async () => {
      for await (const unit of transcoder.units()) {
        units.push(unit as VideoAccessUnit);
      }
    })();
    const aus = readHevcFixture(FIXTURE);
    let turnedAt = 0;
    for (const [i, au] of aus.entries()) {
      if (i === 15) {
        turnedAt = units.length;
        transcoder.setRotation(90);
      }
      transcoder.push(au);
      await sleep(PACE_MS);
    }
    await transcoder.end();
    await consumer;
    const after = units.slice(turnedAt);
    const firstKey = after.findIndex((unit) => unit.isKeyFrame);
    assert.ok(firstKey >= 0, 'a keyframe follows the change');
    // The units in between are frames queued before the change was seen
    assert.ok(firstKey < 12, `the keyframe came after ${firstKey} units`);
    assert.deepStrictEqual(h264NalTypes(after[firstKey].data).slice(0, 2), [7, 8], 'SPS and PPS are inline');
  });
});
