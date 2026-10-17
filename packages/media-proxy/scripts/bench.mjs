#!/usr/bin/env node
/* eslint-disable no-console */
// Feeds an Annex-B HEVC file through the transcoder in real time and reports fps, latency and drops.
// Usage: node scripts/bench.mjs <file.h265> [--codec mjpeg] [--fps 60] [--scale 100] [--quality 80] [--seconds 10]
import {setTimeout as sleep} from 'node:timers/promises';
import {parseArgs} from 'node:util';

import {createTranscoder} from '../lib/src/index.js';
import {readHevcFixture} from '../lib/test/helpers/annexb.js';

const BYTES_PER_MB = 1048576;
const RTP_CLOCK_HZ = 90000;

function parseOptions() {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    options: {
      codec: {type: 'string', default: 'mjpeg'},
      fps: {type: 'string', default: '60'},
      scale: {type: 'string', default: '100'},
      quality: {type: 'string', default: '80'},
      seconds: {type: 'string', default: '10'},
    },
  });
  if (!positionals[0]) {
    throw new Error('usage: node scripts/bench.mjs <file.h265> [options]');
  }
  const fps = Number(values.fps);
  return {
    file: positionals[0],
    codec: values.codec,
    fps,
    scale: Number(values.scale),
    quality: Number(values.quality),
    frames: Math.round(Number(values.seconds) * fps),
  };
}

/** Consumes the transcoder output, recording when each unit arrived relative to when it was sent. */
function collect(transcoder, sentAt) {
  const stats = {received: 0, bytes: 0, latencies: []};
  const done = (async () => {
    for await (const unit of transcoder.units()) {
      stats.received++;
      stats.bytes += unit.data.length;
      const sent = sentAt.get(unit.timestampMicros);
      if (sent !== undefined) {
        stats.latencies.push(performance.now() - sent);
      }
    }
  })();
  return {stats, done};
}

/** Pushes `frames` access units paced at `fps`, looping the clip (key frames repeat, time keeps advancing). */
async function feed(transcoder, units, {fps, frames}, sentAt) {
  const interval = 1000 / fps;
  const start = performance.now();
  for (let i = 0; i < frames; i++) {
    sentAt.set(Math.round((i * 1e6) / fps), performance.now());
    transcoder.push({...units[i % units.length], timestamp: Math.round((i * RTP_CLOCK_HZ) / fps) >>> 0});
    const wait = start + (i + 1) * interval - performance.now();
    if (wait > 0) {
      await sleep(wait);
    }
  }
  await transcoder.end();
  return (performance.now() - start) / 1000;
}

function summarize(options, units, stats, elapsed) {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(1);
  return {
    codec: options.codec,
    clipAccessUnits: units.length,
    sent: options.frames,
    received: stats.received,
    dropped: options.frames - stats.received,
    outFps: +(stats.received / elapsed).toFixed(1),
    mbps: +((stats.bytes * 8) / elapsed / 1e6).toFixed(1),
    latencyMs: {p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: sorted.at(-1)?.toFixed(1)},
    rssMb: Math.round(process.memoryUsage().rss / BYTES_PER_MB),
  };
}

async function main() {
  const options = parseOptions();
  const units = readHevcFixture(options.file);
  const transcoder = createTranscoder({
    codec: options.codec,
    fps: options.fps,
    scale: options.scale,
    quality: options.quality,
  });
  const sentAt = new Map();
  const {stats, done} = collect(transcoder, sentAt);
  const elapsed = await feed(transcoder, units, options, sentAt);
  await done;
  console.log(JSON.stringify(summarize(options, units, stats, elapsed)));
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
