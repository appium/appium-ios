import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PlistUID, createBinaryPlist, parseBinaryPlist} from '../../src/lib/plist/index.js';
import {NSKeyedArchiverDecoder, decodeNSKeyedArchiver} from '../../src/services/ios/dvt/index.js';

/**
 * Round-trips an NSKeyedArchiver object graph through a real binary plist, so
 * UIDs reach the decoder exactly as the binary parser emits them.
 */
function parseBinaryArchive(objects: any[]): any {
  return parseBinaryPlist(
    createBinaryPlist({
      $version: 100000,
      $archiver: 'NSKeyedArchiver',
      $top: {root: new PlistUID(1)},
      $objects: objects,
    }),
  );
}

/**
 * Builds an archived NSError whose NSCode equals the index of its $class
 * object, NSDomain is a UID to a string and NSUserInfo is a UID to $null.
 */
function archivedNSError(): any {
  return parseBinaryArchive([
    '$null',
    {$class: new PlistUID(3), NSCode: 3, NSDomain: new PlistUID(2), NSUserInfo: new PlistUID(0)},
    'DTXMessage',
    {$classname: 'NSError', $classes: ['NSError', 'NSObject']},
  ]);
}

describe('NSKeyedArchiver Decoder', () => {
  describe('isNSKeyedArchive', () => {
    it('should identify NSKeyedArchiver format', () => {
      const validArchive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: 1},
        $objects: ['$null', 'test'],
      };

      assert.strictEqual(NSKeyedArchiverDecoder.isNSKeyedArchive(validArchive), true);
    });

    it('should reject non-NSKeyedArchiver format', () => {
      assert.strictEqual(NSKeyedArchiverDecoder.isNSKeyedArchive(null), false);
      assert.strictEqual(NSKeyedArchiverDecoder.isNSKeyedArchive(undefined), false);
      assert.strictEqual(NSKeyedArchiverDecoder.isNSKeyedArchive('string'), false);
      assert.strictEqual(NSKeyedArchiverDecoder.isNSKeyedArchive([]), false);
      assert.strictEqual(NSKeyedArchiverDecoder.isNSKeyedArchive({someKey: 'value'}), false);
    });
  });

  describe('decode', () => {
    it('should decode simple primitive values', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: 1},
        $objects: ['$null', 'Hello World'],
      };

      const result = decodeNSKeyedArchiver(archive);
      assert.strictEqual(result, 'Hello World');
    });

    it('should decode simple arrays', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: 1},
        $objects: [
          '$null',
          {
            'NS.objects': [2, 3, 4],
            $class: 5,
          },
          'item1',
          'item2',
          'item3',
          {$classname: 'NSArray'},
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      assert.deepStrictEqual(result, ['item1', 'item2', 'item3']);
    });

    it('should decode dictionaries', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: 1},
        $objects: [
          '$null',
          {
            'NS.keys': [2, 3],
            'NS.objects': [4, 5],
            $class: 6,
          },
          'key1',
          'key2',
          'value1',
          'value2',
          {$classname: 'NSDictionary'},
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      assert.deepStrictEqual(result, {
        key1: 'value1',
        key2: 'value2',
      });
    });

    it('should decode nested structures (array of dictionaries)', () => {
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: 1},
        $objects: [
          '$null',
          {
            'NS.objects': [2, 3],
            $class: 10,
          },
          {
            'NS.keys': [4, 5],
            'NS.objects': [6, 7],
            $class: 9,
          },
          {
            'NS.keys': [4, 5],
            'NS.objects': [8, 7],
            $class: 9,
          },
          'identifier',
          'name',
          'group1',
          'test1',
          'group2',
          {$classname: 'NSDictionary'},
          {$classname: 'NSArray'},
        ],
      };

      const result = decodeNSKeyedArchiver(archive);
      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 2);
      assert.deepStrictEqual(result[0], {
        identifier: 'group1',
        name: 'test1',
      });
      assert.deepStrictEqual(result[1], {
        identifier: 'group2',
        name: 'test1',
      });
    });

    it('should return non-archived data as-is', () => {
      const plainData = {key: 'value'};
      const result = decodeNSKeyedArchiver(plainData);
      assert.deepStrictEqual(result, plainData);

      const arrayData = [1, 2, 3];
      const result2 = decodeNSKeyedArchiver(arrayData);
      assert.deepStrictEqual(result2, arrayData);

      const stringData = 'plain string';
      const result3 = decodeNSKeyedArchiver(stringData);
      assert.strictEqual(result3, stringData);
    });

    it('should handle null and undefined', () => {
      assert.strictEqual(decodeNSKeyedArchiver(null), null);
      assert.strictEqual(decodeNSKeyedArchiver(undefined), undefined);
    });

    it('should handle complex condition inducer response structure', () => {
      // Simplified version of the actual condition inducer response
      const archive = {
        $version: 100000,
        $archiver: 'NSKeyedArchiver',
        $top: {root: 1},
        $objects: [
          '$null',
          {
            'NS.objects': [2, 3], // Array of condition groups
            $class: 100,
          },
          // First condition group
          {
            'NS.keys': [4, 5, 6],
            'NS.objects': [7, 8, 9],
            $class: 99,
          },
          // Second condition group
          {
            'NS.keys': [4, 5, 6],
            'NS.objects': [10, 11, 12],
            $class: 99,
          },
          // Keys
          'identifier',
          'name',
          'profiles',
          // Values for first group
          'NetworkLink',
          'Network Link',
          {
            'NS.objects': [13],
            $class: 100,
          },
          // Values for second group
          'GPUPerformanceState',
          'GPU Performance State',
          {
            'NS.objects': [14],
            $class: 100,
          },
          // Profile for NetworkLink
          {
            'NS.keys': [4, 15],
            'NS.objects': [16, 17],
            $class: 99,
          },
          // Profile for GPUPerformanceState
          {
            'NS.keys': [4, 15],
            'NS.objects': [18, 19],
            $class: 99,
          },
          'description',
          'NetworkLink3G',
          '3G Network',
          'GPUPerformanceStateMin',
          'Minimum GPU Performance',
          {$classname: 'NSDictionary'},
          {$classname: 'NSArray'},
        ],
      };

      const result = decodeNSKeyedArchiver(archive);

      assert.ok(Array.isArray(result));
      assert.strictEqual(result.length, 2);

      // Check first group
      assert.strictEqual(result[0].identifier, 'NetworkLink');
      assert.strictEqual(result[0].name, 'Network Link');
      assert.ok('profiles' in result[0]);
      assert.ok(Array.isArray(result[0].profiles));
      assert.strictEqual(result[0].profiles.length, 1);
      assert.strictEqual(result[0].profiles[0].identifier, 'NetworkLink3G');
      assert.strictEqual(result[0].profiles[0].description, '3G Network');

      // Check second group
      assert.strictEqual(result[1].identifier, 'GPUPerformanceState');
      assert.strictEqual(result[1].name, 'GPU Performance State');
      assert.ok('profiles' in result[1]);
      assert.ok(Array.isArray(result[1].profiles));
      assert.strictEqual(result[1].profiles.length, 1);
      assert.strictEqual(result[1].profiles[0].identifier, 'GPUPerformanceStateMin');
      assert.strictEqual(result[1].profiles[0].description, 'Minimum GPU Performance');
    });
  });

  describe('binary plist UIDs', () => {
    it('should resolve a UID property that points at a string', () => {
      assert.strictEqual(decodeNSKeyedArchiver(archivedNSError()).NSDomain, 'DTXMessage');
    });

    it('should keep an integer property that matches an object index', () => {
      assert.strictEqual(decodeNSKeyedArchiver(archivedNSError()).NSCode, 3);
    });

    it('should resolve a UID property that points at $null to null', () => {
      assert.strictEqual(decodeNSKeyedArchiver(archivedNSError()).NSUserInfo, null);
    });

    it('should return a UID stored as an $objects entry unchanged', () => {
      const archive = parseBinaryArchive([
        '$null',
        {$class: new PlistUID(3), formatVersion: new PlistUID(2)},
        new PlistUID(2),
        {$classname: 'XCTestConfiguration', $classes: ['XCTestConfiguration', 'NSObject']},
      ]);

      assert.deepStrictEqual(decodeNSKeyedArchiver(archive), {formatVersion: new PlistUID(2)});
    });

    it('should decode collections whose members are UIDs', () => {
      const archive = parseBinaryArchive([
        '$null',
        {'NS.keys': [new PlistUID(2)], 'NS.objects': [new PlistUID(3)], $class: new PlistUID(7)},
        'items',
        {'NS.objects': [new PlistUID(4), new PlistUID(5)], $class: new PlistUID(6)},
        'first',
        42,
        {$classname: 'NSArray', $classes: ['NSArray', 'NSObject']},
        {$classname: 'NSDictionary', $classes: ['NSDictionary', 'NSObject']},
      ]);

      assert.deepStrictEqual(decodeNSKeyedArchiver(archive), {items: ['first', 42]});
    });
  });
});
