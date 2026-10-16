import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {SimulatorXcode15} from '../../lib/simulator-xcode-15.js';
import {SimulatorXcode27} from '../../lib/simulator-xcode-27.js';

const xcodeVersion = (major: number) => ({versionString: `${major}.0`, versionFloat: major, major, minor: 0});

describe('bulletinBoardVersions', function () {
  it('is the v2 store format for Xcode 15+', function () {
    const sim = new SimulatorXcode15('1234', xcodeVersion(16));

    assert.deepEqual(sim.bulletinBoardVersions, [2]);
  });

  it('adds the v3 store format for Xcode 27', function () {
    const sim = new SimulatorXcode27('1234', xcodeVersion(27));

    assert.deepEqual(sim.bulletinBoardVersions, [2, 3]);
  });
});
