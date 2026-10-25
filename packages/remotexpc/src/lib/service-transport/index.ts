import {getLogger} from '../logger.js';
import {TunnelAvailabilityError} from '../tunnel/errors.js';
import {
  DEFAULT_TUNNEL_SERVICE_WAIT_MS,
  resolveTunnelService,
  resolveTunnelServicePorts,
} from '../tunnel/tunnel-service-resolver.js';
import {AUTO_TUNNEL_WAIT_MS} from './constants.js';
import {UnsupportedTransportError} from './errors.js';
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

export const TRANSPORT_ENV_VAR = 'APPIUM_IOS_REMOTEXPC_TRANSPORT';

/** Options accepted by the `Services.start*` functions. */
export interface StartServiceOptions {
  /**
   * Defaults to `APPIUM_IOS_REMOTEXPC_TRANSPORT`, then `tunnel`. `usbmux` and `auto` must be requested explicitly.
   * Use {@link getAvailableTransports} to find out what a device supports.
   */
  transport?: TransportMode;
}

/** Tunnel catalog lookups used by the resolver; injectable so callers/tests can substitute them. */
export interface TunnelResolvers {
  resolveTunnelService: typeof resolveTunnelService;
  resolveTunnelServicePorts: typeof resolveTunnelServicePorts;
}

const DEFAULT_TUNNEL_RESOLVERS: TunnelResolvers = {resolveTunnelService, resolveTunnelServicePorts};

/** The tunnel unless `APPIUM_IOS_REMOTEXPC_TRANSPORT` explicitly asks for `usbmux` or `auto`. */
export function getDefaultTransportMode(): TransportMode {
  const value = process.env[TRANSPORT_ENV_VAR]?.trim().toLowerCase();
  if (value === 'usbmux' || value === 'auto') {
    return value;
  }
  if (value && value !== 'tunnel' && !warnedInvalidModes.has(value)) {
    warnedInvalidModes.add(value);
    log.warn(`Ignoring invalid ${TRANSPORT_ENV_VAR} value '${value}'; expected tunnel, usbmux or auto. Using tunnel.`);
  }
  return 'tunnel';
}

const warnedInvalidModes = new Set<string>();

/**
 * Chooses the transport for one or more services of a device.
 *
 * - `tunnel`: requires every service in the tunnel catalog.
 * - `usbmux`: requires every service to be startable through lockdown.
 * - `auto`: the tunnel when it serves all of them, otherwise usbmux when every service supports it,
 *   otherwise the original tunnel error.
 *
 * @throws {TunnelAvailabilityError} If no transport can serve the services
 */
export async function resolveServiceTransport(
  udid: string,
  rsdServiceNames: string | string[],
  mode: TransportMode = getDefaultTransportMode(),
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
  mode: TransportMode = getDefaultTransportMode(),
  resolvers: TunnelResolvers = DEFAULT_TUNNEL_RESOLVERS,
): Promise<{transport: ServiceTransport; tunnelPort?: number}> {
  const names = Array.isArray(rsdServiceNames) ? rsdServiceNames : [rsdServiceNames];
  if (names.length === 0) {
    throw new TypeError('At least one service name is required to resolve a transport');
  }
  const usbmux = new UsbmuxServiceTransport(udid);

  if (mode === 'usbmux') {
    assertUsbmuxSupport(usbmux, names);
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
export {UnsupportedTransportError, UsbmuxServiceTransport};
export {UsbmuxServiceConnection} from './usbmux.js';
export {getLockdownServiceName} from './lockdown-service-names.js';
