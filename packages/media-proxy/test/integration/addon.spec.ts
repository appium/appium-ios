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
