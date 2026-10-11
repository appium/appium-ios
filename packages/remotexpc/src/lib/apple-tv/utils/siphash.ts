const SIPHASH_KEY_LENGTH = 16;
const AUTH_TAG_LENGTH = 6;
const MASK_64 = (1n << 64n) - 1n;

type SipHashState = [bigint, bigint, bigint, bigint];

function rotateLeft64(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

function sipRound(v: SipHashState): void {
  v[0] = (v[0] + v[1]) & MASK_64;
  v[1] = rotateLeft64(v[1], 13n);
  v[1] ^= v[0];
  v[0] = rotateLeft64(v[0], 32n);
  v[2] = (v[2] + v[3]) & MASK_64;
  v[3] = rotateLeft64(v[3], 16n);
  v[3] ^= v[2];
  v[0] = (v[0] + v[3]) & MASK_64;
  v[3] = rotateLeft64(v[3], 21n);
  v[3] ^= v[0];
  v[2] = (v[2] + v[1]) & MASK_64;
  v[1] = rotateLeft64(v[1], 17n);
  v[1] ^= v[2];
  v[2] = rotateLeft64(v[2], 32n);
}

/**
 * SipHash-2-4 of `data` under a 16-byte `key`, returned as an unsigned 64-bit bigint.
 * @throws {RangeError} if the key is not 16 bytes
 */
export function siphash24(key: Buffer, data: Buffer): bigint {
  if (key.length !== SIPHASH_KEY_LENGTH) {
    throw new RangeError(`SipHash key must be ${SIPHASH_KEY_LENGTH} bytes, got ${key.length}`);
  }
  const k0 = key.readBigUInt64LE(0);
  const k1 = key.readBigUInt64LE(8);
  const v: SipHashState = [
    k0 ^ 0x736f6d6570736575n,
    k1 ^ 0x646f72616e646f6dn,
    k0 ^ 0x6c7967656e657261n,
    k1 ^ 0x7465646279746573n,
  ];

  const blockEnd = data.length - (data.length % 8);
  for (let offset = 0; offset < blockEnd; offset += 8) {
    const block = data.readBigUInt64LE(offset);
    v[3] ^= block;
    sipRound(v);
    sipRound(v);
    v[0] ^= block;
  }

  let lastBlock = BigInt(data.length & 0xff) << 56n;
  for (let i = 0; i < data.length - blockEnd; i++) {
    lastBlock |= BigInt(data[blockEnd + i]) << BigInt(8 * i);
  }
  v[3] ^= lastBlock;
  sipRound(v);
  sipRound(v);
  v[0] ^= lastBlock;

  v[2] ^= 0xffn;
  for (let i = 0; i < 4; i++) {
    sipRound(v);
  }
  return (v[0] ^ v[1] ^ v[2] ^ v[3]) & MASK_64;
}

/**
 * Computes the 6-byte mDNS `authTag` for a RemotePairing advert:
 * SipHash-2-4(key=altIRK, msg=serviceIdentifier), 8-byte little-endian output, first 6 bytes reversed.
 */
export function computeAuthTag(altIRK: Buffer, serviceIdentifier: string): Buffer {
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(siphash24(altIRK, Buffer.from(serviceIdentifier, 'utf8')));
  return Buffer.from(output.subarray(0, AUTH_TAG_LENGTH)).reverse();
}

/**
 * Validates a base64 `authTag` from a RemotePairing TXT record against the altIRK of a pair record.
 * Any malformed input (wrong key or tag length, undecodable base64) is a mismatch, never an error.
 */
export function validateAuthTag(altIRK: Buffer, serviceIdentifier: string, authTagBase64: string): boolean {
  if (altIRK.length !== SIPHASH_KEY_LENGTH) {
    return false;
  }
  const authTag = Buffer.from(authTagBase64, 'base64');
  if (authTag.length !== AUTH_TAG_LENGTH) {
    return false;
  }
  return computeAuthTag(altIRK, serviceIdentifier).equals(authTag);
}
