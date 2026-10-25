import {plist} from '@appium/support';

import {log} from '../logger.js';

const HEADER_LENGTH = 4;
const MB = 1024 * 1024;
const DEFAULT_MAX_FRAME_LENGTH = 20 * MB;
const MIN_PRINTABLE_CHAR = 32;
const MAX_PRINTABLE_CHAR = 126;
const HEX_DUMP_CHARS_PER_LINE = 19;

/** Resolves the max frame size: explicit option, then APPIUM_IOS_MAX_FRAME_SIZE, then 20 MB. */
export function getMaxFrameLength(explicit?: number): number {
  if (explicit && explicit > 0) {
    return explicit;
  }
  const parsed = Number.parseInt(process.env.APPIUM_IOS_MAX_FRAME_SIZE ?? '', 10);
  return parsed > 0 ? parsed : DEFAULT_MAX_FRAME_LENGTH;
}

/** Thrown when the stream cannot be decoded; `decoded` holds the messages parsed before the failure. */
export class WebInspectorFrameError extends Error {
  constructor(
    message: string,
    readonly decoded: any[],
  ) {
    super(message);
    this.name = 'WebInspectorFrameError';
  }
}

/**
 * Incremental decoder for Web Inspector frames: a 4-byte big-endian
 * payload length followed by a binary plist.
 */
export class WebInspectorFrameDecoder {
  private pending: Buffer[] = [];
  private pendingLength = 0;
  private readonly maxFrameLength: number;

  constructor(maxFrameLength?: number) {
    this.maxFrameLength = getMaxFrameLength(maxFrameLength);
  }

  /**
   * Feeds a chunk of socket data and returns all fully received messages.
   * @throws {WebInspectorFrameError} on an oversize frame or an invalid plist
   */
  push(chunk: Buffer): any[] {
    this.pending.push(chunk);
    this.pendingLength += chunk.length;
    const messages: any[] = [];
    // chunks are only merged once a whole frame is available, so large frames cost linear time
    while (this.pendingLength >= HEADER_LENGTH) {
      const header = this.pending[0].length >= HEADER_LENGTH ? this.pending[0] : this.merge();
      const payloadLength = header.readUInt32BE(0);
      if (payloadLength > this.maxFrameLength) {
        this.pending = [];
        this.pendingLength = 0;
        throw new WebInspectorFrameError(
          `The frame is bigger than expected. Length: ${payloadLength} bytes, max: ${this.maxFrameLength} bytes. ` +
            'Consider increasing webInspectorMaxFrameLength or APPIUM_IOS_MAX_FRAME_SIZE',
          messages,
        );
      }
      const frameLength = HEADER_LENGTH + payloadLength;
      if (this.pendingLength < frameLength) {
        break;
      }
      const buffer = this.merge();
      const payload = buffer.subarray(HEADER_LENGTH, frameLength);
      const rest = buffer.subarray(frameLength);
      this.pending = rest.length ? [rest] : [];
      this.pendingLength = rest.length;
      if (!payload.length) {
        continue;
      }
      try {
        const message = plist.parsePlist(payload);
        if (message) {
          messages.push(message);
        }
      } catch (err: any) {
        throw new WebInspectorFrameError(`Cannot parse a Web Inspector frame: ${err.message}`, messages);
      }
    }
    return messages;
  }

  private merge(): Buffer {
    const merged = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    this.pending = [merged];
    return merged;
  }
}

/** Encodes a message as a length-prefixed binary plist frame. */
export function encodeWebInspectorFrame(message: any): Buffer {
  if (message == null) {
    throw new Error('Cannot send a null object');
  }
  let payload: Buffer;
  try {
    payload = plist.createBinaryPlist(message);
  } catch (e) {
    // bplist-creator chokes on nullish values (node-bplist-creator/issues/29)
    if (!(e instanceof TypeError)) {
      throw e;
    }
    payload = plist.createBinaryPlist(cleanupRpcObject(message));
  }
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/** Recursively removes nullish values from plain objects and arrays. */
export function cleanupRpcObject(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.filter((value) => value != null).map(cleanupRpcObject);
  }
  if (obj === null || typeof obj !== 'object' || Buffer.isBuffer(obj) || obj instanceof Date) {
    return obj;
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value != null) {
      result[key] = cleanupRpcObject(value);
    }
  }
  return result;
}

/** Logs data as hex + printable characters, in the format of ios-webkit-debug-proxy/socat. */
export function logHexDump(direction: 'sent' | 'received', data: Buffer): void {
  log.debug(`Data ${direction}, length: ${data.length}`);
  for (let i = 0; i < data.length; i += HEX_DUMP_CHARS_PER_LINE) {
    const line = data.subarray(i, i + HEX_DUMP_CHARS_PER_LINE);
    const hex = Array.from({length: HEX_DUMP_CHARS_PER_LINE}, (_, j) =>
      j < line.length ? line[j].toString(16).toUpperCase().padStart(2, '0') : '  ',
    );
    const chars = Array.from(line, (c) =>
      c < MIN_PRINTABLE_CHAR || c > MAX_PRINTABLE_CHAR ? '.' : String.fromCharCode(c),
    );
    log.debug(`${hex.join(' ')} ${chars.join('')}`);
  }
}
