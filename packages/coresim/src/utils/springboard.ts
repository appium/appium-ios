import {once} from 'node:events';

import {waitForCondition} from 'asyncbox';

import type {NativeSimctl} from '../native-simctl.js';

const SPRINGBOARD_SERVICE = 'com.apple.SpringBoard';
const SPRINGBOARD_RESTART_TIMEOUT_MS = 30000;

/**
 * SpringBoard of a booted device: the process that owns the BulletinBoard store, see
 * setNotificationsAccess. The simulator shares the host kernel, so it is signalled directly.
 */
export class SpringBoard {
  private pausedPid: number | undefined;

  constructor(
    private readonly simctl: NativeSimctl,
    private readonly udid: string,
  ) {}

  /**
   * Pauses the running SpringBoard so that it cannot rewrite the BulletinBoard store. It can be in
   * the middle of a restart, hence the retries.
   */
  async pause(): Promise<void> {
    try {
      await waitForCondition(
        async () => {
          const pid = await this.pid().catch(() => undefined);
          if (pid && sendSignal(pid, 'SIGSTOP')) {
            this.pausedPid = pid;
          }
          return Boolean(this.pausedPid);
        },
        {waitMs: SPRINGBOARD_RESTART_TIMEOUT_MS, intervalMs: 300},
      );
    } catch {}
    if (!this.pausedPid) {
      throw new Error(`${SPRINGBOARD_SERVICE} is not running`);
    }
  }

  /** Lets the paused SpringBoard run again. */
  resume(): void {
    if (this.pausedPid) {
      sendSignal(this.pausedPid, 'SIGCONT');
    }
  }

  /**
   * Replaces the paused SpringBoard with a new one: asks launchd to stop it (launchd starts a new
   * one right away), resumes it so that it can exit, then waits for the new process.
   */
  async restart(): Promise<void> {
    const previousPid = this.pausedPid;
    try {
      await this.stop();
    } finally {
      this.resume();
      this.pausedPid = undefined;
    }
    try {
      await waitForCondition(
        async () => {
          const pid = await this.pid().catch(() => undefined);
          return Number.isInteger(pid) && pid !== previousPid;
        },
        {waitMs: SPRINGBOARD_RESTART_TIMEOUT_MS, intervalMs: 300},
      );
    } catch {
      throw new Error(`${SPRINGBOARD_SERVICE} did not restart within ${SPRINGBOARD_RESTART_TIMEOUT_MS}ms`);
    }
  }

  private async pid(): Promise<number | undefined> {
    return (await this.simctl.listProcesses(this.udid)).find(({name}) => name === SPRINGBOARD_SERVICE)?.pid;
  }

  private async stop(): Promise<void> {
    // Bare name: resolved against the guest runtime's own bin dirs, like in listProcesses.
    const proc = await this.simctl.spawnProcess(this.udid, 'launchctl', {
      arguments: ['launchctl', 'stop', SPRINGBOARD_SERVICE],
    });
    let stderr = '';
    proc.stdout.resume();
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    const streamError = Promise.race([once(proc.stdout, 'error'), once(proc.stderr, 'error')]).then(([err]) => {
      throw err;
    });
    const [[code, signal]] = await Promise.race([
      Promise.all([once(proc, 'exit'), once(proc.stderr, 'end')]),
      streamError,
    ]);
    if (code !== 0) {
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      throw new Error(
        `'launchctl stop ${SPRINGBOARD_SERVICE}' failed with ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
      );
    }
  }
}

/**
 * @returns `false` if the process no longer exists
 */
function sendSignal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (err: any) {
    if (err?.code === 'ESRCH') {
      return false;
    }
    throw err;
  }
}
