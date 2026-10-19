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
  const flags = isVideo && unit.isKeyFrame ? FLAG_KEYFRAME : 0;
  let track = ApstTrack.Jpeg;
  if (isVideo) {
    track = unit.track === 'audio' ? ApstTrack.Audio : ApstTrack.Video;
  }
  return [writeHeader(track, flags, unit.sequence, unit.timestampMicros, unit.data.length), unit.data];
}

/** Single concatenated buffer variant of {@link encodeApstFrame}. */
export function encodeApstFrameBuffer(unit: VideoAccessUnit | JpegFrame): Buffer {
  return Buffer.concat(encodeApstFrame(unit));
}

export function encodeApstEndOfStream(track: ApstTrack, sequence: number, timestampMicros: number): Buffer {
  return writeHeader(track, FLAG_EOS, sequence, timestampMicros, 0);
}

interface PendingHeader {
  track: ApstTrack;
  flags: number;
  sequence: number;
  timestampMicros: number;
  payloadLength: number;
}

/**
 * Incremental parser; carries a trailing partial frame across `push` calls. Chunks are queued and
 * the header is parsed once, so a large frame arriving in small chunks is copied once, not per chunk.
 */
export class ApstParser {
  private chunks: Buffer[] = [];
  private size = 0;
  private header: PendingHeader | undefined;

  /** @throws {MediaProxyProtocolError} on bad magic/version or an implausible payload length. */
  *push(chunk: Buffer): Generator<ApstFrame> {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
    for (;;) {
      if (!this.header) {
        if (this.size < APST_HEADER_SIZE) {
          return;
        }
        this.header = this.parseHeader(this.take(APST_HEADER_SIZE));
      }
      if (this.size < this.header.payloadLength) {
        return;
      }
      const {track, flags, sequence, timestampMicros, payloadLength} = this.header;
      this.header = undefined;
      yield {
        track,
        sequence,
        timestampMicros,
        data: this.take(payloadLength),
        isConfig: (flags & FLAG_CONFIG) !== 0,
        isKeyFrame: (flags & FLAG_KEYFRAME) !== 0,
        isEndOfStream: (flags & FLAG_EOS) !== 0,
      };
    }
  }

  private parseHeader(buf: Buffer): PendingHeader {
    if (!buf.subarray(0, 4).equals(MAGIC)) {
      throw new MediaProxyProtocolError('Stream desynchronized: unexpected APST magic bytes');
    }
    if (buf.readUInt8(4) !== APST_VERSION) {
      throw new MediaProxyProtocolError(`Unsupported APST version ${buf.readUInt8(4)}`);
    }
    const payloadLength = buf.readUInt32BE(24);
    if (payloadLength > MAX_PAYLOAD) {
      throw new MediaProxyProtocolError(`Implausible APST payload length ${payloadLength}`);
    }
    return {
      track: buf.readUInt8(5) as ApstTrack,
      flags: buf.readUInt8(6),
      sequence: Number(buf.readBigUInt64BE(8)),
      timestampMicros: Number(buf.readBigUInt64BE(16)),
      payloadLength,
    };
  }

  /** Removes the first `n` queued bytes into one new buffer (a single copy). */
  private take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const count = Math.min(head.length, n - offset);
      head.copy(out, offset, 0, count);
      offset += count;
      if (count === head.length) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(count);
      }
    }
    this.size -= n;
    return out;
  }
}
