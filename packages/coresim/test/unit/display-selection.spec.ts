import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import {startJpegStream} from '../../src/commands/jpeg-stream.js';
import {getScreenshot} from '../../src/commands/screenshot.js';
import {startVideoRecording, stopVideoRecording} from '../../src/commands/video-recording.js';
import {startVideoStream} from '../../src/commands/video-stream.js';
import type {DisplayId, SimDisplayInfo} from '../../src/types.js';

const apis = ['screenshot', 'recording', 'video stream', 'JPEG stream'] as const;
type CaptureApi = (typeof apis)[number];
let nextDevice = 0;

function makeFixture(ports: SimDisplayInfo[], api: CaptureApi) {
  const screenshot = mock.fn(async (_options: unknown) => Buffer.from('png'));
  const getDisplays = mock.fn(async () => ports);
  const handle = {stop: async () => {}};
  const start = async (options: unknown) => {
    await screenshot(options);
    return handle;
  };
  const find = mock.fn(async (_udid: string) => ({
    getDisplays,
    screenshot,
    startVideoRecording: async (_file: string, options: unknown) => start(options),
    startVideoStream: start,
    startJpegStream: start,
  }));
  const sim = {_findDevice: find} as any;
  const udid = `display-test-${nextDevice++}`;
  const capture = async (displayId?: DisplayId) => {
    const options = {displayId};
    switch (api) {
      case 'screenshot':
        return await getScreenshot.call(sim, udid, options);
      case 'recording':
        await startVideoRecording.call(sim, udid, '/tmp/display-test.mp4', options);
        await stopVideoRecording.call(sim, udid);
        return;
      case 'video stream':
        await (await startVideoStream.call(sim, udid, options)).stop();
        return;
      case 'JPEG stream':
        await (await startJpegStream.call(sim, udid, options)).stop();
    }
  };
  return {capture, find, getDisplays, screenshot};
}

const ports = [
  {id: 'inner-port', screenId: 3, displayClass: 0, isMain: true},
  {id: 'outer-port', screenId: 1, displayClass: 0, isMain: true},
];

for (const api of apis) {
  describe(`${api} display IDs`, () => {
    const fixture = (ports: SimDisplayInfo[]) => makeFixture(ports, api);
    it('resolves the guest ID instead of using display class or port order', async () => {
      const {capture, screenshot} = fixture(ports);
      await capture(1);
      assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: 'outer-port'}]);
    });

    it('refreshes the mapping for every capture', async () => {
      const {capture, getDisplays, screenshot} = fixture(ports);
      await capture(3);
      getDisplays.mock.mockImplementation(async () => [{...ports[0], id: 'replacement-port'}]);
      await capture(3);
      assert.deepEqual(screenshot.mock.calls[1].arguments, [{displayId: 'replacement-port'}]);
    });

    it('passes a UUID string through without enumeration or numeric coercion', async () => {
      const {capture, getDisplays, screenshot} = fixture(ports);
      await capture('3');
      assert.equal(getDisplays.mock.callCount(), 0);
      assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: '3'}]);
    });

    for (const candidates of [
      [],
      [ports[1]],
      [{...ports[0], screenId: undefined}],
      [ports[0], {...ports[0], id: 'duplicate'}],
    ]) {
      it(`rejects missing or ambiguous IDs: ${JSON.stringify(candidates)}`, async () => {
        const {capture, screenshot} = fixture(candidates);
        await assert.rejects(capture(3), /Cannot uniquely resolve guest screen ID 3/);
        assert.equal(screenshot.mock.callCount(), 0);
      });
    }

    it('rejects an ambiguous default on Duo', async () => {
      const {capture, screenshot} = fixture(ports);
      await assert.rejects(capture(), /Multiple default display ports/);
      assert.equal(screenshot.mock.callCount(), 0);
    });

    it('includes screen ID and UUID pairs in missing-ID and ambiguous-default errors', async () => {
      const {capture, getDisplays} = fixture(ports);
      for (const displayId of [99, undefined]) {
        await assert.rejects(capture(displayId), (error: Error) => {
          assert.ok(error.message.includes('Available display IDs:'));
          assert.ok(error.message.includes('{"screenId":3,"id":"inner-port"}'));
          assert.ok(error.message.includes('{"screenId":1,"id":"outer-port"}'));
          return true;
        });
      }
      assert.equal(getDisplays.mock.callCount(), 2, 'formatting hints must not query ports again');
    });

    it('reports UUIDs when guest IDs are unavailable, preserving numeric zero', async () => {
      const {capture} = fixture([
        {...ports[0], screenId: undefined},
        {...ports[1], screenId: 0},
      ]);
      await assert.rejects(capture(99), (error: Error) => {
        assert.ok(error.message.includes('{"id":"inner-port"}'));
        assert.ok(error.message.includes('{"screenId":0,"id":"outer-port"}'));
        return true;
      });
    });

    it('reports that no display IDs are available when enumeration is empty', async () => {
      const {capture} = fixture([]);
      await assert.rejects(capture(99), /Available display IDs: none/);
    });

    it('selects a unique default port even without guest IDs', async () => {
      const {capture, screenshot} = fixture([{...ports[1], screenId: undefined}]);
      await capture();
      assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: 'outer-port'}]);
    });

    it('preserves native fallback when no port has the primary class', async () => {
      const {capture, screenshot} = fixture([{id: 'tv-port', displayClass: 1, isMain: false}]);
      await capture();
      assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: undefined}]);
    });

    for (const displayId of [-1, 1.5, NaN, Infinity, 0x100000000]) {
      it(`rejects invalid numeric ID ${displayId} before native calls`, async () => {
        const {capture, find} = fixture(ports);
        await assert.rejects(capture(displayId), RangeError);
        assert.equal(find.mock.callCount(), 0);
      });
    }

    it('can retry after display resolution fails', async () => {
      const {capture, getDisplays, screenshot} = fixture([]);
      await assert.rejects(capture(1), /Cannot uniquely resolve/);
      getDisplays.mock.mockImplementation(async () => [ports[1]]);
      await capture(1);
      assert.equal(screenshot.mock.callCount(), 1);
    });

    for (const displayId of [null, true, {}, []]) {
      it(`rejects invalid display ID type ${JSON.stringify(displayId)} before native calls`, async () => {
        const {capture, find} = fixture(ports);
        await assert.rejects(capture(displayId as any), TypeError);
        assert.equal(find.mock.callCount(), 0);
      });
    }

    it('does not treat numeric zero as an omitted ID', async () => {
      const {capture, screenshot} = fixture([{...ports[0], screenId: 0}]);
      await capture(0);
      assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: 'inner-port'}]);
    });
  });
}
