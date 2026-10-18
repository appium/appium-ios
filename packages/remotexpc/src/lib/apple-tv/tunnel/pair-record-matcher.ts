import type {PairRecord} from '../storage/types.js';
import type {AppleTVDevice} from '../types.js';
import {validateAuthTag} from '../utils/siphash.js';

export interface PairRecordCandidate {
  identifier: string;
  record: PairRecord;
}

export interface MatchedPairRecord extends PairRecordCandidate {
  device: AppleTVDevice;
}

export interface PairRecordMatchResult {
  matches: MatchedPairRecord[];
  recordsWithoutAltIRK: string[];
  devicesWithoutAuthTag: string[];
}

/**
 * Matches discovered devices to pair records offline: a device belongs to the record whose stored
 * altIRK reproduces the authTag it advertises. Records saved before altIRK was stored cannot match.
 */
export function matchDevicesToPairRecords(
  devices: AppleTVDevice[],
  candidates: PairRecordCandidate[],
): PairRecordMatchResult {
  const recordsWithoutAltIRK = candidates.filter(({record}) => !record.altIRK).map(({identifier}) => identifier);
  const usableCandidates = candidates.flatMap(({identifier, record}) =>
    record.altIRK ? [{identifier, record, altIRK: record.altIRK}] : [],
  );

  const devicesWithoutAuthTag: string[] = [];
  const matches: MatchedPairRecord[] = [];
  for (const device of devices) {
    const {serviceIdentifier, authTag} = device;
    if (!serviceIdentifier || !authTag) {
      devicesWithoutAuthTag.push(device.identifier);
      continue;
    }
    const match = usableCandidates.find(({altIRK}) => validateAuthTag(altIRK, serviceIdentifier, authTag));
    if (match) {
      matches.push({identifier: match.identifier, record: match.record, device});
    }
  }

  return {matches, recordsWithoutAltIRK, devicesWithoutAuthTag};
}
