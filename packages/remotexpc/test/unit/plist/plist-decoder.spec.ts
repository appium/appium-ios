import assert from 'node:assert/strict';
import {once} from 'node:events';
import {PassThrough} from 'node:stream';
import {describe, it} from 'node:test';

import {createBinaryPlist} from '../../../src/lib/plist/binary-plist-creator.js';
import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import {PlistServiceDecoder} from '../../../src/lib/plist/plist-decoder.js';
import {PlistService} from '../../../src/lib/plist/plist-service.js';
import type {PlistDictionary, PlistValue} from '../../../src/lib/types.js';

const XML_DECLARATION = '<?xml';
/** How far into a message the decoder looks for an XML declaration to trim up to. */
const DECLARATION_SCAN_BYTES = 100;

function xmlDocument(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><note>${body}</note>`;
}

/**
 * Prefixes a plist payload with its 4-byte big-endian length, the way it travels on the wire.
 */
function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Runs one framed message through a fresh decoder. Rejects with the decoder's error if it fails.
 */
async function decode(payload: Buffer): Promise<PlistValue> {
  const decoder = new PlistServiceDecoder();
  const decoded = once(decoder, 'data');
  decoder.write(frame(payload));
  const [message] = await decoded;
  return message;
}

describe('PlistServiceDecoder', function () {
  describe('XML plists', function () {
    it('decodes an XML plist', async function () {
      const message: PlistDictionary = {Status: 'Success', Value: 42};

      assert.deepEqual(await decode(Buffer.from(createPlist(message))), message);
    });

    it('drops the bytes that precede the XML declaration', async function () {
      const message: PlistDictionary = {Status: 'Success'};
      const payload = Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from(createPlist(message))]);

      assert.deepEqual(await decode(payload), message);
    });
  });

  describe('binary plists', function () {
    it('decodes a binary plist', async function () {
      const message: PlistDictionary = {Status: 'Success', Value: 42};

      assert.deepEqual(await decode(createBinaryPlist(message)), message);
    });

    it('decodes a binary plist whose string value is an XML document', async function () {
      const message: PlistDictionary = {Payload: xmlDocument('one')};
      const payload = createBinaryPlist(message);
      const declarationAt = payload.indexOf(XML_DECLARATION);
      assert.ok(
        declarationAt > 0 && declarationAt < DECLARATION_SCAN_BYTES,
        `the XML declaration must sit inside the scanned prefix, got offset ${declarationAt}`,
      );

      assert.deepEqual(await decode(payload), message);
    });

    it('decodes a binary plist that carries several XML documents as data', async function () {
      const message: PlistDictionary = {
        Padding: 'x'.repeat(2 * DECLARATION_SCAN_BYTES),
        Profiles: [Buffer.from(xmlDocument('one')), Buffer.from(xmlDocument('two'))],
      };
      const payload = createBinaryPlist(message);
      const declarationAt = payload.indexOf(XML_DECLARATION);
      assert.ok(
        declarationAt > DECLARATION_SCAN_BYTES,
        `the XML declarations must sit past the scanned prefix, got offset ${declarationAt}`,
      );

      assert.deepEqual(await decode(payload), message);
    });

    it('delivers a binary plist with an XML document in it to a PlistService receiver', async function () {
      const message: PlistDictionary = {Payload: xmlDocument('one')};
      const socket = new PassThrough();
      const service = new PlistService(socket as any);
      try {
        socket.write(frame(createBinaryPlist(message)));

        assert.deepEqual(await service.receivePlist(500), message);
      } finally {
        service.close();
      }
    });
  });
});
