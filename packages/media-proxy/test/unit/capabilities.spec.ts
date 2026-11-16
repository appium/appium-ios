import assert from 'node:assert';
import {describe, it} from 'node:test';

import {getH264Encoders} from '../../src/capabilities.js';

const addon = (encoders: string[]) => ({capabilities: () => ({decoders: ['hevc', 'aac'], encoders})});

describe('getH264Encoders', () => {
  it('lists only the H.264 encoders', () => {
    assert.deepStrictEqual(getH264Encoders(addon(['mjpeg', 'aac', 'h264_videotoolbox', 'libopenh264'])), [
      'h264_videotoolbox',
      'libopenh264',
    ]);
  });

  it('is empty when no H.264 encoder can open', () => {
    assert.deepStrictEqual(getH264Encoders(addon(['mjpeg', 'aac'])), []);
  });
});
