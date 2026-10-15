import {spawn} from 'node:child_process';

/**
 * Runs a command with inherited stdio; rejects on a non-zero exit.
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} [options]
 * @returns {Promise<void>}
 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit', ...options});
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0
        ? resolve(undefined)
        : reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`)),
    );
  });
}
