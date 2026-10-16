import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {NativeSimctl} from '../../src/index.js';

describe('NativeSimctl constructor', () => {
  it('takes the options as a single object', () => {
    const options = {developerDir: '/Xcode', deviceSetPath: '/set', bulletinBoardVersions: [2, 3]};

    assert.deepEqual(new NativeSimctl(options)._options, options);
  });

  it('copies the options object', () => {
    const options = {deviceSetPath: '/set'};
    const sim = new NativeSimctl(options);
    options.deviceSetPath = '/changed';

    assert.equal(sim._options.deviceSetPath, '/set');
  });

  it('still takes the developer dir and the device set path as separate arguments', () => {
    assert.deepEqual(new NativeSimctl('/Xcode', '/set')._options, {developerDir: '/Xcode', deviceSetPath: '/set'});
    assert.deepEqual(new NativeSimctl(undefined, '/set')._options, {developerDir: undefined, deviceSetPath: '/set'});
  });

  it('takes no arguments', () => {
    assert.deepEqual({...new NativeSimctl()._options}, {developerDir: undefined, deviceSetPath: undefined});
  });
});
