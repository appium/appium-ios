import assert from 'node:assert/strict';
import {createSocket, type Socket} from 'node:dgram';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';

import type {DisplayService, MediaStreamAnswer} from '../../../../src/services/ios/display/index.js';
import {
  AnnexBFileWriter,
  ScreenStreamCapture,
} from '../../../../src/services/ios/display/video/screen-stream-capture.js';

/**
 * Builds a capture wired to a stub service and a stub receiver, bypassing
 * `start()` (which would negotiate with a device).
 */
function makeCapture(options: {onStop: () => Promise<void>}): {
  capture: ScreenStreamCapture;
  receiverCloseCalls: () => number;
} {
  let receiverClosed = 0;
  const service = {
    stopAllMediaStreams: async (): Promise<number[]> => {
      await options.onStop();
      return [];
    },
  } as unknown as DisplayService;
  const receiver = {
    close: (): void => {
      receiverClosed += 1;
    },
    async *packets(): AsyncGenerator<Buffer, void, unknown> {
      // No traffic in these tests.
    },
    port: 1234,
  };
  const answer = {
    clientSessionId: undefined,
    streamConfig: {},
    connection: {},
    raw: {},
  } as unknown as MediaStreamAnswer;

  // The constructor is private by design; tests build the object directly.
  const capture = Reflect.construct(ScreenStreamCapture, [service, receiver, answer]) as ScreenStreamCapture;
  return {capture, receiverCloseCalls: () => receiverClosed};
}

describe('ScreenStreamCapture', function () {
  describe('stop()', function () {
    it('tears the stream down exactly once across repeated calls', async function () {
      let stopCalls = 0;
      const {capture, receiverCloseCalls} = makeCapture({
        onStop: async () => {
          stopCalls += 1;
        },
      });

      await capture.stop();
      await capture.stop();
      await capture.stop();

      assert.strictEqual(stopCalls, 1);
      assert.strictEqual(receiverCloseCalls(), 1);
    });

    it('makes a concurrent caller await the in-flight teardown, not return early', async function () {
      // The regression this guards: `recordScreenToFile` triggers stop() from a
      // timer and again from its finally block. If the second call returned
      // early, the function could resolve while the device-side stop was still
      // in flight — and the transport it then created outlived the service's
      // close(), leaking a socket that kept the process alive.
      let released: () => void = () => undefined;
      let settled = false;
      const gate = new Promise<void>((resolve) => {
        released = resolve;
      });
      const {capture} = makeCapture({onStop: () => gate});

      const first = capture.stop().then(() => {
        settled = true;
      });
      const second = capture.stop();

      // Neither call may resolve while the teardown is still blocked.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(settled, false);

      released();
      await Promise.all([first, second]);
      assert.strictEqual(settled, true);
    });

    it('propagates a teardown failure to every caller', async function () {
      const {capture} = makeCapture({
        onStop: async () => {
          throw new Error('device refused the stop');
        },
      });

      const first = capture.stop();
      const second = capture.stop();

      for (const pending of [first, second]) {
        let caught: unknown;
        try {
          await pending;
        } catch (error) {
          caught = error;
        }
        assert.strictEqual((caught as Error | undefined)?.message, 'device refused the stop');
      }
    });
  });
});

/**
 * A UDP socket on the IPv6 loopback standing in for the device's RTCP port. `ScreenStreamCapture.start()`
 * binds an IPv6 socket itself, so these tests need IPv6 loopback like the capture does.
 */
async function bindFakeDevice(): Promise<{socket: Socket; port: number; packets: Buffer[]}> {
  const socket = createSocket('udp6');
  const packets: Buffer[] = [];
  socket.on('message', (data) => packets.push(data));
  await new Promise<void>((resolve) => socket.bind(0, '::1', resolve));
  return {socket, port: socket.address().port, packets};
}

describe('ScreenStreamCapture keyframe requests', function () {
  const SENDER_SSRC = 0x11223344;
  const DEVICE_SSRC = 0xaabbccdd;
  const PSFB = 0xce;

  function fakeService(
    devicePort: number,
    streamConfig?: Record<string, unknown>,
  ): {service: DisplayService; stops: () => number} {
    let stops = 0;
    const service = {
      getTunnelLocalAddress: async () => '::1',
      getDeviceAddress: async () => '::1',
      startVideoStream: async () =>
        ({
          clientSessionId: undefined,
          streamConfig: streamConfig ?? {RemoteSSRC: SENDER_SSRC, LocalSSRC: DEVICE_SSRC, SourcePort: devicePort},
          connection: {},
          raw: {},
        }) as unknown as MediaStreamAnswer,
      stopAllMediaStreams: async () => {
        stops += 1;
        return [];
      },
    } as unknown as DisplayService;
    return {service, stops: () => stops};
  }

  const feedback = (packets: Buffer[]): Buffer[] => packets.filter((p) => p.readUInt8(1) === PSFB);
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  /** Polls instead of sleeping a fixed time, so a loaded runner only makes the test slower, not flaky. */
  async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
    for (let waited = 0; !condition() && waited < timeoutMs; waited += 10) {
      await wait(10);
    }
    assert.ok(condition(), 'timed out waiting for the condition');
  }

  it('asks for a keyframe on demand and addresses it to the device', async function () {
    const device = await bindFakeDevice();
    const {service} = fakeService(device.port);
    const capture = await ScreenStreamCapture.start(service, {keyFrameIntervalMs: 0});
    try {
      assert.strictEqual(await capture.requestKeyFrame(), true);
      await waitFor(() => feedback(device.packets).length > 0);

      const [pli, ...rest] = feedback(device.packets);
      assert.strictEqual(rest.length, 0);
      assert.strictEqual(pli.readUInt8(0), 0x81);
      assert.strictEqual(pli.readUInt32BE(4), SENDER_SSRC);
      assert.strictEqual(pli.readUInt32BE(8), DEVICE_SSRC);
    } finally {
      await capture.stop();
      device.socket.close();
    }
  });

  it('asks every 2000 ms by default, and not before', async function (t) {
    t.mock.timers.enable({apis: ['setInterval', 'Date']});
    const device = await bindFakeDevice();
    const {service} = fakeService(device.port);
    const capture = await ScreenStreamCapture.start(service);
    try {
      t.mock.timers.tick(1999);
      await wait(50);
      assert.strictEqual(feedback(device.packets).length, 0, 'not before 2000 ms');

      t.mock.timers.tick(1);
      await waitFor(() => feedback(device.packets).length === 1);
    } finally {
      await capture.stop();
      device.socket.close();
    }
  });

  it('does not ask periodically when keyFrameIntervalMs is 0, and stops asking after stop()', async function (t) {
    t.mock.timers.enable({apis: ['setInterval', 'Date']});
    const device = await bindFakeDevice();
    const {service, stops} = fakeService(device.port);
    const capture = await ScreenStreamCapture.start(service, {keyFrameIntervalMs: 0});
    t.mock.timers.tick(10_000);
    await wait(50);
    assert.strictEqual(feedback(device.packets).length, 0);
    await capture.stop();
    assert.strictEqual(stops(), 1);
    assert.strictEqual(await capture.requestKeyFrame(), false, 'no requests after stop()');
    device.socket.close();
  });

  it('rejects an interval that is negative, not finite or above the timer limit, before touching the device', async function () {
    const {service} = fakeService(1);
    for (const keyFrameIntervalMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await assert.rejects(ScreenStreamCapture.start(service, {keyFrameIntervalMs}), RangeError);
    }
  });

  it('reports that no request was sent when the device gave no RTCP identity', async function () {
    const {capture} = makeCapture({onStop: async () => undefined});

    assert.strictEqual(await capture.requestKeyFrame(), false);
  });

  it('starts without keepalive or keyframe requests when the device omits its RTCP identity', async function () {
    const {service} = fakeService(1, {});
    const capture = await ScreenStreamCapture.start(service);
    try {
      assert.strictEqual(await capture.requestKeyFrame(), false);
    } finally {
      await capture.stop();
    }
  });
});

describe('AnnexBFileWriter', function () {
  let directory: string;
  let counter = 0;

  before(async function () {
    directory = await mkdtemp(join(tmpdir(), 'annexb-writer-'));
  });

  after(async function () {
    await rm(directory, {force: true, recursive: true});
  });

  const chunk = (byte: number, length: number): Buffer => Buffer.alloc(length, byte);
  const missingPath = (): string => join(directory, 'no', 'such', 'dir', 'screen.h265');

  it('writes every chunk through to the file', async function () {
    const path = join(directory, `stream-${counter++}.h265`);
    const chunks = [chunk(0x11, 40), chunk(0x22, 55), chunk(0x33, 48)];

    const writer = new AnnexBFileWriter(path);
    for (const part of chunks) {
      await writer.write(part);
    }
    await writer.close();

    assert.deepStrictEqual(await readFile(path), Buffer.concat(chunks));
  });

  it('writes a file larger than the stream buffer, so backpressure is exercised', async function () {
    const path = join(directory, `stream-${counter++}.h265`);
    const frame = chunk(0xab, 256 * 1024);
    const frames = 40;

    const writer = new AnnexBFileWriter(path);
    for (let i = 0; i < frames; i++) {
      await writer.write(frame);
    }
    await writer.close();

    const file = await readFile(path);
    assert.strictEqual(file.length, frame.length * frames);
    assert.ok(file.every((byte) => byte === 0xab));
  });

  it('reports a bad output path as a rejection rather than an uncaught error', async function () {
    // A stream 'error' with no listener is an uncaught exception, which during
    // an unattended recording would take the whole process down. The open
    // failure lands asynchronously, so it surfaces from whichever call runs
    // once it has — a later write, or the close in the recorder's finally.
    const writer = new AnnexBFileWriter(missingPath());

    await assert.rejects(async () => {
      await writer.write(chunk(0x11, 40));
      await writer.close();
    }, /ENOENT/);
  });

  it('reports a bad output path from close() when no write ever ran', async function () {
    // The recorder writes nothing until the first keyframe arrives, so a
    // capture that is torn down early reaches close() having never written.
    // close() must still name the real cause, not a generic stream error.
    const writer = new AnnexBFileWriter(missingPath());

    await assert.rejects(() => writer.close(), /ENOENT/);
  });

  it('surfaces a write failure through the next call', async function () {
    const writer = new AnnexBFileWriter(join(directory, `stream-${counter++}.h265`));
    await writer.write(chunk(0x11, 40));

    // Stand in for a disk filling up mid-recording.
    (writer as unknown as {streamError: Error}).streamError = new Error('ENOSPC');

    await assert.rejects(() => writer.write(chunk(0x22, 40)), /ENOSPC/);
    await assert.rejects(() => writer.close(), /ENOSPC/);
  });
});
