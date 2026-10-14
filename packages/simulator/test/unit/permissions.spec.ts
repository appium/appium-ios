import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {expandAllServicesKey, getPermission, setPermissions} from '../../lib/extensions/permissions.js';

function makeSim() {
  const calls: string[] = [];
  const sim = {
    udid: 'device-a',
    log: {
      debug() {},
      warn() {},
      errorWithException: (msg: string) => new Error(msg),
    },
    ps: async () => [],
    _native: {
      grantPermission: async (_udid: string, service: string) => void calls.push(`grant:${service}`),
      revokePermission: async (_udid: string, service: string) => void calls.push(`revoke:${service}`),
      resetPermission: async (_udid: string, service: string) => void calls.push(`reset:${service}`),
      getPermission: async () => 'granted',
    },
  } as any;
  sim.setPermissions = setPermissions;
  return {sim, calls};
}

describe('permissions', () => {
  describe('expandAllServicesKey', () => {
    it('returns the mapping untouched without the all key', () => {
      const mapping = {camera: 'yes'};
      assert.equal(expandAllServicesKey(mapping), mapping);
    });

    it('expands all into every supported service', () => {
      const result = expandAllServicesKey({all: 'yes'});
      assert.ok(!('all' in result));
      assert.equal(result.camera, 'yes');
      assert.equal(result.photos, 'yes');
      assert.equal(result.usertracking, 'yes');
      assert.ok(Object.keys(result).length > 10);
    });

    it('is case-insensitive and lets explicit services win', () => {
      const result = expandAllServicesKey({ALL: 'unset', camera: 'no', location: 'yes'});
      assert.equal(result.camera, 'no');
      assert.equal(result.contacts, 'unset');
      assert.equal(result.location, 'yes');
      assert.ok(!('ALL' in result));
    });
  });

  describe('setPermissions', () => {
    it('grants every supported service for {all: yes}', async () => {
      const {sim, calls} = makeSim();
      await sim.setPermissions('com.example', {all: 'yes'});
      assert.ok(calls.includes('grant:camera'));
      assert.ok(calls.includes('grant:siri'));
      assert.ok(calls.every((c) => c.startsWith('grant:')));
    });

    it('resets every supported service for {all: unset}', async () => {
      const {sim, calls} = makeSim();
      await sim.setPermissions('com.example', {all: 'unset'});
      assert.ok(calls.length > 10);
      assert.ok(calls.every((c) => c.startsWith('reset:')));
    });

    it('still rejects unknown services', async () => {
      const {sim} = makeSim();
      await assert.rejects(sim.setPermissions('com.example', {bogus: 'yes'}), /'bogus' is unknown/);
    });
  });

  it('maps granted status to yes', async () => {
    const {sim} = makeSim();
    assert.equal(await getPermission.call(sim, 'com.example', 'camera'), 'yes');
  });
});
