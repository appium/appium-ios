import {DATA_CHANNEL_HEADER_SIZE, DATA_CHANNEL_MAGIC, DATA_CHANNEL_MESSAGE_TYPE} from './constants.js';

export interface DataChannelHeader {
  type: bigint;
  fileId: bigint;
  size: bigint;
}

/**
 * Encodes a data-channel message header.
 */
export function encodeDataChannelHeader({type, fileId, size}: DataChannelHeader): Buffer {
  const header = Buffer.alloc(DATA_CHANNEL_HEADER_SIZE);
  DATA_CHANNEL_MAGIC.copy(header, 0);
  header.writeBigUInt64BE(type, 8);
  // Offset 16 is reserved and always zero.
  header.writeBigUInt64BE(fileId, 24);
  header.writeBigUInt64BE(size, 32);
  return header;
}

/**
 * Decodes a data-channel message header.
 *
 * @throws {Error} If the buffer is too short or does not start with the magic.
 */
export function decodeDataChannelHeader(buffer: Buffer): DataChannelHeader {
  if (buffer.length < DATA_CHANNEL_HEADER_SIZE) {
    throw new Error(
      `File service data header must be ${DATA_CHANNEL_HEADER_SIZE} bytes long, got ${buffer.length} bytes`,
    );
  }
  const magic = buffer.subarray(0, DATA_CHANNEL_MAGIC.length);
  if (!magic.equals(DATA_CHANNEL_MAGIC)) {
    throw new Error(`File service data header has an invalid magic value '${magic.toString('hex')}'`);
  }
  return {
    type: buffer.readBigUInt64BE(8),
    fileId: buffer.readBigUInt64BE(24),
    size: buffer.readBigUInt64BE(32),
  };
}

/**
 * Builds the request that asks the device to send a file announced by `RetrieveFile`.
 */
export function buildFileDataRequest(fileId: bigint): Buffer {
  return encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA, fileId, size: 0n});
}

type DecoderState = 'header' | 'body' | 'confirmation' | 'done';

/**
 * Incremental decoder for the device's reply to a file data request:
 * a `FILE_DATA` header carrying the file size, the file bytes, then a
 * `TRANSFER_COMPLETE` confirmation. Feed it socket chunks in order.
 */
export class FileDataDecoder {
  private state: DecoderState = 'header';
  private pending: Buffer = Buffer.alloc(0);
  private remaining = 0n;
  private _size: bigint | undefined;

  constructor(private readonly fileId: bigint) {}

  /** Whether the confirmation has been received. */
  get isDone(): boolean {
    return this.state === 'done';
  }

  /** File size announced by the device, once its header has been received. */
  get size(): bigint | undefined {
    return this._size;
  }

  /**
   * Consumes a chunk and returns the file bytes it contained.
   *
   * @throws {Error} If a header is malformed, refers to another file, or bytes
   * arrive after the confirmation.
   */
  push(chunk: Buffer): Buffer[] {
    const payload: Buffer[] = [];
    let data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);

    while (data.length > 0) {
      if (this.state === 'done') {
        throw new Error(`Received ${data.length} unexpected bytes after the file transfer completed`);
      }

      if (this.state === 'body') {
        const take = data.length < this.remaining ? data.length : Number(this.remaining);
        payload.push(data.subarray(0, take));
        data = data.subarray(take);
        this.remaining -= BigInt(take);
        if (this.remaining === 0n) {
          this.state = 'confirmation';
        }
        continue;
      }

      if (data.length < DATA_CHANNEL_HEADER_SIZE) {
        this.pending = Buffer.from(data);
        break;
      }
      const header = this.parseHeader(data.subarray(0, DATA_CHANNEL_HEADER_SIZE));
      data = data.subarray(DATA_CHANNEL_HEADER_SIZE);
      if (this.state === 'header') {
        this._size = header.size;
        this.remaining = header.size;
        this.state = header.size === 0n ? 'confirmation' : 'body';
      } else {
        this.state = 'done';
      }
    }
    return payload;
  }

  private parseHeader(buffer: Buffer): DataChannelHeader {
    const header = decodeDataChannelHeader(buffer);
    const expectedType =
      this.state === 'header' ? DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA : DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE;
    if (header.type !== expectedType) {
      throw new Error(`Expected a file service data message of type ${expectedType}, got type ${header.type}`);
    }
    if (header.fileId !== this.fileId) {
      throw new Error(`Expected data for file ID ${this.fileId}, got data for file ID ${header.fileId}`);
    }
    return header;
  }
}
