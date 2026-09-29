// Standalone child process, not a test file itself — spawned by coresim-integration.spec.ts's
// "does not crash on exit after stop() while the JPEG stream wrapper is still referenced"
// regression test. Same race as av-abort-delivery-child.ts, exercised against JpegStreamSession's
// own TsfnReleaseGuard pair instead of VideoStreamSession's — see that file's own comment for the
// full sequence. Exits 0 on success, 2 if JPEG streaming is unavailable on this CoreSimulator
// (nothing to regress against), 1 on any other error.
import {NativeSimctl, NativeSimUnavailableError} from '../../src/index.js';

const EXIT_SKIP = 2;

async function main(): Promise<void> {
  const udid = process.argv[2];
  if (!udid) {
    throw new Error('expected a device UDID as argv[2]');
  }
  const sim = new NativeSimctl();

  let stream: Awaited<ReturnType<typeof sim.startJpegStream>>;
  try {
    stream = await sim.startJpegStream(udid, {fps: 5});
  } catch (err) {
    if (err instanceof NativeSimUnavailableError) {
      process.exit(EXIT_SKIP);
    }
    throw err;
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  await stream.stop();

  // See av-abort-delivery-child.ts's identical comment on why this delay is needed before exiting.
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
