import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {computeAuthTag, siphash24, validateAuthTag} from '../../../../src/lib/apple-tv/utils/siphash.js';

const KEY = Buffer.from(Array.from({length: 16}, (_, i) => i));
const OTHER_KEY = Buffer.from(Array.from({length: 16}, (_, i) => i + 16));
const SERVICE_IDENTIFIER = '2BE6E510-0325-4365-923E-B14C6F57DB3A';
// authTag for KEY and SERVICE_IDENTIFIER: SipHash-2-4 output, first six bytes reversed
const AUTH_TAG_HEX = 'f2f525ba6756';
const AUTH_TAG_BASE64 = '8vUlumdW';

describe('siphash', function () {
  it('matches the SipHash-2-4 reference vector from the paper', function () {
    const message = Buffer.from(Array.from({length: 15}, (_, i) => i));
    assert.strictEqual(siphash24(KEY, message), 0xa129ca6149be45e5n);
  });

  it('rejects keys that are not 16 bytes', function () {
    assert.throws(() => siphash24(Buffer.alloc(8), Buffer.alloc(0)), RangeError);
  });

  it('computes the authTag as the reversed first six output bytes', function () {
    assert.strictEqual(computeAuthTag(KEY, SERVICE_IDENTIFIER).toString('hex'), AUTH_TAG_HEX);
  });

  it('validates a base64 authTag against the altIRK and service identifier', function () {
    assert.strictEqual(validateAuthTag(KEY, SERVICE_IDENTIFIER, AUTH_TAG_BASE64), true);
  });

  it('rejects an authTag produced under another altIRK or for another identifier', function () {
    assert.strictEqual(validateAuthTag(OTHER_KEY, SERVICE_IDENTIFIER, AUTH_TAG_BASE64), false);
    assert.strictEqual(validateAuthTag(KEY, 'another-identifier', AUTH_TAG_BASE64), false);
  });

  it('treats malformed input as a mismatch instead of throwing', function () {
    assert.strictEqual(validateAuthTag(KEY, SERVICE_IDENTIFIER, 'AAAA'), false);
    assert.strictEqual(validateAuthTag(KEY, SERVICE_IDENTIFIER, '!!!'), false);
    assert.strictEqual(validateAuthTag(KEY, SERVICE_IDENTIFIER, ''), false);
    assert.strictEqual(validateAuthTag(Buffer.alloc(8), SERVICE_IDENTIFIER, AUTH_TAG_BASE64), false);
  });
});
