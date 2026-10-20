import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import {getScreenshot} from '../../src/commands/screenshot.js';
import type {NativeSimctl} from '../../src/native-simctl.js';
import type {ScreenshotOptions, SimDisplayInfo} from '../../src/types.js';

function fixture() {
  let ports: SimDisplayInfo[] = [{id: 'port-a', screenId: 1, displayClass: 0, isMain: true}];
  const state = mock.fn(() => 3);
  const lastBootedAt = mock.fn((): number | null => 1000);
  const getDisplays = mock.fn(async () => ports);
  const screenshot = mock.fn(async (options?: {displayId?: string}) => {
    if (!ports.some(({id}) => id === options?.displayId)) {
      throw new Error('Port no longer exists');
    }
    return Buffer.from(options!.displayId!);
  });
  const client = {
    // Like the native addon, return a new handle wrapper for each lookup.
    _findDevice: async () => ({getDisplays, screenshot, state, lastBootedAt}),
  } as unknown as NativeSimctl;
  const capture = (options: ScreenshotOptions = {}, udid = 'device-a') =>
    getScreenshot.call(client, udid, {displayId: 1, cacheDisplayId: true, ...options});
  return {
    capture,
    getDisplays,
    screenshot,
    state,
    lastBootedAt,
    setPorts: (value: SimDisplayInfo[]) => (ports = value),
  };
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

  it('retains a mapping beyond the old TTL while the boot marker is unchanged', async (t) => {
    const now = t.mock.method(performance, 'now', () => 0);
    const f = fixture();
    await f.capture();
    now.mock.mockImplementation(() => 86400000);
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 1);
  });

  it('refreshes before capture when the boot marker changes, even if the old UUID remains usable', async () => {
    const f = fixture();
    await f.capture();
    f.lastBootedAt.mock.mockImplementation(() => 2000);
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 2);
    assert.equal(f.screenshot.mock.callCount(), 2);
  });

  for (const marker of [null, NaN, Infinity, 0]) {
    it(`disables caching for unavailable/invalid boot marker ${marker}`, async () => {
      const f = fixture();
      f.lastBootedAt.mock.mockImplementation(() => marker);
      await f.capture();
      await f.capture();
      assert.equal(f.getDisplays.mock.callCount(), 2);
    });
  }

  it('discards an existing cache when boot metadata becomes unreadable', async () => {
    const f = fixture();
    await f.capture();
    f.lastBootedAt.mock.mockImplementation(() => {
      throw new Error('Unsupported selector');
    });
    await f.capture();
    f.lastBootedAt.mock.mockImplementation(() => 1000);
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 3);
  });

  it('discards an existing cache when the device is not Booted', async () => {
    const f = fixture();
    await f.capture();
    f.state.mock.mockImplementation(() => 1);
    await f.capture();
    f.state.mock.mockImplementation(() => 3);
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 3);
  });

  for (const phase of ['resolution', 'capture']) {
    it(`does not cache a fresh capture spanning a boot change during ${phase}`, async () => {
      const f = fixture();
      if (phase === 'resolution') {
        f.getDisplays.mock.mockImplementation(async () => {
          f.lastBootedAt.mock.mockImplementation(() => 2000);
          return [{id: 'port-a', screenId: 1, displayClass: 0, isMain: true}];
        });
      } else {
        f.screenshot.mock.mockImplementation(async () => {
          f.lastBootedAt.mock.mockImplementation(() => 2000);
          return Buffer.from('port-a');
        });
      }
      await f.capture();
      await f.capture();
      assert.equal(f.getDisplays.mock.callCount(), 2);
    });
  }

  it('re-resolves after a successful cached capture if its boot marker changed in flight', async () => {
    const f = fixture();
    await f.capture();
    f.screenshot.mock.mockImplementation(async () => {
      f.lastBootedAt.mock.mockImplementation(() => 2000);
      return Buffer.from('port-a');
    });
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 2);
    assert.equal(f.screenshot.mock.callCount(), 3);
  });

  it('explicitly disables and clears an existing cached selection', async () => {
    const f = fixture();
    await f.capture();
    await f.capture({cacheDisplayId: false});
    await f.capture();
    assert.equal(f.getDisplays.mock.callCount(), 3);
  });

  for (const cachedHit of [false, true]) {
    it(`does not restore an invalidated mapping after an in-flight ${cachedHit ? 'cached' : 'fresh'} capture`, async () => {
      const f = fixture();
      if (cachedHit) {
        await f.capture();
      }
      let signalStarted!: () => void;
      const started = new Promise<void>((resolve) => (signalStarted = resolve));
      let finishCapture!: (value: Buffer<ArrayBuffer>) => void;
      const finish = new Promise<Buffer<ArrayBuffer>>((resolve) => (finishCapture = resolve));
      f.screenshot.mock.mockImplementationOnce(async () => {
        signalStarted();
        return await finish;
      });
      const pending = f.capture();
      await started;
      f.setPorts([{id: 'port-b', screenId: 1, displayClass: 0, isMain: true}]);
      assert.equal((await f.capture({cacheDisplayId: false}, 'DEVICE-A')).toString(), 'port-b');
      finishCapture(Buffer.from('port-a'));
      await pending;
      // Keep the old port usable: an incorrect cache hit must not be rescued by a failure.
      f.screenshot.mock.mockImplementation(async (options) => Buffer.from(options!.displayId!));
      assert.equal((await f.capture()).toString(), 'port-b');
      assert.equal(f.getDisplays.mock.callCount(), 3);
    });
  }

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

  it('evicts the least recently used device while retaining a recently captured device', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) {
      await f.capture({}, `device-${i}`);
    }
    await f.capture({}, 'device-0');
    assert.equal(f.getDisplays.mock.callCount(), 32);

    await f.capture({}, 'device-32');
    await f.capture({}, 'device-0');
    assert.equal(f.getDisplays.mock.callCount(), 33);

    await f.capture({}, 'device-1');
    assert.equal(f.getDisplays.mock.callCount(), 34);
  });

  it('rejects a non-boolean cache option', async () => {
    const f = fixture();
    await assert.rejects(f.capture({cacheDisplayId: 1 as any}), /cacheDisplayId must be a boolean/);
    assert.equal(f.getDisplays.mock.callCount(), 0);
  });
});
