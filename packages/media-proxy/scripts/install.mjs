import {access} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Never builds or fails: the addon needs bundled FFmpeg libs, so a missing prebuild is only noted here
// and surfaces as a typed MediaProxyUnavailableError on first use.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const platform = process.env.MEDIA_PROXY_TEST_PLATFORM ?? process.platform;
  const arch = process.env.MEDIA_PROXY_TEST_ARCH ?? process.arch;
  const found = await access(join(PACKAGE_ROOT, 'prebuilds', `${platform}-${arch}`)).then(
    () => true,
    () => false,
  );
  if (!found) {
    process.stdout.write(
      `[@appium/media-proxy] No prebuilt addon for ${platform}-${arch}. ` +
        'Transcoding will be unavailable (a MediaProxyUnavailableError is thrown on use).\n',
    );
  }
}

// Informational only: installing must never fail.
main().catch(() => {});
