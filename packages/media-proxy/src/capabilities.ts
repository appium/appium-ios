import {loadNative} from './native.js';
import type {NativeModule} from './types.js';

/**
 * H.264 encoders that can open on this machine, e.g. `['h264_videotoolbox']` (OpenH264 only once installed). An empty
 * list means `createTranscoder({codec: 'h264'})` would throw `MediaProxyEncoderUnavailableError`.
 *
 * @throws MediaProxyUnavailableError if the addon can't be loaded
 */
export function listH264Encoders(native: Pick<NativeModule, 'capabilities'> = loadNative()): string[] {
  return native.capabilities().encoders.filter((name) => name.startsWith('h264_') || name === 'libopenh264');
}
