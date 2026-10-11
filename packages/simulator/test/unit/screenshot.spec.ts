import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {getScreenshot} from '../../lib/extensions/screenshot.js';

describe('simulator display capture', function () {
  for (const displayId of ['inner-port', 3]) {
    it(`passes display ID ${displayId} unchanged to CoreSim`, async function () {
      const data = Buffer.from('screenshot');
      const capture = sinon.stub().resolves(data);
      const simulator = {udid: 'sim-1', _native: {getScreenshot: capture}} as any;
      assert.equal(await getScreenshot.call(simulator, {displayId}), data);
      sinon.assert.calledOnceWithExactly(capture, 'sim-1', {displayId});
    });
  }

  it('propagates CoreSim capture failures', async function () {
    const error = new Error('Cannot uniquely resolve guest screen ID 3');
    const simulator = {udid: 'sim-1', _native: {getScreenshot: sinon.stub().rejects(error)}} as any;
    await assert.rejects(getScreenshot.call(simulator, {displayId: 3}), (actual) => actual === error);
  });
});
