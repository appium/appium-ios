import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PlistUID, createBinaryPlist, parseBinaryPlist} from '../../../src/lib/plist/index.js';
import {extractNSDictionary, extractNSKeyedArchiverObjects} from '../../../src/services/ios/dvt/utils.js';

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
