import {getLogger} from '../logger.js';
import {getTunnelForDevice} from '../tunnel/tunnel-availability.js';
import {resolveTunnelService, resolveTunnelServicePorts} from '../tunnel/tunnel-service-resolver.js';
import {createUsbmux} from '../usbmux/index.js';
import {AUTO_TUNNEL_WAIT_MS} from './constants.js';
import {getLockdownServiceName} from './lockdown-service-names.js';

const log = getLogger('TransportAvailability');

/** Which transports can currently serve a device (and, if given, a set of services). */
export interface TransportAvailability {
  /** The RemoteXPC tunnel is up and (when services were given) lists all of them */
  tunnel: boolean;
  /** The device is connected and paired, and (when services were given) all of them can be started over lockdown */
  usbmux: boolean;
}

export interface TransportAvailabilityOptions {
  /** How long to wait for the tunnel registry to report the device, in milliseconds (default 2000) */
  tunnelWaitMs?: number;
}

/** Probes behind {@link getAvailableTransports}; injectable for tests. */
export interface AvailabilityProbes {
  getTunnelForDevice: typeof getTunnelForDevice;
  resolveTunnelService: typeof resolveTunnelService;
  resolveTunnelServicePorts: typeof resolveTunnelServicePorts;
  isDeviceReadyOverUsbmux: (udid: string) => Promise<boolean>;
}

const DEFAULT_PROBES: AvailabilityProbes = {
  getTunnelForDevice,
  resolveTunnelService,
  resolveTunnelServicePorts,
  isDeviceReadyOverUsbmux,
};

/**
 * Reports which transports can serve a device right now, without starting anything.
 * Never throws: an unreachable registry, a missing device or a missing pair record simply
 * make the respective transport unavailable.
 *
 * @param udid - Device UDID
 * @param rsdServiceNames - RSD service name(s) the caller intends to start, e.g. `AfcService.RSD_SERVICE_NAME`.
 * Omit to only check the device itself.
 */
export async function getAvailableTransports(
  udid: string,
  rsdServiceNames: string | string[] = [],
  options: TransportAvailabilityOptions = {},
  probes: AvailabilityProbes = DEFAULT_PROBES,
): Promise<TransportAvailability> {
  const names = Array.isArray(rsdServiceNames) ? rsdServiceNames : [rsdServiceNames];
  const waitMs = options.tunnelWaitMs ?? AUTO_TUNNEL_WAIT_MS;

  const [tunnel, usbmux] = await Promise.all([
    isTunnelAvailable(udid, names, waitMs, probes),
    names.every((name) => getLockdownServiceName(name) !== undefined)
      ? probes.isDeviceReadyOverUsbmux(udid).catch((err) => {
          log.debug(`usbmux check failed for ${udid}: ${err}`);
          return false;
        })
      : false,
  ]);
  return {tunnel, usbmux};
}

async function isTunnelAvailable(
  udid: string,
  names: string[],
  waitMs: number,
  probes: AvailabilityProbes,
): Promise<boolean> {
  try {
    if (names.length === 0) {
      await probes.getTunnelForDevice(udid, {waitMs});
    } else if (names.length === 1) {
      await probes.resolveTunnelService(udid, names[0], {waitMs});
    } else {
      await probes.resolveTunnelServicePorts(udid, names, {waitMs});
    }
    return true;
  } catch (err) {
    log.debug(`Tunnel not available for ${udid}: ${err}`);
    return false;
  }
}

/** The device is listed by usbmuxd and has a usable pair record. */
async function isDeviceReadyOverUsbmux(udid: string): Promise<boolean> {
  const usbmux = await createUsbmux();
  try {
    if (!(await usbmux.findDevice(udid))) {
      return false;
    }
    const pairRecord = await usbmux.readPairRecord(udid);
    return Boolean(
      pairRecord?.HostID && pairRecord.SystemBUID && pairRecord.HostCertificate && pairRecord.HostPrivateKey,
    );
  } finally {
    await usbmux.close().catch(() => {});
  }
}
