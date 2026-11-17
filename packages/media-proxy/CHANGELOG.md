# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 1.1.0 (2026-11-17)

### Features

* **media-proxy:** add listH264Encoders() ([#218](https://github.com/appium/appium-ios/issues/218)) ([e4e0193](https://github.com/appium/appium-ios/commit/e4e01935af2bb8d1092791f2627d8419543ef414))
* **media-proxy:** crop the padding and rotate the picture upright ([#214](https://github.com/appium/appium-ios/issues/214)) ([c4c9204](https://github.com/appium/appium-ios/commit/c4c92042c2934519ea103bec8ec4fc800421214d))
* **media-proxy:** H.264 output through Media Foundation on Windows ([#89](https://github.com/appium/appium-ios/issues/89)) ([1b97d0e](https://github.com/appium/appium-ios/commit/1b97d0e8a680558f4e31805b67349d3560035ddd))
* **media-proxy:** H.264 output through VideoToolbox on macOS ([#79](https://github.com/appium/appium-ios/issues/79)) ([9a98d23](https://github.com/appium/appium-ios/commit/9a98d23649b0f94e5103160ba059200d980e301a))
* **media-proxy:** HEVC to MJPEG pipeline on a bundled LGPL FFmpeg ([#70](https://github.com/appium/appium-ios/issues/70)) ([7d8c910](https://github.com/appium/appium-ios/commit/7d8c9108d33f2485a7610fabcea9df0831eecf69))
* **media-proxy:** release the package ([#217](https://github.com/appium/appium-ios/issues/217)) ([b6fbba2](https://github.com/appium/appium-ios/commit/b6fbba2d5048fc6e300f582f5ad438f84b54bdd3))
* **media-proxy:** scaffold @appium/media-proxy transcoder package ([#62](https://github.com/appium/appium-ios/issues/62)) ([4e9c0b4](https://github.com/appium/appium-ios/commit/4e9c0b4e948ee0b8d3d37a8b91ecdac0cd9436d3))
* **media-proxy:** software H.264 through runtime-loaded OpenH264 ([#94](https://github.com/appium/appium-ios/issues/94)) ([c45f4f9](https://github.com/appium/appium-ios/commit/c45f4f95c6e0eb96bf9f6839bed9273c3d56fa30))
* **media-proxy:** transcode the device audio (AAC-ELD to ADTS AAC-LC) ([#101](https://github.com/appium/appium-ios/issues/101)) ([1be81e2](https://github.com/appium/appium-ios/commit/1be81e2dbcd74c7608fcc43e0d9e3871c23aa7bf))

### Bug Fixes

* **media-proxy:** use the device&#x27;s 24 kHz video RTP clock and add Transcoder.requestKeyFrame() ([#212](https://github.com/appium/appium-ios/issues/212)) ([8da4224](https://github.com/appium/appium-ios/commit/8da4224d0712d210ad9b2af71892b8075f5875ea))

### Performance Improvements

* **media-proxy:** low-latency rate control for VideoToolbox, RSS growth in the bench ([#96](https://github.com/appium/appium-ios/issues/96)) ([765353a](https://github.com/appium/appium-ios/commit/765353af76ac525797f6573f35d089bffd92cac6))

### Miscellaneous Chores

* **deps:** bump @appium/* packages to latest 4.0 betas ([#193](https://github.com/appium/appium-ios/issues/193)) ([de20629](https://github.com/appium/appium-ios/commit/de20629ed0e7b9ec22953f25ba30825541be3ca4))
* **media-proxy:** bump @appium/* dependencies to their Appium 4 releases ([778510b](https://github.com/appium/appium-ios/commit/778510b836feb0f33f96b295171a388ea7079b90))
* **media-proxy:** fix lint warnings ([#202](https://github.com/appium/appium-ios/issues/202)) ([b01350f](https://github.com/appium/appium-ios/commit/b01350f65e989be9df52f06d50f0e6813b859543))
* publish ([9c72898](https://github.com/appium/appium-ios/commit/9c72898744045b9ac9f691af75f50976c59eb208))
