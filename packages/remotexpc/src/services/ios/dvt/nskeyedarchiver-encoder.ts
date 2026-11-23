import {getLogger} from '../../../lib/logger.js';
import {PlistUID} from '../../../lib/plist/index.js';
import type {PlistValue} from '../../../lib/types.js';

const log = getLogger('NSKeyedArchiverEncoder');

/**
 * Encodes JavaScript objects into NSKeyedArchiver format
 * capable of satisfying NSSecureCoding requirements.
 */
export class NSKeyedArchiverEncoder {
  protected objects: PlistValue[] = ['$null'];
  protected objectCache = new Map<object, number>(); // Cache for object identity/deduplication
  protected classes = new Map<string, number>(); // Cache for class definitions

  /**
   * Encode the root value into NSKeyedArchiver format
   */
  encode(rootValue: unknown): any {
    const rootIndex = this.archiveObject(rootValue);

    return {
      $version: 100000,
      $archiver: 'NSKeyedArchiver',
      $top: {root: new PlistUID(rootIndex)},
      $objects: this.objects,
    };
  }

  protected archiveObject(value: unknown): number {
    if (value === null || value === undefined) {
      return 0; // $null is always at index 0
    }

    // Primitives (no caching - Maps can't deduplicate primitives by value)
    if (typeof value === 'boolean') {
      const index = this.objects.length;
      this.objects.push(value);
      return index;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
      const index = this.objects.length;
      this.objects.push(value);
      return index;
    }

    if (typeof value === 'string') {
      const index = this.objects.length;
      this.objects.push(value);
      return index;
    }

    // Complex types: check cache for circular references and deduplication
    const cachedObject = this.objectCache.get(value);
    if (cachedObject !== undefined) {
      return cachedObject;
    }

    let index: number;

    if (Buffer.isBuffer(value)) {
      index = this.archiveBuffer(value);
    } else if (value instanceof Set) {
      index = this.archiveSet(value);
    } else if (Array.isArray(value)) {
      index = this.archiveArray(value);
    } else if (typeof value === 'object') {
      // Treat generic objects as dictionaries
      index = this.archiveDictionary(value as Record<string, unknown>);
    } else {
      // Fallback (e.g. symbols, functions) — encode as $null to avoid breaking pipelines
      log.warn(`Unsupported type for NSKeyedArchiver: ${typeof value}. Encoding as $null`);
      return 0;
    }

    return index;
  }

  protected archiveArray(array: unknown[]): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder
    this.objectCache.set(array, index);

    // Archive elements
    const itemUids = array.map((item) => new PlistUID(this.archiveObject(item)));

    // Get class UID
    const classUid = this.getClassUid('NSArray', 'NSObject');

    // Create array structure
    this.objects[index] = {
      'NS.objects': itemUids,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  /** NSSet — same `NS.objects` layout as NSArray; matches NSKeyedArchiver on Apple platforms. */
  protected archiveSet(set: Set<unknown>): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder
    this.objectCache.set(set, index);

    const items = Array.from(set);
    const itemUids = items.map((item) => new PlistUID(this.archiveObject(item)));
    const classUid = this.getClassUid('NSSet', 'NSObject');

    this.objects[index] = {
      'NS.objects': itemUids,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  protected archiveDictionary(dict: Record<string, unknown>): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder
    this.objectCache.set(dict, index);

    const keys = Object.keys(dict);
    const keyUids = keys.map((k) => new PlistUID(this.archiveObject(k)));
    const valUids = keys.map((k) => new PlistUID(this.archiveObject(dict[k])));

    const classUid = this.getClassUid('NSDictionary', 'NSObject');

    this.objects[index] = {
      'NS.keys': keyUids,
      'NS.objects': valUids,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  protected archiveBuffer(buffer: Buffer): number {
    const index = this.objects.length;
    this.objects.push(null);
    this.objectCache.set(buffer, index);

    const classUid = this.getClassUid('NSMutableData', 'NSData', 'NSObject');

    this.objects[index] = {
      'NS.data': buffer,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  protected getClassUid(classname: string, ...superclasses: string[]): number {
    const cachedClass = this.classes.get(classname);
    if (cachedClass !== undefined) {
      return cachedClass;
    }

    const index = this.objects.length;

    // Class definition structure
    const classDef = {
      $classes: [classname, ...superclasses],
      $classname: classname,
    };

    this.objects.push(classDef);
    this.classes.set(classname, index);
    return index;
  }
}
