#!/usr/bin/env node
/* eslint-disable no-console */
// Feeds an Annex-B HEVC file through the transcoder in real time and reports fps, latency and drops.
// Usage: node scripts/bench.mjs <file.h265> [--codec mjpeg] [--fps 60] [--scale 100] [--quality 80] [--seconds 10]
import {readFileSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {parseArgs} from 'node:util';

import {createTranscoder} from '../lib/src/index.js';
import {readHevcFixture} from '../lib/test/helpers/annexb.js';

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
const file = positionals[0];
if (!file) {
  console.error('usage: node scripts/bench.mjs <file.h265> [options]');
  process.exit(2);
}
readFileSync(file); // fail early on a bad path
const units = readHevcFixture(file);
const fps = Number(values.fps);
const total = Math.round(Number(values.seconds) * fps);
const interval = 1000 / fps;

const t = createTranscoder({
  codec: values.codec,
  fps,
  scale: Number(values.scale),
  quality: Number(values.quality),
});
const sentAt = new Map();
const latencies = [];
let bytes = 0;
let out = 0;
const consumer = (async () => {
  for await (const unit of t.units()) {
    out++;
    bytes += unit.data.length;
    const sent = sentAt.get(unit.timestampMicros);
    if (sent !== undefined) {
      latencies.push(performance.now() - sent);
    }
  }
})();

const start = performance.now();
for (let i = 0; i < total; i++) {
  const au = units[i % units.length];
  const micros = Math.round((i * 1e6) / fps);
  sentAt.set(micros, performance.now());
  // Loop the clip: key frames repeat, timestamps keep increasing (RTP 90 kHz).
  t.push({...au, timestamp: Math.round((i * 90000) / fps) >>> 0});
  const wait = start + (i + 1) * interval - performance.now();
  if (wait > 0) {
    await sleep(wait);
  }
}
await t.end();
await consumer;
const elapsed = (performance.now() - start) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]?.toFixed(1);
console.log(
  JSON.stringify({
    codec: values.codec,
    resolution: `${units.length} AUs in clip`,
    sent: total,
    received: out,
    dropped: total - out,
    outFps: +(out / elapsed).toFixed(1),
    mbps: +((bytes * 8) / elapsed / 1e6).toFixed(1),
    latencyMs: {p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: latencies.at(-1)?.toFixed(1)},
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  }),
);
