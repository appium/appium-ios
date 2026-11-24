import {PlistUID} from '../../../lib/plist/index.js';
import {NSKeyedArchiverEncoder} from '../dvt/nskeyedarchiver-encoder.js';
import {isPlainObject} from '../dvt/utils.js';

/**
 * Extended NSKeyedArchiver encoder that handles testmanagerd-specific
 * marker types: NSUUID and XCTCapabilities.
 *
 * Marker objects use a `__type` discriminator field so the encoder can
 * distinguish them from plain dictionaries.
 *
 * Callers must pass **canonical** UUID strings for `NSUUID` markers; this
 * encoder does not validate or normalize (see {@link archiveNSUUID}).
 */
export class TestmanagerdEncoder extends NSKeyedArchiverEncoder {
  protected override archiveObject(value: unknown): number {
    if (value === null || value === undefined) {
      return 0;
    }

    if (isPlainObject(value)) {
      switch (value.__type) {
        case 'NSUUID':
          return this.archiveNSUUID(value.uuid as string);
        case 'XCTCapabilities':
          return this.archiveXCTCapabilities((value.capabilities ?? {}) as Record<string, unknown>);
      }
    }

    return super.archiveObject(value);
  }

  /**
   * @param uuidString Canonical RFC-4122 string with dashes (32 hex digits when
   * dashes are stripped). Callers should use `crypto.randomUUID()` or
   * `canonicalizeUuidString` from `./uuid.js` before encoding; this method does
   * not validate.
   */
  private archiveNSUUID(uuidString: string): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder

    const uuidBytes = Buffer.from(uuidString.replace(/-/g, ''), 'hex');
    const classUid = this.getClassUid('NSUUID', 'NSObject');

    this.objects[index] = {
      'NS.uuidbytes': uuidBytes,
      $class: new PlistUID(classUid),
    };

    return index;
  }

  private archiveXCTCapabilities(capabilities: Record<string, unknown>): number {
    const index = this.objects.length;
    this.objects.push(null); // Placeholder

    const dictIndex = this.archiveDictionary(capabilities);
    const classUid = this.getClassUid('XCTCapabilities', 'NSObject');

    this.objects[index] = {
      'capabilities-dictionary': new PlistUID(dictIndex),
      $class: new PlistUID(classUid),
    };

    return index;
  }
}
