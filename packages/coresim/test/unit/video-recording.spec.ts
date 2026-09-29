import assert from 'node:assert';
import path from 'node:path';
import {describe, it} from 'node:test';

import {isVideoRecording, startVideoRecording, stopVideoRecording} from '../../src/commands/video-recording.js';
import type {NativeSimctl} from '../../src/native-simctl.js';

// A minimal `this` for these command functions — only `_findDevice` is ever touched, so no real
// NativeSimctl/native addon is needed to exercise activeRecordings' own bookkeeping.
function fakeSim(stopImpl: () => Promise<void>): NativeSimctl {
  return {
    _findDevice: async () => ({
      startVideoRecording: async () => ({stop: stopImpl}),
    }),
  } as unknown as NativeSimctl;
}

const outputFile = path.join(process.cwd(), 'fake-recording.mp4');

describe('stopVideoRecording force option', () => {
  it('without force, a failed native stop leaves the entry retryable', async () => {
    const udid = `force-test-retry-${Date.now()}`;
    const sim = fakeSim(async () => {
      throw new Error('synthetic transient stop failure');
    });
    await startVideoRecording.call(sim, udid, outputFile);
    await assert.rejects(stopVideoRecording.call(sim, udid), /synthetic transient stop failure/);
    assert.strictEqual(await isVideoRecording.call(sim, udid), true, 'entry should survive a failed stop');
  });

  it('force releases a stuck entry despite a failed native stop, without rejecting', async () => {
    const udid = `force-test-release-${Date.now()}`;
    const sim = fakeSim(async () => {
      throw new Error('synthetic transient stop failure');
    });
    await startVideoRecording.call(sim, udid, outputFile);
    await stopVideoRecording.call(sim, udid, {force: true});
    assert.strictEqual(await isVideoRecording.call(sim, udid), false);
    // Bookkeeping is back in sync — a new recording is no longer blocked by the old one.
    await startVideoRecording.call(sim, udid, outputFile);
    assert.strictEqual(await isVideoRecording.call(sim, udid), true);
  });

  it('force is a no-op safety net when the native stop actually succeeds', async () => {
    const udid = `force-test-success-${Date.now()}`;
    const sim = fakeSim(async () => {});
    await startVideoRecording.call(sim, udid, outputFile);
    await stopVideoRecording.call(sim, udid, {force: true});
    assert.strictEqual(await isVideoRecording.call(sim, udid), false);
  });
});
