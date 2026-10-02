import type {Devicectl} from '../devicectl.js';
import type {AppInfo, ProcessInfo} from '../types.js';

/**
 * Retrieves the list of installed apps from the device
 */
export async function listApps(this: Devicectl, bundleId?: string): Promise<AppInfo[]> {
  const subcommandOptions = ['--include-all-apps'];

  if (bundleId) {
    subcommandOptions.push('--bundle-id', bundleId);
  }

  const {stdout} = await this.execute(['device', 'info', 'apps'], {
    subcommandOptions,
  });

  return JSON.parse(stdout).result.apps;
}

/**
 * Lists running processes on the device
 */
export async function listProcesses(this: Devicectl): Promise<ProcessInfo[]> {
  const {stdout} = await this.execute(['device', 'info', 'processes']);
  return JSON.parse(stdout).result.runningProcesses;
}
