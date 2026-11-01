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
import {setDictionaryEntry} from './utils.js';

const log = getLogger('Plist');

const OBJECT_AREA_START = BPLIST_MAGIC_AND_VERSION.length;

/**
 * Widest integer accepted for an object length. Writers emit 1, 2, 4 or 8 bytes, and a wider
 * length could not describe anything that fits in memory anyway.
 */
const MAX_LENGTH_INT_BYTES = 8;

/**
 * Object types whose marker is followed by a length, with a separate length integer when the
 * length does not fit the marker's low 4 bits.
 */
const VARIABLE_LENGTH_TYPES = new Set([
  BPLIST_TYPE.DATA,
  BPLIST_TYPE.STRING_ASCII,
  BPLIST_TYPE.STRING_UNICODE,
  BPLIST_TYPE.ARRAY,
  BPLIST_TYPE.SET,
  BPLIST_TYPE.DICT,
]);

/**
 * How many values the parsed result may hold per input byte once shared containers are counted
 * for every parent that references them. A plist without sharing never exceeds one value per
 * byte, so this leaves room for legitimate sharing while stopping a few dozen bytes of nested
 * shared arrays from expanding into billions of values for anything that walks the result.
 */
const MAX_EXPANDED_VALUES_PER_BYTE = 64;

/**
 * Raised when a binary plist is malformed or would need more resources than its size justifies.
 */
export class BinaryPlistError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BinaryPlistError';
  }
}

/**
 * A container whose references have not been resolved yet. A class so it can be told apart from
 * parsed dictionaries, which may have the same keys. `refCount` references follow `startOffset`:
 * the elements of an array, or the keys followed by the values of a dictionary.
 */
class TempObject {
  readonly type: 'array' | 'dict';
  readonly startOffset: number;
  readonly refCount: number;
  visiting = false;
  resolved?: PlistArray | PlistDictionary;
  expandedSize = 0;

  constructor(type: 'array' | 'dict', startOffset: number, refCount: number) {
    this.type = type;
    this.startOffset = startOffset;
    this.refCount = refCount;
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
  private readonly _maxExpandedSize: number;
  private readonly _objectTable: ObjectTableItem[];

  /**
   * Creates a new BinaryPlistParser
   * @param buffer - The binary plist data as a Buffer
   */
  constructor(buffer: Buffer) {
    this._buffer = buffer;
    this._objectTable = [];
    this._maxExpandedSize = buffer.length * MAX_EXPANDED_VALUES_PER_BYTE;

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
   * @throws BinaryPlistError if the buffer is not a valid binary plist
   */
  private _validateHeader(): void {
    if (this._buffer.length < 8 || !this._buffer.subarray(0, 8).equals(BPLIST_MAGIC_AND_VERSION)) {
      throw new BinaryPlistError('Not a binary plist. Expected bplist00 magic.');
    }
  }

  /**
   * Parses and validates the trailer section of the binary plist. Every trailer field comes from
   * the peer, so each one is checked against the buffer before it is allowed to bound any loop.
   * @throws BinaryPlistError if the buffer is too small to contain a trailer or the trailer is inconsistent
   */
  private _parseTrailer(): void {
    if (this._buffer.length < BPLIST_TRAILER_SIZE) {
      throw new BinaryPlistError('Binary plist is too small to contain a trailer.');
    }

    const trailer = this._buffer.subarray(this._buffer.length - BPLIST_TRAILER_SIZE);
    const offsetSize = trailer.readUInt8(6);
    const objectRefSize = trailer.readUInt8(7);
    const numObjects = trailer.readBigUInt64BE(8);
    const topObject = trailer.readBigUInt64BE(16);
    const offsetTableOffset = trailer.readBigUInt64BE(24);
    const offsetTableEnd = BigInt(this._buffer.length - BPLIST_TRAILER_SIZE);

    if (offsetSize < 1 || offsetSize > 8) {
      throw new BinaryPlistError(
        `Invalid binary plist trailer: offset size must be between 1 and 8, got ${offsetSize}.`,
      );
    }
    if (objectRefSize < 1 || objectRefSize > 8) {
      throw new BinaryPlistError(
        `Invalid binary plist trailer: object reference size must be between 1 and 8, got ${objectRefSize}.`,
      );
    }
    if (numObjects < 1n) {
      throw new BinaryPlistError('Invalid binary plist trailer: object count must be at least 1.');
    }
    if (topObject >= numObjects) {
      throw new BinaryPlistError(
        `Invalid binary plist trailer: top object ${topObject} is out of range for ${numObjects} objects.`,
      );
    }
    if (
      offsetTableOffset <= BigInt(OBJECT_AREA_START) ||
      offsetTableOffset + numObjects * BigInt(offsetSize) > offsetTableEnd
    ) {
      throw new BinaryPlistError(
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
        throw new BinaryPlistError(
          `${valueName} value ${result} exceeds MAX_SAFE_INTEGER. Cannot safely convert to number.`,
        );
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
   * @throws BinaryPlistError if the reference is past the object count
   */
  private _readObjectRef(offset: number): number {
    const ref = this._readMultiByteInteger(offset, this._objectRefSize, 'Object reference');
    if (ref >= this._numObjects) {
      throw new BinaryPlistError(
        `Binary plist object reference ${ref} is out of range for ${this._numObjects} objects.`,
      );
    }
    return ref;
  }

  /**
   * Reads one of a container's references straight from the buffer, so no copy of the reference
   * list is ever held in memory
   * @param obj - The container
   * @param position - The position of the reference within the container's reference list
   * @returns The object index the reference points at
   */
  private _readContainerRef(obj: TempObject, position: number): number {
    return this._readObjectRef(obj.startOffset + position * this._objectRefSize);
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
   * Checks that an object's payload lies inside the object area and charges it against the shared
   * budget. Objects in a well-formed plist never overlap, so their payloads can never add up to more
   * than the object area holds; objects laid over each other are rejected before their combined
   * size can outgrow the input.
   * @param startOffset - The offset where the payload starts
   * @param byteCount - The number of payload bytes the object claims
   * @param valueName - Name of the value type for error messages
   * @throws BinaryPlistError if the payload runs past the object area or exhausts the budget
   */
  private _claimPayloadBytes(startOffset: number, byteCount: number, valueName: string): void {
    if (startOffset + byteCount > this._offsetTableOffset) {
      throw new BinaryPlistError(
        `${valueName} at offset ${startOffset} claims ${byteCount} bytes past the end of the object area.`,
      );
    }
    this._payloadBudget -= byteCount;
    if (this._payloadBudget < 0) {
      throw new BinaryPlistError('Binary plist objects claim more bytes in total than the object area holds.');
    }
  }

  /**
   * Parses an integer. Only the 8-byte form is signed.
   * @param startOffset - The offset to start reading from
   * @param intByteCount - The number of bytes to read
   * @returns The parsed integer value (number or bigint)
   */
  private _parseIntegerValue(startOffset: number, intByteCount: number): number | bigint {
    this._claimPayloadBytes(startOffset, intByteCount, 'Integer');

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
        throw new BinaryPlistError(`Unexpected integer byte count: ${intByteCount}. Cannot parse integer value.`);
    }
  }

  /**
   * Parses a real (floating point) value from the buffer
   * @param startOffset - The offset to start reading from
   * @param floatByteCount - The number of bytes to read
   * @returns The parsed floating point value
   */
  private _parseRealValue(startOffset: number, floatByteCount: number): number {
    this._claimPayloadBytes(startOffset, floatByteCount, 'Real');
    switch (floatByteCount) {
      case 4:
        return this._buffer.readFloatBE(startOffset);
      case 8:
        return this._buffer.readDoubleBE(startOffset);
      default:
        throw new BinaryPlistError(`Unexpected float byte count: ${floatByteCount}. Cannot parse real value.`);
    }
  }

  /**
   * Parses a date value from the buffer
   * @param startOffset - The offset to start reading from
   * @returns The parsed Date object
   */
  private _parseDateValue(startOffset: number): Date {
    this._claimPayloadBytes(startOffset, 8, 'Date');
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
    this._claimPayloadBytes(startOffset, uidByteCount, 'UID');
    return new PlistUID(this._readMultiByteInteger(startOffset, uidByteCount, 'UID'));
  }

  /**
   * Parses every object listed in the offset table. Each entry must point at its own object inside
   * the object area; writers never list an object twice, and refusing it keeps the work and memory
   * per entry tied to the bytes that entry describes.
   * @throws BinaryPlistError if an offset lies outside the object area or repeats an earlier entry
   */
  private _parseObjects(): void {
    const seenOffsets = new Uint8Array(Math.ceil(this._offsetTableOffset / 8));
    for (let i = 0; i < this._numObjects; i++) {
      const objOffset = this._readOffset(i);
      if (objOffset < OBJECT_AREA_START || objOffset >= this._offsetTableOffset) {
        throw new BinaryPlistError(`Binary plist object ${i} offset ${objOffset} lies outside the object area.`);
      }
      const seenByte = objOffset >> 3;
      const seenBit = 1 << (objOffset & 7);
      if (seenOffsets[seenByte] & seenBit) {
        throw new BinaryPlistError(`Binary plist offset table points at offset ${objOffset} more than once.`);
      }
      seenOffsets[seenByte] |= seenBit;
      this._objectTable[i] = this._parseObjectAt(objOffset);
    }
  }

  /**
   * Parses the object whose marker byte sits at the given offset
   * @param objOffset - The offset of the marker byte
   * @returns The parsed value, or a TempObject for a container
   * @throws BinaryPlistError if the object's length integer is malformed
   */
  private _parseObjectAt(objOffset: number): ObjectTableItem {
    const marker = this._buffer.readUInt8(objOffset);
    const objType = marker & 0xf0;
    const objInfo = marker & 0x0f;

    let objLength = objInfo;
    let startOffset = objOffset + 1;

    // For variable-length objects longer than 14, the length follows as an integer object
    if (objInfo === 0x0f && VARIABLE_LENGTH_TYPES.has(objType)) {
      this._claimPayloadBytes(startOffset, 1, 'Object length marker');
      const intMarker = this._buffer.readUInt8(startOffset);
      if ((intMarker & 0xf0) !== BPLIST_TYPE.INT) {
        throw new BinaryPlistError(`Expected integer type for length at offset ${startOffset}`);
      }
      const intByteCount = 1 << (intMarker & 0x0f);
      if (intByteCount > MAX_LENGTH_INT_BYTES) {
        throw new BinaryPlistError(
          `Binary plist object length at offset ${startOffset} uses a ${intByteCount}-byte integer, at most ${MAX_LENGTH_INT_BYTES} bytes are allowed.`,
        );
      }
      startOffset++;
      this._claimPayloadBytes(startOffset, intByteCount, 'Object length');
      objLength = this._readMultiByteInteger(startOffset, intByteCount, 'Object length');
      startOffset += intByteCount;
    }

    return this._parseObjectByType(objType, objInfo, startOffset, objLength);
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
        return this._createTempObject('array', startOffset, objLength);

      case BPLIST_TYPE.DICT:
        return this._createTempObject('dict', startOffset, objLength * 2);

      default:
        throw new BinaryPlistError(`Unsupported binary plist object type: ${objType.toString(16)}`);
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
        throw new BinaryPlistError(
          `Unexpected null type object info: 0x${objInfo.toString(16)}. Cannot parse null value.`,
        );
    }
  }

  /**
   * Creates the placeholder for a container after bounding its reference list by the object area
   * @param type - Whether the container is an array or a dictionary
   * @param startOffset - The start offset of the references
   * @param refCount - The number of references the container holds
   * @returns The temporary container object
   */
  private _createTempObject(type: 'array' | 'dict', startOffset: number, refCount: number): TempObject {
    this._claimPayloadBytes(startOffset, refCount * this._objectRefSize, type === 'array' ? 'Array' : 'Dictionary');
    return new TempObject(type, startOffset, refCount);
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
   * Resolves references for arrays and dictionaries. Containers are filled depth first, after the
   * containers they reference, so every reference already points at a final value and a container
   * shared by several parents stays one object. A container reached again while it is still being
   * filled contains itself; CoreFoundation rejects such plists and so does this parser, so callers
   * never receive a cyclic structure.
   * @throws BinaryPlistError if a container contains itself or the result outgrows the input
   */
  private _resolveReferences(): void {
    for (let root = 0; root < this._numObjects; root++) {
      const rootObj = this._objectTable[root];
      if (!this._isTempObject(rootObj) || rootObj.resolved !== undefined) {
        continue;
      }
      const path = [rootObj];
      const cursors = [0];
      rootObj.visiting = true;
      while (path.length > 0) {
        const depth = path.length - 1;
        const obj = path[depth];
        if (cursors[depth] >= obj.refCount) {
          obj.resolved = obj.type === 'array' ? this._resolveArray(obj) : this._resolveDict(obj);
          obj.visiting = false;
          path.pop();
          cursors.pop();
          continue;
        }
        const ref = this._readContainerRef(obj, cursors[depth]++);
        const child = this._objectTable[ref];
        if (!this._isTempObject(child) || child.resolved !== undefined) {
          continue;
        }
        if (child.visiting) {
          throw new BinaryPlistError(`Binary plist object ${ref} contains itself.`);
        }
        child.visiting = true;
        path.push(child);
        cursors.push(0);
      }
    }

    for (let i = 0; i < this._numObjects; i++) {
      const item = this._objectTable[i];
      if (this._isTempObject(item)) {
        this._objectTable[i] = item.resolved;
      }
    }
  }

  /**
   * Returns the final value of an object that has already been resolved
   * @param ref - The object index
   * @returns The value
   */
  private _valueAt(ref: number): PlistValue {
    const item = this._objectTable[ref];
    return this._isTempObject(item) ? item.resolved : item;
  }

  /**
   * Returns how many values an object contributes to a parent once shared containers are counted
   * for every parent that references them
   * @param ref - The object index
   * @returns The flattened size
   */
  private _expandedSizeAt(ref: number): number {
    const item = this._objectTable[ref];
    return this._isTempObject(item) ? item.expandedSize : 1;
  }

  /**
   * Records how large a container is once flattened and rejects results that outgrow the input
   * @param obj - The container
   * @param expandedSize - The flattened size of the container and everything below it
   * @throws BinaryPlistError if the flattened size passes the limit for this plist
   */
  private _setExpandedSize(obj: TempObject, expandedSize: number): void {
    if (expandedSize > this._maxExpandedSize) {
      throw new BinaryPlistError(
        `Binary plist expands to more than ${this._maxExpandedSize} values once shared containers are counted for every parent.`,
      );
    }
    obj.expandedSize = expandedSize;
  }

  /**
   * Builds the array for a temporary array object whose elements are already resolved
   * @param obj - The temporary array object
   * @returns The array
   */
  private _resolveArray(obj: TempObject): PlistArray {
    const array: PlistArray = [];
    let expandedSize = 1;
    for (let j = 0; j < obj.refCount; j++) {
      const ref = this._readContainerRef(obj, j);
      array.push(this._valueAt(ref));
      expandedSize += this._expandedSizeAt(ref);
    }
    this._setExpandedSize(obj, expandedSize);
    return array;
  }

  /**
   * Builds the dictionary for a temporary dictionary object whose keys and values are already resolved
   * @param obj - The temporary dictionary object
   * @returns The dictionary
   * @throws BinaryPlistError if a key is not a string
   */
  private _resolveDict(obj: TempObject): PlistDictionary {
    const dict: PlistDictionary = {};
    const keyCount = obj.refCount / 2;
    let expandedSize = 1;
    for (let j = 0; j < keyCount; j++) {
      const key = this._valueAt(this._readContainerRef(obj, j));
      if (typeof key !== 'string') {
        throw new BinaryPlistError(`Dictionary key must be a string, got ${typeof key}`);
      }
      const valueRef = this._readContainerRef(obj, keyCount + j);
      setDictionaryEntry(dict, key, this._valueAt(valueRef));
      expandedSize += 1 + this._expandedSizeAt(valueRef);
    }
    this._setExpandedSize(obj, expandedSize);
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
        setDictionaryEntry(result, key, this._objectTable[i + 1] as PlistValue);
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
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(BPLIST_MAGIC_AND_VERSION);
}
