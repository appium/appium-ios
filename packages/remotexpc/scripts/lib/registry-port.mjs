import {net} from '@appium/support';

const TUNNEL_REGISTRY_HOST = '127.0.0.1';

/**
 * Returns `preferredPort` if free, else a free port chosen by the OS.
 * @param {number} preferredPort
 * @param {{warn: (message: string) => void}} log
 * @returns {Promise<number>}
 */
export async function resolveAvailableRegistryPort(preferredPort, log) {
  try {
    return await net.getFreePort({port: preferredPort, host: TUNNEL_REGISTRY_HOST});
  } catch {
    const port = await net.getFreePort({host: TUNNEL_REGISTRY_HOST});
    log.warn(`Tunnel registry port ${preferredPort} is in use; using ${port} instead`);
    return port;
  }
}
