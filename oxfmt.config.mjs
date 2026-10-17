import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxfmt';

export default defineConfig({
  ...appiumConfig,
  ignorePatterns: [
    ...ignorePatterns,
    'packages/uicatalog/UIKitCatalog/**',
    // WebDriverAgent's Objective-C/Xcode/Ruby sources aren't JS/TS.
    'packages/webdriveragent/Configurations/**',
    'packages/webdriveragent/Fastlane/**',
    'packages/webdriveragent/PrivateHeaders/**',
    'packages/webdriveragent/WebDriverAgent*/**',
    // Compiled atom output (atoms/*.js) is generated, minified build output - never format it.
    'packages/remote-debugger/atoms/*.js',
    'packages/remote-debugger/atoms/automation/*.js',
  ],
});
