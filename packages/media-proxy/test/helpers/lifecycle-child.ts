import {setTimeout as sleep} from 'node:timers/promises';
/* eslint-disable no-console */
// Runs in a child process (spawned by test/integration/lifecycle.spec.ts) so process-level behaviour
// (GC with --expose-gc, exiting with an open transcoder, worker teardown) can be observed for real.
import {fileURLToPath} from 'node:url';
import {Worker, isMainThread} from 'node:worker_threads';

import {createTranscoder} from '../../src/transcoder.js';
import {readHevcFixture} from './annexb.js';

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/hevc-360x640-30f.h265', import.meta.url));
const COUNT = 10;
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

if (isMainThread || process.argv[2] === 'exit-unclosed') {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
