import assert from 'node:assert';
import {spawnSync} from 'node:child_process';
import {describe, it} from 'node:test';

import {H264_ENCODERS} from '../helpers/annexb.js';

describe('OpenH264', () => {
  // The CI jobs install the library first; without it the H.264 suites would silently skip the software path.
  it('is installed on CI', {skip: !process.env.CI}, () => {
    assert.ok(H264_ENCODERS.includes('libopenh264'), `got ${H264_ENCODERS}`);
  });

  /** Creates a transcoder in a clean process so the cached library of this one can't mask the failure. */
  function createInChild(env: Record<string, string>): {name: string; message: string} {
    const transcoder = new URL('../../src/transcoder.js', import.meta.url).href;
    const script = `import {createTranscoder} from ${JSON.stringify(transcoder)};
      try { createTranscoder({codec: 'h264'}); } catch (e) { console.log(JSON.stringify({name: e.name, message: e.message})); }`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {...process.env, MEDIA_PROXY_OPENH264_PATH: '', ...env},
    });
    assert.ok(result.stdout, `no output: ${result.stderr}`);
    return JSON.parse(result.stdout) as {name: string; message: string};
  }

  it('explains how to install OpenH264 when no encoder opens', () => {
    const error = createInChild({MEDIA_PROXY_H264_ENCODER: 'libopenh264'});
    assert.strictEqual(error.name, 'MediaProxyEncoderUnavailableError');
    assert.match(error.message, /libopenh264: OpenH264 is not configured/);
    assert.match(error.message, /MEDIA_PROXY_OPENH264_PATH/);
    assert.match(
      error.message,
      /https:\/\/github\.com\/appium\/appium-ios\/tree\/main\/packages\/media-proxy#software-h264-openh264/,
    );
  });

  it('names an unknown MEDIA_PROXY_H264_ENCODER override in the error', () => {
    const error = createInChild({MEDIA_PROXY_H264_ENCODER: 'nope'});
    assert.strictEqual(error.name, 'MediaProxyEncoderUnavailableError');
    assert.match(error.message, /MEDIA_PROXY_H264_ENCODER='nope'/);
    assert.match(error.message, /libopenh264/);
  });
});
