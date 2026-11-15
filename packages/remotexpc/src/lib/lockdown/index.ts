import {X509Certificate} from 'node:crypto';
import type {Socket} from 'node:net';
import tls, {type ConnectionOptions, type TLSSocket} from 'node:tls';

import {BasePlistService} from '../../base-plist-service.js';
import {ServiceConnection} from '../../service-connection.js';
import {formatError, formatValue} from '../format-error.js';
import {getLogger} from '../logger.js';
import {type PairRecord} from '../pair-record/index.js';
import {PlistService} from '../plist/plist-service.js';
import {resolveTunnelService} from '../tunnel/tunnel-service-resolver.js';
import type {LockdownDeviceInfo, PlistMessage, PlistValue} from '../types.js';
import {RelayService, createUsbmux} from '../usbmux/index.js';

const log = getLogger('Lockdown');
const tlsManagerLog = getLogger('TLSManager');
const deviceManagerLog = getLogger('DeviceManager');

// Constants
const LABEL = 'appium-internal';
const DEFAULT_TIMEOUT = 5000;
/** A device that accepts the connection but never answers the TLS handshake must not hang callers. */
const TLS_HANDSHAKE_TIMEOUT_MS = 10000;
const DEFAULT_LOCKDOWN_PORT = 62078;
/** 0 lets the OS assign a free ephemeral port, so concurrent relays cannot collide. */
const DEFAULT_RELAY_PORT = 0;
/** RSD service name for lockdownd over a RemoteXPC tunnel (e.g. Apple TV Wi‑Fi). */
const LOCKDOWN_REMOTE_UNTRUSTED = 'com.apple.mobile.lockdown.remote.untrusted';

// Types and Interfaces
interface DeviceProperties {
  ConnectionSpeed: number;
  ConnectionType: string;
  DeviceID: number;
  LocationID: number;
  ProductID: number;
  SerialNumber: string;
  USBSerialNumber: string;
}

interface Device {
  DeviceID: number;
  MessageType: string;
  Properties: DeviceProperties;
}

interface LockdownServiceInfo {
  lockdownService: LockdownService;
  device: Device;
}

interface SessionInfo {
  sessionID: string;
  enableSessionSSL: boolean;
}

interface StartSessionResponse {
  Request?: string;
  SessionID?: PlistValue;
  EnableSessionSSL?: boolean;
  [key: string]: PlistValue | undefined;
}

interface GetValueResponse {
  Request?: string;
  Error?: PlistValue;
  Value?: PlistValue;
  [key: string]: PlistValue | undefined;
}

/** TLS options for a lockdown connection, with the certificate the device has to present when it is known. */
export type LockdownTlsOptions = Partial<ConnectionOptions> & {
  /**
   * PEM `DeviceCertificate` from the pair record. When set, the upgrade fails unless the device
   * presents exactly it. Without it the device is not authenticated.
   */
  deviceCertificate?: string;
};

// Error classes for better error handling
export class LockdownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockdownError';
  }
}

/** lockdownd refused to start a service (e.g. `PasswordProtected`, `InvalidService`). */
export class LockdownStartServiceError extends LockdownError {
  constructor(
    readonly serviceName: string,
    readonly reason: string,
  ) {
    super(
      reason === 'PasswordProtected'
        ? `Cannot start '${serviceName}': the device is locked with a passcode. Unlock it and try again.`
        : `Cannot start '${serviceName}': ${reason}`,
    );
    this.name = 'LockdownStartServiceError';
  }
}

/** Connection attributes returned by lockdownd for a started service. */
export interface StartedLockdownService {
  port: number;
  enableServiceSSL: boolean;
}

/** A strict (paired, TLS-secured when requested) lockdown session over usbmux. */
export interface LockdownSessionInfo {
  lockdown: LockdownService;
  pairRecord: PairRecord;
  deviceId: number;
}

class TLSUpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TLSUpgradeError';
  }
}

class DeviceNotFoundError extends Error {
  constructor(udid: string) {
    super(`Device with UDID ${udid} not found`);
    this.name = 'DeviceNotFoundError';
  }
}

// TLS Manager for handling TLS operations
class TLSManager {
  /**
   * Upgrades a socket to TLS and, when `tlsOptions.deviceCertificate` is set, authenticates the device
   * by that pinned certificate. Chain validation stays off because lockdown certificates have an empty
   * subject and issuer, so OpenSSL takes the device certificate for a self-signed one and refuses it
   * even when the pair record's root certificate is trusted. The handshake still proves the peer holds
   * the private key of the certificate it presents, so an exact match with the pair record's
   * `DeviceCertificate` is what authenticates the device. The match is checked once the handshake has
   * finished, because the Node TLS client cannot reject a peer certificate earlier.
   * @throws TLSUpgradeError if the handshake fails or the device presents a different certificate
   */
  async upgradeSocketToTLS(
    socket: Socket,
    tlsOptions: LockdownTlsOptions,
    timeoutMs = TLS_HANDSHAKE_TIMEOUT_MS,
  ): Promise<TLSSocket> {
    const {deviceCertificate, ...connectionOptions} = tlsOptions;
    return new Promise((resolve, reject) => {
      socket.pause();
      tlsManagerLog.debug('Upgrading socket to TLS...');

      let timer: NodeJS.Timeout | undefined;
      let secure: TLSSocket;
      try {
        const pinnedCertificate = deviceCertificate ? new X509Certificate(deviceCertificate) : undefined;
        secure = tls.connect(
          {
            socket,
            rejectUnauthorized: false,
            minVersion: 'TLSv1.2',
            ...connectionOptions,
          },
          () => {
            clearTimeout(timer);
            if (pinnedCertificate && !secure.getPeerX509Certificate()?.raw.equals(pinnedCertificate.raw)) {
              secure.destroy();
              reject(
                new TLSUpgradeError(
                  'The device presented a TLS certificate that does not match the DeviceCertificate of its pair record',
                ),
              );
              return;
            }
            tlsManagerLog.info('TLS handshake completed');
            resolve(secure);
          },
        );
      } catch (err) {
        // e.g. invalid PEM in the pair record: tls.connect throws synchronously
        reject(new TLSUpgradeError(`TLS socket error: ${(err as Error).message}`));
        return;
      }
      // armed only once `secure` exists, so the callback can never hit a TDZ error
      timer = setTimeout(() => {
        secure.destroy();
        reject(new TLSUpgradeError(`TLS handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      secure.on('error', (err) => {
        clearTimeout(timer);
        tlsManagerLog.error(`TLS socket error: ${err}`);
        reject(new TLSUpgradeError(`TLS socket error: ${err.message}`));
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        tlsManagerLog.error(`Underlying socket error during TLS: ${err}`);
        reject(new TLSUpgradeError(`Socket error during TLS: ${err.message}`));
      });
    });
  }
}

// Device Manager for handling device operations
class DeviceManager {
  /**
   * Lists all connected devices
   */
  async listDevices(): Promise<Device[]> {
    const usbmux = await createUsbmux();
    try {
      deviceManagerLog.debug('Listing connected devices...');
      const devices = await usbmux.listDevices();
      deviceManagerLog.debug(
        `Found ${devices.length} devices: ${devices.map((d) => d.Properties.SerialNumber).join(', ')}`,
      );
      return devices;
    } finally {
      await this.closeUsbmux(usbmux);
    }
  }

  /**
   * Finds a device by UDID
   */
  async findDeviceByUDID(udid: string): Promise<Device> {
    const devices = await this.listDevices();

    if (!devices || devices.length === 0) {
      throw new LockdownError('No devices connected');
    }

    const device = devices.find((d) => d.Properties.SerialNumber.toLowerCase() === udid.toLowerCase());
    if (!device) {
      throw new DeviceNotFoundError(udid);
    }

    deviceManagerLog.info(
      `Found device: DeviceID=${device.DeviceID}, SerialNumber=${device.Properties.SerialNumber}, ConnectionType=${device.Properties.ConnectionType}`,
    );

    return device;
  }

  /**
   * Reads pair record for a device
   * @throws LockdownError if the device has no pair record or it lacks the host certificate or key
   */
  async readPairRecord(udid: string): Promise<PairRecord> {
    const record = await this.findPairRecord(udid);
    if (!record?.HostCertificate || !record.HostPrivateKey) {
      const err = new LockdownError('Pair record missing certificate or key');
      deviceManagerLog.error(`Error getting pair record: ${err}`);
      throw err;
    }
    return record;
  }

  /**
   * Finds the pair record for a device, or null if it is not paired
   * @returns The pair record, or null if the device is not paired with this host
   */
  async findPairRecord(udid: string): Promise<PairRecord | null> {
    deviceManagerLog.debug(`Retrieving pair record for UDID: ${udid}`);
    const usbmux = await createUsbmux();

    try {
      const record = await usbmux.readPairRecord(udid);
      deviceManagerLog.info(record ? 'Pair record retrieved successfully' : 'No pair record found');
      return record;
    } catch (err) {
      deviceManagerLog.error(`Error getting pair record: ${formatError(err)}`);
      throw err;
    } finally {
      await this.closeUsbmux(usbmux);
    }
  }

  private async closeUsbmux(usbmux: any): Promise<void> {
    try {
      await usbmux.close();
    } catch (err) {
      deviceManagerLog.error(`Error closing usbmux: ${formatError(err)}`);
    }
  }
}

// Main LockdownService class
export class LockdownService extends BasePlistService {
  private readonly udid: string;
  private tlsService?: PlistService;
  private isTLS = false;
  private tlsUpgradePromise?: Promise<void>;
  private tlsUpgradeError?: Error;
  private _relayService?: RelayService;
  private readonly tlsManager = new TLSManager();
  private readonly deviceManager = new DeviceManager();

  constructor(socket: Socket, udid: string, autoSecure = true) {
    super(socket);
    this.udid = udid;
    log.info(`LockdownService initialized for UDID: ${udid}`);

    if (autoSecure) {
      this.tlsUpgradePromise = (async () => {
        try {
          await this.tryUpgradeToTLS();
        } catch (err) {
          this.tlsUpgradeError = err instanceof Error ? err : new Error(String(err));
        }
      })();
    }
  }

  /**
   * Starts a lockdown session
   */
  async startSession(hostID: string, systemBUID: string, timeout = DEFAULT_TIMEOUT): Promise<SessionInfo> {
    log.debug(`Starting lockdown session with HostID: ${hostID}`);

    const request: Record<string, PlistValue> = {
      Label: LABEL,
      Request: 'StartSession',
      HostID: hostID,
      SystemBUID: systemBUID,
    };

    const response = (await this.sendAndReceive(request, timeout)) as StartSessionResponse;

    if (response.Request === 'StartSession' && response.SessionID) {
      const sessionInfo: SessionInfo = {
        sessionID: formatValue(response.SessionID),
        enableSessionSSL: Boolean(response.EnableSessionSSL),
      };

      log.info(`Lockdown session started, SessionID: ${sessionInfo.sessionID}`);
      return sessionInfo;
    }

    throw new LockdownError(`Unexpected session data: ${JSON.stringify(response)}`);
  }

  /**
   * Starts a session using the given pair record and upgrades the connection to TLS.
   * @throws LockdownError if the pair record is incomplete or the device does not enable TLS for the
   * session, so a paired session never continues in plain text
   */
  async startSecureSession(pairRecord: PairRecord): Promise<void> {
    if (!this.validatePairRecord(pairRecord)) {
      throw new LockdownError(
        `The pair record for ${this.udid} is incomplete. Unlock the device and trust this computer, then retry.`,
      );
    }
    const sessionInfo = await this.startSession(pairRecord.HostID as string, pairRecord.SystemBUID as string);
    if (!sessionInfo.enableSessionSSL) {
      throw new LockdownError(`The device ${this.udid} did not enable TLS for a paired lockdown session`);
    }
    await this.performTLSUpgrade(pairRecord);
  }

  /**
   * Asks lockdownd to start a service. Requires a session (see {@link startSecureSession}).
   *
   * @param serviceName - Lockdown service name, e.g. `com.apple.afc`
   * @param timeout - Request timeout in milliseconds
   * @returns The device port to connect to and whether the connection must use TLS
   */
  async startService(serviceName: string, timeout = DEFAULT_TIMEOUT): Promise<StartedLockdownService> {
    const response = await this.sendAndReceive({Label: LABEL, Request: 'StartService', Service: serviceName}, timeout);
    if (response.Error) {
      throw new LockdownStartServiceError(serviceName, formatValue(response.Error));
    }
    const port = Number(response.Port);
    if (!Number.isInteger(port) || port <= 0) {
      throw new LockdownError(`Unexpected StartService response for '${serviceName}': ${JSON.stringify(response)}`);
    }
    return {port, enableServiceSSL: Boolean(response.EnableServiceSSL)};
  }

  /**
   * Upgrades the connection to TLS when the device is paired. Only a device without a pair record
   * stays in plain text. With a pair record every failure is thrown.
   */
  async tryUpgradeToTLS(): Promise<void> {
    try {
      const pairRecord = await this.deviceManager.findPairRecord(this.udid);
      if (!pairRecord) {
        log.info(`No pair record for ${this.udid}. Continuing unencrypted.`);
        return;
      }
      await this.startSecureSession(pairRecord);
    } catch (err) {
      log.error(`TLS upgrade failed: ${formatError(err)}`);
      throw err;
    }
  }

  /**
   * Gets the current socket (TLS or regular)
   */
  public getSocket(): Socket | TLSSocket {
    return this.isTLS && this.tlsService ? this.tlsService.getSocket() : this.getPlistService().getSocket();
  }

  /**
   * Sends a message and receives a response
   */
  public override async sendAndReceive(
    msg: Record<string, PlistValue>,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<PlistMessage> {
    const service = this.isTLS && this.tlsService ? this.tlsService : this._plistService;
    return service.sendPlistAndReceive(msg, timeout);
  }

  /**
   * Reads the device wall clock unix timestamp (seconds) from lockdownd.
   */
  public async getTimeIntervalSince1970(timeout = DEFAULT_TIMEOUT): Promise<number> {
    const value = await this.getValue<PlistValue>('TimeIntervalSince1970', undefined, timeout);

    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    throw new LockdownError(`Unexpected TimeIntervalSince1970 value type: ${typeof value}`);
  }

  /**
   * Reads device wall clock and converts it to a Date object in UTC.
   * The value is derived from Unix epoch seconds (`TimeIntervalSince1970`).
   */
  public async getDeviceDate(timeout = DEFAULT_TIMEOUT): Promise<Date> {
    const unixSeconds = await this.getTimeIntervalSince1970(timeout);
    return new Date(unixSeconds * 1000);
  }

  /**
   * Reads the device timezone identifier (for example: "Europe/Berlin").
   */
  public async getTimeZone(timeout = DEFAULT_TIMEOUT): Promise<string> {
    const value = await this.getValue<PlistValue>('TimeZone', undefined, timeout);
    if (typeof value === 'string') {
      return value;
    }
    throw new LockdownError(`Unexpected TimeZone value type: ${typeof value}`);
  }

  /**
   * Reads iOS platform version from lockdownd (`ProductVersion`).
   * Example value: `26.3.1`.
   */
  public async getProductVersion(timeout = DEFAULT_TIMEOUT): Promise<string> {
    const value = await this.getValue<PlistValue>('ProductVersion', undefined, timeout);
    if (typeof value === 'string') {
      return value;
    }
    throw new LockdownError(`Unexpected ProductVersion value type: ${typeof value}`);
  }

  /**
   * Reads all default lockdownd values (same behavior as GetValue with no key/domain).
   * Useful for retrieving broad device information payloads.
   */
  public async getDeviceInfo(timeout = DEFAULT_TIMEOUT): Promise<LockdownDeviceInfo> {
    const value = await this.getValue<PlistValue>(undefined, undefined, timeout);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as LockdownDeviceInfo;
    }
    throw new LockdownError(`Unexpected device info payload type: ${Array.isArray(value) ? 'array' : typeof value}`);
  }

  /**
   * Closes the service and associated resources
   */
  public override close(): void {
    log.info('Closing LockdownService connections');

    try {
      this.closeSocket();
      this.stopRelayService();
    } catch (err) {
      log.error(`Error during close: ${formatError(err)}`);
      throw err;
    }
  }

  /**
   * Sets the relay service for this lockdown instance
   */
  public set relayService(relay: RelayService) {
    this._relayService = relay;
  }

  /**
   * Gets the relay service for this lockdown instance
   */
  public get relayService(): RelayService | undefined {
    return this._relayService;
  }

  /**
   * Waits for TLS upgrade to complete if in progress
   * @throws The TLS upgrade failure, if the automatic upgrade of a paired device failed
   */
  public async waitForTLSUpgrade(): Promise<void> {
    await this.tlsUpgradePromise;
    if (this.tlsUpgradeError) {
      throw this.tlsUpgradeError;
    }
  }

  /**
   * Stops the relay service with an optional custom message
   */
  public stopRelayService(message = 'Stopping relay server associated with LockdownService'): void {
    const relay = this.relayService;
    if (relay) {
      log.info(message);
      void (async () => {
        try {
          await relay.stop();
          log.info('Relay server stopped successfully');
        } catch (err) {
          log.error(`Error stopping relay server: ${formatError(err)}`);
        }
      })();
    }
  }

  /**
   * Reads a value from lockdownd using the GetValue request.
   *
   * @param key - Optional value key, e.g. TimeIntervalSince1970
   * @param domain - Optional value domain
   * @param timeout - Request timeout in milliseconds
   */
  private async getValue<T = PlistValue>(key?: string, domain?: string, timeout = DEFAULT_TIMEOUT): Promise<T> {
    const request: Record<string, PlistValue> = {
      Label: LABEL,
      Request: 'GetValue',
    };

    if (domain) {
      request.Domain = domain;
    }
    if (key) {
      request.Key = key;
    }

    const response = (await this.sendAndReceive(request, timeout)) as GetValueResponse;

    if (response.Error) {
      throw new LockdownError(`Lockdown GetValue failed for key "${key ?? '<all>'}": ${formatValue(response.Error)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(response, 'Value')) {
      throw new LockdownError(`Lockdown GetValue missing Value for key "${key ?? '<all>'}"`);
    }

    const value = response.Value as unknown;
    if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
      return (value as {data: unknown}).data as T;
    }
    return value as T;
  }

  private validatePairRecord(record: PairRecord): boolean {
    return Boolean(record?.HostCertificate && record.HostPrivateKey && record.HostID && record.SystemBUID);
  }

  private async performTLSUpgrade(pairRecord: PairRecord): Promise<void> {
    const tlsSocket = await this.tlsManager.upgradeSocketToTLS(
      this.getSocket() as Socket,
      pairRecordTlsOptions(pairRecord),
    );

    this.tlsService = new PlistService(tlsSocket);
    this.isTLS = true;
    log.info('Successfully upgraded connection to TLS');
  }

  private closeSocket(): void {
    if (this.isTLS && this.tlsService) {
      this.tlsService.close();
    } else {
      super.close();
    }
  }
}

// Factory class for creating LockdownService instances
export class LockdownServiceFactory {
  private readonly deviceManager = new DeviceManager();

  /**
   * Creates a LockdownService for a specific device UDID
   * @throws If the device is not found, the relay cannot be reached or the automatic TLS upgrade of a
   * paired device fails. The lockdown socket is destroyed before the relay is stopped, because the
   * relay server only finishes closing once its connections are gone.
   */
  async createByUDID(udid: string, port = DEFAULT_LOCKDOWN_PORT, autoSecure = true): Promise<LockdownServiceInfo> {
    log.info(`Creating LockdownService for UDID: ${udid}`);

    // Find the device
    const device = await this.deviceManager.findDeviceByUDID(udid);

    // Create relay service
    const relay = new RelayService(device.DeviceID, port, DEFAULT_RELAY_PORT);
    await relay.start();

    let service: LockdownService | undefined;
    let socket: Socket | undefined;
    try {
      // Connect through the relay
      socket = await relay.connect();
      log.debug('Socket connected, creating LockdownService');

      // Create the lockdown service
      service = new LockdownService(socket, udid, autoSecure);
      service.relayService = relay;

      // Wait for TLS upgrade if enabled
      if (autoSecure) {
        log.debug('Waiting for TLS upgrade to complete...');
        await service.waitForTLSUpgrade();
      }

      return {lockdownService: service, device};
    } catch (err) {
      // Clean up relay on error. Route directly through `relay` (not `service`), since
      // `service` is still undefined if relay.connect() itself is what failed.
      socket?.destroy();
      await relay.stop().catch((stopErr) => {
        log.error(`Error stopping relay after failure: ${stopErr}`);
      });
      throw err;
    }
  }
}

/**
 * Opens a paired, TLS-secured lockdown session over usbmux (no tunnel, no local relay).
 * The caller owns the returned `lockdown` and must close it.
 *
 * @throws If the device is not connected, not paired, or the session cannot be established
 */
export async function openLockdownSession(udid: string): Promise<LockdownSessionInfo> {
  const deviceManager = new DeviceManager();
  const device = await deviceManager.findDeviceByUDID(udid);
  const pairRecord = await deviceManager.readPairRecord(udid);

  const usbmux = await createUsbmux();
  let socket: Socket;
  try {
    socket = await usbmux.connect(device.DeviceID, DEFAULT_LOCKDOWN_PORT);
  } catch (err) {
    await usbmux.close().catch(() => {});
    throw err;
  }

  const lockdown = new LockdownService(socket, udid, false);
  try {
    await lockdown.startSecureSession(pairRecord);
  } catch (err) {
    // Closing must not mask the actual failure (e.g. a locked device)
    try {
      lockdown.close();
    } catch (closeErr) {
      log.debug(`Error closing lockdown after a failed session: ${formatError(closeErr)}`);
    }
    throw err;
  }
  return {lockdown, pairRecord, deviceId: device.DeviceID};
}

/**
 * Lockdown over an RSD tunnel. Opens a scoped discovery connection, resolves the remote
 * lockdown port, and returns a `LockdownService` (discovery RSD is closed before return).
 */
export async function createLockdownServiceForTunnel(udid: string): Promise<LockdownService> {
  const {host, port: lockdownPort} = await resolveTunnelService(udid, LOCKDOWN_REMOTE_UNTRUSTED);

  const conn = await ServiceConnection.createUsingTCP(host, String(lockdownPort));
  try {
    await rsdHandshakeLockdownPlistService(conn);
  } catch (err) {
    conn.close();
    throw err;
  }
  return new LockdownService(conn.detachSocket(), udid, false);
}

/**
 * Create a LockdownService by UDID via usbmux relay (backward-compatible helper).
 */
export async function createLockdownServiceByUDID(
  udid: string,
  port = DEFAULT_LOCKDOWN_PORT,
  autoSecure = true,
): Promise<LockdownServiceInfo> {
  const factory = new LockdownServiceFactory();
  return factory.createByUDID(udid, port, autoSecure);
}

/**
 * Builds the TLS options of a lockdown connection from a pair record: the host identity to present
 * and the device certificate to pin.
 * @throws LockdownError if the pair record lacks the host certificate, its key or the device certificate
 */
export function pairRecordTlsOptions(pairRecord: PairRecord): LockdownTlsOptions {
  const {HostCertificate, HostPrivateKey, DeviceCertificate} = pairRecord;
  if (!HostCertificate || !HostPrivateKey) {
    throw new LockdownError('Pair record missing TLS certificate or key');
  }
  if (!DeviceCertificate) {
    throw new LockdownError(
      'Pair record has no DeviceCertificate, so the device cannot be authenticated. ' +
        'Pair the device again to get a complete record.',
    );
  }
  return {cert: HostCertificate, key: HostPrivateKey, deviceCertificate: DeviceCertificate};
}

/**
 * Upgrade an existing socket connection to TLS using Lockdown-compatible options.
 * When `tlsOptions.deviceCertificate` is set, the device has to present it.
 */
export function upgradeSocketToTLS(
  socket: Socket,
  tlsOptions: LockdownTlsOptions,
  timeoutMs = TLS_HANDSHAKE_TIMEOUT_MS,
): Promise<TLSSocket> {
  const tlsManager = new TLSManager();
  return tlsManager.upgradeSocketToTLS(socket, tlsOptions, timeoutMs);
}

/**
 * RSD handshake on the remote lockdown TCP socket: RSDCheckin, RSDCheckin echo, StartService.
 */
async function rsdHandshakeLockdownPlistService(conn: ServiceConnection): Promise<void> {
  const checkin: Record<string, PlistValue> = {
    Label: LABEL,
    ProtocolVersion: '2',
    Request: 'RSDCheckin',
  };

  const first = await conn.sendPlistRequest(checkin, DEFAULT_TIMEOUT);
  if (first.Request !== 'RSDCheckin') {
    throw new LockdownError(`Invalid RSDCheckin response: ${JSON.stringify(first)}`);
  }

  const second = await conn.receive(DEFAULT_TIMEOUT);
  if (!second || second.Request !== 'StartService') {
    throw new LockdownError(`Expected StartService after RSDCheckin, got: ${JSON.stringify(second)}`);
  }
  if (second.Error) {
    const desc = second.ErrorDescription ?? 'Unknown error';
    throw new LockdownError(`RSD remote lockdown service failed: ${formatValue(second.Error)} — ${formatValue(desc)}`);
  }
}
