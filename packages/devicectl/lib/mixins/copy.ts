import type {Devicectl} from '../devicectl.js';
import type {ListFilesOptions, PullFileOptions} from '../types.js';

/**
 * Lists files at a specified path on the device
 */
export async function listFiles(
  this: Devicectl,
  domainType: string,
  domainIdentifier: string,
  opts: ListFilesOptions = {},
): Promise<string[]> {
  const subcommandOptions = ['--domain-type', domainType, '--domain-identifier', domainIdentifier];

  if (opts.username) {
    subcommandOptions.push('--username', opts.username);
  }

  if (opts.subdirectory) {
    subcommandOptions.push('--subdirectory', opts.subdirectory);
  }

  const {stdout} = await this.execute(['device', 'info', 'files'], {
    subcommandOptions,
  });

  return JSON.parse(stdout).result.files.map(({name}: {name: string}) => name);
}

/**
 * Pulls a file from the specified path on the device to a local file system
 */
export async function pullFile(this: Devicectl, from: string, to: string, opts: PullFileOptions): Promise<string> {
  const subcommandOptions = [
    '--domain-type',
    opts.domainType,
    '--domain-identifier',
    opts.domainIdentifier,
    '--source',
    from,
    '--destination',
    to,
  ];

  if (opts.username) {
    subcommandOptions.push('--user', opts.username);
  }

  await this.execute(['device', 'copy', 'from'], {
    subcommandOptions,
    timeout: opts.timeout ?? 120000,
    asJson: false,
  });

  return to;
}
