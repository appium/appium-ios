// Standalone child process, not a test file itself — spawned by coresim-integration.spec.ts's
// "does not crash on exit after stop() while the stream wrapper is still referenced" regression
// test. Reproduces the exact sequence a prior fix got wrong: start a stream, stop() it (which
// releases its ThreadSafeFunctions via onEnd), keep the returned handle referenced (so its native
// wrapper isn't GC'd/Finalized — the active-session registry only deregisters on Finalize, not on
// stop()), then process.exit() — exercising CleanupActiveSessions's exit-time AbortDelivery
// against an already-released session. Exits 0 on success, 2 if video streaming is unavailable on
// this CoreSimulator (nothing to regress against), 1 on any other error. A crash shows up to the
// parent as a non-zero/signal exit from execFile, same as any other abnormal child exit.
import {NativeSimctl, NativeSimUnavailableError} from '../../src/index.js';

const EXIT_SKIP = 2;

async function main(): Promise<void> {
  const udid = process.argv[2];
  if (!udid) {
    throw new Error('expected a device UDID as argv[2]');
  }
  const sim = new NativeSimctl();

  let stream: Awaited<ReturnType<typeof sim.startVideoStream>>;
  try {
    stream = await sim.startVideoStream(udid, {fps: 5});
  } catch (err) {
    if (err instanceof NativeSimUnavailableError) {
      process.exit(EXIT_SKIP);
    }
    throw err;
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  await stream.stop();

  // Release()'s actual native cleanup (closing the TSFN's libuv handle) happens asynchronously,
  // not synchronously within stop()'s own await — give the event loop time to actually run it
  // before exiting, or a too-early AbortDelivery() would race a release that hasn't finished yet
  // instead of hitting the already-released handle this test means to exercise.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // `stream` is still referenced by this local — its native wrapper is not eligible for
  // Finalize()/deregistration yet, so the session is still in the addon's active-session registry
  // when process.exit() below fires the exit-cleanup path.
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
