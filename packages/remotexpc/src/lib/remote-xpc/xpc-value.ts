import {util} from '@appium/support';

import type {XPCDictionary, XPCValue} from '../types.js';

/**
 * Coerces an XPC value to a dictionary, or `undefined` when it is not a plain
 * object (an array, primitive, `Buffer`, `Uint8Array`, `Date`, `null`, or
 * `undefined`).
 */
export function asDictionary(value: XPCValue | undefined): XPCDictionary | undefined {
  return util.isPlainObject(value) ? (value as XPCDictionary) : undefined;
}

/**
 * Coerces an XPC value to a string, or `undefined` when it is not one.
 */
export function asString(value: XPCValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Coerces an XPC integer or double (`number` or `bigint`) to a `number`, or
 * `undefined` when it is neither.
 */
export function asNumber(value: XPCValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  return typeof value === 'bigint' ? Number(value) : undefined;
}
