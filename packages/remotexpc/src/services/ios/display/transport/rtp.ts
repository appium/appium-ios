/**
 * Minimal RTP (RFC 3550) receive path for the DisplayService media streams:
 * a UDP socket bound on the tunnel plus just enough header parsing to recover
 * payloads, marker bits and sequence numbers.
 */
import {type RemoteInfo, type Socket, createSocket} from 'node:dgram';

import {getLogger} from '../../../../lib/logger.js';

const log = getLogger('MediaReceiver');

/** Fixed RTP header size, before CSRC entries and any extension header. */
const RTP_HEADER_SIZE = 12;

// RTCP packet types (200..207) alias into the RTP payload-type field as 64..95
// once the marker bit is masked off, which is how they are told apart on a
// port that carries both.
const RTCP_PAYLOAD_TYPE_MIN = 64;
const RTCP_PAYLOAD_TYPE_MAX = 95;

/** A parsed RTP packet. */
export interface RtpPacket {
  /** 7-bit payload type identifying the codec/stream. */
  payloadType: number;
  /** Marker bit; set on the last packet of an access unit for video. */
  marker: boolean;
  /** 16-bit sequence number, wrapping. */
  sequence: number;
  /** 32-bit media-clock timestamp. */
  timestamp: number;
  /** Synchronization source identifier. */
  ssrc: number;
  /** Payload following the header, CSRC list and extension header. */
  payload: Buffer;
}

/**
 * Parses an RTP packet.
 *
 * Returns `undefined` for datagrams that are too short or that are RTCP rather
 * than RTP, so callers can simply skip them.
 */
export function parseRtpPacket(data: Buffer): RtpPacket | undefined {
  if (data.length < RTP_HEADER_SIZE) {
    return undefined;
  }
  const payloadType = data[1] & 0x7f;
  if (payloadType >= RTCP_PAYLOAD_TYPE_MIN && payloadType <= RTCP_PAYLOAD_TYPE_MAX) {
    return undefined;
  }

  const csrcCount = data[0] & 0x0f;
  let headerLength = RTP_HEADER_SIZE + csrcCount * 4;
  if (data[0] & 0x10) {
    // Extension header: 2-byte profile id, then a 2-byte length in 32-bit words.
    if (data.length < headerLength + 4) {
      return undefined;
    }
    headerLength += 4 + data.readUInt16BE(headerLength + 2) * 4;
  }
  if (data.length < headerLength) {
    return undefined;
  }

  return {
    payloadType,
    marker: (data[1] & 0x80) !== 0,
    sequence: data.readUInt16BE(2),
    timestamp: data.readUInt32BE(4),
    ssrc: data.readUInt32BE(8),
    payload: data.subarray(headerLength),
  };
}

/** Returns whether `sequence` immediately follows `previous`, modulo 2^16. */
export function isNextSequence(previous: number, sequence: number): boolean {
  return sequence === ((previous + 1) & 0xffff);
}

/**
 * Receive-buffer sizes attempted in order when binding. A large buffer absorbs
 * event-loop stalls that would otherwise show up as kernel UDP drops; the
 * kernel caps the request (`kern.ipc.maxsockbuf`, ~8 MB on macOS), so the
 * smaller fallbacks matter.
 */
const RECEIVE_BUFFER_SIZES = [4 * 1024 * 1024, 1 * 1024 * 1024, 256 * 1024];

/**
 * The most datagrams held for the consumer. The kernel buffer already holds a few thousand, so this is only
 * reached when the consumer stalls; further datagrams are dropped rather than growing memory without limit.
 */
export const MAX_QUEUED_DATAGRAMS = 8192;

/** Strips an IPv6 zone id (`fe80::1%en0`) and writes the address in canonical form, so any spelling of it compares equal. */
function normalizeAddress(address: string): string {
  const zone = address.indexOf('%');
  const bare = (zone < 0 ? address : address.slice(0, zone)).toLowerCase();
  try {
    return new URL(`http://[${bare}]`).hostname;
  } catch {
    return bare;
  }
}

/** Options for {@link UdpMediaReceiver.bind}. */
export interface UdpMediaReceiverOptions {
  /** Local UDP port; `0` (default) lets the OS choose. */
  port?: number;
}

/**
 * The UDP socket the device pushes RTP to.
 *
 * The socket must be bound *before* the stream is negotiated: the device starts
 * sending as soon as it answers, and its answer needs the port number.
 *
 * Packets are buffered as they arrive and drained through {@link packets}, so
 * datagrams that land between `bind()` and the first read are not lost.
 */
export class UdpMediaReceiver {
  private readonly socket: Socket;
  private readonly queue: Buffer[] = [];
  private pendingResolve: ((value: Buffer | undefined) => void) | undefined;
  private closed = false;
  private allowedSource: string | undefined;
  private lastSource: {address: string; allowed: boolean} | undefined;
  private droppedDatagrams = 0;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('message', (data: Buffer, rinfo: RemoteInfo) => this.onMessage(data, rinfo));
    socket.on('error', (error: Error) => {
      log.debug(`Media receiver socket error: ${error.message}`);
      this.close();
    });
  }

  /** Binds an IPv6 UDP socket and starts buffering incoming datagrams. */
  static async bind(options: UdpMediaReceiverOptions = {}): Promise<UdpMediaReceiver> {
    const socket = createSocket({type: 'udp6', reuseAddr: true});
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.close();
        reject(new Error(`Failed to bind a UDP media receiver: ${error.message}`, {cause: error}));
      };
      socket.once('error', onError);
      socket.bind(options.port ?? 0, '::', () => {
        socket.off('error', onError);
        resolve();
      });
    });

    for (const size of RECEIVE_BUFFER_SIZES) {
      try {
        socket.setRecvBufferSize(size);
        break;
      } catch {
        // Too large for this kernel; try the next size down.
      }
    }

    return new UdpMediaReceiver(socket);
  }

  /**
   * Accepts datagrams from `address` only. The socket listens on every interface, so without this any host
   * that finds the port could inject packets or flood the queue. Datagrams queued so far are discarded: the
   * device only starts sending once it has the answer to the negotiation, which comes after this call.
   *
   * @param address The device's address, as used to send it RTCP.
   */
  restrictTo(address: string): void {
    this.allowedSource = normalizeAddress(address);
    this.lastSource = undefined;
    this.queue.length = 0;
  }

  /** The bound local port, to advertise to the device. */
  get port(): number {
    return this.socket.address().port;
  }

  /** Number of datagrams received and not yet consumed. */
  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Sends a datagram from this socket.
   *
   * Used for RTCP receiver reports and keyframe requests, which must originate from the same port the
   * media arrives on so the device associates them with the session. Never rejects — a dropped
   * keepalive is not worth failing a capture over, and the socket may already be closing during
   * teardown — so callers that care whether the datagram left read the result.
   *
   * @returns Whether the datagram was handed to the network: `false` if the receiver is closed or the
   * send failed.
   */
  async send(data: Buffer, host: string, port: number): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      this.socket.send(data, port, host, (error) => {
        if (error) {
          log.debug(`RTCP send to [${host}]:${port} failed: ${error.message}`);
        }
        resolve(!error);
      });
    });
  }

  /**
   * Yields datagrams as they arrive, ending when the receiver is closed or
   * `signal` aborts.
   */
  async *packets(signal?: AbortSignal): AsyncGenerator<Buffer, void, unknown> {
    const onAbort = (): void => this.wake(undefined);
    signal?.addEventListener('abort', onAbort, {once: true});
    try {
      for (;;) {
        if (signal?.aborted) {
          return;
        }
        const next = this.queue.shift() ?? (await this.waitForPacket());
        if (next === undefined) {
          return;
        }
        yield next;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Closes the socket and releases any consumer waiting in {@link packets}. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.socket.close();
    } catch {
      // Already closing or closed.
    }
    this.wake(undefined);
  }

  private onMessage(data: Buffer, rinfo: RemoteInfo): void {
    if (!this.isAllowed(rinfo.address)) {
      this.noteDropped(`from unexpected source [${rinfo.address}]:${rinfo.port}`);
      return;
    }
    if (!this.pendingResolve && this.queue.length >= MAX_QUEUED_DATAGRAMS) {
      this.noteDropped('because the queue is full');
      return;
    }
    this.enqueue(data);
  }

  // One-entry cache: the sender is almost always the same, and canonicalizing per datagram is wasteful
  private isAllowed(address: string): boolean {
    if (this.allowedSource === undefined) {
      return true;
    }
    if (this.lastSource?.address !== address) {
      this.lastSource = {address, allowed: normalizeAddress(address) === this.allowedSource};
    }
    return this.lastSource.allowed;
  }

  // Logs the first drop and then every 1000th, so a flood does not flood the log too
  private noteDropped(reason: string): void {
    if (this.droppedDatagrams++ % 1000 === 0) {
      log.debug(`Dropped a media datagram ${reason} (${this.droppedDatagrams} dropped so far)`);
    }
  }

  private enqueue(data: Buffer): void {
    if (this.pendingResolve) {
      this.wake(data);
      return;
    }
    this.queue.push(data);
  }

  private waitForPacket(): Promise<Buffer | undefined> {
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise<Buffer | undefined>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  private wake(value: Buffer | undefined): void {
    const resolve = this.pendingResolve;
    if (resolve) {
      this.pendingResolve = undefined;
      resolve(value);
    }
  }
}
