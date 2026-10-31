/**
 * Binary Property List (bplist) Parser
 *
 * This module provides functionality to parse binary property lists (bplists)
 * commonly used in Apple's iOS and macOS systems.
 */
import {getLogger} from '../logger.js';
import type {PlistArray, PlistDictionary, PlistValue} from '../types.js';
import {APPLE_EPOCH_OFFSET, BPLIST_MAGIC_AND_VERSION, BPLIST_TRAILER_SIZE, BPLIST_TYPE} from './constants.js';
import {PlistUID} from './plist-uid.js';

const log = getLogger('Plist');

const OBJECT_AREA_START = BPLIST_MAGIC_AND_VERSION.length;

/**
 * Represents a container during binary plist parsing, before its references are resolved.
 * A class so it can be told apart from parsed dictionaries, which may have the same keys.
 * For an array `refs` holds the element references; for a dictionary it holds the key
 * references followed by the value references.
 */
class TempObject {
  readonly type: 'array' | 'dict';
  readonly refs: number[];

  constructor(type: 'array' | 'dict', refs: number[]) {
    this.type = type;
    this.refs = refs;
  }
}

/**
 * Type for the object table during parsing
 */
type ObjectTableItem = PlistValue | TempObject;

/**
 * Class for parsing binary property lists
 */
class BinaryPlistParser {
  private _buffer: Buffer;
  private _offsetSize: number;
  private _objectRefSize: number;
  private _numObjects: number;
  private _topObject: number;
  private _offsetTableOffset: number;
  private _payloadBudget: number;
  private readonly _objectTable: ObjectTableItem[];

  /**
   * Creates a new BinaryPlistParser
   * @param buffer - The binary plist data as a Buffer
   */
  constructor(buffer: Buffer) {
    this._buffer = buffer;
    this._objectTable = [];

    // Initialize with default values, will be set in parseTrailer
    this._offsetSize = 0;
    this._objectRefSize = 0;
    this._numObjects = 0;
    this._topObject = 0;
    this._offsetTableOffset = 0;
    this._payloadBudget = 0;
  }

  /**
   * Parses the binary plist
   * @returns The parsed JavaScript object
   */
  parse(): PlistValue {
    this._validateHeader();
    this._parseTrailer();
    this._parseObjects();
    this._resolveReferences();
    return this._handleTopObject();
  }

  /**
   * Validates the binary plist header
   * @throws Error if the buffer is not a valid binary plist
   */
  private _validateHeader(): void {
    if (this._buffer.length < 8 || !this._buffer.slice(0, 8).equals(BPLIST_MAGIC_AND_VERSION)) {
      throw new Error('Not a binary plist. Expected bplist00 magic.');
    }
  }

  /**
   * Parses and validates the trailer section of the binary plist. Every trailer field comes from
   * the peer, so each one is checked against the buffer before it is allowed to bound any loop.
   * @throws Error if the buffer is too small to contain a trailer or the trailer is inconsistent
   */
  private _parseTrailer(): void {
    if (this._buffer.length < BPLIST_TRAILER_SIZE) {
      throw new Error('Binary plist is too small to contain a trailer.');
    }

    const trailer = this._buffer.subarray(this._buffer.length - BPLIST_TRAILER_SIZE);
    const offsetSize = trailer.readUInt8(6);
    const objectRefSize = trailer.readUInt8(7);
    const numObjects = trailer.readBigUInt64BE(8);
    const topObject = trailer.readBigUInt64BE(16);
    const offsetTableOffset = trailer.readBigUInt64BE(24);
    const offsetTableEnd = BigInt(this._buffer.length - BPLIST_TRAILER_SIZE);

    if (offsetSize < 1 || offsetSize > 8) {
      throw new Error(`Invalid binary plist trailer: offset size must be between 1 and 8, got ${offsetSize}.`);
    }
    if (objectRefSize < 1 || objectRefSize > 8) {
      throw new Error(
        `Invalid binary plist trailer: object reference size must be between 1 and 8, got ${objectRefSize}.`,
      );
    }
    if (numObjects < 1n) {
      throw new Error('Invalid binary plist trailer: object count must be at least 1.');
    }
    if (topObject >= numObjects) {
      throw new Error(
        `Invalid binary plist trailer: top object ${topObject} is out of range for ${numObjects} objects.`,
      );
    }
    if (
      offsetTableOffset <= BigInt(OBJECT_AREA_START) ||
      offsetTableOffset + numObjects * BigInt(offsetSize) > offsetTableEnd
    ) {
      throw new Error(
        `Invalid binary plist trailer: offset table at ${offsetTableOffset} with ${numObjects} entries of ${offsetSize} byte(s) does not fit before the trailer.`,
      );
    }

    this._offsetSize = offsetSize;
    this._objectRefSize = objectRefSize;
    this._numObjects = Number(numObjects);
    this._topObject = Number(topObject);
    this._offsetTableOffset = Number(offsetTableOffset);
    this._payloadBudget = this._offsetTableOffset - OBJECT_AREA_START;
  }

  /**
   * Helper method to read multi-byte integers safely, handling potential overflow
   * @param startOffset - The offset to start reading from
   * @param byteCount - The number of bytes to read
   * @param valueName - Name of the value type for error messages
   * @returns The parsed integer value
   */
  private _readMultiByteInteger(startOffset: number, byteCount: number, valueName: string): number {
    // Use BigInt for calculations if byteCount is large enough to potentially overflow
    if (byteCount > 6) {
      // 6 bytes = 48 bits, safely under MAX_SAFE_INTEGER
      let result = 0n;
      for (let i = 0; i < byteCount; i++) {
        result = (result << 8n) | BigInt(this._buffer.readUInt8(startOffset + i));
      }

      // Check if the value exceeds MAX_SAFE_INTEGER
      if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error(`${valueName} value ${result} exceeds MAX_SAFE_INTEGER. Cannot safely convert to number.`);
      }

      // Safe to convert to number without precision loss
      return Number(result);
    }

    // Use regular number arithmetic for smaller values
    let result = 0;
    for (let i = 0; i < byteCount; i++) {
      result = result * 256 + this._buffer.readUInt8(startOffset + i);
    }
    return result;
  }

  /**
   * Reads an object reference from the buffer and checks that it points at an existing object
   * @param offset - The offset to read from
   * @returns The object reference index
   * @throws RangeError if the reference is past the object count
   */
  private _readObjectRef(offset: number): number {
    const ref = this._readMultiByteInteger(offset, this._objectRefSize, 'Object reference');
    if (ref >= this._numObjects) {
      throw new RangeError(`Binary plist object reference ${ref} is out of range for ${this._numObjects} objects.`);
    }
    return ref;
  }

  /**
   * Reads consecutive object references after bounding them by the object area
   * @param startOffset - The offset of the first reference
   * @param count - The number of references to read
   * @param valueName - Name of the container type for error messages
   * @returns The object indices the references point at
   */
  private _readObjectRefs(startOffset: number, count: number, valueName: string): number[] {
    this._claimPayloadBytes(startOffset, count * this._objectRefSize, valueName);
    const refs: number[] = [];
    for (let j = 0; j < count; j++) {
      refs.push(this._readObjectRef(startOffset + j * this._objectRefSize));
    }
    return refs;
  }

  /**
   * Checks that a variable-length payload lies inside the object area and charges it against the
   * shared budget. Objects in a well-formed plist never overlap, so their payloads can never add
   * up to more than the object area holds; an offset table whose entries alias one large object
   * is rejected before it can multiply that object's size.
   * @param startOffset - The offset where the payload starts
   * @param byteCount - The number of payload bytes the object claims
   * @param valueName - Name of the value type for error messages
   * @throws RangeError if the payload runs past the object area or exhausts the budget
   */
  private _claimPayloadBytes(startOffset: number, byteCount: number, valueName: string): void {
    if (startOffset + byteCount > this._offsetTableOffset) {
      throw new RangeError(
        `${valueName} at offset ${startOffset} claims ${byteCount} bytes past the end of the object area.`,
      );
    }
    this._payloadBudget -= byteCount;
    if (this._payloadBudget < 0) {
      throw new RangeError('Binary plist objects claim more bytes in total than the object area holds.');
    }
  }

  /**
   * Reads an offset from the offset table
   * @param index - The index in the offset table
   * @returns The offset value
   */
  private _readOffset(index: number): number {
    const offsetStart = this._offsetTableOffset + index * this._offsetSize;
    return this._readMultiByteInteger(offsetStart, this._offsetSize, 'Offset');
  }

  /**
   * Parses an integer. Only the 8-byte form is signed.
   * @param startOffset - The offset to start reading from
   * @param intByteCount - The number of bytes to read
   * @returns The parsed integer value (number or bigint)
   */
  private _parseIntegerValue(startOffset: number, intByteCount: number): number | bigint {
    // Handle different integer sizes
    switch (intByteCount) {
      case 1:
        return this._buffer.readUInt8(startOffset);
      case 2:
        return this._buffer.readUInt16BE(startOffset);
      case 4:
        return this._buffer.readUInt32BE(startOffset);
      case 8: {
        // For 64-bit integers, we need to handle potential precision loss
        const bigInt = this._buffer.readBigInt64BE(startOffset);
        const intValue = Number(bigInt);

        // Check if conversion to Number caused precision loss
        if (BigInt(intValue) !== bigInt) {
          log.warn('Precision loss when converting 64-bit integer to Number. Returning BigInt value.');
          return bigInt; // Return the BigInt directly to avoid precision loss
        }

        return intValue; // Return as number if no precision loss
      }
      case 16: {
        // 128-bit integers are stored as big-endian two's complement. They
        // appear in large archives (e.g. sysmontap process samples) for values
        // that Apple encodes in 16 bytes even when they fit in fewer.
        const high = this._buffer.readBigUInt64BE(startOffset);
        const low = this._buffer.readBigUInt64BE(startOffset + 8);
        let bigInt = (high << 64n) | low;

        // Interpret the sign bit of the full 128-bit value.
        if (high >> 63n === 1n) {
          bigInt -= 1n << 128n;
        }

        const intValue = Number(bigInt);
        // Values beyond Number's safe range are returned as BigInt to preserve
        // precision. This is common and expected (e.g. sysmontap counters), so
        // it is intentionally not logged.
        return BigInt(intValue) === bigInt ? intValue : bigInt;
      }
      default:
        throw new TypeError(`Unexpected integer byte count: ${intByteCount}. Cannot parse integer value.`);
    }
  }

  /**
   * Parses a real (floating point) value from the buffer
   * @param startOffset - The offset to start reading from
   * @param floatByteCount - The number of bytes to read
   * @returns The parsed floating point value
   */
  private _parseRealValue(startOffset: number, floatByteCount: number): number {
    switch (floatByteCount) {
      case 4:
        return this._buffer.readFloatBE(startOffset);
      case 8:
        return this._buffer.readDoubleBE(startOffset);
      default:
        throw new TypeError(`Unexpected float byte count: ${floatByteCount}. Cannot parse real value.`);
    }
  }

  /**
   * Parses a date value from the buffer
   * @param startOffset - The offset to start reading from
   * @returns The parsed Date object
   */
  private _parseDateValue(startOffset: number): Date {
    // Date is stored as a float, seconds since 2001-01-01
    const timestamp = this._buffer.readDoubleBE(startOffset);
    // Convert Apple epoch (2001-01-01) to Unix epoch (1970-01-01)
    return new Date((timestamp + APPLE_EPOCH_OFFSET) * 1000);
  }

  /**
   * Parses a data value from the buffer
   * @param startOffset - The offset to start reading from
   * @param objLength - The length of the data
   * @returns The parsed Buffer
   */
  private _parseDataValue(startOffset: number, objLength: number): Buffer {
    this._claimPayloadBytes(startOffset, objLength, 'Data');
    return Buffer.from(this._buffer.subarray(startOffset, startOffset + objLength));
  }

  /**
   * Parses an ASCII string from the buffer
   * @param startOffset - The offset to start reading from
   * @param objLength - The length of the string
   * @returns The parsed string
   */
  private _parseAsciiString(startOffset: number, objLength: number): string {
    this._claimPayloadBytes(startOffset, objLength, 'ASCII string');
    return this._buffer.toString('ascii', startOffset, startOffset + objLength);
  }

  /**
   * Parses a Unicode string from the buffer. Binary plists store them as UTF-16BE, so a copy is
   * byte swapped for Node's UTF-16LE decoder.
   * @param startOffset - The offset to start reading from
   * @param objLength - The length of the string in UTF-16 code units
   * @returns The parsed string
   */
  private _parseUnicodeString(startOffset: number, objLength: number): string {
    const bytesToRead = objLength * 2;
    this._claimPayloadBytes(startOffset, bytesToRead, 'Unicode string');
    return Buffer.from(this._buffer.subarray(startOffset, startOffset + bytesToRead))
      .swap16()
      .toString('utf16le');
  }

  /**
   * Parses a UID value from the buffer
   * @param startOffset - The offset to start reading from
   * @param uidByteCount - The number of bytes to read
   * @returns The parsed UID, kept distinct from integers so NSKeyedArchiver references stay recognizable
   */
  private _parseUidValue(startOffset: number, uidByteCount: number): PlistUID {
    return new PlistUID(this._readMultiByteInteger(startOffset, uidByteCount, 'UID'));
  }

  /**
   * Parses all objects in the binary plist
   */
  private _parseObjects(): void {
    for (let i = 0; i < this._numObjects; i++) {
      const objOffset = this._readOffset(i);
      if (objOffset < OBJECT_AREA_START || objOffset >= this._offsetTableOffset) {
        throw new RangeError(`Binary plist object ${i} offset ${objOffset} lies outside the object area.`);
      }
      const objType = this._buffer.readUInt8(objOffset) & 0xf0;
      const objInfo = this._buffer.readUInt8(objOffset) & 0x0f;

      let objLength = objInfo;
      let startOffset = objOffset + 1;

      // For objects with length > 15, the actual length follows
      if (objInfo === 0x0f) {
        const intType = this._buffer.readUInt8(startOffset) & 0xf0;
        if (intType !== BPLIST_TYPE.INT) {
          throw new TypeError(`Expected integer type for length at offset ${startOffset}`);
        }

        const intInfo = this._buffer.readUInt8(startOffset) & 0x0f;
        startOffset++;

        // Read the length based on the integer size
        const intByteCount = 1 << intInfo;
        objLength = this._readMultiByteInteger(startOffset, intByteCount, 'Object length');
        startOffset += intByteCount;
      }

      // Parse the object based on its type
      this._objectTable[i] = this._parseObjectByType(objType, objInfo, startOffset, objLength);
    }
  }

  /**
   * Parses an object based on its type
   * @param objType - The object type
   * @param objInfo - The object info
   * @param startOffset - The start offset
   * @param objLength - The object length
   * @returns The parsed object
   */
  private _parseObjectByType(
    objType: number,
    objInfo: number,
    startOffset: number,
    objLength: number,
  ): PlistValue | TempObject {
    switch (objType) {
      case BPLIST_TYPE.NULL:
        return this._parseNullType(objInfo);

      case BPLIST_TYPE.INT:
        return this._parseIntegerValue(startOffset, 1 << objInfo);

      case BPLIST_TYPE.REAL:
        return this._parseRealValue(startOffset, 1 << objInfo);

      case BPLIST_TYPE.DATE:
        return this._parseDateValue(startOffset);

      case BPLIST_TYPE.DATA:
        return this._parseDataValue(startOffset, objLength);

      case BPLIST_TYPE.STRING_ASCII:
        return this._parseAsciiString(startOffset, objLength);

      case BPLIST_TYPE.STRING_UNICODE:
        return this._parseUnicodeString(startOffset, objLength);

      case BPLIST_TYPE.UID:
        return this._parseUidValue(startOffset, objInfo + 1);

      case BPLIST_TYPE.ARRAY:
        return this._createTempArray(objLength, startOffset);

      case BPLIST_TYPE.DICT:
        return this._createTempDict(objLength, startOffset);

      default:
        throw new TypeError(`Unsupported binary plist object type: ${objType.toString(16)}`);
    }
  }

  /**
   * Parses a null type object
   * @param objInfo - The object info
   * @returns The parsed value (null, false, or true)
   */
  private _parseNullType(objInfo: number): PlistValue {
    switch (objInfo) {
      case 0x00:
        return null;
      case 0x08:
        return false;
      case 0x09:
        return true;
      case 0x0f:
        return null; // fill byte
      default:
        throw new TypeError(`Unexpected null type object info: 0x${objInfo.toString(16)}. Cannot parse null value.`);
    }
  }

  /**
   * Creates a temporary array object holding its element references
   * @param objLength - The array length
   * @param startOffset - The start offset of the references
   * @returns The temporary array object
   */
  private _createTempArray(objLength: number, startOffset: number): TempObject {
    return new TempObject('array', this._readObjectRefs(startOffset, objLength, 'Array'));
  }

  /**
   * Creates a temporary dictionary object holding its key references followed by its value references
   * @param objLength - The dictionary length
   * @param startOffset - The start offset of the references
   * @returns The temporary dictionary object
   */
  private _createTempDict(objLength: number, startOffset: number): TempObject {
    return new TempObject('dict', this._readObjectRefs(startOffset, objLength * 2, 'Dictionary'));
  }

  /**
   * Type guard to check if an object is a TempObject
   * @param obj - The object to check
   * @returns True if the object is a TempObject
   */
  private _isTempObject(obj: ObjectTableItem): obj is TempObject {
    return obj instanceof TempObject;
  }

  /**
   * Resolves references for arrays and dictionaries. Containers are filled depth first, after
   * the containers they reference, so every reference already points at a final value and a
   * container shared by several parents stays one object. A container reached again while it is
   * still being filled contains itself; CoreFoundation rejects such plists and so does this parser,
   * so callers never receive a cyclic structure.
   * @throws Error if a container contains itself
   */
  private _resolveReferences(): void {
    const visiting = new Uint8Array(this._numObjects);
    for (let root = 0; root < this._numObjects; root++) {
      if (!this._isTempObject(this._objectTable[root])) {
        continue;
      }
      const path = [root];
      const cursors = [0];
      visiting[root] = 1;
      while (path.length > 0) {
        const depth = path.length - 1;
        const index = path[depth];
        const obj = this._objectTable[index] as TempObject;
        if (cursors[depth] >= obj.refs.length) {
          this._objectTable[index] = obj.type === 'array' ? this._resolveArray(obj) : this._resolveDict(obj);
          visiting[index] = 0;
          path.pop();
          cursors.pop();
          continue;
        }
        const refIdx = obj.refs[cursors[depth]++];
        if (!this._isTempObject(this._objectTable[refIdx])) {
          continue;
        }
        if (visiting[refIdx]) {
          throw new Error(`Binary plist object ${refIdx} contains itself.`);
        }
        visiting[refIdx] = 1;
        path.push(refIdx);
        cursors.push(0);
      }
    }
  }

  /**
   * Builds the array for a temporary array object whose elements are already resolved
   * @param obj - The temporary array object
   * @returns The array
   */
  private _resolveArray(obj: TempObject): PlistArray {
    return obj.refs.map((ref) => this._objectTable[ref] as PlistValue);
  }

  /**
   * Builds the dictionary for a temporary dictionary object whose keys and values are already resolved
   * @param obj - The temporary dictionary object
   * @returns The dictionary
   * @throws TypeError if a key is not a string
   */
  private _resolveDict(obj: TempObject): PlistDictionary {
    const dict: PlistDictionary = {};
    const keyCount = obj.refs.length / 2;
    for (let j = 0; j < keyCount; j++) {
      const key = this._objectTable[obj.refs[j]];
      if (typeof key !== 'string') {
        throw new TypeError(`Dictionary key must be a string, got ${typeof key}`);
      }
      dict[key] = this._objectTable[obj.refs[keyCount + j]] as PlistValue;
    }
    return dict;
  }

  /**
   * Handles special case for the top object
   * @returns The final parsed value
   */
  private _handleTopObject(): PlistValue {
    // If the top object is an empty object but we have key-value pairs in the array format,
    // convert it to a proper object
    if (
      this._topObject === 0 &&
      this._objectTable[0] &&
      typeof this._objectTable[0] === 'object' &&
      !this._isTempObject(this._objectTable[0]) &&
      Object.keys(this._objectTable[0] as object).length === 0 &&
      this._objectTable.length > 1
    ) {
      return this._convertArrayToDict();
    }

    return this._objectTable[this._topObject] as PlistValue;
  }

  /**
   * Converts an array format to a dictionary
   * @returns The converted dictionary
   */
  private _convertArrayToDict(): PlistDictionary {
    const result: PlistDictionary = {};
    // Process the array in key-value pairs
    for (let i = 1; i < this._objectTable.length; i += 2) {
      const key = this._objectTable[i];
      if (i + 1 < this._objectTable.length && typeof key === 'string') {
        const value = this._objectTable[i + 1];
        if (!this._isTempObject(value)) {
          result[key] = value;
        }
      }
    }
    return result;
  }
}

/**
 * Parses a binary plist buffer into a JavaScript object
 * @param buffer - The binary plist data as a Buffer
 * @returns The parsed JavaScript object
 */
export function parseBinaryPlist(buffer: Buffer): PlistValue {
  const parser = new BinaryPlistParser(buffer);
  return parser.parse();
}

/**
 * Determines if a buffer is a binary plist
 * @param buffer - The buffer to check
 * @returns True if the buffer is a binary plist
 */
export function isBinaryPlist(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.slice(0, 8).equals(BPLIST_MAGIC_AND_VERSION);
}
