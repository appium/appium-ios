import {MediaProxyProtocolError} from '../errors.js';
import type {JpegFrame, VideoAccessUnit} from '../types.js';

/**
 * APST wire framing, identical to the Android settings app's streaming protocol
 * (`io.appium.settings.streaming.StreamProtocol`), so one client can consume both platforms.
 * 28-byte big-endian header: magic "APST", version, track, flags, reserved, u64 sequence,
 * u64 timestampMicros, u32 payloadLength; then the payload.
 */
export enum ApstTrack {
  Jpeg = 0,
  Video = 1,
  Audio = 2,
}

export const APST_VERSION = 1;
export const APST_HEADER_SIZE = 28;
const MAGIC = Buffer.from('APST', 'ascii');
const FLAG_CONFIG = 0x01;
const FLAG_KEYFRAME = 0x02;
const FLAG_EOS = 0x04;
/** Sanity bound on a single payload; anything larger means the stream is desynchronized. */
const MAX_PAYLOAD = 64 * 1024 * 1024;

export interface ApstFrame {
  track: ApstTrack;
  sequence: number;
  timestampMicros: number;
  data: Buffer;
  isConfig: boolean;
  isKeyFrame: boolean;
  isEndOfStream: boolean;
}

function writeHeader(
  track: ApstTrack,
  flags: number,
  sequence: number,
  timestampMicros: number,
  payloadLength: number,
): Buffer {
  const header = Buffer.alloc(APST_HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(APST_VERSION, 4);
  header.writeUInt8(track, 5);
  header.writeUInt8(flags, 6);
  header.writeBigUInt64BE(BigInt(sequence), 8);
  header.writeBigUInt64BE(BigInt(timestampMicros), 16);
  header.writeUInt32BE(payloadLength, 24);
  return header;
}

/** Returns `[header, payload]` so callers can `socket.write` both without concatenating. */
export function encodeApstFrame(unit: VideoAccessUnit | JpegFrame): [Buffer, Buffer] {
  const isVideo = 'track' in unit;
  const flags = isVideo ? (unit.isConfig ? FLAG_CONFIG : 0) | (unit.isKeyFrame ? FLAG_KEYFRAME : 0) : 0;
  return [
    writeHeader(
      isVideo ? ApstTrack.Video : ApstTrack.Jpeg,
      flags,
      unit.sequence,
      unit.timestampMicros,
      unit.data.length,
    ),
    unit.data,
  ];
}

/** Single concatenated buffer variant of {@link encodeApstFrame}. */
export function encodeApstFrameBuffer(unit: VideoAccessUnit | JpegFrame): Buffer {
  return Buffer.concat(encodeApstFrame(unit));
}

export function encodeApstEndOfStream(track: ApstTrack, sequence: number, timestampMicros: number): Buffer {
  return writeHeader(track, FLAG_EOS, sequence, timestampMicros, 0);
}

/** Incremental parser; carries a trailing partial frame across `push` calls. */
export class ApstParser {
  private buf: Buffer = Buffer.alloc(0);

  /** @throws {MediaProxyProtocolError} on bad magic/version or an implausible payload length. */
  *push(chunk: Buffer): Generator<ApstFrame> {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < APST_HEADER_SIZE) {
        return;
      }
      if (!this.buf.subarray(0, 4).equals(MAGIC)) {
        throw new MediaProxyProtocolError('Stream desynchronized: unexpected APST magic bytes');
      }
      if (this.buf.readUInt8(4) !== APST_VERSION) {
        throw new MediaProxyProtocolError(`Unsupported APST version ${this.buf.readUInt8(4)}`);
      }
      const payloadLength = this.buf.readUInt32BE(24);
      if (payloadLength > MAX_PAYLOAD) {
        throw new MediaProxyProtocolError(`Implausible APST payload length ${payloadLength}`);
      }
      const total = APST_HEADER_SIZE + payloadLength;
      if (this.buf.length < total) {
        return;
      }
      const flags = this.buf.readUInt8(6);
      const frame: ApstFrame = {
        track: this.buf.readUInt8(5) as ApstTrack,
        sequence: Number(this.buf.readBigUInt64BE(8)),
        timestampMicros: Number(this.buf.readBigUInt64BE(16)),
        data: Buffer.from(this.buf.subarray(APST_HEADER_SIZE, total)),
        isConfig: (flags & FLAG_CONFIG) !== 0,
        isKeyFrame: (flags & FLAG_KEYFRAME) !== 0,
        isEndOfStream: (flags & FLAG_EOS) !== 0,
      };
      this.buf = this.buf.subarray(total);
      yield frame;
    }
  }
}
