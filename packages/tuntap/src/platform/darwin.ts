import {execFileAsync} from './exec.js';
import {assertEffectiveRoot} from './require-root.js';
import type {TunTapPlatform} from './types.js';

/** macOS implementation using `ifconfig` and `route`. */
export class DarwinTunTapPlatform implements TunTapPlatform {
  /** @inheritdoc */
  async configure(interfaceName: string, address: string, mtu: number): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('ifconfig', [interfaceName, 'inet6', address, 'prefixlen', '64', 'up']);
    await execFileAsync('ifconfig', [interfaceName, 'mtu', String(mtu)]);
  }

  /** @inheritdoc */
  async addRoute(interfaceName: string, destination: string): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('route', ['-n', 'add', '-inet6', destination, '-interface', interfaceName]);
  }

  /** @inheritdoc */
  async removeRoute(_interfaceName: string, destination: string): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('route', ['-n', 'delete', '-inet6', destination]);
  }
}
