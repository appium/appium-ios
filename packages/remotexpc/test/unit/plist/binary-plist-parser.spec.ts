import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {node} from '@appium/support';

import {BinaryPlistError as RootBinaryPlistError} from '../../../src/index.js';
import {BinaryPlistError, createBinaryPlist, parseBinaryPlist} from '../../../src/lib/plist/index.js';
import {PlistUID} from '../../../src/lib/plist/plist-uid.js';
import type {PlistDictionary} from '../../../src/lib/types.js';

const PKG_ROOT = node.getModuleRootSync('appium-ios-remotexpc', fileURLToPath(import.meta.url));
const SAMPLE_BINARY_PLIST = path.join(PKG_ROOT, 'test', 'unit', 'plist', 'fixtures', 'sample.binary.plist');

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

    it('should parse offset table entries that point at the same object once and share the result', function () {
      const objects = [
        Buffer.from([TYPE_DICT | 0x02, 0x01, 0x02, 0x03, 0x04]),
        asciiString('a'),
        asciiString('b'),
        Buffer.from([TYPE_ARRAY | 0x01, 0x05]),
        Buffer.from([TYPE_INT, 0x07]),
      ];
      const offsets = computeOffsets(objects);
      const plist = buildBinaryPlist({
        objects,
        offsets: [offsets[0], offsets[1], offsets[2], offsets[3], offsets[3], offsets[4]],
        numObjects: 6,
      });
      const parsed = parseBinaryPlist(plist) as PlistDictionary;
      assert.deepStrictEqual(parsed, {a: [7], b: [7]});
      assert.strictEqual(parsed.a, parsed.b);
    });

    it('should parse offset table entries that alias one object without repeating its work', function () {
      const copies = 100_000;
      const plist = buildBinaryPlist({
        objects: [Buffer.from([TYPE_ASCII | 0x0f, TYPE_INT, 0x00])],
        offsets: Array.from({length: copies}, () => HEADER.length),
        numObjects: copies,
      });
      assert.strictEqual(parseBinaryPlist(plist), '');
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

  describe('Top Object', function () {
    it('should return an empty top-level dictionary even when the table holds unreferenced objects', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([TYPE_DICT]), asciiString('k'), Buffer.from([0x09])]});
      assert.deepStrictEqual(parseBinaryPlist(plist), {});
    });

    it('should return an empty top-level array even when the table holds unreferenced objects', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([TYPE_ARRAY]), asciiString('k'), Buffer.from([0x09])]});
      assert.deepStrictEqual(parseBinaryPlist(plist), []);
    });

    it('should honour a top object that is not the first entry', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([0x08]), Buffer.from([0x09])], topObject: 1});
      assert.strictEqual(parseBinaryPlist(plist), true);
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

    it('should reject an integer or real marker with an unsupported width before charging the budget', function () {
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects: [Buffer.from([TYPE_INT | 0x05])]})),
        /Unexpected integer byte count: 32/,
      );
      assert.throws(
        () => parseBinaryPlist(buildBinaryPlist({objects: [Buffer.from([TYPE_REAL | 0x01])]})),
        /Unexpected float byte count: 2/,
      );
    });

    it('should accept only the 8-byte date marker', function () {
      const seconds = Buffer.alloc(8);
      seconds.writeDoubleBE(0, 0);
      const valid = buildBinaryPlist({objects: [Buffer.concat([Buffer.from([TYPE_DATE | 0x03]), seconds])]});
      assert.deepStrictEqual(parseBinaryPlist(valid), new Date('2001-01-01T00:00:00Z'));
      const invalid = buildBinaryPlist({objects: [Buffer.concat([Buffer.from([TYPE_DATE]), seconds])]});
      assert.throws(() => parseBinaryPlist(invalid), /Unexpected date marker/);
    });

    it('should write dates with the 8-byte marker CoreFoundation requires', function () {
      const date = new Date('2023-01-01T12:00:00Z');
      const plist = createBinaryPlist({date});
      assert.ok(plist.includes(Buffer.from([TYPE_DATE | 0x03])), 'expected a 0x33 date marker');
      assert.deepStrictEqual(parseBinaryPlist(plist), {date});
    });

    it('should reject a set marker before reading a length for it', function () {
      const plist = buildBinaryPlist({objects: [Buffer.from([0xcf, TYPE_INT | 0x02])]});
      assert.throws(() => parseBinaryPlist(plist), /Unsupported binary plist object type: c0/);
      const shortSet = buildBinaryPlist({objects: [Buffer.from([0xc1, 0x00])]});
      assert.throws(() => parseBinaryPlist(shortSet), /Unsupported binary plist object type: c0/);
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

    it('should export BinaryPlistError from the package root', function () {
      assert.strictEqual(RootBinaryPlistError, BinaryPlistError);
    });

    it('should only ever raise BinaryPlistError for randomly corrupted plists', function () {
      const seeds = [
        readFileSync(SAMPLE_BINARY_PLIST),
        createBinaryPlist({
          text: 'é'.repeat(40),
          data: Buffer.alloc(40, 0x5a),
          list: Array.from({length: 20}, (_, index) => ({index, flag: index % 2 === 0, uid: new PlistUID(index)})),
          nested: {deep: {deeper: [1.5, -7, 2n ** 40n, new Date(0)]}},
        }),
      ];
      const random = seededRandom(0x5eed);
      for (const seed of seeds) {
        for (let iteration = 0; iteration < 1500; iteration++) {
          const corrupted = corruptPlist(seed, random);
          try {
            parseBinaryPlist(corrupted);
          } catch (error) {
            assert.ok(
              error instanceof BinaryPlistError,
              `iteration ${iteration} raised ${String(error)} for ${corrupted.toString('hex')}`,
            );
          }
        }
      }
    });
  });
});

/**
 * Returns a deterministic pseudo random generator so a failing iteration can be reproduced.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Corrupts a copy of a plist by overwriting a few bytes, biased towards the trailer where the
 * sizes and counts live, and occasionally truncating it.
 */
function corruptPlist(plist: Buffer, random: () => number): Buffer {
  const corrupted = Buffer.from(plist);
  const edits = 1 + Math.floor(random() * 4);
  for (let edit = 0; edit < edits; edit++) {
    const inTrailer = random() < 0.5;
    const position = inTrailer
      ? corrupted.length - TRAILER_SIZE + Math.floor(random() * TRAILER_SIZE)
      : Math.floor(random() * corrupted.length);
    corrupted[position] = Math.floor(random() * 256);
  }
  if (random() < 0.1) {
    return corrupted.subarray(0, Math.floor(random() * corrupted.length));
  }
  return corrupted;
}
