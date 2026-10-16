import {setTimeout as sleep} from 'node:timers/promises';
/* eslint-disable no-console */
// Runs in a child process (spawned by test/integration/lifecycle.spec.ts) so process-level behaviour
// (GC with --expose-gc, exiting with an open transcoder, worker teardown) can be observed for real.
import {fileURLToPath} from 'node:url';
import {Worker, isMainThread} from 'node:worker_threads';

import {createTranscoder} from '../../src/transcoder.js';
import {readHevcFixture} from './annexb.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-360x640-30f.h265', import.meta.url));
// Large frames keep the worker busy long enough for GC to run while close() is still draining.
const HEAVY_FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-1170x2532-9f.h265', import.meta.url));
const COUNT = 10;
const WORKER_SCENARIOS = new Set(['exit-unclosed', 'close-and-hang']);
const [firstUnit] = readHevcFixture(FIXTURE);

async function collected(close: boolean): Promise<number> {
  const gc = (globalThis as {gc?: () => void}).gc;
  if (!gc) {
    throw new Error('run with --expose-gc');
  }
  let finalized = 0;
  const registry = new FinalizationRegistry(() => void finalized++);
  for (let i = 0; i < COUNT; i++) {
    const t = createTranscoder({codec: 'mjpeg'});
    registry.register(t, i);
    t.push(firstUnit);
    if (close) {
      await t.close();
    }
  }
  for (let attempt = 0; attempt < 100 && finalized < COUNT - 1; attempt++) {
    await sleep(20);
    gc();
  }
  return finalized;
}

async function main(): Promise<void> {
  switch (process.argv[2]) {
    case 'gc-closed':
      console.log(JSON.stringify({finalized: await collected(true), count: COUNT}));
      break;
    case 'gc-abandoned':
      console.log(JSON.stringify({finalized: await collected(false), count: COUNT}));
      break;
    case 'close-survives-gc': {
      // Only the close() promise is kept: the transcoder itself is dropped and collected mid-drain.
      const gc = (globalThis as {gc?: () => void}).gc;
      const closing = (() => {
        const t = createTranscoder({codec: 'mjpeg'});
        for (const au of readHevcFixture(HEAVY_FIXTURE)) {
          t.push(au);
        }
        return t.close();
      })();
      for (let i = 0; i < 20; i++) {
        gc?.();
        await sleep(0);
      }
      await closing;
      console.log('done');
      break;
    }
    case 'close-and-hang': {
      // Runs in a worker the parent terminates while this close() is still draining.
      const t = createTranscoder({codec: 'mjpeg'});
      for (const au of readHevcFixture(HEAVY_FIXTURE)) {
        t.push(au);
      }
      void t.close();
      await sleep(60_000);
      break;
    }
    case 'worker-terminate': {
      const worker = new Worker(fileURLToPath(import.meta.url), {argv: ['close-and-hang']});
      await sleep(30);
      await worker.terminate();
      console.log('done');
      break;
    }
    case 'exit-unclosed': {
      // Deliberately never closed: the process must still exit on its own.
      const t = createTranscoder({codec: 'mjpeg'});
      t.push(firstUnit);
      await sleep(50);
      if (isMainThread) {
        console.log('done');
      }
      break;
    }
    case 'worker-exit': {
      const worker = new Worker(fileURLToPath(import.meta.url), {argv: ['exit-unclosed']});
      await new Promise((resolve) => worker.once('exit', resolve));
      console.log('done');
      break;
    }
    default:
      throw new Error(`unknown scenario ${process.argv[2]}`);
  }
}

if (isMainThread || WORKER_SCENARIOS.has(process.argv[2])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
