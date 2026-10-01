import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxlint';

export default defineConfig({
  extends: [appiumConfig],
  ignorePatterns: [
    ...ignorePatterns,
    'packages/uicatalog/UIKitCatalog/**',
    // Compiled atom output (atoms/*.js) is generated build output - never lint it.
    'packages/remote-debugger/atoms/*.js',
    'packages/remote-debugger/atoms/automation/*.js',
  ],
  overrides: [
    {
      files: ['packages/remotexpc/**'],
      rules: {'unicorn/filename-case': ['error', {case: 'kebabCase'}]},
    },
    {
      files: [
        'packages/remotexpc/src/lib/plist/length-based-splitter.ts',
        'packages/remotexpc/src/lib/plist/plist-decoder.ts',
        'packages/remotexpc/src/lib/plist/plist-encoder.ts',
        'packages/remotexpc/src/lib/usbmux/usbmux-decoder.ts',
        'packages/remotexpc/src/lib/usbmux/usbmux-encoder.ts',
        'packages/remotexpc/src/services/ios/afc/stream-utils.ts',
        'packages/remotexpc/src/services/ios/zipconduit/stream-zip.ts',
      ],
      rules: {
        // These files implement Node stream APIs that require callback signatures.
        'promise/prefer-await-to-callbacks': 'off',
      },
    },
    {
      // Atom sources run injected into a WebKit page context, never under Node.
      files: ['packages/remote-debugger/atoms/src/**'],
      env: {browser: true, node: false},
    },
    {
      // These tests reference DOM globals (document, TouchEvent, ...) installed onto globalThis
      // by test/unit/helpers/atoms-module.ts, to run atoms/src code in the same realm it expects.
      files: ['packages/remote-debugger/test/unit/atoms-src/**'],
      env: {browser: true, node: true},
    },
    {
      // Reference DOM globals (document, getComputedStyle, ...) the same way, either directly or
      // via JSX/React markup that only makes sense in a browser-like environment.
      files: [
        'packages/remote-debugger/test/unit/helpers/layout.ts',
        'packages/remote-debugger/test/unit/helpers/react-fixture.ts',
        'packages/remote-debugger/test/unit/helpers/angular-fixture.ts',
        'packages/remote-debugger/test/unit/frameworks/**',
        'packages/remote-debugger/test/fixtures/frameworks/**',
      ],
      env: {browser: true, node: true},
    },
  ],
});
