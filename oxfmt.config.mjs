import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxfmt';

export default defineConfig({
  ...appiumConfig,
  ignorePatterns: [
    ...ignorePatterns,
    'packages/uicatalog/UIKitCatalog/**',
    // Compiled atom output (atoms/*.js) is generated, minified build output - never format it.
    'packages/remote-debugger/atoms/*.js',
    'packages/remote-debugger/atoms/automation/*.js',
  ],
});
