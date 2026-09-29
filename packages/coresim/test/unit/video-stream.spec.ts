import assert from 'node:assert';
import {describe, it} from 'node:test';

import {VideoStream} from '../../src/index.js';
import type {VideoAccessUnit} from '../../src/index.js';

function fakeUnit(sequence: number, isKeyFrame = sequence === 0): VideoAccessUnit {
  return {track: 'video', data: Buffer.from([sequence]), isKeyFrame, sequence, timestampMicros: sequence * 1000};
}

/**
 * Pure JS-level coverage of `VideoStream`'s buffering/lifecycle, exercised via its `@internal`
 * methods (the same ones `coresim.mm`'s native glue calls) — no simulator or native addon needed.
 * Mutating/native-backed coverage lives under test/integration instead.
 */
describe('VideoStream', () => {
  it('retains an access unit produced before any consumer starts iterating', async () => {
    const stream = new VideoStream('h264');
    // Simulate the encoder's very first (keyframe) callback firing before the caller has had a
    // chance to call accessUnits() — see CLAUDE.md for why this race is real, not hypothetical.
    stream._handleAccessUnit(fakeUnit(0));

    const it1 = stream.accessUnits();
    const {value, done} = await it1.next();
    assert.strictEqual(done, false);
    assert.strictEqual(value?.sequence, 0);
    assert.strictEqual(value?.isKeyFrame, true);
    await stream.stop();
  });

  it('resyncs after overflow, discarding interframes until the next keyframe', async () => {
    const stream = new VideoStream('h264');
    let keyFrameRequests = 0;
    // Only the one method the queue's overflow path actually calls is exercised here.
    stream._attachHandle({stop: async () => {}, requestKeyFrame: () => keyFrameRequests++});
    // One keyframe plus enough interframes to force an overflow — an interframe is only
    // decodable given every frame it references, so none of these (nor the keyframe itself,
    // since the whole backlog is cleared on overflow) should ever reach the consumer.
    for (let i = 0; i <= 60; i++) {
      stream._handleAccessUnit(fakeUnit(i));
    }
    assert.strictEqual(keyFrameRequests, 1, 'overflow should have requested a fresh keyframe to resync from');
    // A later interframe is still discarded — only a keyframe ends the resync.
    stream._handleAccessUnit(fakeUnit(70, false));
    stream._handleAccessUnit(fakeUnit(100, true));
    stream._handleAccessUnit(fakeUnit(101, false));

    const received: number[] = [];
    for await (const unit of stream.accessUnits()) {
      received.push(unit.sequence);
      if (received.length === 2) {
        break;
      }
    }
    assert.deepStrictEqual(received, [100, 101]);
    await stream.stop();
  });

  it('returns cleanly from accessUnits() given an already-aborted signal, without yielding units pushed before it', async () => {
    const stream = new VideoStream('h264');
    const controller = new AbortController();
    controller.abort();
    // Pushed before iterating even starts — an already-aborted signal must win over dequeuing
    // whatever's already buffered, not just future pushes.
    stream._handleAccessUnit(fakeUnit(0));
    const received: VideoAccessUnit[] = [];
    for await (const unit of stream.accessUnits(controller.signal)) {
      received.push(unit);
    }
    assert.strictEqual(received.length, 0);
    await stream.stop();
  });

  it('returns cleanly from accessUnits() called after stop(), without yielding units retained from before it', async () => {
    const stream = new VideoStream('h264');
    stream._handleAccessUnit(fakeUnit(0));
    await stream.stop();
    const received: VideoAccessUnit[] = [];
    for await (const unit of stream.accessUnits()) {
      received.push(unit);
    }
    assert.strictEqual(received.length, 0);
  });

  it('rejects a second concurrent accessUnits() consumer', async () => {
    const stream = new VideoStream('h264');
    const firstIterator = stream.accessUnits();
    const firstNext = firstIterator.next(); // starts executing synchronously up to its first await
    await assert.rejects(async () => {
      for await (const _unit of stream.accessUnits()) {
        // no-op — expected to reject before ever reaching a unit
      }
    }, /only one active consumer/);
    await stream.stop();
    await firstNext;
  });

  it('resolves both callers of a concurrent stop()', async () => {
    const stream = new VideoStream('h264');
    await Promise.all([stream.stop(), stream.stop()]);
  });

  it('throws an error into an active accessUnits() consumer', async () => {
    const stream = new VideoStream('h264');
    const iterating = (async () => {
      const received: VideoAccessUnit[] = [];
      for await (const unit of stream.accessUnits()) {
        received.push(unit);
      }
      return received;
    })();
    stream._handleAccessUnit(fakeUnit(0));
    stream._handleError(new Error('synthetic encoder failure'));
    await assert.rejects(iterating, /synthetic encoder failure/);
  });

  it('emits "error" when an explicit listener is attached', async () => {
    const stream = new VideoStream('h264');
    const received = new Promise<Error>((resolve) => stream.once('error', resolve));
    stream._handleError(new Error('synthetic error, with listener'));
    const error = await received;
    assert.match(error.message, /synthetic error, with listener/);
  });

  it('does not crash when an error occurs with no listener and no active consumer', () => {
    const stream = new VideoStream('h264');
    assert.doesNotThrow(() => stream._handleError(new Error('synthetic error, nobody listening')));
  });
});
