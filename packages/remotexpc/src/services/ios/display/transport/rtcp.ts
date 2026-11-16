/**
 * RTCP receiver reports for the DisplayService media streams.
 *
 * The device's `streamConfig` sets `RTCPTimeoutEnabled: true` with
 * `RTCPTimeoutInterval: 20`, meaning it expects periodic proof that someone is
 * still listening. Without it the device **reaps the session after ~20 s** and
 * silently stops sending — measured on iOS 27.0, both the video and audio
 * streams stop dead at the 20 s mark. Sending a receiver report once a second
 * keeps the session alive indefinitely.
 *
 * The packet is an RTCP compound of a Receiver Report (RFC 3550 §6.4.2) and a
 * minimal SDES chunk (§6.5), matching what Xcode's mirror sends.
 */
import {getLogger} from '../../../../lib/logger.js';
import type {XPCDictionary} from '../../../../lib/types.js';
import type {UdpMediaReceiver} from './rtp.js';

const log = getLogger('Rtcp');

/** How often to send a receiver report. */
const DEFAULT_INTERVAL_MS = 1000;

const RTCP_VERSION_AND_COUNT = 0x81; // version 2, one report block
const RTCP_PACKET_TYPE_RR = 0xc9; // 201
const RTCP_PACKET_TYPE_SDES = 0xca; // 202
const RTCP_PACKET_TYPE_PSFB = 0xce; // 206, payload-specific feedback
const RTCP_FMT_PLI = 1; // RFC 4585 §6.3.1
/**
 * Requests closer together than this are one request: the device answers within about 50 ms, and RFC 4585
 * asks senders of feedback to bound its rate. Also what keeps several consumers from piling IDRs onto the stream.
 */
const MIN_KEYFRAME_REQUEST_SPACING_MS = 200;

/** Where to send receiver reports, and the SSRCs identifying the session. */
export interface RtcpStreamIdentity {
  /**
   * Our synchronization source — taken from the answer's **`RemoteSSRC`**.
   * The `streamConfig` is written from the device's point of view, so its
   * "remote" is us.
   */
  localSsrc: number;
  /** The device's synchronization source — the answer's **`LocalSSRC`**. */
  remoteSsrc: number;
  /** The device's address on the tunnel. */
  host: string;
  /** The device's media source port, where receiver reports must be sent. */
  port: number;
}

/**
 * Extracts the RTCP identity from a media stream answer's `streamConfig`.
 *
 * Returns `undefined` when the device omitted the fields, in which case the
 * caller should simply skip the keepalive rather than fail the capture.
 *
 * @param streamConfig The `streamConfig` from a {@link MediaStreamAnswer}.
 * @param deviceHost The device's address on the tunnel.
 */
export function rtcpIdentityFromStreamConfig(
  streamConfig: XPCDictionary,
  deviceHost: string,
): RtcpStreamIdentity | undefined {
  const localSsrc = streamConfig.RemoteSSRC; // ours — see RtcpStreamIdentity
  const remoteSsrc = streamConfig.LocalSSRC; // the device's
  const port = streamConfig.SourcePort;
  if (typeof localSsrc !== 'number' || typeof remoteSsrc !== 'number' || typeof port !== 'number' || port === 0) {
    return undefined;
  }
  return {localSsrc, remoteSsrc, host: deviceHost, port};
}

/**
 * Builds the RTCP compound packet: a Receiver Report followed by an SDES chunk.
 *
 * Every field the device does not need is left zero — it only checks that
 * reports keep arriving. `extendedHighestSequence` is reported honestly when
 * known; zero is still a valid keepalive.
 */
export function buildReceiverReport(identity: RtcpStreamIdentity, extendedHighestSequence = 0): Buffer {
  // Receiver Report: header + one report block = 32 bytes (length 7 words + 1).
  const rr = Buffer.alloc(32);
  rr.writeUInt8(RTCP_VERSION_AND_COUNT, 0);
  rr.writeUInt8(RTCP_PACKET_TYPE_RR, 1);
  rr.writeUInt16BE(7, 2); // length in 32-bit words, minus one
  rr.writeUInt32BE(identity.localSsrc >>> 0, 4); // sender of this report: us
  rr.writeUInt32BE(identity.remoteSsrc >>> 0, 8); // the source being reported on
  // Bytes 12..15 are fraction lost + cumulative packets lost; left at zero so
  // the device never throttles its encoder on our account.
  rr.writeUInt32BE(extendedHighestSequence >>> 0, 16);
  // 20..31: interarrival jitter, last SR, delay since last SR — all zero.

  // SDES with a single source chunk and an empty CNAME: 81 ca 0002 <ssrc>
  // 01 00 00 00 — byte-identical to Xcode's.
  const sdes = Buffer.alloc(12);
  sdes.writeUInt8(RTCP_VERSION_AND_COUNT, 0);
  sdes.writeUInt8(RTCP_PACKET_TYPE_SDES, 1);
  sdes.writeUInt16BE(2, 2);
  sdes.writeUInt32BE(identity.localSsrc >>> 0, 4);
  sdes.writeUInt8(0x01, 8); // CNAME item, zero length
  // 9..11 stay zero: null terminator plus padding to a 32-bit boundary.

  return Buffer.concat([rr, sdes]);
}

/**
 * Builds a Picture Loss Indication (RFC 4585 §6.3.1), which asks the device for a keyframe.
 *
 * The device answers with a full IDR (VPS, SPS, PPS and the picture) within about 50 ms. It sends only one IDR
 * on its own, at the start of the stream, so this is the only way to recover from a damaged picture or to
 * give a late consumer a point to start decoding from.
 *
 * It is sent on its own, not inside an RR-led compound packet as RFC 3550 §6.1 asks. The device accepts
 * that (verified on an iPad running iPadOS 27.0.1, which answered every one with an IDR).
 */
export function buildPictureLossIndication(identity: RtcpStreamIdentity): Buffer {
  const pli = Buffer.alloc(12);
  pli.writeUInt8(0x80 | RTCP_FMT_PLI, 0); // version 2, no padding, FMT 1
  pli.writeUInt8(RTCP_PACKET_TYPE_PSFB, 1);
  pli.writeUInt16BE(2, 2); // length in 32-bit words, minus one
  pli.writeUInt32BE(identity.localSsrc >>> 0, 4); // sender of the request: us
  pli.writeUInt32BE(identity.remoteSsrc >>> 0, 8); // the media source the picture is lost from
  return pli;
}

/** Options for {@link RtcpKeepalive.start}. */
export interface RtcpKeepaliveOptions {
  /** How often to send a report. Defaults to 1000 ms. */
  intervalMs?: number;
  /** Label used in debug logs, e.g. `'video'`. */
  label?: string;
  /**
   * Also ask the device for a keyframe this often, in milliseconds. Off (`0`) by default; see
   * {@link RtcpKeepalive.requestKeyFrame}. At most 2^31 - 1, the longest delay a Node timer takes.
   */
  keyFrameIntervalMs?: number;
}

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Periodically sends RTCP receiver reports so the device keeps a media session
 * alive past its 20 s timeout.
 *
 * The first report goes out **immediately**, not on the first tick and not
 * gated on having received anything: a silent or static screen produces no
 * media for a while, and waiting would let the device reap the session before
 * any data ever arrived.
 */
export class RtcpKeepalive {
  private readonly receiver: UdpMediaReceiver;
  private readonly identity: RtcpStreamIdentity;
  private readonly label: string;
  private timer: NodeJS.Timeout | undefined;
  private keyFrameTimer: NodeJS.Timeout | undefined;
  private lastKeyFrameRequestAt = Number.NEGATIVE_INFINITY;
  private extendedHighestSequence = 0;
  private cycles = 0;
  private lastSequence: number | undefined;
  private stopped = false;

  private constructor(receiver: UdpMediaReceiver, identity: RtcpStreamIdentity, label: string) {
    this.receiver = receiver;
    this.identity = identity;
    this.label = label;
  }

  /**
   * Starts sending reports, emitting the first one right away.
   *
   * @param receiver The socket the media arrives on; reports must come from it.
   * @param identity Destination and SSRCs, from {@link rtcpIdentityFromStreamConfig}.
   * @param options Interval and log label.
   */
  static start(
    receiver: UdpMediaReceiver,
    identity: RtcpStreamIdentity,
    options: RtcpKeepaliveOptions = {},
  ): RtcpKeepalive {
    const {intervalMs = DEFAULT_INTERVAL_MS, label = 'media', keyFrameIntervalMs = 0} = options;
    if (!Number.isFinite(keyFrameIntervalMs) || keyFrameIntervalMs < 0 || keyFrameIntervalMs > MAX_TIMER_DELAY_MS) {
      throw new RangeError(`keyFrameIntervalMs must be between 0 and ${MAX_TIMER_DELAY_MS}, got ${keyFrameIntervalMs}`);
    }
    const keepalive = new RtcpKeepalive(receiver, identity, label);

    log.debug(
      `Starting ${label} RTCP keepalive to [${identity.host}]:${identity.port} ` +
        `every ${intervalMs}ms (ssrc ${identity.localSsrc} -> ${identity.remoteSsrc})`,
    );
    void keepalive.sendReport();
    keepalive.timer = setInterval(() => void keepalive.sendReport(), intervalMs);
    keepalive.timer.unref?.();
    if (keyFrameIntervalMs > 0) {
      keepalive.keyFrameTimer = setInterval(() => void keepalive.requestKeyFrameQuietly(), keyFrameIntervalMs);
      keepalive.keyFrameTimer.unref?.();
    }
    return keepalive;
  }

  /**
   * Records a received RTP sequence number so reports carry an honest extended
   * highest-sequence value, tracking 16-bit wraparound.
   */
  observeSequence(sequence: number): void {
    if (this.lastSequence !== undefined && sequence < this.lastSequence && this.lastSequence - sequence > 0x8000) {
      this.cycles = (this.cycles + 1) & 0xffff;
    }
    this.lastSequence = sequence;
    const candidate = ((this.cycles << 16) >>> 0) + sequence;
    if (candidate > this.extendedHighestSequence) {
      this.extendedHighestSequence = candidate;
    }
  }

  /**
   * Asks the device for a keyframe with a Picture Loss Indication.
   *
   * Requests within 200 ms of the previous one are coalesced into it, since a keyframe is already on its way.
   *
   * @returns Whether a keyframe is on its way: `false` once stopped, or if the request could not be sent.
   */
  async requestKeyFrame(): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    const now = performance.now();
    if (now - this.lastKeyFrameRequestAt < MIN_KEYFRAME_REQUEST_SPACING_MS) {
      return true;
    }
    // Set before awaiting, so concurrent callers coalesce too
    this.lastKeyFrameRequestAt = now;
    log.debug(`Requesting a ${this.label} keyframe from [${this.identity.host}]:${this.identity.port}`);
    const sent = await this.receiver.send(
      buildPictureLossIndication(this.identity),
      this.identity.host,
      this.identity.port,
    );
    if (!sent) {
      this.lastKeyFrameRequestAt = Number.NEGATIVE_INFINITY;
    }
    return sent;
  }

  private async requestKeyFrameQuietly(): Promise<void> {
    try {
      await this.requestKeyFrame();
    } catch (error) {
      log.debug(
        `Periodic ${this.label} keyframe request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Stops sending reports. Safe to call more than once. */
  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.keyFrameTimer);
    this.timer = undefined;
    this.keyFrameTimer = undefined;
  }

  private async sendReport(): Promise<void> {
    if (this.stopped) {
      return;
    }
    const packet = buildReceiverReport(this.identity, this.extendedHighestSequence);
    await this.receiver.send(packet, this.identity.host, this.identity.port);
  }
}
