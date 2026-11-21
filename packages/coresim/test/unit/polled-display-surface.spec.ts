import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {describe, it} from 'node:test';

import {getPkgRoot} from '../../src/utils/index.js';

type Lookup = {status: 'surface'; token: number} | {status: 'noSurface'} | {status: 'unavailable'; message: string};

interface PolledDisplaySurfaceHandle {
  refreshIntervalSeconds: number;
  current(): Lookup;
  reset(): void;
}

/** The addon's internal test hook (see coresim.mm); deliberately not in the package's own types. */
interface TestingAddon {
  _createPolledDisplaySurfaceForTesting(lookup: () => Lookup, clock: () => number): PolledDisplaySurfaceHandle;
}

// CoreSimulator, and so the addon, only exists on macOS.
const addon: TestingAddon | undefined =
  process.platform === 'darwin' ? createRequire(import.meta.url)('node-gyp-build')(getPkgRoot()) : undefined;

/**
 * A PolledDisplaySurface (the native class both stream pollers read the display through) on a fake
 * clock and a scripted lookup. Each lookup that finds a surface hands out a new token, so a test
 * can tell a kept surface from a freshly looked up one.
 */
function fixture() {
  const state = {now: 100, lookups: 0, next: 'surface' as Lookup['status'] | 'throw'};
  const polled = addon!._createPolledDisplaySurfaceForTesting(
    () => {
      state.lookups++;
      switch (state.next) {
        case 'surface':
          return {status: 'surface', token: state.lookups};
        case 'noSurface':
          return {status: 'noSurface'};
        case 'unavailable':
          return {status: 'unavailable', message: `lookup ${state.lookups} failed`};
        default:
          throw new Error('lookup threw');
      }
    },
    () => state.now,
  );
  return {state, polled, interval: polled.refreshIntervalSeconds};
}

describe('PolledDisplaySurface', {skip: addon ? false : 'the native addon only loads on macOS'}, () => {
  it('looks the surface up at most once per refresh interval', () => {
    const {state, polled, interval} = fixture();
    assert.equal(interval, 1);

    assert.deepEqual(polled.current(), {status: 'surface', token: 1});
    // Every later poll inside the interval gets the kept surface, like the ticks after Start().
    for (const elapsed of [0, 0.016, 0.5, 0.999]) {
      state.now = 100 + elapsed;
      assert.deepEqual(polled.current(), {status: 'surface', token: 1});
    }
    assert.equal(state.lookups, 1);

    state.now = 100 + interval;
    assert.deepEqual(polled.current(), {status: 'surface', token: 2});
    // The interval counts from the last lookup, not from the first one.
    state.now = 100 + interval + 0.999;
    assert.deepEqual(polled.current(), {status: 'surface', token: 2});
    assert.equal(state.lookups, 2);
  });

  it('looks up again on the very next poll after finding no surface', () => {
    const {state, polled} = fixture();
    state.next = 'noSurface';
    assert.deepEqual(polled.current(), {status: 'noSurface'});
    assert.deepEqual(polled.current(), {status: 'noSurface'});
    assert.equal(state.lookups, 2);

    state.next = 'surface';
    assert.deepEqual(polled.current(), {status: 'surface', token: 3});
    assert.deepEqual(polled.current(), {status: 'surface', token: 3});
    assert.equal(state.lookups, 3);
  });

  it('drops the kept surface when a refresh finds none', () => {
    const {state, polled, interval} = fixture();
    assert.deepEqual(polled.current(), {status: 'surface', token: 1});

    state.now += interval;
    state.next = 'noSurface';
    assert.deepEqual(polled.current(), {status: 'noSurface'});
    // Not the old surface again, even though no time has passed since that refresh.
    assert.deepEqual(polled.current(), {status: 'noSurface'});
    assert.equal(state.lookups, 3);
  });

  it('passes an unavailable display through with its error and keeps nothing', () => {
    const {state, polled, interval} = fixture();
    assert.deepEqual(polled.current(), {status: 'surface', token: 1});

    // Still inside the interval, so the display going away is not seen yet.
    state.next = 'unavailable';
    state.now += interval / 2;
    assert.deepEqual(polled.current(), {status: 'surface', token: 1});

    state.now += interval / 2;
    assert.deepEqual(polled.current(), {status: 'unavailable', message: 'lookup 2 failed'});
    // The failure is not kept either: the next poll asks again.
    assert.deepEqual(polled.current(), {status: 'unavailable', message: 'lookup 3 failed'});
    state.next = 'surface';
    assert.deepEqual(polled.current(), {status: 'surface', token: 4});
  });

  it('keeps no surface when a lookup throws', () => {
    const {state, polled, interval} = fixture();
    assert.deepEqual(polled.current(), {status: 'surface', token: 1});

    state.now += interval;
    state.next = 'throw';
    assert.throws(() => polled.current(), /lookup threw/);
    state.next = 'surface';
    assert.deepEqual(polled.current(), {status: 'surface', token: 3});
  });

  it('looks up again right after reset()', () => {
    const {state, polled} = fixture();
    assert.deepEqual(polled.current(), {status: 'surface', token: 1});
    polled.reset();
    assert.deepEqual(polled.current(), {status: 'surface', token: 2});
    assert.deepEqual(polled.current(), {status: 'surface', token: 2});
    assert.equal(state.lookups, 2);

    // reset() with nothing kept is harmless.
    polled.reset();
    polled.reset();
    assert.deepEqual(polled.current(), {status: 'surface', token: 3});
  });
});
