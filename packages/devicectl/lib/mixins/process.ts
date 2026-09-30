import type {Devicectl} from '../devicectl.js';
import type {LaunchAppOptions, ProcessInfo, TerminateAppOptions} from '../types.js';

/**
 * Simulates memory warning for the process with the given PID
 */
export async function sendMemoryWarning(this: Devicectl, pid: number | string): Promise<void> {
  await this.execute(['device', 'process', 'sendMemoryWarning'], {
    subcommandOptions: ['--pid', `${pid}`],
  });
}

/**
 * Send POSIX signal to the running process
 */
export async function sendSignalToProcess(
  this: Devicectl,
  pid: number | string,
  signal: number | string,
): Promise<void> {
  await this.execute(['device', 'process', 'signal'], {
    subcommandOptions: ['--signal', `${signal}`, '--pid', `${pid}`],
  });
}

/**
 * Launch the given bundle id application with the given environment variable.
 * This method is over devicectl command, this it may take additional seconds to launch the app.
 * Please use via WDA or via appium-ios-device as primary method to launch app if possible.
 */
export async function launchApp(this: Devicectl, bundleId: string, opts: LaunchAppOptions = {}): Promise<void> {
  const {env, terminateExisting = false} = opts;

  const subcommandOptions: string[] = [];

  if (terminateExisting) {
    subcommandOptions.push('--terminate-existing');
  }

  if (env && Object.keys(env).length > 0) {
    subcommandOptions.push(
      '--environment-variables',
      JSON.stringify(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]))),
    );
  }

  // The bundle id should be the last to apply arguments properly.
  // devicectl command might not raise exception while the order is wrong.
  subcommandOptions.push(bundleId);

  await this.execute(['device', 'process', 'launch'], {
    subcommandOptions,
    asJson: false,
  });
}

/**
 * Terminates all running processes for the app with the given bundle identifier.
 *
 * Resolves the app's install path via {@link Devicectl.listApps}, finds matching
 * processes with `devicectl device info processes --filter`, then terminates each
 * via `devicectl device process terminate`.
 *
 * @returns `true` if at least one process was terminated, otherwise `false`
 */
export async function terminateApp(
  this: Devicectl,
  bundleId: string,
  opts: TerminateAppOptions = {},
): Promise<boolean> {
  const apps = await this.listApps(bundleId);
  if (apps.length === 0) {
    return false;
  }

  const processes = await listProcessesForAppPath(this, appUrlToFilesystemPath(apps[0].url));
  if (processes.length === 0) {
    return false;
  }

  const {force = false} = opts;
  const subcommandOptions: string[] = [];
  if (force) {
    subcommandOptions.push('--kill');
  }

  await Promise.all(
    processes.map(({processIdentifier}) =>
      this.execute(['device', 'process', 'terminate'], {
        subcommandOptions: [...subcommandOptions, '--pid', `${processIdentifier}`],
      }),
    ),
  );

  return true;
}

/** Converts a devicectl app URL to a filesystem path for process filters. */
export function appUrlToFilesystemPath(appUrl: string): string {
  const path = appUrl.startsWith('file:') ? new URL(appUrl).pathname : appUrl;
  return path.replace(/\/$/, '') || '/';
}

/** Escapes a value for use inside a devicectl process filter string. */
export function escapeProcessFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function listProcessesForAppPath(devicectl: Devicectl, appPath: string): Promise<ProcessInfo[]> {
  const filter = `executable.path BEGINSWITH "${escapeProcessFilterValue(appPath)}"`;
  const {stdout} = await devicectl.execute(['device', 'info', 'processes'], {
    subcommandOptions: ['--filter', filter],
  });
  return JSON.parse(stdout).result.runningProcesses;
}
