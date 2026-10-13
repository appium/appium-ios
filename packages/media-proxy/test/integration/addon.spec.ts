import assert from 'node:assert';
import {describe, it} from 'node:test';

import {MediaProxyEncoderUnavailableError} from '../../src/errors.js';
import {loadNative} from '../../src/native.js';
import {createTranscoder} from '../../src/transcoder.js';

describe('native addon', () => {
  it('loads on this platform and reports its compiled-in codecs', () => {
    const caps = loadNative().capabilities();
    assert.ok(Array.isArray(caps.decoders));
    assert.ok(Array.isArray(caps.encoders));
  });

  it('fails with a typed error when the requested encoder is not compiled in', function () {
    if (loadNative().capabilities().encoders.length > 0) {
      return;
    }
    assert.throws(() => createTranscoder({codec: 'h264'}), MediaProxyEncoderUnavailableError);
  });
});
