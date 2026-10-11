import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {PairRecord} from '../../../src/lib/apple-tv/storage/types.js';
import {matchDevicesToPairRecords} from '../../../src/lib/apple-tv/tunnel/pair-record-matcher.js';
import type {AppleTVDevice} from '../../../src/lib/apple-tv/types.js';
import {computeAuthTag} from '../../../src/lib/apple-tv/utils/siphash.js';

const ALT_IRK = Buffer.from(Array.from({length: 16}, (_, i) => i));
const OTHER_ALT_IRK = Buffer.from(Array.from({length: 16}, (_, i) => i + 16));

function device(name: string, altIRK?: Buffer, serviceIdentifier = `${name}-service-id`): AppleTVDevice {
  return {
    name,
    identifier: `${name}-identifier`,
    identifierSource: 'bonjour',
    hostname: `${name}.local`,
    ip: '10.0.0.1',
    port: 49152,
    model: 'AppleTV',
    version: '17.0',
    serviceIdentifier,
    authTag: altIRK ? computeAuthTag(altIRK, serviceIdentifier).toString('base64') : undefined,
  };
}

function record(altIRK?: Buffer): PairRecord {
  return {publicKey: Buffer.alloc(32), privateKey: Buffer.alloc(32), remoteUnlockHostKey: '', altIRK};
}

describe('matchDevicesToPairRecords', function () {
  it('pairs each device with the record whose altIRK reproduces its authTag', function () {
    const mine = device('mine', ALT_IRK);
    const other = device('other', OTHER_ALT_IRK);
    const mineRecord = record(ALT_IRK);
    const otherRecord = record(OTHER_ALT_IRK);

    const result = matchDevicesToPairRecords(
      [other, mine],
      [
        {identifier: 'MINE', record: mineRecord},
        {identifier: 'OTHER', record: otherRecord},
      ],
    );

    assert.deepStrictEqual(result.matches, [
      {identifier: 'OTHER', record: otherRecord, device: other},
      {identifier: 'MINE', record: mineRecord, device: mine},
    ]);
    assert.deepStrictEqual(result.recordsWithoutAltIRK, []);
    assert.deepStrictEqual(result.devicesWithoutAuthTag, []);
  });

  it('never matches a device whose authTag no record can reproduce', function () {
    const result = matchDevicesToPairRecords(
      [device('stranger', OTHER_ALT_IRK)],
      [{identifier: 'MINE', record: record(ALT_IRK)}],
    );

    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.devicesWithoutAuthTag, []);
  });

  it('reports devices that advertise no authTag or no service identifier', function () {
    const noTag = device('no-tag');
    const noServiceIdentifier: AppleTVDevice = {...device('no-service', ALT_IRK), serviceIdentifier: undefined};

    const result = matchDevicesToPairRecords(
      [noTag, noServiceIdentifier],
      [{identifier: 'MINE', record: record(ALT_IRK)}],
    );

    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.devicesWithoutAuthTag, ['no-tag-identifier', 'no-service-identifier']);
  });

  it('reports records without an altIRK and never matches them', function () {
    const result = matchDevicesToPairRecords([device('mine', ALT_IRK)], [{identifier: 'STALE', record: record()}]);

    assert.deepStrictEqual(result.matches, []);
    assert.deepStrictEqual(result.recordsWithoutAltIRK, ['STALE']);
  });

  it('matches on the service identifier, not the possibly enriched device identifier', function () {
    const enriched = {...device('mine', ALT_IRK), identifier: 'DEVICECTL-UDID', identifierSource: 'devicectl' as const};

    const result = matchDevicesToPairRecords([enriched], [{identifier: 'MINE', record: record(ALT_IRK)}]);

    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].device.identifier, 'DEVICECTL-UDID');
  });
});
