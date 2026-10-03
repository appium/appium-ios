import assert from 'node:assert';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {TunTap, TunTapDeviceError, TunTapPermissionError} from '../../src/index.js';
import {hasPrivileges} from '../utils.js';

const execFileAsync = promisify(execFile);

const hasRequiredPrivileges = await hasPrivileges();
const skipReason = getSkipReason(hasRequiredPrivileges);
const skipUnlessLinuxTun =
  process.platform === 'linux' && existsSync('/dev/net/tun') ? false : 'Requires Linux with /dev/net/tun';

// Messages as built by the native backends' OpenDevice().
const LINUX_EMFILE_MESSAGE = 'Failed to open /dev/net/tun: Too many open files';
const LINUX_EACCES_MESSAGE =
  "Failed to open /dev/net/tun: Permission denied. Try running with sudo or add your user to the 'tun' group.";
const WINDOWS_ACCESS_DENIED_MESSAGE =
  'Failed to create or open WinTun adapter: create failed with Access is denied.; ' +
  'open failed with The system cannot find the file specified.';

const INDEX_URL = new URL('../../src/index.js', import.meta.url).href;
// Exhausts the fd table after the addon is loaded so open("/dev/net/tun") fails with EMFILE.
const EMFILE_OPEN_SCRIPT = `
  import {closeSync, openSync} from 'node:fs';
  import {TunTap} from '${INDEX_URL}';
  const tun = new TunTap();
  const fds = [];
  try {
    for (;;) fds.push(openSync('/dev/null', 'r'));
  } catch (err) {
    if (err.code !== 'EMFILE') throw err;
  }
  let result;
  try {
    tun.open();
    result = {opened: true};
  } catch (err) {
    result = {name: err.name, message: err.message, code: err.cause?.code};
  }
  fds.forEach((fd) => closeSync(fd));
  tun.close();
  process.stdout.write(JSON.stringify(result));
`;

describe('TunTap open() error mapping', {timeout: 10000}, () => {
  it('should throw TunTapPermissionError when opened without root or Administrator', {skip: skipReason}, () => {
    const tun = new TunTap();
    assert.throws(
      () => tun.open(),
      (err: unknown) => {
        assert.ok(err instanceof TunTapPermissionError);
        assert.ok(err.cause instanceof Error);
        assert.strictEqual(err.cause.message, err.message);
        assert.ok(['EACCES', 'EPERM'].includes((err.cause as NodeJS.ErrnoException).code ?? ''));
        return true;
      },
    );
  });

  it(
    'should throw TunTapDeviceError when /dev/net/tun cannot be opened for lack of fds',
    {skip: skipUnlessLinuxTun},
    async () => {
      const {stdout} = await execFileAsync('sh', [
        '-c',
        'ulimit -n 128 && exec "$0" --input-type=module -e "$1"',
        process.execPath,
        EMFILE_OPEN_SCRIPT,
      ]);
      const result = JSON.parse(stdout);
      assert.strictEqual(result.name, 'TunTapDeviceError');
      assert.strictEqual(result.code, 'EMFILE');
      assert.doesNotMatch(result.message, /sudo/);
    },
  );
});

describe('TunTap open() native error classification', () => {
  it('should map a Linux EACCES open failure to TunTapPermissionError', () => {
    const tun = withNativeOpenError(LINUX_EACCES_MESSAGE, 'EACCES');
    assert.throws(() => tun.open(), TunTapPermissionError);
  });

  it('should map a Linux EMFILE open failure to TunTapDeviceError', () => {
    const tun = withNativeOpenError(LINUX_EMFILE_MESSAGE, 'EMFILE');
    assert.throws(() => tun.open(), TunTapDeviceError);
  });

  it('should map a Windows ERROR_ACCESS_DENIED open failure to TunTapPermissionError', () => {
    const tun = withNativeOpenError(WINDOWS_ACCESS_DENIED_MESSAGE, 'EPERM');
    assert.throws(() => tun.open(), TunTapPermissionError);
  });

  it('should not infer a permission error from message text without an errno code', () => {
    const tun = withNativeOpenError(LINUX_EACCES_MESSAGE);
    assert.throws(() => tun.open(), TunTapDeviceError);
  });
});

function getSkipReason(privileged: boolean): string | false {
  return privileged ? 'Requires an unprivileged process' : false;
}

/**
 * Makes native open() throw on a fresh instance. The addon's prototype methods are non-writable and
 * non-configurable, so t.mock.method cannot restore them; each test builds its own TunTap instead.
 */
function withNativeOpenError(message: string, code?: string): TunTap {
  const tun = new TunTap();
  const device = (tun as unknown as {device: object}).device;
  Object.defineProperty(device, 'open', {
    value: () => {
      throw Object.assign(new Error(message), {code});
    },
  });
  return tun;
}
