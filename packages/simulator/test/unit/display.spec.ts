import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {getDisplays} from '../../lib/extensions/display.js';

describe('simulator displays', function () {
  it('lists the displays of the device', async function () {
    const displays = [
      {id: 'main-port', displayClass: 0, isMain: true},
      {id: 'external-port', displayClass: 1, isMain: false},
    ];
    const list = sinon.stub().resolves(displays);
    const simulator = {udid: 'sim-1', _native: {getDisplays: list}} as any;
    assert.deepEqual(await getDisplays.call(simulator), displays);
    assert.ok(list.calledOnceWithExactly('sim-1'));
  });
});
