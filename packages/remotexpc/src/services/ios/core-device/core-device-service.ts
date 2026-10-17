import {randomUUID} from 'node:crypto';

import {getLogger} from '../../../lib/logger.js';
import {Http2Constants, XpcConstants} from '../../../lib/remote-xpc/constants.js';
import {
  RemoteXpcFramedTransport,
  type RemoteXpcMessageInfo,
} from '../../../lib/remote-xpc/remote-xpc-framed-transport.js';
import {encodeMessage} from '../../../lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary, XPCValue} from '../../../lib/types.js';
import {BaseService} from '../base-service.js';

const log = getLogger('CoreDeviceService');

/** Transports already carrying the permanent failure loggers. */
const loggedTransports = new WeakSet<RemoteXpcFramedTransport>();

const CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_INVOKE_TIMEOUT_MS = 30_000;

/**
 * CoreDevice protocol version reported to the device.
 */
const CORE_DEVICE_VERSION_STRING = '629.3';
const CORE_DEVICE_DDI_PROTOCOL_VERSION = 2;

/**
 * Builds the `CoreDevice.coreDeviceVersion` dictionary. `components` are encoded
 * as XPC uint64 values (hence `bigint`), while `originalComponentsCount` is an
 * int64 (a plain integer).
 */
function buildCoreDeviceVersion(version: string): XPCDictionary {
  const components = version.split('.');
  return {
    components: components.map((component) => BigInt(component)),
    originalComponentsCount: components.length,
    stringValue: version,
  };
}

const CORE_DEVICE_VERSION = buildCoreDeviceVersion(CORE_DEVICE_VERSION_STRING);

export interface CoreDeviceInvokeOptions {
  /** Optional action identifier for the invocation. */
  actionIdentifier?: string;
  /** Override the default response timeout. */
  timeoutMs?: number;
}

/**
 * Receives the requests a device sends while one of ours is in flight, before
 * the device replies to ours. `respond` answers the request on the connection it
 * arrived on.
 */
export type CoreDevicePeerMessageHandler = (body: XPCDictionary, respond: (replyBody: XPCDictionary) => void) => void;

/**
 * Error thrown when a CoreDevice invocation fails or returns no output.
 */
export class CoreDeviceError extends Error {
  readonly response?: XPCDictionary;

  constructor(message: string, response?: XPCDictionary) {
    super(message);
    this.name = 'CoreDeviceError';
    this.response = response;
  }
}

/**
 * Base class for iOS CoreDevice (`com.apple.coredevice.*`) services.
 *
 * CoreDevice services speak RemoteXPC over the tunnel and wrap every request in
 * a common invocation envelope. This base owns the framed transport lifecycle
 * and exposes:
 *   - {@link invoke} for request/response features (the common case)
 *   - {@link send} for fire-and-forget messages (e.g. HID events)
 *
 * Subclasses pass their RSD service name to the constructor and typically also
 * expose it via a static `RSD_SERVICE_NAME` for catalog checks.
 */
export abstract class CoreDeviceService extends BaseService {
  private readonly serviceName: string;

  protected transport: RemoteXpcFramedTransport | null = null;
  protected nextMessageId = 1;

  /** Serializes invocations so concurrent calls do not interleave replies. */
  private invokeQueue: Promise<unknown> = Promise.resolve();
  /** Connection being opened by {@link getTransport}, shared by concurrent callers. */
  private pendingTransport: Promise<RemoteXpcFramedTransport> | null = null;

  constructor(udid: string, serviceName: string) {
    super(udid);
    this.serviceName = serviceName;
  }

  async close(): Promise<void> {
    // A connection still being opened would otherwise be stored after close().
    await this.pendingTransport?.catch((): void => undefined);
    if (!this.transport) {
      return;
    }

    const transport = this.transport;
    this.transport = null;
    await transport.close();
  }

  /**
   * Sends a fire-and-forget XPC message on the root channel. Used by services
   * that do not expect a reply (e.g. HID event streams).
   */
  protected async send(body: XPCDictionary): Promise<void> {
    const transport = await this.getTransport();
    transport.sendDataFrame(
      encodeMessage({
        flags: XpcConstants.XPC_FLAGS_ALWAYS_SET | XpcConstants.XPC_FLAGS_DATA_PRESENT,
        id: this.allocateMessageId(),
        body,
      }),
      Http2Constants.ROOT_CHANNEL,
    );
  }

  /**
   * Sends a direct XPC request on the root channel and returns the full reply.
   * Some CoreDevice services (for example pasteboard) do not use the common
   * `CoreDevice.featureIdentifier` invocation envelope.
   */
  protected async sendReceive(body: XPCDictionary, options: CoreDeviceInvokeOptions = {}): Promise<XPCDictionary> {
    return this.enqueueInvocation(() => this.exchange(() => this.refreshTransport(), body, options));
  }

  /**
   * Like {@link sendReceive}, but keeps the current connection (opening one on
   * first use) instead of a fresh one per request. Used by session-oriented
   * services whose state lives as long as the connection (e.g. the file service).
   *
   * Only the reply carrying the request's message id is accepted, so a late
   * reply to an earlier request is never returned. When the exchange fails
   * (timeout, transport error, closed connection), the connection is dropped,
   * because the device may still be sending on it; the next call reconnects.
   */
  protected async sendReceiveOnConnection(
    body: XPCDictionary,
    options: CoreDeviceInvokeOptions = {},
    onPeerMessage?: CoreDevicePeerMessageHandler,
  ): Promise<XPCDictionary> {
    return this.enqueueInvocation(async () => {
      try {
        return await this.exchange(() => this.getTransport(), body, options, {matchReplyId: true, onPeerMessage});
      } catch (err) {
        await this.dropTransport();
        throw err;
      }
    });
  }

  /**
   * Closes the current connection, if any, so the next call opens a new one.
   */
  protected async dropTransport(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    await transport?.close().catch((err: Error) => log.debug(`Cannot close the CoreDevice transport: ${err.message}`));
  }

  /**
   * Returns the id for the next outgoing root-channel message. Subclasses may
   * override it when a service expects a particular id sequence.
   */
  protected allocateMessageId(): number {
    return this.nextMessageId++;
  }

  /**
   * Invokes a CoreDevice feature and returns its `CoreDevice.output`.
   *
   * Each invocation uses a fresh connection: CoreDevice services close the
   * connection after a request/response cycle, so reusing a connection
   * across invocations fails. Calls are also serialized, so they never overlap.
   */
  protected async invoke(
    featureIdentifier?: string,
    input: XPCDictionary = {},
    options: CoreDeviceInvokeOptions = {},
  ): Promise<XPCValue> {
    return this.enqueueInvocation(() => this.invokeInternal(featureIdentifier, input, options));
  }

  protected async createTransport(): Promise<RemoteXpcFramedTransport> {
    const transport = new RemoteXpcFramedTransport(await this.resolveServiceAddress(this.serviceName));
    attachTransportLogging(transport);
    await transport.connect({timeoutMs: CONNECT_TIMEOUT_MS});
    return transport;
  }

  protected async getTransport(): Promise<RemoteXpcFramedTransport> {
    if (this.transport?.isConnected) {
      return this.transport;
    }
    this.pendingTransport ??= this.newTransport()
      .then((transport) => {
        this.transport = transport;
        return transport;
      })
      .finally(() => {
        this.pendingTransport = null;
      });
    return await this.pendingTransport;
  }

  private async enqueueInvocation<T>(operation: () => Promise<T>): Promise<T> {
    // Serialize invocations: await the previous call's completion, then install
    // a new tail that the next caller will await. Prior failures are ignored so
    // one failed call does not poison the queue.
    const previous = this.invokeQueue;
    let release: () => void = () => undefined;
    this.invokeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await previous;
    } catch {
      // Ignore the previous invocation's outcome.
    }

    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Creates a transport that already carries a permanent `'error'` listener.
   * Attaching it after connect() would leave the handshake window uncovered:
   * frames arriving there can emit `'error'`, and Node throws one that has no
   * listener. Attaching is idempotent, so an override of createTransport() that
   * already attached is not double-wired.
   */
  private async newTransport(): Promise<RemoteXpcFramedTransport> {
    const transport = await this.createTransport();
    attachTransportLogging(transport);
    this.nextMessageId = 1;
    return transport;
  }

  /**
   * Closes any existing connection and opens a fresh one. Used by {@link invoke}
   * because CoreDevice services are one-shot per connection.
   */
  private async refreshTransport(): Promise<RemoteXpcFramedTransport> {
    if (this.transport) {
      const previous = this.transport;
      this.transport = null;
      await previous.close().catch((): void => undefined);
    }
    this.transport = await this.newTransport();
    return this.transport;
  }

  private async invokeInternal(
    featureIdentifier: string | undefined,
    input: XPCDictionary,
    options: CoreDeviceInvokeOptions,
  ): Promise<XPCValue> {
    const transport = await this.refreshTransport();
    const request = this.buildEnvelope(featureIdentifier, input, options.actionIdentifier);

    // Register the response listener before sending so a fast reply is not lost.
    const responsePromise = this.waitForResponse(
      transport,
      options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      featureIdentifier,
    );

    transport.sendDataFrame(
      encodeMessage({
        flags:
          XpcConstants.XPC_FLAGS_ALWAYS_SET |
          XpcConstants.XPC_FLAGS_DATA_PRESENT |
          XpcConstants.XPC_FLAGS_WANTING_REPLY,
        id: this.allocateMessageId(),
        body: request,
      }),
      Http2Constants.ROOT_CHANNEL,
    );

    const response = await responsePromise;
    const output = response['CoreDevice.output'];
    if (output === undefined) {
      throw buildInvocationError(featureIdentifier, response);
    }
    return output;
  }

  private async exchange(
    acquireTransport: () => Promise<RemoteXpcFramedTransport>,
    body: XPCDictionary,
    options: CoreDeviceInvokeOptions,
    responseOptions: {matchReplyId?: boolean; onPeerMessage?: CoreDevicePeerMessageHandler} = {},
  ): Promise<XPCDictionary> {
    const transport = await acquireTransport();
    const operationIdentifier = options.actionIdentifier ?? '<raw>';
    const messageId = this.allocateMessageId();

    // Register the response listener before sending so a fast reply is not lost.
    const responsePromise = this.waitForResponse(
      transport,
      options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS,
      operationIdentifier,
      {
        expectedReplyId: responseOptions.matchReplyId ? BigInt(messageId) : undefined,
        onPeerMessage: responseOptions.onPeerMessage,
      },
    );

    transport.sendDataFrame(
      encodeMessage({
        flags:
          XpcConstants.XPC_FLAGS_ALWAYS_SET |
          XpcConstants.XPC_FLAGS_DATA_PRESENT |
          XpcConstants.XPC_FLAGS_WANTING_REPLY,
        id: messageId,
        body,
      }),
      Http2Constants.ROOT_CHANNEL,
    );

    return await responsePromise;
  }

  private buildEnvelope(
    featureIdentifier: string | undefined,
    input: XPCDictionary,
    actionIdentifier?: string,
  ): XPCDictionary {
    const request: XPCDictionary = {
      'CoreDevice.CoreDeviceDDIProtocolVersion': CORE_DEVICE_DDI_PROTOCOL_VERSION,
      'CoreDevice.coreDeviceVersion': CORE_DEVICE_VERSION,
      'CoreDevice.deviceIdentifier': randomUUID(),
      'CoreDevice.input': input,
      'CoreDevice.invocationIdentifier': randomUUID(),
    };
    if (featureIdentifier !== undefined) {
      request['CoreDevice.featureIdentifier'] = featureIdentifier;
      request['CoreDevice.action'] = {};
    }
    if (actionIdentifier !== undefined) {
      request['CoreDevice.actionIdentifier'] = actionIdentifier;
    }
    return request;
  }

  /**
   * Resolves with the device's reply to the request that is about to be sent.
   *
   * @param timeoutMs Maximum time without any message from the device. Requests
   * the device sends in between (see {@link CoreDevicePeerMessageHandler}) restart it.
   * @param options.expectedReplyId When set, replies carrying another message id
   * are ignored.
   */
  private waitForResponse(
    transport: RemoteXpcFramedTransport,
    timeoutMs: number,
    featureIdentifier: string | undefined,
    options: {expectedReplyId?: bigint; onPeerMessage?: CoreDevicePeerMessageHandler} = {},
  ): Promise<XPCDictionary> {
    const {expectedReplyId, onPeerMessage} = options;
    return new Promise<XPCDictionary>((resolve, reject) => {
      let settled = false;
      let lastDecodeError: Error | undefined;
      let timer: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        transport.off('message', onMessage);
        transport.off('decodeError', onDecodeError);
        transport.off('error', onError);
        transport.off('close', onClose);
      };

      const armTimer = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          const cause = lastDecodeError ? `; last message was undecodable: ${lastDecodeError.message}` : '';
          reject(
            new CoreDeviceError(
              `CoreDevice invocation '${featureIdentifier ?? '<none>'}' timed out after ${timeoutMs}ms${cause}`,
            ),
          );
        }, timeoutMs);
      };

      const onMessage = (body: XPCDictionary, info?: RemoteXpcMessageInfo): void => {
        // Skip empty/handshake acks; the real reply carries CoreDevice.* keys.
        if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
          return;
        }
        if (onPeerMessage && info && isPeerRequest(info)) {
          armTimer();
          try {
            onPeerMessage(body, (replyBody) => replyToPeer(transport, info, replyBody));
          } catch (error) {
            cleanup();
            reject(error);
          }
          return;
        }
        if (expectedReplyId !== undefined && info && info.id !== expectedReplyId) {
          log.debug(
            `Ignoring a reply to message ${info.id} while awaiting the reply to message ${expectedReplyId} ` +
              `('${featureIdentifier ?? '<none>'}')`,
          );
          return;
        }
        cleanup();
        resolve(body);
      };

      const onDecodeError = (error: Error): void => {
        lastDecodeError = error;
      };

      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const onClose = (): void => {
        cleanup();
        reject(new CoreDeviceError(`CoreDevice connection closed while awaiting '${featureIdentifier ?? '<none>'}'`));
      };

      armTimer();
      transport.on('message', onMessage);
      transport.on('decodeError', onDecodeError);
      transport.once('error', onError);
      transport.once('close', onClose);
    });
  }
}

/**
 * Whether a received message is a request from the device rather than a reply
 * to one of ours.
 */
function isPeerRequest({flags}: RemoteXpcMessageInfo): boolean {
  return (flags & XpcConstants.XPC_FLAGS_WANTING_REPLY) !== 0 && (flags & XpcConstants.XPC_FLAGS_REPLY) === 0;
}

/**
 * Answers a device request on the connection it arrived on.
 */
function replyToPeer(transport: RemoteXpcFramedTransport, info: RemoteXpcMessageInfo, body: XPCDictionary): void {
  transport.sendDataFrame(
    encodeMessage({
      flags: XpcConstants.XPC_FLAGS_ALWAYS_SET | XpcConstants.XPC_FLAGS_DATA_PRESENT | XpcConstants.XPC_FLAGS_REPLY,
      id: info.id,
      body,
    }),
    Http2Constants.REPLY_CHANNEL,
  );
}

/**
 * Attaches the permanent failure listeners once per transport. An `'error'` with
 * no listener is thrown by Node and crashes the process, and fire-and-forget
 * `send()` registers no per-call listener of its own.
 */
function attachTransportLogging(transport: RemoteXpcFramedTransport): void {
  if (loggedTransports.has(transport)) {
    return;
  }
  loggedTransports.add(transport);

  transport.on('error', (error: Error) => {
    log.debug(`CoreDevice transport error: ${error.message}`);
  });
  transport.once('decodeError', (error: Error) => {
    log.debug(`CoreDevice skipped an undecodable message: ${error.message}`);
  });
}

/**
 * Builds a descriptive error from a CoreDevice reply that carries no output.
 * The device returns an `NSError`-shaped `CoreDevice.error` whose `userInfo`
 * holds a human-readable reason; surface it so callers can tell *why* (e.g. a
 * missing bundle id or pid) instead of a generic failure.
 */
function buildInvocationError(featureIdentifier: string | undefined, response: XPCDictionary): CoreDeviceError {
  const feature = featureIdentifier ?? '<none>';
  const deviceError = response['CoreDevice.error'];
  if (!deviceError || typeof deviceError !== 'object' || Array.isArray(deviceError)) {
    return new CoreDeviceError(`CoreDevice invocation '${feature}' returned no output`, response);
  }

  const error = deviceError as XPCDictionary;
  const userInfo = error.userInfo && typeof error.userInfo === 'object' ? (error.userInfo as XPCDictionary) : {};
  const reason =
    pickString(userInfo.NSLocalizedDescription) ??
    pickString(userInfo.NSLocalizedFailureReason) ??
    pickString(userInfo.NSDebugDescription) ??
    'unknown error';
  const failureReason = pickString(userInfo.NSLocalizedFailureReason);
  const detail = failureReason && failureReason !== reason ? `${reason} ${failureReason}` : reason;
  const domain = pickString(error.domain) ?? 'unknown';
  const code = typeof error.code === 'number' ? ` ${error.code}` : '';

  return new CoreDeviceError(`CoreDevice '${feature}' failed: ${detail} [${domain}${code}]`, response);
}

function pickString(value: XPCValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export default CoreDeviceService;
