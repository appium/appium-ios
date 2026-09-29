import {execFileSync} from 'node:child_process';

// Overridable only for test/unit/install-script.spec.ts, which spawns this file as a real
// subprocess to verify the skip branch without needing to fake process.platform themselves.
const platform = process.env.CORESIM_TEST_PLATFORM ?? process.platform;

// CoreSimulator.framework only exists on macOS — there's nothing to build or load anywhere else.
// Skip straight to a no-op there so `npm install` always succeeds regardless of platform; the
// package still installs fine (its TS/error-class surface is plain JS), it just throws a clear,
// typed error the first time native functionality is actually used (see native-simctl.ts's
// loadNative()). Any macOS arch is fine here — an Intel Mac just compiles from source instead of
// using the darwin-arm64 prebuild.
if (platform !== 'darwin') {
  process.stdout.write(
    `[@appium/coresim] Skipping native addon build: CoreSimulator.framework requires macOS ` +
      `(current platform: ${platform}). This package will throw a NativeSimUnavailableError at ` +
      'runtime if used here.\n',
  );
  process.exit(0);
}

execFileSync('node-gyp-build', {stdio: 'inherit', shell: true});
