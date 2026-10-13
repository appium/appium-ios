import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Never builds from source: the addon needs the bundled LGPL FFmpeg shared libs (see
// scripts/build-ffmpeg.sh), so `npm install` must always succeed and the package throws a typed
// MediaProxyUnavailableError on first use when no matching prebuild exists.
const platform = process.env.MEDIA_PROXY_TEST_PLATFORM ?? process.platform;
const arch = process.env.MEDIA_PROXY_TEST_ARCH ?? process.arch;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

try {
  if (!existsSync(join(root, 'prebuilds', `${platform}-${arch}`))) {
    process.stdout.write(
      `[@appium/media-proxy] No prebuilt addon for ${platform}-${arch}. ` +
        'Transcoding will be unavailable (a MediaProxyUnavailableError is thrown on use).\n',
    );
  }
} catch {
  // Informational only: installing must never fail.
}
