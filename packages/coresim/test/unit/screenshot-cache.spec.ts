import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import {getScreenshot} from '../../src/commands/screenshot.js';
import type {NativeSimctl} from '../../src/native-simctl.js';
import type {ScreenshotOptions, SimDisplayInfo} from '../../src/types.js';

function fixture() {
  let ports: SimDisplayInfo[] = [{id: 'port-a', screenId: 1, displayClass: 0, isMain: true}];
  const getDisplays = mock.fn(async () => ports);
  const screenshot = mock.fn(async (options?: {displayId?: string}) => {
    if (!ports.some(({id}) => id === options?.displayId)) {
      throw new Error('Port no longer exists');
    }
    return Buffer.from(options!.displayId!);
  });
  const client = {
    // Like the native addon, return a new handle wrapper for each lookup.
    _findDevice: async () => ({getDisplays, screenshot}),
  } as unknown as NativeSimctl;
  const capture = (options: ScreenshotOptions = {}, udid = 'device-a') =>
    getScreenshot.call(client, udid, {displayId: 1, cacheDisplayId: true, ...options});
  return {capture, getDisplays, screenshot, setPorts: (value: SimDisplayInfo[]) => (ports = value)};
}

describe('opt-in screenshot display cache', () => {
  it('reuses successful numeric resolution across handle wrappers and preserves capture options', async () => {
    const f = fixture();
    await f.capture();
    await f.capture({format: 'jpeg', quality: 40}, 'DEVICE-A');
    assert.equal(f.getDisplays.mock.callCount(), 1);
    assert.deepEqual(f.screenshot.mock.calls[1].arguments[0], {displayId: 'port-a', format: 'jpeg', quality: 40});
  });

  it('does not cache unless opted in', async () => {
    const f = fixture();
    await f.capture({cacheDisplayId: false});
    await f.capture({cacheDisplayId: undefined});
    assert.equal(f.getDisplays.mock.callCount(), 2);
  });

  it('keeps clients and devices isolated', async () => {
    const a = fixture();
    const b = fixture();
    await a.capture();
    await a.capture({}, 'device-b');
    await b.capture();
    assert.equal(a.getDisplays.mock.callCount(), 2);
    assert.equal(b.getDisplays.mock.callCount(), 1);
  });

  it('expires after one second without extending the TTL on hits', async (t) => {
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const f = fixture();
    await f.capture();
    now = 900;
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 1);
    now = 1000;
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 2);
  });

  it('refreshes a replaced UUID on a failed hit and retries the same numeric ID', async () => {
    const f = fixture();
    await f.capture();
    f.setPorts([{id: 'port-b', screenId: 1, displayClass: 0, isMain: true}]);
    assert.equal((await f.capture()).toString(), 'port-b');
    assert.equal(f.getDisplays.mock.callCount(), 2);
    assert.equal(f.screenshot.mock.callCount(), 3);
  });

  it('propagates refresh failure without switching to a different display', async () => {
    const f = fixture();
    await f.capture();
    f.setPorts([{id: 'other', screenId: 3, displayClass: 0, isMain: true}]);
    await assert.rejects(f.capture(), /Cannot uniquely resolve guest screen ID 1/);
    assert.equal(f.screenshot.mock.callCount(), 2);
    f.setPorts([{id: 'new', screenId: 1, displayClass: 0, isMain: true}]);
    assert.equal((await f.capture()).toString(), 'new');
  });

  it('retries a failed cached capture only once and never caches failed fresh captures', async () => {
    const f = fixture();
    await f.capture();
    f.screenshot.mock.mockImplementation(async () => {
      throw new Error('Encoder failed');
    });
    await assert.rejects(f.capture(), /Encoder failed/);
    assert.equal(f.screenshot.mock.callCount(), 3);
    await assert.rejects(f.capture(), /Encoder failed/);
    assert.equal(f.screenshot.mock.callCount(), 4);
    assert.equal(f.getDisplays.mock.callCount(), 3);
  });

  it('always resolves default selection afresh and rejects new ambiguity', async () => {
    const f = fixture();
    await f.capture({displayId: undefined});
    f.setPorts([
      {id: 'port-a', screenId: 1, displayClass: 0, isMain: true},
      {id: 'port-b', screenId: 3, displayClass: 0, isMain: true},
    ]);
    await assert.rejects(f.capture({displayId: undefined}), /Multiple default display ports/);
    assert.equal(f.getDisplays.mock.callCount(), 2);
  });

  it('passes UUIDs through without display enumeration', async () => {
    const f = fixture();
    await f.capture({displayId: 'port-a'});
    await f.capture({displayId: 'port-a'});
    assert.equal(f.getDisplays.mock.callCount(), 0);
  });

  it('refreshes when the selected numeric ID changes', async () => {
    const f = fixture();
    await f.capture();
    f.setPorts([{id: 'port-b', screenId: 0, displayClass: 0, isMain: true}]);
    assert.equal((await f.capture({displayId: 0})).toString(), 'port-b');
    assert.equal(f.getDisplays.mock.callCount(), 2);
  });

  it('bounds the number of retained device entries', async () => {
    const f = fixture();
    for (let i = 0; i < 33; i++) {
      await f.capture({}, `device-${i}`);
    }
    await f.capture({}, 'device-0');
    assert.equal(f.getDisplays.mock.callCount(), 34);
  });

  it('rejects a non-boolean cache option', async () => {
    const f = fixture();
    await assert.rejects(f.capture({cacheDisplayId: 1 as any}), /cacheDisplayId must be a boolean/);
    assert.equal(f.getDisplays.mock.callCount(), 0);
  });
});
