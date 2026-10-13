import {createRequire} from 'node:module';

import {MediaProxyUnavailableError} from './errors.js';
import {PACKAGE_NAME, getPkgRoot} from './pkg-root.js';
import type {NativeModule} from './types.js';

const require = createRequire(import.meta.url);

export const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32'] as const;
export const SUPPORTED_ARCHS = ['x64', 'arm64'] as const;

/** Throws {@link MediaProxyUnavailableError} unless this platform/arch has a build. */
export function assertSupportedPlatform(platform: string = process.platform, arch: string = process.arch): void {
  if (
    !(SUPPORTED_PLATFORMS as readonly string[]).includes(platform) ||
    !(SUPPORTED_ARCHS as readonly string[]).includes(arch)
  ) {
    throw new MediaProxyUnavailableError(
      `${PACKAGE_NAME} supports darwin/linux/win32 on x64/arm64, not ${platform}-${arch}`,
      platform,
      arch,
    );
  }
}

/**
 * Wraps `load` so nothing runs until the first call. A failure is re-typed as
 * {@link MediaProxyUnavailableError} and not cached (retried on the next call); success is cached.
 */
export function createNativeLoader(load: () => unknown): () => NativeModule {
  let native: NativeModule | undefined;
  return () => {
    if (native) {
      return native;
    }
    assertSupportedPlatform();
    try {
      native = load() as NativeModule;
    } catch (err) {
      throw new MediaProxyUnavailableError(
        `No usable ${PACKAGE_NAME} addon for ${process.platform}-${process.arch}: ${(err as Error).message}`,
        process.platform,
        process.arch,
      );
    }
    return native;
  };
}

// Never invoked at import or install time, only by the first API call that needs the addon.
export const loadNative = createNativeLoader(() => require('node-gyp-build')(getPkgRoot()));
