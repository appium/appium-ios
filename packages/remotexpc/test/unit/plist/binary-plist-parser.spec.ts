import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {createBinaryPlist, parseBinaryPlist} from '../../../src/lib/plist/index.js';
import {PlistUID} from '../../../src/lib/plist/plist-uid.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

const HEADER = Buffer.from('bplist00', 'ascii');
const TRAILER_SIZE = 32;

const TYPE_INT = 0x10;
const TYPE_REAL = 0x20;
const TYPE_DATE = 0x30;
const TYPE_DATA = 0x40;
const TYPE_ASCII = 0x50;
const TYPE_UNICODE = 0x60;
const TYPE_UID = 0x80;
const TYPE_ARRAY = 0xa0;
const TYPE_DICT = 0xd0;

interface BinaryPlistLayout {
  objects: Buffer[];
  offsets?: number[];
  offsetSize?: number;
  objectRefSize?: number;
  numObjects?: number;
  topObject?: number;
  offsetTableOffset?: number;
}

/**
 * Assembles a binary plist from raw object encodings. Every trailer field and the offset table
 * can be overridden so malformed inputs can be built byte for byte.
 */
function buildBinaryPlist(layout: BinaryPlistLayout): Buffer {
  const objectData = Buffer.concat(layout.objects);
  const offsets = layout.offsets ?? computeOffsets(layout.objects);
  const offsetSize = layout.offsetSize ?? 1;
  const offsetTable = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((offset, index) => writeBigEndian(offsetTable, offset, index * offsetSize, offsetSize));
  const trailer = Buffer.alloc(TRAILER_SIZE);
  trailer.writeUInt8(offsetSize, 6);
  trailer.writeUInt8(layout.objectRefSize ?? 1, 7);
  trailer.writeBigUInt64BE(BigInt(layout.numObjects ?? layout.objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(layout.topObject ?? 0), 16);
  trailer.writeBigUInt64BE(BigInt(layout.offsetTableOffset ?? HEADER.length + objectData.length), 24);
  return Buffer.concat([HEADER, objectData, offsetTable, trailer]);
}

/**
 * Writes a big-endian unsigned integer of any width, including widths Node's Buffer refuses.
 */
function writeBigEndian(buffer: Buffer, value: number, position: number, size: number): void {
  let remaining = BigInt(value);
  for (let index = size - 1; index >= 0; index--) {
    buffer[position + index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
}

/**
 * Computes where each object starts when the objects are laid out back to back after the header.
 */
function computeOffsets(objects: Buffer[]): number[] {
  const offsets: number[] = [];
  let offset = HEADER.length;
  for (const object of objects) {
    offsets.push(offset);
    offset += object.length;
  }
  return offsets;
}

/**
 * Encodes an object marker whose length does not fit the 4 info bits, so a 4-byte integer follows.
 */
function markerWithLength(type: number, length: number): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt8(type | 0x0f, 0);
  header.writeUInt8(0x12, 1);
  header.writeUInt32BE(length, 2);
  return header;
}

/**
 * Encodes an ASCII string object short enough for its length to fit the marker.
 */
function asciiString(text: string): Buffer {
  return Buffer.concat([Buffer.from([TYPE_ASCII | text.length]), Buffer.from(text, 'ascii')]);
}

/**
 * Builds a chain of arrays where each level holds two references to the level below, so the
 * flattened result doubles with every level while the encoding grows by a few bytes.
 */
function sharedArrayChain(depth: number): Buffer {
  let level: unknown[] = [];
  for (let index = 0; index < depth; index++) {
    level = [level, level];
  }
  return createBinaryPlist(level as never);
}

describe('Binary Plist Parser Hardening', function () {
  describe('Reported Inputs', function () {
    it('should reject a unicode string whose claimed length is far past the buffer', function () {
      const plist = buildBinaryPlist({
        objects: [Buffer.concat([markerWithLength(TYPE_UNICODE, 2 ** 27), Buffer.from([0x00, 0x41])])],
      });
      assert.throws(() => parseBinaryPlist(plist), /Unicode string .* past the end of the object area/);
    });

    it('should reject a trailer claiming millions of objects with a zero offset size', function () {
      const plist = buildBinaryPlist({
        objects: [],
        offsetSize: 0,
        objectRefSize: 0,
        numObjects: 4_000_000,
        offsetTableOffset: HEADER.length,
      });
      assert.throws(() => parseBinaryPlist(plist), /offset size must be between 1 and 8/);
    });

    it('should reject an array of millions of elements with a zero object reference size', function () {
      const plist = buildBinaryPlist({
        objects: [markerWithLength(TYPE_ARRAY, 8_000_000)],
        objectRefSize: 0,
      });
      assert.throws(() => parseBinaryPlist(plist), /object reference size must be between 1 and 8/);
    });
  });

  describe('Trailer Validation', function () {
    const objects = [Buffer.from([0x09])];

    it('should reject an offset size outside 1 to 8', function () {
      assert.throws(() => parseBinaryPlist(buildBinaryPlist({objects, offsetSize: 0})), /offset size must be/);
      assert.throws(() => parseBinaryPlist(buildBinaryPlist({objects, offsetSize: 9})), /offset size must be/);
    });

    it('should reject an object reference size outside 1 to 8', function () {
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects, objectRefSize: 0})),
        /object reference size must be/,
      );
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects, objectRefSize: 9})),
        /object reference size must be/,
      );
    });

    it('should reject a zero object count', function () {
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects, numObjects: 0})),
        /object count must be at least 1/,
      );
    });

    it('should reject a top object index past the object count', function () {
      assert.throws(() => parseBinaryPlist(buildBinaryPlist({objects, topObject: 1})), /top object 1 is out of range/);
    });

    it('should reject an offset table that does not fit before the trailer', function () {
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects, numObjects: 2})),
        /does not fit before the trailer/,
      );
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects, offsetTableOffset: 2 ** 40})),
        /does not fit before the trailer/,
      );
    });
  });

  describe('Offset And Reference Validation', function () {
    it('should reject an object offset outside the object area', function () {
      const objects = [Buffer.from([0x09])];
      assert.throws(() => parseBinaryPlist(buildBinaryPlist({objects, offsets: [0]})), /outside the object area/);
      assert.throws(() => parseBinaryPlist(buildBinaryPlist({objects, offsets: [9]})), /outside the object area/);
      assert.throws(() => parseBinaryPlist(buildBinaryPlist({objects, offsets: [200]})), /outside the object area/);
    });

    it('should reject offset table entries that point at the same object', function () {
      const object = Buffer.from([TYPE_ASCII | 0x0f, TYPE_INT, 0x00]);
      const copies = 100_000;
      const plist = buildBinaryPlist({
        objects: [object],
        offsets: Array.from({length: copies}, () => HEADER.length),
        numObjects: copies,
      });
      assert.throws(() => parseBinaryPlist(plist), /points at offset 8 more than once/);
    });

    it('should reject an object reference past the object count', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([TYPE_ARRAY | 0x01, 0x05])]});
      assert.throws(() => parseBinaryPlist(plist), /out of range/);
    });

    it('should reject an array that contains itself', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([TYPE_ARRAY | 0x01, 0x00])]});
      assert.throws(() => parseBinaryPlist(plist), /contains itself/);
    });

    it('should reject containers that reference each other in a cycle', function () {
      const plist = buildBinaryPlist({
        objects: [
          Buffer.from([TYPE_DICT | 0x01, 0x01, 0x02]),
          asciiString('k'),
          Buffer.from([TYPE_ARRAY | 0x01, 0x00]),
        ],
      });
      assert.throws(() => parseBinaryPlist(plist), /contains itself/);
    });

    it('should still share a container that is referenced more than once', function () {
      const shared = {inner: [1, 2, 3]};
      const obj = {first: shared, second: shared, list: [shared, shared]};
      const parsed = parseBinaryPlist(createBinaryPlist(obj)) as PlistDictionary;
      assert.deepStrictEqual(parsed, obj);
      assert.strictEqual(parsed.first, parsed.second);
    });
  });

  describe('Shared Container Expansion', function () {
    it('should reject shared containers that flatten to exponentially more values than the plist holds', function () {
      assert.throws(() => parseBinaryPlist(sharedArrayChain(40)), /expands to more than/);
    });

    it('should still parse moderate sharing of nested containers', function () {
      const parsed = parseBinaryPlist(sharedArrayChain(8)) as unknown[];
      assert.strictEqual(parsed.length, 2);
      assert.strictEqual(parsed[0], parsed[1]);
    });
  });

  describe('Length Validation', function () {
    const variableLengthCases: Array<[string, number]> = [
      ['data', TYPE_DATA],
      ['ascii string', TYPE_ASCII],
      ['unicode string', TYPE_UNICODE],
      ['array', TYPE_ARRAY],
      ['dictionary', TYPE_DICT],
    ];

    for (const [name, type] of variableLengthCases) {
      it(`should reject a ${name} whose length runs past the object area`, function () {
        const plist = buildBinaryPlist({objects: [Buffer.concat([markerWithLength(type, 0xffff), Buffer.alloc(4)])]});
        assert.throws(() => parseBinaryPlist(plist), /past the end of the object area/);
      });
    }

    const fixedSizeCases: Array<[string, number]> = [
      ['integer', TYPE_INT | 0x03],
      ['real', TYPE_REAL | 0x03],
      ['date', TYPE_DATE | 0x03],
      ['uid', TYPE_UID | 0x03],
    ];

    for (const [name, marker] of fixedSizeCases) {
      it(`should reject a ${name} whose payload runs past the object area`, function () {
        const plist = buildBinaryPlist({objects: [Buffer.from([marker])]});
        assert.throws(() => parseBinaryPlist(plist), /past the end of the object area/);
      });
    }

    it('should reject a length integer wider than 8 bytes', function () {
      for (const intInfo of [0x04, 0x0f]) {
        const plist = buildBinaryPlist({
          objects: [Buffer.concat([Buffer.from([TYPE_ASCII | 0x0f, TYPE_INT | intInfo]), Buffer.alloc(32768)])],
        });
        assert.throws(() => parseBinaryPlist(plist), /at most 8 bytes/);
      }
    });

    it('should reject a length integer whose bytes run past the object area', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([TYPE_ASCII | 0x0f, TYPE_INT | 0x02])]});
      assert.throws(() => parseBinaryPlist(plist), /Object length .* past the end of the object area/);
    });

    it('should reject overlapping objects that claim more bytes in total than the plist holds', function () {
      const headerCount = 16;
      const filler = Buffer.alloc(4096, 0x61);
      const headers: Buffer[] = [];
      for (let index = 0; index < headerCount; index++) {
        const header = Buffer.alloc(4);
        header.writeUInt8(TYPE_ASCII | 0x0f, 0);
        header.writeUInt8(TYPE_INT | 0x01, 1);
        header.writeUInt16BE(filler.length + 4 * (headerCount - 1 - index), 2);
        headers.push(header);
      }
      const plist = buildBinaryPlist({
        objects: [...headers, filler],
        offsets: computeOffsets(headers),
        numObjects: headerCount,
      });
      assert.throws(() => parseBinaryPlist(plist), /more bytes in total/);
    });

    it('should parse 4-byte UIDs above 2^31 as unsigned', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([TYPE_UID | 0x03, 0x80, 0x00, 0x00, 0x01])]});
      assert.deepStrictEqual(parseBinaryPlist(plist), new PlistUID(2147483649));
    });

    it('should still parse strings and containers that need a multi-byte length', function () {
      const obj = {
        ascii: 'a'.repeat(70_000),
        unicode: 'é'.repeat(70_000),
        data: Buffer.alloc(70_000, 0x5a),
        list: Array.from({length: 300}, (_, index) => index),
      };
      const parsed = parseBinaryPlist(createBinaryPlist(obj)) as PlistDictionary;
      assert.strictEqual(parsed.ascii, obj.ascii);
      assert.strictEqual(parsed.unicode, obj.unicode);
      assert.deepStrictEqual(parsed.data, obj.data);
      assert.deepStrictEqual(parsed.list, obj.list);
    });
  });

  describe('Dictionary Keys', function () {
    it('should store a __proto__ key as an own property instead of changing the prototype', function () {
      const plist = buildBinaryPlist({
        objects: [
          Buffer.from([TYPE_DICT | 0x01, 0x01, 0x02]),
          asciiString('__proto__'),
          Buffer.from([TYPE_DICT | 0x01, 0x03, 0x04]),
          asciiString('x'),
          Buffer.from([0x09]),
        ],
      });
      const parsed = parseBinaryPlist(plist) as PlistDictionary;
      assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
      assert.deepStrictEqual(Object.keys(parsed), ['__proto__']);
      assert.deepStrictEqual(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value, {x: true});
      assert.strictEqual((parsed as Record<string, unknown>).x, undefined);
    });

    it('should reject a dictionary key that is not a string', function () {
      const plist = buildBinaryPlist({
        objects: [Buffer.from([TYPE_DICT | 0x01, 0x01, 0x02]), Buffer.from([0x09]), Buffer.from([0x08])],
      });
      assert.throws(() => parseBinaryPlist(plist), /Dictionary key must be a string/);
    });
  });

  describe('Error Type', function () {
    const malformedInputs: Array<[string, Buffer]> = [
      ['trailer', buildBinaryPlist({objects: [Buffer.from([0x09])], offsetSize: 0})],
      ['object offset', buildBinaryPlist({objects: [Buffer.from([0x09])], offsets: [200]})],
      [
        'object length',
        buildBinaryPlist({objects: [Buffer.concat([markerWithLength(TYPE_DATA, 0xffff), Buffer.alloc(4)])]}),
      ],
      ['object reference', buildBinaryPlist({objects: [Buffer.from([TYPE_ARRAY | 0x01, 0x05])]})],
      ['cycle', buildBinaryPlist({objects: [Buffer.from([TYPE_ARRAY | 0x01, 0x00])]})],
      ['expansion', sharedArrayChain(40)],
      [
        'dictionary key',
        buildBinaryPlist({objects: [Buffer.from([TYPE_DICT | 0x01, 0x01, 0x01]), Buffer.from([0x09])]}),
      ],
      [
        'integer width',
        buildBinaryPlist({objects: [Buffer.concat([Buffer.from([TYPE_INT | 0x05]), Buffer.alloc(32)])]}),
      ],
      ['object type', buildBinaryPlist({objects: [Buffer.from([0x70])]})],
    ];

    for (const [name, plist] of malformedInputs) {
      it(`should raise BinaryPlistError for a malformed ${name}`, function () {
        assert.throws(() => parseBinaryPlist(plist), {name: 'BinaryPlistError'});
      });
    }
  });
});
