import assert from 'node:assert';
import {describe, it} from 'node:test';

import {getH264Encoders} from '../../src/capabilities.js';
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

  it('reports no H.264 encoder when the only one allowed is OpenH264 and none is installed', () => {
    const keys = ['MEDIA_PROXY_H264_ENCODER', 'MEDIA_PROXY_OPENH264_PATH'] as const;
    const saved = keys.map((key) => process.env[key]);
    process.env.MEDIA_PROXY_H264_ENCODER = 'libopenh264';
    delete process.env.MEDIA_PROXY_OPENH264_PATH;
    try {
      assert.deepStrictEqual(getH264Encoders(), []);
    } finally {
      keys.forEach((key, i) => (saved[i] === undefined ? delete process.env[key] : (process.env[key] = saved[i])));
    }
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
