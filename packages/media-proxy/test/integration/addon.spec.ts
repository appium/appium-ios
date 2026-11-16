import assert from 'node:assert';
import {spawnSync} from 'node:child_process';
import {describe, it} from 'node:test';

import {loadNative} from '../../src/native.js';

describe('native addon', () => {
  it('loads on this platform and reports its compiled-in codecs', () => {
    const caps = loadNative().capabilities();
    assert.deepStrictEqual(caps.decoders, ['hevc', 'aac']);
    assert.ok(caps.encoders.includes('mjpeg'));
    assert.ok(caps.encoders.includes('aac'));
    if (process.platform !== 'darwin') {
      assert.ok(!caps.encoders.includes('h264_videotoolbox'));
    }
    if (process.platform !== 'win32') {
      assert.ok(!caps.encoders.includes('h264_mf'));
    }
  });

  // A missing encoder would otherwise just skip the H.264 suites unnoticed.
  it(
    'offers an H.264 encoder on CI macOS and Windows runners',
    {skip: !process.env.CI || !['darwin', 'win32'].includes(process.platform)},
    () => {
      const name = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_mf';
      assert.ok(loadNative().capabilities().encoders.includes(name));
    },
  );

  // A child process: the addon reads the environment (and caches what it loads) at the OS level, which
  // `process.env` changes don't reliably reach, and CI has OpenH264 installed.
  it('reports no H.264 encoder when the only one allowed is OpenH264 and none is installed', () => {
    const {MEDIA_PROXY_OPENH264_PATH: _installed, ...env} = process.env;
    const module = new URL('../../src/capabilities.js', import.meta.url).href;
    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {getH264Encoders} from ${JSON.stringify(module)}; console.log(JSON.stringify(getH264Encoders()));`,
      ],
      {env: {...env, MEDIA_PROXY_H264_ENCODER: 'libopenh264'}, encoding: 'utf8'},
    );
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(JSON.parse(run.stdout), []);
  });

  it('rejects an unknown output codec', () => {
    const config = {outputCodec: 'h265', fps: 60, bitrate: 1, quality: 80, scale: 100};
    assert.throws(
      () =>
        loadNative().createTranscoder(
          config as never,
          () => {},
          () => {},
        ),
      (err: Error) => err.name === 'MediaProxyOptionError',
    );
  });
});
