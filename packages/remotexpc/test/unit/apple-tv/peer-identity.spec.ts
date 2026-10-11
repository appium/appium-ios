import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PairingDataComponentType} from '../../../src/lib/apple-tv/constants.js';
import {Opack2} from '../../../src/lib/apple-tv/encryption/index.js';
import {extractPeerIdentity} from '../../../src/lib/apple-tv/pairing-protocol/peer-identity.js';
import type {Opack2Dictionary} from '../../../src/lib/apple-tv/types.js';

const ALT_IRK = Buffer.from(Array.from({length: 16}, (_, i) => i));

function infoTLV(info: Opack2Dictionary): Record<number, Buffer> {
  return {[PairingDataComponentType.INFO]: Opack2.dumps(info)};
}

describe('extractPeerIdentity', function () {
  it('reads the upper-cased remotepairing_udid and the 16-byte altIRK from M6 INFO', function () {
    const identity = extractPeerIdentity(
      infoTLV({remotepairing_udid: 'abcd-1234', altIRK: ALT_IRK, model: 'AppleTV14,1'}),
    );
    assert.deepStrictEqual(identity, {remotePairingUdid: 'ABCD-1234', altIRK: ALT_IRK});
  });

  it('drops an altIRK that is not 16 bytes but keeps the udid', function () {
    const identity = extractPeerIdentity(infoTLV({remotepairing_udid: 'abcd', altIRK: Buffer.from('short')}));
    assert.strictEqual(identity.remotePairingUdid, 'ABCD');
    assert.strictEqual(identity.altIRK, undefined);
  });

  it('drops an altIRK that is not binary', function () {
    const identity = extractPeerIdentity(infoTLV({altIRK: ALT_IRK.toString('hex')}));
    assert.strictEqual(identity.altIRK, undefined);
  });

  it('returns nothing when INFO is absent', function () {
    assert.deepStrictEqual(extractPeerIdentity({}), {});
  });

  it('returns nothing when INFO is not a dictionary', function () {
    assert.deepStrictEqual(extractPeerIdentity({[PairingDataComponentType.INFO]: Opack2.dumps('text')}), {});
  });
});
