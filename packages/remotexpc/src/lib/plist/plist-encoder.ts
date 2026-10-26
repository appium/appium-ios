import {Transform, type TransformCallback} from 'node:stream';

import type {PlistDictionary} from '../types.js';
import {LENGTH_FIELD_4_BYTES, UTF8_ENCODING} from './constants.js';
import {createPlist} from './plist-creator.js';

/**
 * Encodes a plist message as XML behind the 4-byte big-endian length prefix that lockdown services expect
 */
export function framePlist(data: PlistDictionary): Buffer {
  const plistBuffer = Buffer.from(createPlist(data), UTF8_ENCODING);
  const header = Buffer.alloc(LENGTH_FIELD_4_BYTES);
  header.writeUInt32BE(plistBuffer.length, 0);
  return Buffer.concat([header, plistBuffer]);
}

/**
 * Encodes JavaScript objects to plist format with length prefix
 */
export class PlistServiceEncoder extends Transform {
  constructor() {
    super({objectMode: true});
  }

  _transform(data: PlistDictionary, encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.push(framePlist(data));
      callback();
    } catch (err) {
      callback(err as Error);
    }
  }
}
