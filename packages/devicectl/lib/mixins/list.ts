import type {Devicectl} from '../devicectl.js';
import type {DeviceInfo} from '../types.js';

/**
 * Retrieves the list of connected device infos.
 * Might be empty if no devices are connected.
 */
export async function listDevices(this: Devicectl): Promise<DeviceInfo[]> {
  const {stdout} = await this.execute(['list', 'devices'], {
    noDevice: true,
  });
  return JSON.parse(stdout).result.devices;
}
