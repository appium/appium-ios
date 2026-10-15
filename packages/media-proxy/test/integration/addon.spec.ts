import assert from 'node:assert';
import {describe, it} from 'node:test';

import {loadNative} from '../../src/native.js';

describe('native addon', () => {
  it('loads on this platform and reports its compiled-in codecs', () => {
    const caps = loadNative().capabilities();
    assert.deepStrictEqual(caps.decoders, ['hevc']);
    assert.deepStrictEqual(caps.encoders, ['mjpeg']);
  });
});
