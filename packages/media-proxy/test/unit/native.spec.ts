import assert from 'node:assert';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import {MediaProxyUnavailableError} from '../../src/errors.js';
import {assertSupportedPlatform, createNativeLoader} from '../../src/native.js';
import {createTranscoder} from '../../src/transcoder.js';

describe('assertSupportedPlatform', () => {
  it('accepts every darwin/linux/win32 x x64/arm64 combination', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      for (const arch of ['x64', 'arm64']) {
        assert.doesNotThrow(() => assertSupportedPlatform(platform, arch));
      }
    }
  });

  it('throws a typed error otherwise', () => {
    assert.throws(
      () => assertSupportedPlatform('freebsd', 'x64'),
      (err: unknown) => err instanceof MediaProxyUnavailableError && err.platform === 'freebsd' && err.arch === 'x64',
    );
    assert.throws(() => assertSupportedPlatform('linux', 'ia32'), MediaProxyUnavailableError);
  });
});

describe('createNativeLoader', () => {
  it('does nothing until first called', () => {
    let calls = 0;
    createNativeLoader(() => {
      calls++;
      return {};
    });
    assert.strictEqual(calls, 0);
  });

  it('re-types load failures, retries them, then caches a success', () => {
    let calls = 0;
    const addon = {capabilities: () => ({decoders: [], encoders: []})};
    const load = createNativeLoader(() => {
      if (++calls < 3) {
        throw new Error('dlopen failed: libavcodec not found');
      }
      return addon;
    });
    for (let i = 0; i < 2; i++) {
      assert.throws(
        load,
        (err: unknown) => err instanceof MediaProxyUnavailableError && /libavcodec not found/.test(err.message),
      );
    }
    assert.strictEqual(load(), addon);
    assert.strictEqual(load(), addon);
    assert.strictEqual(calls, 3);
  });
});

describe('createTranscoder', () => {
  it('validates options before loading the addon', () => {
    assert.throws(() => createTranscoder({output: {codec: 'mjpeg', quality: 101}}), RangeError);
  });
});

describe('scripts/install.mjs', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'install.mjs');

  it('always exits 0, noting when no prebuild matches', () => {
    const out = execFileSync(process.execPath, [script], {
      env: {...process.env, MEDIA_PROXY_TEST_PLATFORM: 'plan9', MEDIA_PROXY_TEST_ARCH: 'x64'},
      encoding: 'utf8',
    });
    assert.match(out, /No prebuilt addon for plan9-x64/);
  });
});
