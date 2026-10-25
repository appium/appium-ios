import type net from 'node:net';

import {ServiceConnection, type ServiceConnectionOptions} from '../../service-connection.js';
import {openLockdownSession, upgradeSocketToTLS} from '../lockdown/index.js';
import {getLogger} from '../logger.js';
import type {PlistDictionary} from '../types.js';
import {createUsbmux} from '../usbmux/index.js';
import {UnsupportedTransportError} from './errors.js';
import {getLockdownServiceName} from './lockdown-service-names.js';

const log = getLogger('UsbmuxServiceTransport');

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;

let experimentalWarningLogged = false;

/**
 * Starts lockdown services through lockdownd over usbmux (the way libimobiledevice and the
 * deprecated appium-ios-device do), so no RemoteXPC tunnel is needed.
 *
 * Transitional: relies on the classic lockdown services remaining available on the device.
 */
export class UsbmuxServiceTransport {
  readonly kind = 'usbmux' as const;

  constructor(readonly udid: string) {}

  /** @returns `true` if the RSD-named service can be started over lockdown */
  supports(rsdServiceName: string): boolean {
    return getLockdownServiceName(rsdServiceName) !== undefined;
  }

  /**
   * Starts the service and returns a socket positioned at the start of the service protocol
   * (TLS already negotiated when the device requires it).
   *
   * @param rsdServiceName - The RSD shim name the service class knows (mapped to the lockdown name)
   * @throws {UnsupportedTransportError} If the service is tunnel-only
   */
  async openSocket(rsdServiceName: string, opts: {timeoutMs?: number} = {}): Promise<net.Socket> {
    const lockdownName = getLockdownServiceName(rsdServiceName);
    if (!lockdownName) {
      throw new UnsupportedTransportError(
        `Service ${rsdServiceName} is not available without a RemoteXPC tunnel (usbmux-only mode). ` +
          'Please run the tunnel creation script first',
      );
    }
    if (!experimentalWarningLogged) {
      experimentalWarningLogged = true;
      log.warn(
        'No RemoteXPC tunnel is used: starting services through lockdown over usbmux. ' +
          'This relies on legacy lockdown services and some features are unavailable.',
      );
    }

    const {timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS} = opts;
    const {lockdown, pairRecord, deviceId} = await openLockdownSession(this.udid);
    let started;
    try {
      started = await lockdown.startService(lockdownName);
    } finally {
      // Closing must not mask the actual failure (e.g. a locked device)
      try {
        lockdown.close();
      } catch (closeErr) {
        log.debug(`Error closing lockdown after StartService: ${closeErr}`);
      }
    }
    log.debug(`Started ${lockdownName} on port ${started.port} (ssl=${started.enableServiceSSL})`);

    const usbmux = await createUsbmux();
    let socket: net.Socket;
    try {
      socket = await usbmux.connect(deviceId, started.port, timeoutMs);
    } catch (err) {
      await usbmux.close().catch(() => {});
      throw err;
    }
    try {
      if (started.enableServiceSSL) {
        socket = await upgradeSocketToTLS(socket, {
          cert: pairRecord.HostCertificate as string,
          key: pairRecord.HostPrivateKey as string,
        });
      }
    } catch (err) {
      socket.destroy();
      throw err;
    }
    socket.setKeepAlive(true);
    socket.setNoDelay(true);
    return socket;
  }
}

/**
 * Plist service connection over a lockdown-started socket. The RSD tunnel path makes the device send
 * a `StartService` greeting that several service classes read right after connecting; lockdown has no
 * such message, so it is replayed to a caller that reads before sending anything. This keeps the
 * service classes identical for both transports.
 */
export class UsbmuxServiceConnection extends ServiceConnection {
  private greetingPending = true;

  constructor(
    socket: net.Socket,
    private readonly serviceName: string,
    options?: ServiceConnectionOptions,
  ) {
    super(socket, options);
  }

  override async receive(timeout?: number): Promise<PlistDictionary> {
    if (this.greetingPending) {
      this.greetingPending = false;
      return {Request: 'StartService', Service: this.serviceName};
    }
    return await super.receive(timeout);
  }

  override async sendAndReceive(message: PlistDictionary, timeout?: number): Promise<PlistDictionary> {
    this.greetingPending = false;
    return await super.sendAndReceive(message, timeout);
  }

  protected override send(message: PlistDictionary): void {
    this.greetingPending = false;
    super.send(message);
  }
}
