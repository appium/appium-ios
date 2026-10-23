import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import type {NativeSimctl} from '../../src/native-simctl.js';
import {beginDisplaySelection} from '../../src/utils/display-cache.js';

function fixture() {
  const getDisplays = mock.fn(async () => [{id: 'port-a', screenId: 1, displayClass: 0, isMain: true}]);
  const device = {getDisplays, state: () => 3, lastBootedAt: () => 1000};
  const client = {_findDevice: async () => device} as unknown as NativeSimctl;
  return {client, getDisplays};
}

describe('shared display cache', () => {
  it('shares committed selections without invoking a capture operation', async () => {
    const {client, getDisplays} = fixture();
    const first = await beginDisplaySelection(client, 'device-a', 1, true);
    const port = await first.resolveFresh();
    assert.equal(first.commit(port), true);
    const next = await beginDisplaySelection(client, 'DEVICE-A', 1, true);
    assert.equal(next.cachedPortId, 'port-a');
    assert.equal(getDisplays.mock.callCount(), 1);
  });

  it('does not publish a selection before the caller commits success', async () => {
    const {client} = fixture();
    const first = await beginDisplaySelection(client, 'device-a', 1, true);
    await first.resolveFresh();
    const next = await beginDisplaySelection(client, 'device-a', 1, true);
    assert.equal(next.cachedPortId, undefined);
  });

  it('does not let an older operation replace a newer committed selection', async () => {
    const {client, getDisplays} = fixture();
    const first = await beginDisplaySelection(client, 'device-a', 1, true);
    const oldPort = await first.resolveFresh();
    getDisplays.mock.mockImplementation(async () => [{id: 'port-b', screenId: 1, displayClass: 0, isMain: true}]);
    const next = await beginDisplaySelection(client, 'device-a', 1, true);
    next.commit(await next.resolveFresh());
    assert.equal(first.commit(oldPort), true);
    assert.equal((await beginDisplaySelection(client, 'device-a', 1, true)).cachedPortId, 'port-b');
  });
});
