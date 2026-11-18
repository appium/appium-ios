import type net from 'node:net';

import {RSD_HANDSHAKE_FRAMES, rsdHandshakeLockdownPlistService} from '../../lib/lockdown/index.js';
import {
  type ServiceTransport,
  TUNNEL_TRANSPORT,
  UnsupportedTransportError,
  UsbmuxServiceTransport,
} from '../../lib/service-transport/index.js';
import {DEFAULT_TUNNEL_SERVICE_WAIT_MS, resolveTunnelService} from '../../lib/tunnel/tunnel-service-resolver.js';
import {ServiceConnection, type ServiceConnectionOptions} from '../../service-connection.js';

/**
 * Interface for service information
 */
export interface Service {
  serviceName: string;
  port: string;
}

/** Options shared by all services built on {@link BaseService}. */
export interface BaseServiceOptions {
  /** How service connections are established. Defaults to the RemoteXPC tunnel. */
  transport?: ServiceTransport;
}

/**
 * Base class for iOS services that provides common functionality
 */
export class BaseService {
  protected readonly udid: string;
  protected readonly serviceTransport: ServiceTransport;

  /**
   * Creates a new BaseService instance
   * @param udid Device UDID
   * @param options Service options (e.g. the transport)
   */
  constructor(udid: string, options: BaseServiceOptions = {}) {
    this.udid = udid;
    this.serviceTransport = options.transport ?? TUNNEL_TRANSPORT;
  }

  /**
   * Starts a lockdown service without sending a check-in message
   */
  public async startLockdownWithoutCheckin(
    serviceName: string,
    options: Record<string, any> = {},
  ): Promise<ServiceConnection> {
    this.assertTunnelTransport(serviceName);
    const [host, port] = await this.resolveServiceAddress(serviceName);
    return ServiceConnection.createUsingTCP(host, String(port), options);
  }

  /**
   * Starts a lockdown service and completes its handshake, so the returned connection is positioned
   * at the service's own protocol on either transport. Over the RemoteXPC tunnel the handshake is the
   * `RSDCheckin` echo followed by the `StartService` greeting. `options.createConnectionTimeout`
   * bounds the TCP connect and `options.handshakeTimeout` each of those two replies.
   * @throws {LockdownStartServiceError} If the device refuses to start the service
   */
  public async startLockdownService(
    serviceName: string,
    options: Record<string, any> = {},
  ): Promise<ServiceConnection> {
    if (this.serviceTransport instanceof UsbmuxServiceTransport) {
      return await this.startUsbmuxService(this.serviceTransport, serviceName, options);
    }
    const connection = await this.startLockdownWithoutCheckin(serviceName, options);
    try {
      await rsdHandshakeLockdownPlistService(connection, serviceName, options.handshakeTimeout);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  /**
   * Starts a service that streams raw bytes right after its handshake and returns its socket
   * positioned at the first of them, none consumed by plist framing. The caller must `resume()`
   * the socket after attaching its reader.
   */
  public async startRawShimService(serviceName: string): Promise<net.Socket> {
    if (this.serviceTransport instanceof UsbmuxServiceTransport) {
      return await this.serviceTransport.openSocket(serviceName);
    }
    const connection = await this.startLockdownService(serviceName, {
      plistOptions: {maxFrames: RSD_HANDSHAKE_FRAMES},
    });
    return connection.detachSocket();
  }

  /**
   * Starts the service through lockdown over usbmux. Already past the (RSD-only) check-in.
   */
  private async startUsbmuxService(
    transport: UsbmuxServiceTransport,
    serviceName: string,
    options: Record<string, any>,
  ): Promise<ServiceConnection> {
    const socket = await transport.openSocket(serviceName, {timeoutMs: options.createConnectionTimeout});
    return new ServiceConnection(socket, options as ServiceConnectionOptions);
  }

  /** Services that need the raw RSD address (DTX, CoreDevice) cannot run over usbmux. */
  private assertTunnelTransport(serviceName: string): void {
    if (this.serviceTransport.kind !== 'tunnel') {
      throw new UnsupportedTransportError(
        `Service ${serviceName} is not available without a RemoteXPC tunnel. ` +
          'Please run the tunnel creation script first',
      );
    }
  }

  protected async resolveServiceAddress(
    serviceName: string,
    waitMs: number = DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  ): Promise<[string, number]> {
    this.assertTunnelTransport(serviceName);
    const {host, port} = await resolveTunnelService(this.udid, serviceName, {
      waitMs,
    });
    return [host, port];
  }
}

/**
 * Remove any SSL wrapper from the socket so raw binary protocols (DTX)
 * can read/write directly. Both DVT and testmanagerd services require this.
 */
export function stripSSL(socket: net.Socket): void {
  if ('_sslobj' in socket) {
    (socket as any)._sslobj = null;
  }
}

export default BaseService;
