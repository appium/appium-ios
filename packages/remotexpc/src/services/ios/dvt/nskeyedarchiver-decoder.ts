import {getLogger} from '../../../lib/logger.js';
import {toRefIndex, toUidIndex} from './utils.js';

const log = getLogger('NSKeyedArchiverDecoder');
const MAX_DECODE_DEPTH = 1000;

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
  private readonly objects: any[];
  private readonly decoded: Map<number, any>;
  private readonly archive: any;

  constructor(data: any) {
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
  static isNSKeyedArchive(data: any): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    return (
      '$archiver' in data && data.$archiver === 'NSKeyedArchiver' && '$objects' in data && Array.isArray(data.$objects)
    );
  }

  /**
   * Decode the entire archive starting from the root
   */
  decode(): any {
    if (!this.objects || this.objects.length === 0) {
      return null;
    }

    const rootIndex = toRefIndex(this.archive.$top?.root);
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
  private decodeObject(index: number, visited: Set<number> = new Set(), depth: number = 0): any {
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
    if (this.decoded.has(index)) {
      return this.decoded.get(index);
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

    // Handle Buffer/binary data (eg. screenshots)
    if (Buffer.isBuffer(obj)) {
      this.decoded.set(index, obj);
      visited.delete(index);
      return obj;
    }

    if (toUidIndex(obj) !== null) {
      visited.delete(index);
      return obj;
    }

    // Handle NSDictionary (NS.keys + NS.objects) - check this FIRST before NSArray
    if ('NS.keys' in obj && 'NS.objects' in obj) {
      const result = this.decodeDictionary(obj['NS.keys'], obj['NS.objects'], visited, depth);
      this.decoded.set(index, result);
      visited.delete(index);
      return result;
    }

    // Handle NSArray (NS.objects only, without NS.keys)
    if ('NS.objects' in obj) {
      const result = this.decodeArray(obj['NS.objects'], visited, depth);
      this.decoded.set(index, result);
      visited.delete(index);
      return result;
    }

    // Handle regular objects - just return as-is but resolve references
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === '$class') {
        continue; // Skip class metadata
      }

      const uid = toUidIndex(value);
      result[key] = uid === null || visited.has(uid) ? value : this.decodeObject(uid, visited, depth + 1);
    }

    this.decoded.set(index, result);
    visited.delete(index);
    return result;
  }

  /**
   * Decode the object a collection member references, or return the member unchanged when it is not a reference
   */
  private decodeRef(ref: any, visited: Set<number>, depth: number): any {
    const index = toRefIndex(ref);
    return index === null ? ref : this.decodeObject(index, visited, depth);
  }

  /**
   * Decode an NSArray
   */
  private decodeArray(refs: any, visited: Set<number> = new Set(), depth: number = 0): any[] {
    if (!Array.isArray(refs)) {
      return [];
    }

    return refs.map((ref) => this.decodeRef(ref, visited, depth + 1));
  }

  /**
   * Decode an NSDictionary
   */
  private decodeDictionary(keyRefs: any, valueRefs: any, visited: Set<number> = new Set(), depth: number = 0): any {
    if (!Array.isArray(keyRefs) || !Array.isArray(valueRefs)) {
      return {};
    }

    const result: any = {};

    for (let i = 0; i < keyRefs.length && i < valueRefs.length; i++) {
      const key = this.decodeRef(keyRefs[i], visited, depth + 1);
      const value = this.decodeRef(valueRefs[i], visited, depth + 1);

      // Object keys are strings in JS. Coerce primitive keys (e.g. the integer
      // pids used by the sysmontap `Processes` map) so they are not dropped.
      if (typeof key === 'string' || typeof key === 'number' || typeof key === 'bigint' || typeof key === 'boolean') {
        result[String(key)] = value;
      }
    }

    return result;
  }
}

/**
 * Decode NSKeyedArchiver data or return as-is if not archived
 */
export function decodeNSKeyedArchiver(data: any): any {
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
