import assert from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {createTranscoder, transcode} from '../../src/transcoder.js';
import type {AudioAccessUnit, NalAccessUnit, VideoAccessUnit} from '../../src/types.js';
import {HAS_H264, readHevcFixture} from '../helpers/annexb.js';

const HEVC_FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-360x640-30f.h265', import.meta.url));
// 1 s of 440 Hz (left) / 880 Hz (right) from AudioToolbox (`afconvert -d aace@48000`), stored as u16 BE length +
// access unit. It has 512-sample frames and the matching config; the device itself sends 480-sample frames.
const ELD_FIXTURE = fileURLToPath(new URL('../../../test/fixtures/aac-eld-48k-stereo-512.bin', import.meta.url));
const ELD_CONFIG = Buffer.from([0xf8, 0xe6, 0x40, 0x00]);
const ELD_FRAME = 512;
const AAC_FRAME = 1024;
const RATE = 48_000;

function readEld(): AudioAccessUnit[] {
  const file = readFileSync(ELD_FIXTURE);
  const units: AudioAccessUnit[] = [];
  for (let at = 0; at < file.length;) {
    const size = file.readUInt16BE(at);
    units.push({data: file.subarray(at + 2, at + 2 + size), timestamp: units.length * ELD_FRAME});
    at += 2 + size;
  }
  return units;
}

const OPTIONS = {codec: 'h264', audio: true, audioSpecificConfig: ELD_CONFIG} as const;

async function transcodeAudio(units: AudioAccessUnit[]): Promise<VideoAccessUnit[]> {
  const transcoder = createTranscoder(OPTIONS);
  for (const unit of units) {
    transcoder.pushAudio(unit);
  }
  await transcoder.end();
  const out: VideoAccessUnit[] = [];
  for await (const unit of transcoder.units()) {
    out.push(unit);
  }
  return out;
}

describe('AAC-ELD -> ADTS AAC-LC', {skip: !HAS_H264}, () => {
  it('frames AAC-LC units in ADTS on a steady clock', async () => {
    const units = await transcodeAudio(readEld());
    assert.ok(units.length >= 45, `${units.length} units`);
    units.forEach((unit, i) => {
      const {data} = unit;
      assert.strictEqual(unit.track, 'audio');
      assert.ok(unit.isKeyFrame);
      assert.strictEqual(unit.sequence, i);
      assert.strictEqual(data.readUInt16BE(0) & 0xfff6, 0xfff0, 'syncword, layer 0');
      assert.strictEqual((data[2] >> 6) + 1, 2, 'AAC-LC');
      assert.strictEqual((data[2] >> 2) & 0xf, 3, '48 kHz');
      assert.strictEqual(((data[2] & 1) << 2) | (data[3] >> 6), 2, 'stereo');
      assert.strictEqual(((data[3] & 3) << 11) | (data[4] << 3) | (data[5] >> 5), data.length, 'frame length');
      assert.ok(Math.abs(unit.timestampMicros - Math.round((i * AAC_FRAME * 1e6) / RATE)) <= 1);
    });
  });

  it('decodes back to the original tones', {skip: spawnSync('ffmpeg', ['-version']).error !== undefined}, async () => {
    const adts = Buffer.concat((await transcodeAudio(readEld())).map((u) => u.data));
    const decoded = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'aac', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], {
      input: adts,
      maxBuffer: 1 << 26,
    });
    assert.strictEqual(decoded.status, 0, decoded.stderr.toString());
    const pcm = decoded.stdout;
    const frames = pcm.length / 4;
    assert.ok(frames >= 40_000, `${frames} sample frames`);
    // Zero crossings per channel over the steady middle: 440 Hz and 880 Hz.
    const crossings = [0, 0];
    const from = 8192;
    const to = 40_960;
    for (let ch = 0; ch < 2; ch++) {
      for (let i = from + 1; i < to; i++) {
        const prev = pcm.readInt16LE((i - 1) * 4 + ch * 2);
        const cur = pcm.readInt16LE(i * 4 + ch * 2);
        crossings[ch] += prev < 0 !== cur < 0 ? 1 : 0;
      }
    }
    const seconds = (to - from) / RATE;
    assert.ok(Math.abs(crossings[0] / 2 / seconds - 440) < 15, `left ${(crossings[0] / 2 / seconds).toFixed(1)} Hz`);
    assert.ok(Math.abs(crossings[1] / 2 / seconds - 880) < 30, `right ${(crossings[1] / 2 / seconds).toFixed(1)} Hz`);
  });

  it('pads a gap of lost packets with silence so the clock keeps its length', async () => {
    const all = readEld();
    const gapped = all.filter((_, i) => i < 30 || i >= 50); // 20 units (~213 ms) missing
    const whole = await transcodeAudio(all);
    const withGap = await transcodeAudio(gapped);
    assert.ok(Math.abs(withGap.length - whole.length) <= 1, `${withGap.length} vs ${whole.length} units`);
  });

  it('restarts the timeline after a long gap instead of padding it', async () => {
    const units = readEld().map((u, i) => (i < 20 ? u : {...u, timestamp: u.timestamp + 10 * RATE}));
    const out = await transcodeAudio(units);
    const jump = out.findIndex((u, i) => i > 0 && u.timestampMicros - out[i - 1].timestampMicros > 5e6);
    assert.ok(jump > 0, 'timestamps jump with the input');
    assert.ok(out.length < 60, `${out.length} units`);
  });

  it('ignores a repeated unit', async () => {
    const all = readEld();
    const repeated = [...all.slice(0, 11), all[10], ...all.slice(11)];
    const [plain, dup] = [await transcodeAudio(all), await transcodeAudio(repeated)];
    assert.strictEqual(dup.length, plain.length);
  });

  it('settles close() with audio and video workers busy, repeatedly', async () => {
    const audio = readEld();
    const [video] = readHevcFixture(HEVC_FIXTURE);
    for (let round = 0; round < 10; round++) {
      const transcoder = createTranscoder(OPTIONS);
      transcoder.push(video);
      audio.forEach((unit) => transcoder.pushAudio(unit));
      await transcoder.close();
      transcoder.pushAudio(audio[0]); // ignored once closed
    }
  });

  it('interleaves with video on one clock, with a sequence per track', async () => {
    async function* video(): AsyncGenerator<NalAccessUnit> {
      for (const au of readHevcFixture(HEVC_FIXTURE)) {
        yield au;
        await sleep(10);
      }
    }
    async function* audio(): AsyncGenerator<AudioAccessUnit> {
      for (const au of readEld()) {
        yield au;
        await sleep(5);
      }
    }
    const out: VideoAccessUnit[] = [];
    for await (const unit of transcode(video(), OPTIONS, undefined, audio())) {
      out.push(unit);
    }
    const videoUnits = out.filter((u) => u.track === 'video');
    const audioUnits = out.filter((u) => u.track === 'audio');
    assert.strictEqual(videoUnits.length, 30);
    assert.ok(audioUnits.length > 10);
    for (const track of [videoUnits, audioUnits]) {
      track.forEach((u, i) => assert.strictEqual(u.sequence, i));
      assert.ok(track.every((u, i) => i === 0 || u.timestampMicros > track[i - 1].timestampMicros));
    }
    // Both tracks start at the beginning of the stream, not offset by one another.
    assert.ok(videoUnits[0].timestampMicros < 100_000);
    assert.ok(audioUnits[0].timestampMicros < 100_000);
  });
});
