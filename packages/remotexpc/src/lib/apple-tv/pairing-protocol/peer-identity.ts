import {ALT_IRK_LENGTH, PairingDataComponentType} from '../constants.js';
import {Opack2} from '../encryption/index.js';
import type {Opack2Dictionary} from '../types.js';

/** Identity the Apple TV reveals in the encrypted INFO payload of pair-setup M6. */
export interface PairSetupPeerIdentity {
  remotePairingUdid?: string;
  altIRK?: Buffer;
}

/**
 * Reads `remotepairing_udid` and `altIRK` from the decrypted M6 TLV.
 * Absent or malformed fields are left undefined; altIRK must be exactly 16 bytes.
 */
export function extractPeerIdentity(decryptedTLV: Record<number, Buffer | undefined>): PairSetupPeerIdentity {
  const info = decryptedTLV[PairingDataComponentType.INFO];
  if (!info) {
    return {};
  }

  const decodedInfo = Opack2.loads(info);
  if (!isOpackDictionary(decodedInfo)) {
    return {};
  }

  const remotePairingUdid = decodedInfo.remotepairing_udid;
  const altIRK = decodedInfo.altIRK;
  return {
    remotePairingUdid:
      typeof remotePairingUdid === 'string' && remotePairingUdid ? remotePairingUdid.toUpperCase() : undefined,
    altIRK: Buffer.isBuffer(altIRK) && altIRK.length === ALT_IRK_LENGTH ? altIRK : undefined,
  };
}

function isOpackDictionary(value: unknown): value is Opack2Dictionary {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}
