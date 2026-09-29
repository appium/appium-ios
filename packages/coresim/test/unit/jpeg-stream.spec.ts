import assert from 'node:assert';
import {describe, it} from 'node:test';

import {JpegStream} from '../../src/index.js';
import type {JpegFrame} from '../../src/index.js';

function fakeFrame(sequence: number): JpegFrame {
  return {data: Buffer.from([sequence]), sequence, timestampMicros: sequence * 1000};
}

/**
 * Pure JS-level coverage of `JpegStream`'s buffering/lifecycle, exercised via its `@internal`
 * methods (the same ones `coresim.mm`'s native glue calls) — no simulator or native addon needed.
 * Mutating/native-backed coverage lives under test/integration instead.
 */
describe('JpegStream', () => {
  it('retains a frame produced before any consumer starts iterating', async () => {
    const stream = new JpegStream();
    stream._handleFrame(fakeFrame(0));

    const it1 = stream.frames();
    const {value, done} = await it1.next();
    assert.strictEqual(done, false);
    assert.strictEqual(value?.sequence, 0);
    await stream.stop();
  });

  it('drops the oldest buffered frames on overflow, keeping the freshest', async () => {
    const stream = new JpegStream();
    // Every frame is independently decodable, so overflow just drops the oldest — no resync
    // concept, unlike VideoStream's interframe-aware queue.
    for (let i = 0; i <= 60; i++) {
      stream._handleFrame(fakeFrame(i));
    }
    const {value} = await stream.frames().next();
    assert.strictEqual(value?.sequence, 1, 'the very oldest buffered frame should have been dropped');
    await stream.stop();
  });

  it('returns cleanly from frames() given an already-aborted signal, without yielding frames pushed before it', async () => {
    const stream = new JpegStream();
    const controller = new AbortController();
    controller.abort();
    stream._handleFrame(fakeFrame(0));
    const received: JpegFrame[] = [];
    for await (const frame of stream.frames(controller.signal)) {
      received.push(frame);
    }
    assert.strictEqual(received.length, 0);
    await stream.stop();
  });

  it('returns cleanly from frames() called after stop(), without yielding frames retained from before it', async () => {
    const stream = new JpegStream();
    stream._handleFrame(fakeFrame(0));
    await stream.stop();
    const received: JpegFrame[] = [];
    for await (const frame of stream.frames()) {
      received.push(frame);
    }
    assert.strictEqual(received.length, 0);
  });

  it('rejects a second concurrent frames() consumer', async () => {
    const stream = new JpegStream();
    const firstIterator = stream.frames();
    const firstNext = firstIterator.next(); // starts executing synchronously up to its first await
    await assert.rejects(async () => {
      for await (const _frame of stream.frames()) {
        // no-op — expected to reject before ever reaching a frame
      }
    }, /only one active consumer/);
    await stream.stop();
    await firstNext;
  });

  it('resolves both callers of a concurrent stop()', async () => {
    const stream = new JpegStream();
    await Promise.all([stream.stop(), stream.stop()]);
  });

  it('throws an error into an active frames() consumer', async () => {
    const stream = new JpegStream();
    const iterating = (async () => {
      const received: JpegFrame[] = [];
      for await (const frame of stream.frames()) {
        received.push(frame);
      }
      return received;
    })();
    stream._handleFrame(fakeFrame(0));
    stream._handleError(new Error('synthetic encoder failure'));
    await assert.rejects(iterating, /synthetic encoder failure/);
  });

  it('emits "error" when an explicit listener is attached', async () => {
    const stream = new JpegStream();
    const received = new Promise<Error>((resolve) => stream.once('error', resolve));
    stream._handleError(new Error('synthetic error, with listener'));
    const error = await received;
    assert.match(error.message, /synthetic error, with listener/);
  });

  it('does not crash when an error occurs with no listener and no active consumer', () => {
    const stream = new JpegStream();
    assert.doesNotThrow(() => stream._handleError(new Error('synthetic error, nobody listening')));
  });
});
