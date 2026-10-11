import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {getDisplays, getScreenshot} from '../../lib/extensions/screenshot.js';

describe('simulator display capture', function () {
  it('preserves guest screen IDs and port UUIDs when enumerating', async function () {
    const displays = [
      {id: 'inner-port', screenId: 3, displayClass: 0, isMain: true},
      {id: 'outer-port', screenId: 1, displayClass: 0, isMain: true},
    ];
    const enumerate = sinon.stub().resolves(displays);
    const simulator = {udid: 'sim-1', _native: {getDisplays: enumerate}} as any;
    assert.deepEqual(await getDisplays.call(simulator), displays);
    sinon.assert.calledOnceWithExactly(enumerate, 'sim-1');
  });

  it('passes the chosen port UUID unchanged to native capture', async function () {
    const data = Buffer.from('screenshot');
    const capture = sinon.stub().resolves(data);
    const simulator = {udid: 'sim-1', _native: {getScreenshot: capture}} as any;
    assert.equal(await getScreenshot.call(simulator, {displayId: 'inner-port'}), data);
    sinon.assert.calledOnceWithExactly(capture, 'sim-1', {displayId: 'inner-port'});
  });

  it('propagates enumeration failures', async function () {
    const error = new Error('No IO client');
    const simulator = {udid: 'sim-1', _native: {getDisplays: sinon.stub().rejects(error)}} as any;
    await assert.rejects(getDisplays.call(simulator), (actual) => actual === error);
  });
});
