import assert from 'node:assert';
import {describe, it} from 'node:test';

import {loadNative} from '../../src/native.js';

describe('native addon', () => {
  it('loads on this platform and reports its compiled-in codecs', () => {
    const caps = loadNative().capabilities();
    assert.deepStrictEqual(caps.decoders, ['hevc']);
    assert.ok(caps.encoders.includes('mjpeg'));
    assert.strictEqual(caps.encoders.includes('h264_videotoolbox'), process.platform === 'darwin');
  });
});
