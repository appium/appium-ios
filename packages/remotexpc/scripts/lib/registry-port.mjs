import {once} from 'node:events';
import net from 'node:net';

const TUNNEL_REGISTRY_HOST = '127.0.0.1';

/**
 * Binds to `port` (0 = OS-assigned), then releases it and resolves the bound port.
 * @param {number} port
 * @returns {Promise<number>}
 */
async function bindFreePort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, TUNNEL_REGISTRY_HOST, () => resolve(undefined));
  });
  const address = probe.address();
  const closed = once(probe, 'close');
  probe.close();
  await closed;
  if (!address || typeof address === 'string') {
    throw new Error('Could not resolve a free port');
  }
  return address.port;
}

/**
 * Returns `preferredPort` if free, else a free port chosen by the OS.
 * @param {number} preferredPort
 * @param {{warn: (message: string) => void}} log
 * @returns {Promise<number>}
 */
export async function resolveAvailableRegistryPort(preferredPort, log) {
  try {
    return await bindFreePort(preferredPort);
  } catch {
    const port = await bindFreePort(0);
    log.warn(`Tunnel registry port ${preferredPort} is in use; using ${port} instead`);
    return port;
  }
}
