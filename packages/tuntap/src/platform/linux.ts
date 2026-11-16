import type {ExecException} from 'node:child_process';

import {fs} from '@appium/support';

import {TunTapError} from '../errors.js';
import {log} from '../logger.js';
import {execFileAsync} from './exec.js';
import {assertEffectiveRoot} from './require-root.js';
import type {TunTapPlatform} from './types.js';

/** Linux implementation using `ip` from iproute2. */
export class LinuxTunTapPlatform implements TunTapPlatform {
  /** @inheritdoc */
  async configure(interfaceName: string, address: string, mtu: number): Promise<void> {
    assertEffectiveRoot();
    try {
      await fs.which('ip');
    } catch {
      throw new TunTapError(
        'The "ip" command is not available. Please install iproute2 (e.g., sudo apt install iproute2)',
      );
    }

    try {
      await execFileAsync('ip', ['-6', 'addr', 'add', `${address}/64`, 'dev', interfaceName]);
    } catch (err: unknown) {
      // `util.promisify(execFile)` rejects with `ExecException` (extends `Error`; adds `stderr`, `code`, …).
      const {message} = err as ExecException;
      if (!message.includes('File exists')) {
        throw err;
      }
      log.warn(`Address ${address} may already be configured on ${interfaceName}`);
    }

    await execFileAsync('ip', ['link', 'set', 'dev', interfaceName, 'up', 'mtu', String(mtu)]);
  }

  /** @inheritdoc */
  async addRoute(interfaceName: string, destination: string): Promise<void> {
    assertEffectiveRoot();
    try {
      await execFileAsync('ip', ['-6', 'route', 'add', destination, 'dev', interfaceName]);
    } catch (err: unknown) {
      const {message} = err as ExecException;
      if (message.includes('File exists')) {
        log.info(`Route to ${destination} already exists`);
        return;
      }
      throw err;
    }
  }

  /** @inheritdoc */
  async removeRoute(interfaceName: string, destination: string): Promise<void> {
    assertEffectiveRoot();
    await execFileAsync('ip', ['-6', 'route', 'del', destination, 'dev', interfaceName]);
  }
}
