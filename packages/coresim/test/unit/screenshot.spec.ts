import assert from 'node:assert/strict';
import {describe, it, mock} from 'node:test';

import {getScreenshot} from '../../src/commands/screenshot.js';
import type {SimDisplayInfo} from '../../src/types.js';

function fixture(ports: SimDisplayInfo[]) {
  const screenshot = mock.fn(async (_options: unknown) => Buffer.from('png'));
  const getDisplays = mock.fn(async () => ports);
  const find = mock.fn(async (_udid: string) => ({getDisplays, screenshot}));
  const capture = (displayId?: string | number) => getScreenshot.call({_findDevice: find} as any, 'sim-1', {displayId});
  return {capture, find, getDisplays, screenshot};
}

const ports = [
  {id: 'inner-port', screenId: 3, displayClass: 0, isMain: true},
  {id: 'outer-port', screenId: 1, displayClass: 0, isMain: true},
];

describe('numeric screenshot display IDs', () => {
  it('resolves the guest ID instead of using display class or port order', async () => {
    const {capture, screenshot} = fixture(ports);
    await capture(1);
    assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: 'outer-port'}]);
  });

  it('refreshes the mapping for every capture', async () => {
    const {capture, getDisplays, screenshot} = fixture(ports);
    await capture(3);
    getDisplays.mock.mockImplementation(async () => [{...ports[0], id: 'replacement-port'}]);
    await capture(3);
    assert.deepEqual(screenshot.mock.calls[1].arguments, [{displayId: 'replacement-port'}]);
  });

  it('passes a UUID string through without enumeration or numeric coercion', async () => {
    const {capture, getDisplays, screenshot} = fixture(ports);
    await capture('3');
    assert.equal(getDisplays.mock.callCount(), 0);
    assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: '3'}]);
  });

  for (const candidates of [
    [],
    [ports[1]],
    [{...ports[0], screenId: undefined}],
    [ports[0], {...ports[0], id: 'duplicate'}],
  ]) {
    it(`rejects missing or ambiguous IDs: ${JSON.stringify(candidates)}`, async () => {
      const {capture, screenshot} = fixture(candidates);
      await assert.rejects(capture(3), /Cannot uniquely resolve guest screen ID 3/);
      assert.equal(screenshot.mock.callCount(), 0);
    });
  }

  it('rejects an ambiguous default on Duo', async () => {
    const {capture, screenshot} = fixture(ports);
    await assert.rejects(capture(), /Multiple default display ports/);
    assert.equal(screenshot.mock.callCount(), 0);
  });

  it('selects a unique default port even without guest IDs', async () => {
    const {capture, screenshot} = fixture([{...ports[1], screenId: undefined}]);
    await capture();
    assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: 'outer-port'}]);
  });

  it('preserves native fallback when no port has the primary class', async () => {
    const {capture, screenshot} = fixture([{id: 'tv-port', displayClass: 1, isMain: false}]);
    await capture();
    assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: undefined}]);
  });

  for (const displayId of [-1, 1.5, NaN, Infinity, 0x100000000]) {
    it(`rejects invalid numeric ID ${displayId} before native calls`, async () => {
      const {capture, find} = fixture(ports);
      await assert.rejects(capture(displayId), RangeError);
      assert.equal(find.mock.callCount(), 0);
    });
  }

  it('does not treat numeric zero as an omitted ID', async () => {
    const {capture, screenshot} = fixture([{...ports[0], screenId: 0}]);
    await capture(0);
    assert.deepEqual(screenshot.mock.calls[0].arguments, [{displayId: 'inner-port'}]);
  });
});
