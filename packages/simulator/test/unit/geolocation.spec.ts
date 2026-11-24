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

  it('passes only the coordinates if the altitude is not provided', async function () {
    const {calls, set} = createSim();
    assert.equal(await set(37.7749, '-122.4194'), true);
    assert.equal(await set(37.7749, -122.4194, undefined), true);
    assert.equal(await set(37.7749, -122.4194, null), true);
    assert.deepEqual(calls, [
      [UDID, 37.7749, -122.4194],
      [UDID, 37.7749, -122.4194],
      [UDID, 37.7749, -122.4194],
    ]);
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
});
