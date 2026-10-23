import {PlistUID} from '../../../lib/plist/plist-uid.js';
import type {PlistDictionary} from '../../../lib/types.js';

/**
 * Check whether a value is a non-null plain object.
 */
export function isPlainObject(value: any): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check whether an object contains all requested property keys.
 */
export function hasProperties(obj: any, ...props: string[]): boolean {
  return isPlainObject(obj) ? props.every((prop) => prop in obj) : false;
}

/**
 * Return the `$objects` index a UID points at, or null when the value is not a UID.
 * Binary plists yield `PlistUID`, XML plists yield `{CF$UID: n}`.
 */
export function toUidIndex(value: any): number | null {
  if (value instanceof PlistUID) {
    return value.value;
  }
  return isPlainObject(value) && typeof value.CF$UID === 'number' ? value.CF$UID : null;
}

/**
 * Return the `$objects` index of a value in a slot that only ever holds
 * references, such as `NS.objects` members or `$top.root`, so a plain index is accepted too.
 */
export function toRefIndex(value: any): number | null {
  return typeof value === 'number' ? value : toUidIndex(value);
}

/**
 * Check whether data appears to be NSKeyedArchiver payload format.
 */
export function isNSKeyedArchiverFormat(data: any): boolean {
  return hasProperties(data, '$objects') && Array.isArray(data.$objects) && data.$objects.length > 0;
}

/**
 * Check whether an object matches NSDictionary-style archive keys.
 */
export function isNSDictionaryFormat(obj: any): boolean {
  return hasProperties(obj, 'NS.keys', 'NS.objects');
}

/**
 * Check whether an object carries NSError-like marker properties.
 */
export function hasNSErrorIndicators(obj: any): boolean {
  if (!isPlainObject(obj)) {
    return false;
  }

  const errorProps = ['NSCode', 'NSUserInfo', 'NSDomain'];
  return errorProps.some((prop) => prop in obj);
}

/**
 * Extract $objects array from NSKeyedArchiver format, returns null if invalid
 */
export function extractNSKeyedArchiverObjects(data: any): any[] | null {
  if (!isNSKeyedArchiverFormat(data)) {
    return null;
  }

  const objects = data.$objects;
  return objects.length > 1 ? objects : null;
}

/**
 * Extract NSDictionary from NSKeyedArchiver objects using key/value references
 */
export function extractNSDictionary(dictObj: any, objects: any[]): PlistDictionary {
  if (!isNSDictionaryFormat(dictObj)) {
    return {};
  }

  const keysRef = dictObj['NS.keys'];
  const valuesRef = dictObj['NS.objects'];

  if (!Array.isArray(keysRef) || !Array.isArray(valuesRef)) {
    return {};
  }

  const result: PlistDictionary = {};
  for (let i = 0; i < keysRef.length; i++) {
    const keyIndex = toRefIndex(keysRef[i]);
    const valueIndex = toRefIndex(valuesRef[i]);
    if (keyIndex === null || valueIndex === null) {
      continue;
    }
    const key = objects[keyIndex];
    if (typeof key === 'string') {
      result[key] = objects[valueIndex];
    }
  }

  return result;
}

/**
 * Extract strings from NSKeyedArchiver objects array as dictionary keys
 */
export function extractCapabilityStrings(objects: any[]): PlistDictionary {
  const result: PlistDictionary = {};

  // Start from index 1 because index 0 is always '$null' in NSKeyedArchiver format
  for (let i = 1; i < objects.length; i++) {
    const obj = objects[i];
    if (typeof obj === 'string' && obj !== '$null') {
      result[obj] = true;
    }
  }

  return result;
}
