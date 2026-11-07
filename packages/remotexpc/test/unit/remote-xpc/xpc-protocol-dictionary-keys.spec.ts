import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {decodeMessage, encodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary} from '../../../src/lib/types.js';

/**
 * Builds a dictionary whose only entry is an own `__proto__` key, the way a peer could send it.
 */
function withOwnProtoKey(value: XPCDictionary): XPCDictionary {
  const dict: XPCDictionary = {};
  Object.defineProperty(dict, '__proto__', {value, enumerable: true, writable: true, configurable: true});
  return dict;
}

describe('xpc-protocol dictionary keys', function () {
  it('should decode a __proto__ key as an own property instead of changing the prototype', function () {
    const decoded = decodeMessage(encodeMessage({flags: 1, id: 1n, body: withOwnProtoKey({x: true})}));
    const body = decoded.message.body as XPCDictionary;
    assert.strictEqual(Object.getPrototypeOf(body), Object.prototype);
    assert.deepStrictEqual(Object.keys(body), ['__proto__']);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(body, '__proto__')?.value, {x: true});
    assert.strictEqual((body as Record<string, unknown>).x, undefined);
  });
});
