import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {setGeolocation} from '../../lib/extensions/geolocation.js';

describe('geolocation', function () {
  const UDID = 'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB';

  function createSim() {
    const calls: unknown[][] = [];
    const sim = {
      udid: UDID,
      _native: {
        setLocation: async (...args: unknown[]) => {
          calls.push(args);
        },
      },
    };
    return {calls, set: (...args: any[]) => (setGeolocation as any).apply(sim, args) as Promise<boolean>};
  }

  it('passes no altitude if it is not provided or blank', async function () {
    const {calls, set} = createSim();
    assert.equal(await set(37.7749, '-122.4194'), true);
    assert.equal(await set(37.7749, -122.4194, undefined), true);
    assert.equal(await set(37.7749, -122.4194, null), true);
    assert.equal(await set(37.7749, -122.4194, ''), true);
    assert.equal(await set(37.7749, -122.4194, '  '), true);
    assert.deepEqual(calls, Array(5).fill([UDID, 37.7749, -122.4194, undefined]));
  });

  it('passes the altitude as a number if it is provided', async function () {
    const {calls, set} = createSim();
    assert.equal(await set(46.5584, 8.561, 2106.5), true);
    assert.equal(await set('46.5584', '8.561', '-12.5'), true);
    assert.equal(await set(46.5584, 8.561, 0), true);
    assert.deepEqual(calls, [
      [UDID, 46.5584, 8.561, 2106.5],
      [UDID, 46.5584, 8.561, -12.5],
      [UDID, 46.5584, 8.561, 0],
    ]);
  });

  it('rejects values that are not finite numbers', async function () {
    const {calls, set} = createSim();
    await assert.rejects(set('abc', 8.561), /latitude must be a finite number, got 'abc'/);
    await assert.rejects(set('', 8.561), /latitude must be a finite number/);
    await assert.rejects(set(46.5584, Number.POSITIVE_INFINITY), /longitude must be a finite number/);
    await assert.rejects(set(46.5584, 8.561, 'high'), /altitude must be a finite number, got 'high'/);
    await assert.rejects(set(46.5584, 8.561, Number.NaN), /altitude must be a finite number/);
    assert.deepEqual(calls, []);
  });
});
