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
