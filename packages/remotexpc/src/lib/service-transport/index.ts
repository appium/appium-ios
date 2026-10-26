import {getLogger} from '../logger.js';
import {TunnelAvailabilityError} from '../tunnel/errors.js';
import {
  DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  resolveTunnelService,
  resolveTunnelServicePorts,
} from '../tunnel/tunnel-service-resolver.js';
import {assertDeviceReadyOverUsbmux} from './availability.js';
import {AUTO_TUNNEL_WAIT_MS} from './constants.js';
import {UnsupportedTransportError, UsbmuxDeviceUnavailableError} from './errors.js';
import {UsbmuxServiceTransport} from './usbmux.js';

const log = getLogger('ServiceTransport');

/** How a service connection is established: RemoteXPC tunnel, lockdown over usbmux, or tunnel-then-usbmux. */
export type TransportMode = 'auto' | 'tunnel' | 'usbmux';

/** Marker for the RemoteXPC tunnel transport (the service classes implement it themselves). */
export interface TunnelServiceTransport {
  readonly kind: 'tunnel';
}

export type ServiceTransport = TunnelServiceTransport | UsbmuxServiceTransport;

export const TUNNEL_TRANSPORT: TunnelServiceTransport = Object.freeze({kind: 'tunnel'});

/** Options accepted by the `Services.start*` functions. */
export interface StartServiceOptions {
  /**
   * Defaults to `tunnel`; `usbmux` and `auto` must be requested explicitly.
   * Use {@link getAvailableTransports} to find out what a device supports.
   */
  transport?: TransportMode;
}

/** Tunnel catalog lookups used by the resolver; injectable so callers/tests can substitute them. */
export interface TunnelResolvers {
  resolveTunnelService: typeof resolveTunnelService;
  resolveTunnelServicePorts: typeof resolveTunnelServicePorts;
  /** Verifies the device can start lockdown services; defaults to a usbmuxd + pair record check */
  assertUsbmuxReady?: (udid: string) => Promise<void>;
}

const DEFAULT_TUNNEL_RESOLVERS: TunnelResolvers = {resolveTunnelService, resolveTunnelServicePorts};

/**
 * Chooses the transport for one or more services of a device.
 *
 * - `tunnel`: requires every service in the tunnel catalog.
 * - `usbmux`: requires every service to be startable through lockdown and the device to be
 *   connected and paired.
 * - `auto`: the tunnel when it serves all of them, otherwise usbmux when every service supports it and
 *   the device is connected and paired, otherwise the original tunnel error.
 *
 * @throws {TunnelAvailabilityError} If no transport can serve the services
 * @throws {UsbmuxDeviceUnavailableError} In `usbmux` mode, if the device is not connected or paired
 */
export async function resolveServiceTransport(
  udid: string,
  rsdServiceNames: string | string[],
  mode: TransportMode = 'tunnel',
  resolvers: TunnelResolvers = DEFAULT_TUNNEL_RESOLVERS,
): Promise<ServiceTransport> {
  return (await resolveServiceTransportWithPort(udid, rsdServiceNames, mode, resolvers)).transport;
}

/**
 * Like {@link resolveServiceTransport}, additionally returning the service's tunnel port when
 * the tunnel was chosen for a single service (so callers needing it avoid a second registry lookup).
 */
export async function resolveServiceTransportWithPort(
  udid: string,
  rsdServiceNames: string | string[],
  mode: TransportMode = 'tunnel',
  resolvers: TunnelResolvers = DEFAULT_TUNNEL_RESOLVERS,
): Promise<{transport: ServiceTransport; tunnelPort?: number}> {
  const names = Array.isArray(rsdServiceNames) ? rsdServiceNames : [rsdServiceNames];
  if (names.length === 0) {
    throw new TypeError('At least one service name is required to resolve a transport');
  }
  const usbmux = new UsbmuxServiceTransport(udid);

  const assertUsbmuxReady = resolvers.assertUsbmuxReady ?? assertDeviceReadyOverUsbmux;

  if (mode === 'usbmux') {
    assertUsbmuxSupport(usbmux, names);
    await assertUsbmuxReady(udid);
    return {transport: usbmux};
  }

  try {
    const waitMs = mode === 'auto' ? AUTO_TUNNEL_WAIT_MS : DEFAULT_TUNNEL_SERVICE_WAIT_MS;
    if (names.length === 1) {
      const {port} = await resolvers.resolveTunnelService(udid, names[0], {waitMs});
      return {transport: TUNNEL_TRANSPORT, tunnelPort: port};
    }
    await resolvers.resolveTunnelServicePorts(udid, names, {waitMs});
    return {transport: TUNNEL_TRANSPORT};
  } catch (err) {
    if (mode === 'tunnel' || !(err instanceof TunnelAvailabilityError)) {
      throw err;
    }
    if (!names.every((name) => usbmux.supports(name))) {
      throw err;
    }
    try {
      await assertUsbmuxReady(udid);
    } catch (usbmuxErr) {
      // Keep the tunnel error so callers asking the user to start a tunnel still recognise it
      log.debug(`Tunnel unavailable for ${udid} (${err.message}) and usbmux is not usable: ${usbmuxErr}`);
      throw err;
    }
    log.debug(`Tunnel unavailable for ${udid} (${err.message}); using lockdown over usbmux`);
    return {transport: usbmux};
  }
}

function assertUsbmuxSupport(usbmux: UsbmuxServiceTransport, names: string[]): void {
  const unsupported = names.filter((name) => !usbmux.supports(name));
  if (unsupported.length > 0) {
    throw new UnsupportedTransportError(
      `Service(s) ${unsupported.join(', ')} are not available without a RemoteXPC tunnel. ` +
        'Please run the tunnel creation script first',
    );
  }
}

export {getAvailableTransports} from './availability.js';
export type {AvailabilityProbes, TransportAvailability, TransportAvailabilityOptions} from './availability.js';
export {UnsupportedTransportError, UsbmuxDeviceUnavailableError, UsbmuxServiceTransport};
export {UsbmuxServiceConnection} from './usbmux.js';
export {getLockdownServiceName} from './lockdown-service-names.js';
export {SERVICE_NAMES} from './service-names.js';
