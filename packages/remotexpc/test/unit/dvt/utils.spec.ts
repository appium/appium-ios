import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PlistUID, createBinaryPlist, parseBinaryPlist} from '../../../src/lib/plist/index.js';
import {
  extractCapabilityStrings,
  extractNSDictionary,
  extractNSKeyedArchiverObjects,
} from '../../../src/services/ios/dvt/utils.js';

describe('DVT utils', () => {
  describe('extractNSDictionary', () => {
    it('should resolve UID keys and values from a binary plist archive', () => {
      const archive = parseBinaryPlist(
        createBinaryPlist({
          $version: 100000,
          $archiver: 'NSKeyedArchiver',
          $top: {root: new PlistUID(1)},
          $objects: [
            '$null',
            {'NS.keys': [new PlistUID(2)], 'NS.objects': [new PlistUID(3)], $class: new PlistUID(4)},
            'com.apple.instruments.server.services.deviceinfo',
            1,
            {$classname: 'NSDictionary', $classes: ['NSDictionary', 'NSObject']},
          ],
        }),
      );
      const objects = extractNSKeyedArchiverObjects(archive) as any[];

      assert.deepStrictEqual(extractNSDictionary(objects[1], objects), {
        'com.apple.instruments.server.services.deviceinfo': 1,
      });
    });
  });
});

describe('DVT utils dictionary keys', () => {
  it('should store a __proto__ key from an NSDictionary as an own property', () => {
    const archive = parseBinaryPlist(
      createBinaryPlist({
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: new PlistUID(1)},
        $objects: [
          '$null',
          {'NS.keys': [new PlistUID(2)], 'NS.objects': [new PlistUID(3)], $class: new PlistUID(4)},
          '__proto__',
          {x: true},
          {$classname: 'NSDictionary', $classes: ['NSDictionary', 'NSObject']},
        ],
      }),
    );
    const objects = extractNSKeyedArchiverObjects(archive) as any[];
    const dict = extractNSDictionary(objects[1], objects);
    assert.strictEqual(Object.getPrototypeOf(dict), Object.prototype);
    assert.deepStrictEqual(Object.keys(dict), ['__proto__']);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(dict, '__proto__')?.value, {x: true});
    assert.strictEqual((dict as Record<string, unknown>).x, undefined);
  });

  it('should keep a __proto__ capability string as an own key', () => {
    const capabilities = extractCapabilityStrings(['$null', '__proto__', 'com.apple.example']);
    assert.strictEqual(Object.getPrototypeOf(capabilities), Object.prototype);
    assert.deepStrictEqual(Object.keys(capabilities), ['__proto__', 'com.apple.example']);
  });
});
