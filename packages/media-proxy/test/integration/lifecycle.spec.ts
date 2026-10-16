import assert from 'node:assert';
import {execFile} from 'node:child_process';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const CHILD = fileURLToPath(new URL('../helpers/lifecycle-child.js', import.meta.url));
const EXIT_TIMEOUT_MS = 20_000;

async function runChild(scenario: string, nodeArgs: string[] = []): Promise<string> {
  const {stdout} = await execFileAsync(process.execPath, [...nodeArgs, CHILD, scenario], {timeout: EXIT_TIMEOUT_MS});
  return stdout.trim();
}

// Spawned (not run in-process) because they need --expose-gc and real process exit behaviour.
describe('transcoder lifecycle', () => {
  it('lets closed transcoders be garbage collected', async () => {
    const {finalized, count} = JSON.parse(await runChild('gc-closed', ['--expose-gc']));
    // The newest one can still be pinned by the child's own frame.
    assert.ok(finalized >= count - 1, `finalized ${finalized}/${count}`);
  });

  it('lets abandoned (never closed) transcoders be garbage collected', async () => {
    const {finalized, count} = JSON.parse(await runChild('gc-abandoned', ['--expose-gc']));
    assert.ok(finalized >= count - 1, `finalized ${finalized}/${count}`);
  });

  it('exits on its own with an unclosed transcoder', async () => {
    assert.strictEqual(await runChild('exit-unclosed'), 'done');
  });

  it('exits when a worker thread leaves a transcoder unclosed', async () => {
    assert.strictEqual(await runChild('worker-exit'), 'done');
  });
});
