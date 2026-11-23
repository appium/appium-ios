import {setDictionaryEntry} from '../../../lib/dictionary.js';
import {getLogger} from '../../../lib/logger.js';
import type {PlistArray, PlistDictionary, PlistValue} from '../../../lib/types.js';
import {isPlainObject, toRefIndex, toUidIndex} from './utils.js';

const log = getLogger('NSKeyedArchiverDecoder');
const MAX_DECODE_DEPTH = 1000;

/** The top level of an NSKeyedArchiver plist. */
interface NSKeyedArchive extends PlistDictionary {
  $archiver: 'NSKeyedArchiver';
  $objects: PlistValue[];
}

/**
 * Decode NSKeyedArchiver formatted data into native JavaScript objects
 *
 * NSKeyedArchiver is Apple's serialization format that stores object graphs
 * with references. The format includes:
 * - $version: Archive version (typically 100000)
 * - $archiver: "NSKeyedArchiver"
 * - $top: Root object references
 * - $objects: Array of all objects with cross-references
 */
export class NSKeyedArchiverDecoder {
  private readonly objects: PlistValue[];
  private readonly decoded: Map<number, PlistValue>;
  private readonly archive: NSKeyedArchive;

  constructor(data: unknown) {
    if (!NSKeyedArchiverDecoder.isNSKeyedArchive(data)) {
      throw new Error('Data is not in NSKeyedArchiver format');
    }

    this.archive = data;
    this.objects = data.$objects || [];
    this.decoded = new Map();
  }

  /**
   * Check if data is in NSKeyedArchiver format
   */
  static isNSKeyedArchive(data: unknown): data is NSKeyedArchive {
    return isPlainObject(data) && data.$archiver === 'NSKeyedArchiver' && Array.isArray(data.$objects);
  }

  /**
   * Decode the entire archive starting from the root
   */
  decode(): PlistValue {
    if (!this.objects || this.objects.length === 0) {
      return null;
    }

    const top = this.archive.$top;
    const rootIndex = isPlainObject(top) ? toRefIndex(top.root) : null;
    if (rootIndex !== null) {
      return this.decodeObject(rootIndex);
    }

    // Fallback: decode first non-null object
    log.warn('Could not find root reference, using fallback');
    return this.decodeObject(1);
  }

  /**
   * Decode an object at a specific index
   */
  private decodeObject(index: number, visited: Set<number> = new Set(), depth: number = 0): PlistValue {
    // Prevent stack overflow with depth limit
    if (depth > MAX_DECODE_DEPTH) {
      log.warn(`Maximum decode depth exceeded at index ${index}`);
      return null;
    }
    if (index < 0 || index >= this.objects.length) {
      return null;
    }

    // Prevent infinite recursion
    if (visited.has(index)) {
      return null; // Return null for circular references
    }

    // Check cache
    const cached = this.decoded.get(index);
    if (cached !== undefined) {
      return cached;
    }

    visited.add(index);
    const obj = this.objects[index];

    // Handle null marker
    if (obj === '$null' || obj === null) {
      visited.delete(index);
      return null;
    }

    // Handle primitive types
    if (typeof obj !== 'object') {
      visited.delete(index);
      return obj;
    }

    // Handle Buffer/binary data (eg. screenshots) and dates, which hold no references
    if (Buffer.isBuffer(obj) || obj instanceof Date) {
      this.decoded.set(index, obj);
      visited.delete(index);
      return obj;
    }

    if (toUidIndex(obj) !== null) {
      visited.delete(index);
      return obj;
    }

    // What is left is keyed (an archived object, or rarely a raw array) and may hold UID references
    const record = obj as Record<string, PlistValue>;

    // Handle NSDictionary (NS.keys + NS.objects) - check this FIRST before NSArray
    if ('NS.keys' in record && 'NS.objects' in record) {
      const result = this.decodeDictionary(record['NS.keys'], record['NS.objects'], visited, depth);
      this.decoded.set(index, result);
      visited.delete(index);
      return result;
    }

    // Handle NSArray (NS.objects only, without NS.keys)
    if ('NS.objects' in record) {
      const result = this.decodeArray(record['NS.objects'], visited, depth);
      this.decoded.set(index, result);
      visited.delete(index);
      return result;
    }

    // Handle regular objects - just return as-is but resolve references
    const result: PlistDictionary = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === '$class') {
        continue; // Skip class metadata
      }

      const uid = toUidIndex(value);
      setDictionaryEntry(
        result,
        key,
        uid === null || visited.has(uid) ? value : this.decodeObject(uid, visited, depth + 1),
      );
    }

    this.decoded.set(index, result);
    visited.delete(index);
    return result;
  }

  /**
   * Decode the object a collection member references, or return the member unchanged when it is not a reference
   */
  private decodeRef(ref: PlistValue, visited: Set<number>, depth: number): PlistValue {
    const index = toRefIndex(ref);
    return index === null ? ref : this.decodeObject(index, visited, depth);
  }

  /**
   * Decode an NSArray
   */
  private decodeArray(refs: PlistValue, visited: Set<number> = new Set(), depth: number = 0): PlistArray {
    if (!Array.isArray(refs)) {
      return [];
    }

    return refs.map((ref) => this.decodeRef(ref, visited, depth + 1));
  }

  /**
   * Decode an NSDictionary
   */
  private decodeDictionary(
    keyRefs: PlistValue,
    valueRefs: PlistValue,
    visited: Set<number> = new Set(),
    depth: number = 0,
  ): PlistDictionary {
    if (!Array.isArray(keyRefs) || !Array.isArray(valueRefs)) {
      return {};
    }

    const result: PlistDictionary = {};

    for (let i = 0; i < keyRefs.length && i < valueRefs.length; i++) {
      const key = this.decodeRef(keyRefs[i], visited, depth + 1);
      const value = this.decodeRef(valueRefs[i], visited, depth + 1);

      // Object keys are strings in JS. Coerce primitive keys (e.g. the integer
      // pids used by the sysmontap `Processes` map) so they are not dropped.
      if (typeof key === 'string' || typeof key === 'number' || typeof key === 'bigint' || typeof key === 'boolean') {
        setDictionaryEntry(result, String(key), value);
      }
    }

    return result;
  }
}

/**
 * Decode NSKeyedArchiver data or return as-is if not archived
 */
export function decodeNSKeyedArchiver(data: unknown): any {
  if (!data) {
    return data;
  }

  // Check if this is NSKeyedArchiver format
  if (!NSKeyedArchiverDecoder.isNSKeyedArchive(data)) {
    return data;
  }

  try {
    const decoder = new NSKeyedArchiverDecoder(data);
    return decoder.decode();
  } catch (error) {
    log.warn('Failed to decode NSKeyedArchiver data:', error);
    return data;
  }
}
