import {log as logger} from '@appium/logger';
import {exec, SubProcess} from 'teen_process';

import * as copyMixins from './mixins/copy.js';
import * as infoMixins from './mixins/info.js';
import * as listMixins from './mixins/list.js';
import * as processMixins from './mixins/process.js';
import type {DevicectlOptions, ExecuteOptions, ExecuteResult} from './types.js';

const XCRUN = 'xcrun';
const LOG_TAG = 'Devicectl';
type SudoUser = {uid: number; gid: number};

/**
 * Node.js wrapper around Apple's devicectl tool
 *
 * This class provides methods to interact with iOS devices using the devicectl command-line tool.
 * It requires Xcode 15+ and iOS 17+ to function properly.
 *
 */
export class Devicectl {
  /** The unique device identifier */
  public readonly udid: string;

  sendMemoryWarning = processMixins.sendMemoryWarning;
  sendSignalToProcess = processMixins.sendSignalToProcess;
  launchApp = processMixins.launchApp;
  terminateApp = processMixins.terminateApp;

  listProcesses = infoMixins.listProcesses;
  listApps = infoMixins.listApps;

  listFiles = copyMixins.listFiles;
  pullFile = copyMixins.pullFile;

  listDevices = listMixins.listDevices;

  private readonly preferNonRootWhenSudo: boolean;
  private readonly sudoUser: SudoUser | null;

  /**
   * Creates a new Devicectl instance
   *
   * @param udid - The unique device identifier
   */
  constructor(udid: string, opts?: DevicectlOptions) {
    this.udid = udid;
    this.preferNonRootWhenSudo = opts?.preferNonRootWhenSudo ?? true;
    this.sudoUser = this.resolveSudoUser();
  }

  /**
   * Executes a devicectl command
   *
   * @param subcommand - The devicectl subcommand to execute
   * @param opts - Execution options
   * @returns Promise that resolves to the command result
   */
  async execute<T extends ExecuteOptions>(subcommand: string[], opts?: T): Promise<ExecuteResult<T>> {
    const {
      logStdout = false,
      asynchronous = false,
      asJson = true,
      noDevice = false,
      subcommandOptions,
      timeout,
      runAsNonRootWhenSudo = this.preferNonRootWhenSudo,
    } = opts ?? {};

    const finalArgs = ['devicectl', ...subcommand, ...(noDevice ? [] : ['--device', this.udid])];

    if (subcommandOptions && subcommandOptions.length > 0) {
      finalArgs.push(...(Array.isArray(subcommandOptions) ? subcommandOptions : [subcommandOptions]));
    }

    if (asJson) {
      finalArgs.push('--quiet', '--json-output', '-');
    }

    const userOpts = runAsNonRootWhenSudo && this.sudoUser ? this.sudoUser : undefined;
    const cmdStr = [XCRUN, ...finalArgs].map((arg) => `"${arg}"`).join(' ');
    logger.debug(LOG_TAG, `Executing ${cmdStr}`);

    try {
      if (asynchronous) {
        const result = new SubProcess(XCRUN, finalArgs, userOpts);
        await result.start(0);
        return result as ExecuteResult<T>;
      }

      const execOpts = {
        ...userOpts,
        ...(typeof timeout === 'number' ? {timeout} : {}),
      };
      const result = await exec(XCRUN, finalArgs, execOpts);

      if (logStdout) {
        logger.debug(LOG_TAG, `Command output: ${result.stdout}`);
      }

      return result as ExecuteResult<T>;
    } catch (e: any) {
      throw new Error(`'${cmdStr}' failed. Original error: ${e.stderr || e.stdout || e.message}`, {
        cause: e,
      });
    }
  }

  private resolveSudoUser(): SudoUser | null {
    if (!process.geteuid || process.geteuid() !== 0) {
      return null;
    }

    const uid = Number(process.env.SUDO_UID);
    const gid = Number(process.env.SUDO_GID);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
      return null;
    }
    return {uid, gid};
  }
}
