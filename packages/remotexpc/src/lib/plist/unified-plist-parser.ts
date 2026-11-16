import type {PlistValue} from '../types.js';
import {BinaryPlistError, isBinaryPlist, parseBinaryPlist} from './binary-plist-parser.js';
import {parsePlist as parseXmlPlist} from './plist-parser.js';
import {ensureString} from './utils.js';

/**
 * Unified plist parser that can handle both XML and binary plists
 * @param data - The plist data as a string or Buffer
 * @returns The parsed JavaScript object
 * @throws BinaryPlistError, unchanged, when a binary plist is malformed so callers can tell it apart
 * @throws Error for any other parse failure, with the original error as its cause
 */
export function parsePlist(data: string | Buffer): PlistValue {
  try {
    // Check if it's a binary plist (only if data is a Buffer)
    if (Buffer.isBuffer(data) && isBinaryPlist(data)) {
      return parseBinaryPlist(data);
    } else {
      // Otherwise, assume it's an XML plist
      return parseXmlPlist(ensureString(data));
    }
  } catch (error) {
    if (error instanceof BinaryPlistError) {
      throw error;
    }
    throw new Error(`Failed to parse plist: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
  }
}
