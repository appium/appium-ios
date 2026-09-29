import {EventEmitter} from 'node:events';
import {Socket} from 'node:net';
import {constants as osConstants} from 'node:os';

import type {NativeSimctl} from '../native-simctl.js';
import type {SpawnOptions} from '../types.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    spawnProcess(udid: string, path: string, options?: SpawnOptions): Promise<SpawnedProcess>;
  }
}

// Some signal numbers have more than one name (e.g. SIGABRT/SIGIOT are both 6) — built with a
// for-of rather than Object.fromEntries so the *first* name Node lists for a number wins instead
// of whichever happens to be last, which would otherwise make an aborted process unpredictably
// report as the obscure historical alias (confirmed: this reversed Object.fromEntries reported a
// real SIGABRT as 'SIGIOT').
const SIGNAL_NAME_BY_NUMBER: Record<number, NodeJS.Signals> = {};
for (const [name, num] of Object.entries(osConstants.signals)) {
  SIGNAL_NAME_BY_NUMBER[num] ??= name as NodeJS.Signals;
}

interface SpawnedProcessEvents {
  exit: [code: number | null, signal: NodeJS.Signals | null];
}

/**
 * A process spawned on a simulator device via `NativeSimctl.spawnProcess`. The simulator shares
 * the host kernel and filesystem, so `pid` is a real host OS process id — {@link kill} just calls
 * Node's own `process.kill()`, no native call needed. `stdout`/`stderr` stream live output as the
 * process runs; `'exit'` fires exactly once, with a decoded `(code, signal)` pair mirroring
 * `child_process.ChildProcess`'s own semantics (exactly one of the two is non-null).
 */
export class SpawnedProcess extends EventEmitter<SpawnedProcessEvents> {
  readonly stdout: Socket;
  readonly stderr: Socket;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    readonly pid: number,
    stdoutFd: number,
    stderrFd: number,
  ) {
    super();
    // `net.Socket` (not `fs.createReadStream`) deliberately: these fds are blocking NSPipe read
    // ends, and fs's reads always run as blocking syscalls on the shared libuv threadpool (default
    // size 4) regardless of the fd's actual type — a single quiet process's idle stdout+stderr
    // reads permanently occupy 2 of those 4 workers until output or EOF arrives, and two quiet
    // processes exhaust the pool entirely, stalling unrelated fs work *and* this addon's own
    // AsyncWorkers (confirmed empirically: an unrelated fs.readFile took 8+ seconds instead of
    // ~1ms while two quiet spawned processes' output was being read this way). A pipe fd is
    // recognized by libuv as a named-pipe handle regardless of whether it's an anonymous pipe(2),
    // so wrapping it in a Socket gets real event-driven (kqueue/epoll) I/O instead, exactly like
    // Node's own child_process does for a child's stdio pipes.
    this.stdout = new Socket({fd: stdoutFd, readable: true, writable: false});
    this.stderr = new Socket({fd: stderrFd, readable: true, writable: false});
  }

  /** Whether the process has neither exited nor been killed yet. */
  get running(): boolean {
    return this.exitCode === null && this.signalCode === null;
  }

  /**
   * Sends a signal to the process — a thin wrapper over `process.kill()`. A no-op returning
   * `false` once exit has already been observed, rather than risking `process.kill()` throwing
   * `ESRCH` on an already-reaped pid or, worse, hitting an unrelated process if the pid has since
   * been recycled by the OS.
   */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (!this.running) {
      return false;
    }
    return process.kill(this.pid, signal);
  }

  /** @internal Invoked once by NativeSimctl when the native termination callback fires. */
  _handleExit(code: number | null, signal: number | null): void {
    this.exitCode = code;
    this.signalCode = signal === null ? null : (SIGNAL_NAME_BY_NUMBER[signal] ?? null);
    this.emit('exit', this.exitCode, this.signalCode);
  }
}

/**
 * Native equivalent of `simctl spawn`. Streams live stdout/stderr and eventually reports an
 * exit code/signal — see {@link SpawnedProcess}.
 *
 * @param udid — UDID of the target device
 * @param path — path to the executable to spawn. A bare name with no `/` (e.g. `launchctl`) is
 * resolved by searching the Simulator runtime's standard bin dirs (`usr/bin`, `bin`, `usr/sbin`,
 * `sbin`, `usr/local/bin`), mirroring `simctl spawn`'s own bare-name resolution — there's no way
 * to query the guest's actual `$PATH`, so this is a fixed best-effort list, and throws if nothing
 * matches. Anything containing `/` is instead resolved relative to the Simulator's own runtime
 * root (e.g. `/usr/bin/log`) and confined there, so this cannot be used to spawn an arbitrary host
 * executable. A leading `/` is tolerated (still resolved relative to the runtime root, not the
 * host's own `/`). Throws if `path` would resolve outside the runtime (e.g. via `..`). Not
 * auto-prepended to `options.arguments`.
 * @param options — see {@link SpawnOptions}
 * @returns a handle to the spawned process
 */
export async function spawnProcess(
  this: NativeSimctl,
  udid: string,
  path: string,
  options: SpawnOptions = {},
): Promise<SpawnedProcess> {
  return runCatchingAsync(async () => {
    const device = await this._findDevice(udid);
    // The native termination callback (delivered via a ThreadSafeFunction/GCD path) and
    // device.spawn()'s own promise resolution (an AsyncWorker completion) are independent async
    // signals with no guaranteed relative order — a process that exits almost immediately can have
    // its termination callback fire before the promise below resolves and `proc` exists. Buffer the
    // exit args in that case and deliver them once the handle is constructed, rather than assuming
    // the callback always arrives second.
    let proc: SpawnedProcess | undefined;
    let pendingExit: [code: number | null, signal: number | null] | undefined;
    const {pid, stdoutFd, stderrFd} = await device.spawn(path, options, (code, signal) => {
      if (proc) {
        proc._handleExit(code, signal);
      } else {
        pendingExit = [code, signal];
      }
    });
    proc = new SpawnedProcess(pid, stdoutFd, stderrFd);
    if (pendingExit) {
      // Delivering this synchronously would emit 'exit' before spawnProcess()'s own promise has
      // even resolved — a caller doing `const proc = await sim.spawnProcess(...); proc.on('exit', ...)`
      // would never see it, since its listener can't be attached until after that await returns.
      // setImmediate defers past both promise-resolution microtasks and any synchronous listener
      // setup that runs right after them, guaranteeing the listener is attached first.
      const exitArgs = pendingExit;
      const deliverTo = proc;
      setImmediate(() => deliverTo._handleExit(...exitArgs));
    }
    return proc;
  });
}
