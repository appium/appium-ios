import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {launchApp} from '../../lib/extensions/applications.js';

describe('launchApp', function () {
  for (const activateSuspended of [undefined, false, true]) {
    it(`only backgrounds the application when requested (${activateSuspended})`, async function () {
      const nativeLaunch = sinon.stub().resolves(123);
      const simulator = {udid: 'sim-1', _native: {launchApp: nativeLaunch}} as any;
      await launchApp.call(simulator, 'io.appium.wda.xctrunner', {
        environment: {USE_PORT: '8100'},
        terminateExisting: true,
        ...(activateSuspended === undefined ? {} : {activateSuspended}),
      });
      sinon.assert.calledOnceWithExactly(nativeLaunch, 'sim-1', 'io.appium.wda.xctrunner', {
        environment: {USE_PORT: '8100'},
        terminate_running_process: true,
        ...(activateSuspended ? {activate_suspended: true} : {}),
      });
    });
  }

  it('preserves native launch failures for background launches', async function () {
    const error = new Error('Cannot launch application');
    const simulator = {udid: 'sim-1', _native: {launchApp: sinon.stub().rejects(error)}} as any;
    await assert.rejects(
      launchApp.call(simulator, 'io.appium.wda.xctrunner', {activateSuspended: true}),
      (actual) => actual === error,
    );
  });
});
