# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.11.0](https://github.com/appium/appium-ios/compare/@appium/coresim@1.10.2...@appium/coresim@1.11.0) (2026-10-03)

### Features

* apply DeviceHub pasteboard sync changes without rebooting the simulator ([#26](https://github.com/appium/appium-ios/issues/26)) ([5c6eabb](https://github.com/appium/appium-ios/commit/5c6eabbf9cfb900563ed816a6392f48db11ef18e))


## [1.10.2](https://github.com/appium/appium-ios/compare/@appium/coresim@1.10.1...@appium/coresim@1.10.2) (2026-10-02)

### Miscellaneous Chores

* ensure Dependabot preserves version ranges ([#24](https://github.com/appium/appium-ios/issues/24)) ([95e4e1a](https://github.com/appium/appium-ios/commit/95e4e1a4703f8ca833f01ecf2af75f4696d98043))


## [1.10.1](https://github.com/appium/appium-ios/compare/@appium/coresim@1.10.0...@appium/coresim@1.10.1) (2026-09-30)

**Note:** Version bump only for package @appium/coresim





## 1.10.0 (2026-09-29)

### Features

* move appium/coresim into the monorepo as packages/coresim ([#16](https://github.com/appium/appium-ios/issues/16)) ([a1acd55](https://github.com/appium/appium-ios/commit/a1acd556f716595d120bc2bf92b317ad84cbfad4))


## [1.9.0](https://github.com/appium/coresim/compare/v1.8.0...v1.9.0) (2026-09-27)

### Features

* add setOrientation and fix video/streaming session resize on device rotation ([#21](https://github.com/appium/coresim/issues/21)) ([3a73986](https://github.com/appium/coresim/commit/3a739869a7669076e764d05bb240f7a0e68cd9df))

## [1.8.0](https://github.com/appium/coresim/compare/v1.7.0...v1.8.0) (2026-09-25)

### Features

* add real-time JPEG frame streaming (startJpegStream) ([#20](https://github.com/appium/coresim/issues/20)) ([7a73c0a](https://github.com/appium/coresim/commit/7a73c0a46a5ce72afeb435fb9209e75d7a21df79))

## [1.7.0](https://github.com/appium/coresim/compare/v1.6.0...v1.7.0) (2026-09-23)

### Features

* add force option to stopVideoRecording ([#19](https://github.com/appium/coresim/issues/19)) ([1b756ce](https://github.com/appium/coresim/commit/1b756ce3d41ad35dca0f7448de82715570e6ce60))

## [1.6.0](https://github.com/appium/coresim/compare/v1.5.0...v1.6.0) (2026-09-23)

### Features

* add optional audio capture to video recording and streaming  ([#18](https://github.com/appium/coresim/issues/18)) ([e634078](https://github.com/appium/coresim/commit/e634078669db724a676bf95fa074a89d3ac5a9c8))

## [1.5.0](https://github.com/appium/coresim/compare/v1.4.0...v1.5.0) (2026-09-22)

### Features

* Add video recording API ([#17](https://github.com/appium/coresim/issues/17)) ([d399403](https://github.com/appium/coresim/commit/d399403c1d329f303ab51726fa382313cf09ad0f))

## [1.4.0](https://github.com/appium/coresim/compare/v1.3.0...v1.4.0) (2026-09-19)

### Features

* resolve bare command names in spawnProcess against the runtime's bin dirs ([#16](https://github.com/appium/coresim/issues/16)) ([155654d](https://github.com/appium/coresim/commit/155654d1b2ac1235445cd511c0f7a0d49038bf26))

## [1.3.0](https://github.com/appium/coresim/compare/v1.2.1...v1.3.0) (2026-09-19)

### Features

* confine spawnProcess to the Simulator runtime root ([#15](https://github.com/appium/coresim/issues/15)) ([2f30f65](https://github.com/appium/coresim/commit/2f30f65e55e8a3cafb0fb0a0c0f2db612287b4a1))

## [1.2.1](https://github.com/appium/coresim/compare/v1.2.0...v1.2.1) (2026-09-18)

### Bug Fixes

* keep defaults spawns attached to the guest bootstrap namespace ([#14](https://github.com/appium/coresim/issues/14)) ([82a2154](https://github.com/appium/coresim/commit/82a215436f9d4ef4346e403f318d37f446717aad))
* resolve devices by udid case-insensitively ([#13](https://github.com/appium/coresim/issues/13)) ([713b700](https://github.com/appium/coresim/commit/713b700a96e66fa8755b69fbd3537fb54d0e251f))

## [1.2.0](https://github.com/appium/coresim/compare/v1.1.1...v1.2.0) (2026-09-17)

### Features

* Support more permission types ([#12](https://github.com/appium/coresim/issues/12)) ([164cb7d](https://github.com/appium/coresim/commit/164cb7d4d4bbc9029f18ad137f1215d82fa3ab79))

## [1.1.1](https://github.com/appium/coresim/compare/v1.1.0...v1.1.1) (2026-09-16)

### Bug Fixes

* Pass correct stream handle ([#11](https://github.com/appium/coresim/issues/11)) ([4584776](https://github.com/appium/coresim/commit/4584776f1d143bc709233cdfa2a557eb3bb99bd7))

## [1.1.0](https://github.com/appium/coresim/compare/v1.0.1...v1.1.0) (2026-09-16)

### Features

* Expose getRuntimeRootPath publicly ([#10](https://github.com/appium/coresim/issues/10)) ([00725ee](https://github.com/appium/coresim/commit/00725eec8cbe46be020eda18a11d30125552b11a))

## [1.0.1](https://github.com/appium/coresim/compare/v1.0.0...v1.0.1) (2026-09-16)

### Miscellaneous Chores

* Fix repository url ([e579041](https://github.com/appium/coresim/commit/e579041fb922428e126f9031c9fc542b64c53c12))

## 1.0.0 (2026-09-16)

### Features

* Add biometric enrollment/matching and shake gesture ([#6](https://github.com/appium/coresim/issues/6)) ([c465311](https://github.com/appium/coresim/commit/c465311a0eaf2dbe807140a554457f09d5cbf8bb))
* Add clearLocation and getAppContainer ([#7](https://github.com/appium/coresim/issues/7)) ([75a1c69](https://github.com/appium/coresim/commit/75a1c69f521a2a70e709618657671ff7972bd2b5))
* Add custom device set support ([#9](https://github.com/appium/coresim/issues/9)) ([39a3e9d](https://github.com/appium/coresim/commit/39a3e9d215711b886c39c1592b5476b9286d7d5e))
* Add getWebInspectorSocket and listProcesses ([#8](https://github.com/appium/coresim/issues/8)) ([6337a8f](https://github.com/appium/coresim/commit/6337a8f1ec082b79098278c35551bd3318984bca))
* Add native addon foundation and core device/app lifecycle ([#1](https://github.com/appium/coresim/issues/1)) ([85957c9](https://github.com/appium/coresim/commit/85957c9b7420a37048bf39a47ea12b1e6a03db67))
* Add pasteboard sync (getPasteboard/setPasteboard) ([#3](https://github.com/appium/coresim/issues/3)) ([55bcb5b](https://github.com/appium/coresim/commit/55bcb5bec80d958e9d42e19adae8a050554cd472))
* Add screenshot capture (getScreenshot) ([#4](https://github.com/appium/coresim/issues/4)) ([f347d04](https://github.com/appium/coresim/commit/f347d04e88269ff6e56dd7d922b11f3bba458440))
* Add TCC permission reads, bulk shutdown-all, and media library injection ([#2](https://github.com/appium/coresim/issues/2)) ([3556dbd](https://github.com/appium/coresim/commit/3556dbd946121d5685d5cd5ee8a106a20a1dd402))
