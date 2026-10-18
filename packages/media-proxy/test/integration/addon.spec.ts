import assert from 'node:assert';
import {describe, it} from 'node:test';

import {loadNative} from '../../src/native.js';

describe('native addon', () => {
  it('loads on this platform and reports its compiled-in codecs', () => {
    const caps = loadNative().capabilities();
    assert.deepStrictEqual(caps.decoders, ['hevc']);
    assert.ok(caps.encoders.includes('mjpeg'));
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
