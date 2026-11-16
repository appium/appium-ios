import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {DeviceInfo} from '../../../../src/services/ios/dvt/instruments/device-info.js';

/**
 * Builds a DVT stub whose channel answers every request with the given reply.
 */
function replyingDvt(reply: unknown): any {
  const channel = {
    call: () => async () => 1,
    receiveReply: async () => reply,
  };
  return {makeChannel: async () => channel};
}

describe('DeviceInfo', function () {
  it('should keep a __proto__ trace code as an own key', async function () {
    const info = new DeviceInfo(replyingDvt('__proto__ swapped prototype\n0x1 first code'));
    const codes = await info.traceCodes();
    assert.strictEqual(Object.getPrototypeOf(codes), Object.prototype);
    assert.deepStrictEqual(Object.keys(codes), ['__proto__', '0x1']);
    assert.strictEqual(Object.getOwnPropertyDescriptor(codes, '__proto__')?.value, 'swapped prototype');
  });
});
