# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 17.5.0 (2026-09-30)

### Features

* add _rpc_reportCurrentState handler for iOS 14 ([#239](https://github.com/appium/appium-ios/issues/239)) ([65e544f](https://github.com/appium/appium-ios/commit/65e544f5c21f6079f0bcccec7346f7fa6abd0c5a))
* add option to include Safari in apps to listen for ([#161](https://github.com/appium/appium-ios/issues/161)) ([0edc527](https://github.com/appium/appium-ios/commit/0edc527a37941907d9770a82a343c14cd3ff12f0))
* add possibility of full initialization if web inspector. ([#192](https://github.com/appium/appium-ios/issues/192)) ([5a7b77c](https://github.com/appium/appium-ios/commit/5a7b77cd3b4f4b8f9f86430bf35476bc543804f9))
* add possibility to launch safari without WDA ([#155](https://github.com/appium/appium-ios/issues/155)) ([a6d73ef](https://github.com/appium/appium-ios/commit/a6d73ef400a5170f633a7c59fba5f90e62e78ccb))
* add shadowRoot workaround to atoms ([c80c947](https://github.com/appium/appium-ios/commit/c80c94721ff21774293d72e547610c7174ee390f))
* add timeout to connect, defaulting to 0 ([#196](https://github.com/appium/appium-ios/issues/196)) ([9f356ab](https://github.com/appium/appium-ios/commit/9f356ab41d1dcceac49de1024662aa2412fcda85))
* add utility for listening to protocol on sims ([163f921](https://github.com/appium/appium-ios/commit/163f921822861bc9e75d8822c4491965e7317a7c))
* add webInspectorMaxFrameLength option ([#234](https://github.com/appium/appium-ios/issues/234)) ([ef0cfea](https://github.com/appium/appium-ios/commit/ef0cfeada5df45dddc87caeb3890169311b99785))
* add WIRTypeWebPage as an accepted web page type ([#203](https://github.com/appium/appium-ios/issues/203)) ([d431d87](https://github.com/appium/appium-ios/commit/d431d87a7efd0ccfedf69163c3c57a889d0c0bf5))
* allow &#x27;*&#x27; as bundle id reported by Safari ([#179](https://github.com/appium/appium-ios/issues/179)) ([03af3c5](https://github.com/appium/appium-ios/commit/03af3c52ba8851b38f8526e6698df00d9c41f42a))
* allow passing in a list of additional possible bundle identifiers ([#182](https://github.com/appium/appium-ios/issues/182)) ([13514b5](https://github.com/appium/appium-ios/commit/13514b5157ee59a8bd9bb7e6b5463186e730e3be))
* do not note when scripts are parsed ([7bdccd3](https://github.com/appium/appium-ios/commit/7bdccd3c1ce587ba5c0c61640d6edd7c284e7ce0))
* do not throw error if circular structure found ([#212](https://github.com/appium/appium-ios/issues/212)) ([db00ccf](https://github.com/appium/appium-ios/commit/db00ccf363ec5f217350d5b26621c6dfab66f0fd))
* enable debugger on page selection ([3352b77](https://github.com/appium/appium-ios/commit/3352b775a025d453607fde5ddfadc59045815593))
* handle Console.messageRepeatCountUpdated event ([117ff6f](https://github.com/appium/appium-ios/commit/117ff6f662a5e2a80c5f613adbeea89508b5ee7c))
* handle new provisional target creation ([#204](https://github.com/appium/appium-ios/issues/204)) ([a9b6a0a](https://github.com/appium/appium-ios/commit/a9b6a0a2fc8992dee1eef23bdca289e84a615c9a))
* make isTargetBased true by default ([#238](https://github.com/appium/appium-ios/issues/238)) ([e44e135](https://github.com/appium/appium-ios/commit/e44e1357045efc021c768696fbce9321b128d987))
* move appium-remote-debugger into the monorepo as packages/remote-debugger ([#19](https://github.com/appium/appium-ios/issues/19)) ([0c9c681](https://github.com/appium/appium-ios/commit/0c9c6814dbaaaa35f1e3d94862b49b2d269fe770))
* Restore &#x60;appium-ios&#x60; monorepo to a working state ([#7](https://github.com/appium/appium-ios/issues/7)) ([80d12e2](https://github.com/appium/appium-ios/commit/80d12e2498fbad7c08eea0ddb868196f00af0840))

### Bug Fixes

* add id to message logging ([e2a4f95](https://github.com/appium/appium-ios/commit/e2a4f9531f97d5f6cf789f871ce7eb12cb9074f7))
* add old safariviewcontroller app bundle id too ([#197](https://github.com/appium/appium-ios/issues/197)) ([4b3f1fd](https://github.com/appium/appium-ios/commit/4b3f1fd81e8f9b04646ad20a46a40cebcf69bc31))
* add safariviewcontroller bundle id to standard list ([#189](https://github.com/appium/appium-ios/issues/189)) ([4148e21](https://github.com/appium/appium-ios/commit/4148e21d45765440320932dc734e67f273930f79))
* add WIRTypePage page type for 13.4 webviews ([09ef151](https://github.com/appium/appium-ios/commit/09ef1514a2b6cd38fb261cf99b6a3edf909ea79e))
* always do the loop once in async execute ([#185](https://github.com/appium/appium-ios/issues/185)) ([53ca464](https://github.com/appium/appium-ios/commit/53ca4640844c72aa7f1345a31c2da0d2ece2922e))
* better handling of targets ([#150](https://github.com/appium/appium-ios/issues/150)) ([1a5430d](https://github.com/appium/appium-ios/commit/1a5430da6efa050b8b6b334e05a6824bf4d8d5cd))
* compute target if we can ([#160](https://github.com/appium/appium-ios/issues/160)) ([2b0be39](https://github.com/appium/appium-ios/commit/2b0be39d6996c59d689fc936bfeae7d154170137))
* connection issues ([#165](https://github.com/appium/appium-ios/issues/165)) ([3148900](https://github.com/appium/appium-ios/commit/314890093607d438a5c437e38cbc3c9713650fed))
* do not ignore empty urls ([#190](https://github.com/appium/appium-ios/issues/190)) ([33d88dc](https://github.com/appium/appium-ios/commit/33d88dc68fb89262d33ba16012004dbf50b413d3))
* Do not process appDict with promise ([7f69354](https://github.com/appium/appium-ios/commit/7f6935417c5e07d5f810d30bfab2317d887d5e39))
* do not receive rpc messages when &#x27;disconnected&#x27; ([#163](https://github.com/appium/appium-ios/issues/163)) ([ec397c6](https://github.com/appium/appium-ios/commit/ec397c643c9548f86c364d5c7be4a1a9b46ebdfc))
* do not send Target.exists on iOS 13.4 ([#219](https://github.com/appium/appium-ios/issues/219)) ([24cc4f1](https://github.com/appium/appium-ios/commit/24cc4f15b9a34a9a9daf30123a8d245b3d7d5c9a))
* do not use user gestures ([#177](https://github.com/appium/appium-ios/issues/177)) ([e48650b](https://github.com/appium/appium-ios/commit/e48650b15aad887a42d1be05ab39c177e9fdb141))
* do not wait for reply on setup commands ([#191](https://github.com/appium/appium-ios/issues/191)) ([27f8cab](https://github.com/appium/appium-ios/commit/27f8cab5e2b2ed69d35c98435247a0428bd0a485))
* enable console logging on page after navigating ([#176](https://github.com/appium/appium-ios/issues/176)) ([c346b94](https://github.com/appium/appium-ios/commit/c346b94b29ebc8032e00f403a8c6cd52bdfa9fa6))
* get real devices working correctly ([#195](https://github.com/appium/appium-ios/issues/195)) ([604dd45](https://github.com/appium/appium-ios/commit/604dd4506c29684d6d1341782fbc3a2ff632ba4d))
* handle async execute on iOS without awaitPromise ([#199](https://github.com/appium/appium-ios/issues/199)) ([247509b](https://github.com/appium/appium-ios/commit/247509b569398e2e9435d43596a9fd1b50cb7350))
* handle selecting apps multiple times ([780744f](https://github.com/appium/appium-ios/commit/780744ff7b5259285a58ff52957097339480ca98))
* ignore add target event if provisional ([#205](https://github.com/appium/appium-ios/issues/205)) ([6b5b244](https://github.com/appium/appium-ios/commit/6b5b2444f5e471e5f459eb1fa76c6272cc2b3f68))
* improve logging ([5e22236](https://github.com/appium/appium-ios/commit/5e2223697ca12ccabb994bb9c2b79abfafcd709f))
* Iterate over resolved pagearrays first before waiting for promises ([#142](https://github.com/appium/appium-ios/issues/142)) ([697898d](https://github.com/appium/appium-ios/commit/697898dfebc050b9c09e8901958a577737d1b4ba))
* linting of bin ([435346f](https://github.com/appium/appium-ios/commit/435346f933a07ba1fd5a32a37e501bb08c81de99))
* log the app, page and target when sending ([2a8a5a1](https://github.com/appium/appium-ios/commit/2a8a5a152613fe9ef228b7e6a1c0be73412682fc))
* make sure an uncalled event handler is removed ([8696da2](https://github.com/appium/appium-ios/commit/8696da2152cba7bbd2e597326002c59c83773c21))
* make sure list of apps unique ([c372697](https://github.com/appium/appium-ios/commit/c372697b2c08f5207a541b25310e72c8725f565c))
* make sure react components work ([#202](https://github.com/appium/appium-ios/issues/202)) ([91a669c](https://github.com/appium/appium-ios/commit/91a669cb74f9ec74fd4b9fc5dbbfa2160c043bfe))
* make sure that app dict is not modified at the same time ([#172](https://github.com/appium/appium-ios/issues/172)) ([195931b](https://github.com/appium/appium-ios/commit/195931b348a1dc827d48c8bb291b9623e6d3262b))
* missing communication protocol call ([20e5603](https://github.com/appium/appium-ios/commit/20e56031a52227e060ebf4ee1756f81c90d73fc8))
* more involved fix for target ids ([85c0e42](https://github.com/appium/appium-ios/commit/85c0e42f88987ff9b01366800ea3384c163b9d12))
* move atoms notes out of atoms folder ([f93e157](https://github.com/appium/appium-ios/commit/f93e1577b7e8ba3e740eeb21085b1ffef51850e0))
* only print target if there is one, in send message ([c4175d7](https://github.com/appium/appium-ios/commit/c4175d7cc4b3c1ac467a3817ece6df6a2564eb4c))
* **package:** update appium-base-driver to version 3.0.0 ([#83](https://github.com/appium/appium-ios/issues/83)) ([6feb1dd](https://github.com/appium/appium-ios/commit/6feb1dd1947d38aaf4e95de4fce51b9a366bd9dd))
* **package:** update appium-base-driver to version 5.0.0 ([#180](https://github.com/appium/appium-ios/issues/180)) ([b85c345](https://github.com/appium/appium-ios/commit/b85c34542bf4daec96a726741d503ca6c74c3df0))
* **package:** update appium-ios-device to version 0.10.0 ([#147](https://github.com/appium/appium-ios/issues/147)) ([a5deb47](https://github.com/appium/appium-ios/commit/a5deb47f8ccfeac3f4304a55a5c784a58af43dba))
* **package:** update bplist-creator to version 0.0.8 ([#129](https://github.com/appium/appium-ios/issues/129)) ([0ecfd1a](https://github.com/appium/appium-ios/commit/0ecfd1a037ed051f32407129b41e5efc3521f9f5))
* **package:** update ws to version 6.0.0 ([#87](https://github.com/appium/appium-ios/issues/87)) ([eb793b3](https://github.com/appium/appium-ios/commit/eb793b38d6062e8e9d2975a13224979bd239602f))
* **package:** update ws to version 7.0.0 ([#127](https://github.com/appium/appium-ios/issues/127)) ([14f7550](https://github.com/appium/appium-ios/commit/14f7550a17321e024277958e517a04f554cd68c3))
* poll likely targets when none present in web ([7f99c83](https://github.com/appium/appium-ios/commit/7f99c83fe39ed29cffb4df7e6d219789128f3b29))
* properly handle connected apps callback ([aac5e85](https://github.com/appium/appium-ios/commit/aac5e85c81950df9e29d257ca947368764652e41))
* Properly save reported targets ([#148](https://github.com/appium/appium-ios/issues/148)) ([a9791d8](https://github.com/appium/appium-ios/commit/a9791d880360697c8f8fc54618868358a90983ca))
* remove dependencies we no longer use ([#154](https://github.com/appium/appium-ios/issues/154)) ([2fdcff6](https://github.com/appium/appium-ios/commit/2fdcff693b3c9b0b06daf54bb1668ce0e77a54ce))
* remove standard functions from return values ([#208](https://github.com/appium/appium-ios/issues/208)) ([0bb556a](https://github.com/appium/appium-ios/commit/0bb556ab709f1ffd86739bf893ed2e3007ea3116))
* retry if targetId had changed ([#244](https://github.com/appium/appium-ios/issues/244)) ([8187895](https://github.com/appium/appium-ios/commit/81878952b566786daed2c3850330d53d1660e0a9))
* stringify error when we do not know how to handle an message ([6cdc391](https://github.com/appium/appium-ios/commit/6cdc391bbfad2dde1767d95433eda901e1718769))
* try what seems to be a default ios 13 target when none are indicated ([e6f5d5c](https://github.com/appium/appium-ios/commit/e6f5d5c9105f04ed3d34e8c87122b5d8fe714f7a))
* use promises instead of http/https for async execute ([#164](https://github.com/appium/appium-ios/issues/164)) ([5a9b9d1](https://github.com/appium/appium-ios/commit/5a9b9d17ecadb5e4d1e95b44c738e78be4e6b84f))
* use web inspector service verbose and chunk size parameters ([#175](https://github.com/appium/appium-ios/issues/175)) ([5338a49](https://github.com/appium/appium-ios/commit/5338a49c9df3f92375a4102c6f87271a3b4bbb57))
* Wait between retries ([#157](https://github.com/appium/appium-ios/issues/157)) ([d05e9eb](https://github.com/appium/appium-ios/commit/d05e9eb4b30330bd9f157d29386462c05960c1c3))


## [17.4.3](https://github.com/appium/appium-remote-debugger/compare/v17.4.2...v17.4.3) (2026-09-21)

### Miscellaneous Chores

* drop appium-ios-simulator, rely solely on @appium/coresim ([#547](https://github.com/appium/appium-remote-debugger/issues/547)) ([9727530](https://github.com/appium/appium-remote-debugger/commit/97275300d5968a1794790d0024ffb46671f365fd))

## [17.4.2](https://github.com/appium/appium-remote-debugger/compare/v17.4.1...v17.4.2) (2026-09-02)

### Miscellaneous Chores

* bump support-related dependencies ([#544](https://github.com/appium/appium-remote-debugger/issues/544)) ([644abcb](https://github.com/appium/appium-remote-debugger/commit/644abcb511800cce3c5ff37f2e2f520c118896fe))

## [17.4.1](https://github.com/appium/appium-remote-debugger/compare/v17.4.0...v17.4.1) (2026-08-31)

### Bug Fixes

* Add workarounds for known WebKit automation bugs ([#543](https://github.com/appium/appium-remote-debugger/issues/543)) ([6f05db2](https://github.com/appium/appium-remote-debugger/commit/6f05db2315b1c510ff50ac1b11512fa2cebdd2cb))

## [17.4.0](https://github.com/appium/appium-remote-debugger/compare/v17.3.0...v17.4.0) (2026-08-29)

### Features

* export AutomationSession and its types from the package root ([#542](https://github.com/appium/appium-remote-debugger/issues/542)) ([afde3f6](https://github.com/appium/appium-remote-debugger/commit/afde3f6269121199e02ee6d761762b6748fcfadd))

## [17.3.0](https://github.com/appium/appium-remote-debugger/compare/v17.2.1...v17.3.0) (2026-08-29)

### Features

* make the Automation session a full WebDriver backend ([#540](https://github.com/appium/appium-remote-debugger/issues/540)) ([1f35745](https://github.com/appium/appium-remote-debugger/commit/1f3574527953b3e71c7867226a0c2f12cbf14175))

## [17.2.1](https://github.com/appium/appium-remote-debugger/compare/v17.2.0...v17.2.1) (2026-08-29)

### Miscellaneous Chores

* bump base-driver & support ([#541](https://github.com/appium/appium-remote-debugger/issues/541)) ([71b70a8](https://github.com/appium/appium-remote-debugger/commit/71b70a8022d7641f9a7ff16af49afd23eb78bf5a))

## [17.2.0](https://github.com/appium/appium-remote-debugger/compare/v17.1.0...v17.2.0) (2026-08-28)

### Features

* Add automation session support ([#539](https://github.com/appium/appium-remote-debugger/issues/539)) ([db68d1d](https://github.com/appium/appium-remote-debugger/commit/db68d1d88a29f42d003f5c02cb2ec680aaa113ad))

## [17.1.0](https://github.com/appium/appium-remote-debugger/compare/v17.0.7...v17.1.0) (2026-08-15)

### Features

* export atom names and make execute/executeAtom results generic ([#538](https://github.com/appium/appium-remote-debugger/issues/538)) ([3fb1387](https://github.com/appium/appium-remote-debugger/commit/3fb138713510b4889466b1b298a77f81e3d9eae0))

## [17.0.7](https://github.com/appium/appium-remote-debugger/compare/v17.0.6...v17.0.7) (2026-08-13)

### Miscellaneous Chores

* exercise atoms against Angular-rendered DOM ([#536](https://github.com/appium/appium-remote-debugger/issues/536)) ([9399ac1](https://github.com/appium/appium-remote-debugger/commit/9399ac18e9662162a90fba80eea655fc36b1101f))

## [17.0.6](https://github.com/appium/appium-remote-debugger/compare/v17.0.5...v17.0.6) (2026-08-12)

### Miscellaneous Chores

* exercise atoms against React-rendered DOM, not just static HTML fixtures ([#535](https://github.com/appium/appium-remote-debugger/issues/535)) ([9f9a33a](https://github.com/appium/appium-remote-debugger/commit/9f9a33afb3f62f5f1f6b4d945f9f91153ce5c4ba))

## [17.0.5](https://github.com/appium/appium-remote-debugger/compare/v17.0.4...v17.0.5) (2026-08-12)

### Bug Fixes

* Support typing into contenteditable elements in the type atom ([#529](https://github.com/appium/appium-remote-debugger/issues/529)) ([da022b3](https://github.com/appium/appium-remote-debugger/commit/da022b35cb57f64072ff5b4881e7fde9cf4129b5))

## [17.0.4](https://github.com/appium/appium-remote-debugger/compare/v17.0.3...v17.0.4) (2026-08-11)

### Bug Fixes

* Recognize ShadowRoot instances when wrapping execute_script results ([#530](https://github.com/appium/appium-remote-debugger/issues/530)) ([f19b0be](https://github.com/appium/appium-remote-debugger/commit/f19b0bebf6b9e63df6feb78f697d6e36525ab05e))

## [17.0.3](https://github.com/appium/appium-remote-debugger/compare/v17.0.2...v17.0.3) (2026-08-11)

### Miscellaneous Chores

* **deps-dev:** bump @types/jsdom from 28.0.3 to 30.0.0 ([#532](https://github.com/appium/appium-remote-debugger/issues/532)) ([21c827a](https://github.com/appium/appium-remote-debugger/commit/21c827a8a54a98d07f515fa160fcb4876146504b))

## [17.0.2](https://github.com/appium/appium-remote-debugger/compare/v17.0.1...v17.0.2) (2026-08-11)

### Bug Fixes

* Restore per-keystroke typing fidelity for number inputs ([#16697](https://github.com/appium/appium-remote-debugger/issues/16697)) ([#531](https://github.com/appium/appium-remote-debugger/issues/531)) ([4770ffa](https://github.com/appium/appium-remote-debugger/commit/4770ffa4e61023be9f90741a307154f5b5bf2203))

## [17.0.1](https://github.com/appium/appium-remote-debugger/compare/v17.0.0...v17.0.1) (2026-08-10)

### Bug Fixes

* Preserve full string when typing into number inputs ([#528](https://github.com/appium/appium-remote-debugger/issues/528)) ([8d88f33](https://github.com/appium/appium-remote-debugger/commit/8d88f3399c135a94344559127c1d2efd7f899e12))

## [17.0.0](https://github.com/appium/appium-remote-debugger/compare/v16.4.0...v17.0.0) (2026-08-10)

### ⚠ BREAKING CHANGES

* Dropped support of older browsers and platforms in atoms. Current atoms are only targeting mobile Safari since iOS 17

### Features

* Rewrite atoms/src as plain TypeScript, remove Closure Compiler ([#527](https://github.com/appium/appium-remote-debugger/issues/527)) ([bdbe585](https://github.com/appium/appium-remote-debugger/commit/bdbe5856a900dae64da75abc25c24df3f0d3aae7))

## [16.4.0](https://github.com/appium/appium-remote-debugger/compare/v16.3.0...v16.4.0) (2026-08-08)

### Features

* Add typescript checks to atoms ([#526](https://github.com/appium/appium-remote-debugger/issues/526)) ([cd2700f](https://github.com/appium/appium-remote-debugger/commit/cd2700fae4f03cee02c8ffb0f9c92efce79b1f3a))

## [16.3.0](https://github.com/appium/appium-remote-debugger/compare/v16.2.1...v16.3.0) (2026-08-07)

### Features

* Make atoms return W3C-compatible element and error responses ([#525](https://github.com/appium/appium-remote-debugger/issues/525)) ([b05bdb0](https://github.com/appium/appium-remote-debugger/commit/b05bdb00dab79194f66a70b2734081dc36ffdfee))

## [16.2.1](https://github.com/appium/appium-remote-debugger/compare/v16.2.0...v16.2.1) (2026-08-07)

### Bug Fixes

* Bound the element cache in atoms to prevent memory leaks ([#524](https://github.com/appium/appium-remote-debugger/issues/524)) ([efd9498](https://github.com/appium/appium-remote-debugger/commit/efd949847a8c6f9a8c014378ebb7792af7cd7839))

## [16.2.0](https://github.com/appium/appium-remote-debugger/compare/v16.1.0...v16.2.0) (2026-08-07)

### Features

* Add codegraph support ([#523](https://github.com/appium/appium-remote-debugger/issues/523)) ([c1ac753](https://github.com/appium/appium-remote-debugger/commit/c1ac753fdabf2b9aa41cda484e3cab022be9116a))

## [16.1.0](https://github.com/appium/appium-remote-debugger/compare/v16.0.3...v16.1.0) (2026-08-07)

### Features

* Vendor Selenium atoms ([#522](https://github.com/appium/appium-remote-debugger/issues/522)) ([634f31a](https://github.com/appium/appium-remote-debugger/commit/634f31a8c0641a3a52f8556e0c6eb42f932f0ebd))

## [16.0.3](https://github.com/appium/appium-remote-debugger/compare/v16.0.2...v16.0.3) (2026-07-28)

### Miscellaneous Chores

* Drop glob dependency ([#521](https://github.com/appium/appium-remote-debugger/issues/521)) ([5579cde](https://github.com/appium/appium-remote-debugger/commit/5579cdee4574b17d652790577193bf950194fe08))

## [16.0.2](https://github.com/appium/appium-remote-debugger/compare/v16.0.1...v16.0.2) (2026-07-27)

### Miscellaneous Chores

* Drop chai ([#518](https://github.com/appium/appium-remote-debugger/issues/518)) ([e5c9afc](https://github.com/appium/appium-remote-debugger/commit/e5c9afca5c63c14dc59fcd6f6ad7587fbcccf4f5))

## [16.0.1](https://github.com/appium/appium-remote-debugger/compare/v16.0.0...v16.0.1) (2026-07-27)

### Miscellaneous Chores

* Integrate oxc and release configs ([#517](https://github.com/appium/appium-remote-debugger/issues/517)) ([c09aab4](https://github.com/appium/appium-remote-debugger/commit/c09aab431614854bb6cf2cb17099f7a692f8763b))

## [16.0.0](https://github.com/appium/appium-remote-debugger/compare/v15.10.9...v16.0.0) (2026-07-26)

### ⚠ BREAKING CHANGES

* Consumers using require('appium-remote-debugger') must switch to import/dynamic import() — the package no longer ships a CommonJS entry point.

### Features

* Migrate the package to ESM ([#516](https://github.com/appium/appium-remote-debugger/issues/516)) ([0beb0ff](https://github.com/appium/appium-remote-debugger/commit/0beb0ff29261675746e1f5b6aa98144de789b3f2))

## [15.10.9](https://github.com/appium/appium-remote-debugger/compare/v15.10.8...v15.10.9) (2026-07-11)

### Miscellaneous Chores

* Drop mocha ([#511](https://github.com/appium/appium-remote-debugger/issues/511)) ([2b8cc59](https://github.com/appium/appium-remote-debugger/commit/2b8cc5956911aa9a67b7b5e4e15f0679f41855fc))

## [15.10.8](https://github.com/appium/appium-remote-debugger/compare/v15.10.7...v15.10.8) (2026-07-01)

### Miscellaneous Chores

* downgrade conventional-changelog-conventionalcommits to v9 ([#507](https://github.com/appium/appium-remote-debugger/issues/507)) ([ef4896f](https://github.com/appium/appium-remote-debugger/commit/ef4896f00fad0f9a1c804038f7141a0397cbbc7b))

## [15.10.7](https://github.com/appium/appium-remote-debugger/compare/v15.10.6...v15.10.7) (2026-07-01)

## [15.10.6](https://github.com/appium/appium-remote-debugger/compare/v15.10.5...v15.10.6) (2026-06-29)

## [15.10.5](https://github.com/appium/appium-remote-debugger/compare/v15.10.4...v15.10.5) (2026-06-19)

### Miscellaneous Chores

* **deps-dev:** bump @types/node from 25.9.4 to 26.0.0 ([#503](https://github.com/appium/appium-remote-debugger/issues/503)) ([bd89860](https://github.com/appium/appium-remote-debugger/commit/bd89860def7b8b6cfd8262228ecd0cd209348f28))

## [15.10.4](https://github.com/appium/appium-remote-debugger/compare/v15.10.3...v15.10.4) (2026-06-19)

### Miscellaneous Chores

* **deps:** bump appium-ios-remotexpc from 2.4.0 to 5.0.1 ([#502](https://github.com/appium/appium-remote-debugger/issues/502)) ([5e87eb3](https://github.com/appium/appium-remote-debugger/commit/5e87eb38018affd70a258e7ef3b7fc355b14786a))

## [15.10.3](https://github.com/appium/appium-remote-debugger/compare/v15.10.2...v15.10.3) (2026-05-26)

### Bug Fixes

* compatibility with iOS 26 ([#498](https://github.com/appium/appium-remote-debugger/issues/498)) ([410d97f](https://github.com/appium/appium-remote-debugger/commit/410d97fe4700bc55e0f5e50b858550aded748090))

## [15.10.2](https://github.com/appium/appium-remote-debugger/compare/v15.10.1...v15.10.2) (2026-05-21)

### Miscellaneous Chores

* **deps:** bump appium-ios-remotexpc from 1.1.13 to 2.0.0 ([#496](https://github.com/appium/appium-remote-debugger/issues/496)) ([304a173](https://github.com/appium/appium-remote-debugger/commit/304a1738dce1165057b187c4a680c000d1c4801b))

## [15.10.1](https://github.com/appium/appium-remote-debugger/compare/v15.10.0...v15.10.1) (2026-05-11)

### Miscellaneous Chores

* Use cancellable sleep from asyncbox ([#495](https://github.com/appium/appium-remote-debugger/issues/495)) ([f33d1db](https://github.com/appium/appium-remote-debugger/commit/f33d1db34948799cca5159a700a6ea4f8b57cb4c))

## [15.10.0](https://github.com/appium/appium-remote-debugger/compare/v15.9.1...v15.10.0) (2026-05-10)

### Features

* Reorganize utils ([#494](https://github.com/appium/appium-remote-debugger/issues/494)) ([332e70d](https://github.com/appium/appium-remote-debugger/commit/332e70df703fceb1f5f21f9c3665db6c051c34d6))

## [15.9.1](https://github.com/appium/appium-remote-debugger/compare/v15.9.0...v15.9.1) (2026-05-06)

### Miscellaneous Chores

* **deps-dev:** bump sinon from 21.1.2 to 22.0.0 ([#493](https://github.com/appium/appium-remote-debugger/issues/493)) ([660eaef](https://github.com/appium/appium-remote-debugger/commit/660eaefcff37e6434c4f40d57f1489a668ee53d7))

## [15.9.0](https://github.com/appium/appium-remote-debugger/compare/v15.8.1...v15.9.0) (2026-04-30)

### Features

* Use cancellable delay built using native promises ([#492](https://github.com/appium/appium-remote-debugger/issues/492)) ([84b9aa9](https://github.com/appium/appium-remote-debugger/commit/84b9aa9b26aaa63e8668cdb16e55362e08059b66))

## [15.8.1](https://github.com/appium/appium-remote-debugger/compare/v15.8.0...v15.8.1) (2026-04-29)

### Bug Fixes

* Copilot review comments ([#491](https://github.com/appium/appium-remote-debugger/issues/491)) ([3eb2f5c](https://github.com/appium/appium-remote-debugger/commit/3eb2f5c83c5631b80ef46e81abed7cec22d82879))

## [15.8.0](https://github.com/appium/appium-remote-debugger/compare/v15.7.3...v15.8.0) (2026-04-27)

### Features

* Ditch bluebird and lodash ([#490](https://github.com/appium/appium-remote-debugger/issues/490)) ([a0bb8b1](https://github.com/appium/appium-remote-debugger/commit/a0bb8b1349810d7e40405c0c5eb47198ab514029))

## [15.7.3](https://github.com/appium/appium-remote-debugger/compare/v15.7.2...v15.7.3) (2026-04-22)

### Miscellaneous Chores

* Bump appium-ios-remotexpc to ^1.0.0 ([#489](https://github.com/appium/appium-remote-debugger/issues/489)) ([354851a](https://github.com/appium/appium-remote-debugger/commit/354851aacbeada4e41421a8062d92149621a19fd))

## [15.7.2](https://github.com/appium/appium-remote-debugger/compare/v15.7.1...v15.7.2) (2026-04-17)

### Miscellaneous Chores

* **deps-dev:** bump typescript from 5.9.3 to 6.0.3 ([#487](https://github.com/appium/appium-remote-debugger/issues/487)) ([6696ac8](https://github.com/appium/appium-remote-debugger/commit/6696ac8927ffd28c35825303279baf2719c3696d))

## [15.7.1](https://github.com/appium/appium-remote-debugger/compare/v15.7.0...v15.7.1) (2026-04-17)

### Miscellaneous Chores

* **atoms:** update Selenium atoms from trunk ([#486](https://github.com/appium/appium-remote-debugger/issues/486)) ([16b7a89](https://github.com/appium/appium-remote-debugger/commit/16b7a896f98167de560c70aaf03c965b83e01b02))

## [15.7.0](https://github.com/appium/appium-remote-debugger/compare/v15.6.0...v15.7.0) (2026-04-17)

### Features

* Add automated atoms compilation script ([#485](https://github.com/appium/appium-remote-debugger/issues/485)) ([aa129f4](https://github.com/appium/appium-remote-debugger/commit/aa129f42beade3f6e1682430d281249eb2f6250d))

## [15.6.0](https://github.com/appium/appium-remote-debugger/compare/v15.5.0...v15.6.0) (2026-03-10)

### Features

* implement shim web inspector functionality ([#482](https://github.com/appium/appium-remote-debugger/issues/482)) ([e5484eb](https://github.com/appium/appium-remote-debugger/commit/e5484eb04d60d1be630bdfc5982f7c4822d40af3))

## [15.5.0](https://github.com/appium/appium-remote-debugger/compare/v15.4.0...v15.5.0) (2026-02-23)

### Features

* add ignoredBundleIds option to skip system processes in webview detection ([#480](https://github.com/appium/appium-remote-debugger/issues/480)) ([89331b0](https://github.com/appium/appium-remote-debugger/commit/89331b0f59dbd520e80143ef21dddd80dce10371))

## [15.4.0](https://github.com/appium/appium-remote-debugger/compare/v15.3.5...v15.4.0) (2026-02-18)

### Features

* Remove the deprecated Page.navigate command ([#479](https://github.com/appium/appium-remote-debugger/issues/479)) ([68459a7](https://github.com/appium/appium-remote-debugger/commit/68459a75b0a356a3371989992b5477b20d41d9b8))

## [15.3.5](https://github.com/appium/appium-remote-debugger/compare/v15.3.4...v15.3.5) (2026-02-16)

### Bug Fixes

* format ([#478](https://github.com/appium/appium-remote-debugger/issues/478)) ([c49cc38](https://github.com/appium/appium-remote-debugger/commit/c49cc383afe313dfc83a3d34b523360b0f60bc20))

## [15.3.4](https://github.com/appium/appium-remote-debugger/compare/v15.3.3...v15.3.4) (2026-02-07)

### Bug Fixes

* Introduce proper overloads for createRemoteDebugger ([#477](https://github.com/appium/appium-remote-debugger/issues/477)) ([5b82545](https://github.com/appium/appium-remote-debugger/commit/5b82545f3342f6d700106b8bc18650ce0122735f))

## [15.3.3](https://github.com/appium/appium-remote-debugger/compare/v15.3.2...v15.3.3) (2026-02-06)

### Miscellaneous Chores

* Update development notes ([#476](https://github.com/appium/appium-remote-debugger/issues/476)) ([09c6661](https://github.com/appium/appium-remote-debugger/commit/09c666158b11712ef1bfbe62ca05bb1f9544c1b5))

## [15.3.2](https://github.com/appium/appium-remote-debugger/compare/v15.3.1...v15.3.2) (2026-02-01)

### Miscellaneous Chores

* bump asyncbox ([#475](https://github.com/appium/appium-remote-debugger/issues/475)) ([ed68f27](https://github.com/appium/appium-remote-debugger/commit/ed68f273f3ea3fa82b08130bc55ae2e745dff44a))

## [15.3.1](https://github.com/appium/appium-remote-debugger/compare/v15.3.0...v15.3.1) (2026-01-28)

### Miscellaneous Chores

* **deps-dev:** bump @appium/eslint-config-appium-ts from 2.0.5 to 3.0.0 ([#473](https://github.com/appium/appium-remote-debugger/issues/473)) ([a7ef17e](https://github.com/appium/appium-remote-debugger/commit/a7ef17e9abb9ef36b64c0d04f0d78d3b16a8e0e7))

## [15.3.0](https://github.com/appium/appium-remote-debugger/compare/v15.2.14...v15.3.0) (2026-01-24)

### Features

* Migrate RPC clients to typescript ([#472](https://github.com/appium/appium-remote-debugger/issues/472)) ([81f3aab](https://github.com/appium/appium-remote-debugger/commit/81f3aabb73257c87ae24261e00614e6d530662d0))

## [15.2.14](https://github.com/appium/appium-remote-debugger/compare/v15.2.13...v15.2.14) (2026-01-24)

### Miscellaneous Chores

* Migrate RPC helpers to typescript ([#471](https://github.com/appium/appium-remote-debugger/issues/471)) ([8da661f](https://github.com/appium/appium-remote-debugger/commit/8da661fe6554b5d7b862408fd24d1ce40873f30c))

## [15.2.13](https://github.com/appium/appium-remote-debugger/compare/v15.2.12...v15.2.13) (2026-01-22)

### Miscellaneous Chores

* Migrate various modules to typescript ([#468](https://github.com/appium/appium-remote-debugger/issues/468)) ([ff96233](https://github.com/appium/appium-remote-debugger/commit/ff96233dda3d76f4894d8a2e36dfaef99457933c))

## [15.2.12](https://github.com/appium/appium-remote-debugger/compare/v15.2.11...v15.2.12) (2026-01-21)

### Miscellaneous Chores

* **deps:** bump asyncbox from 4.1.1 to 5.0.0 ([#467](https://github.com/appium/appium-remote-debugger/issues/467)) ([42985d7](https://github.com/appium/appium-remote-debugger/commit/42985d7ce739b21fcc1900b53e363e4dc657b988))

## [15.2.11](https://github.com/appium/appium-remote-debugger/compare/v15.2.10...v15.2.11) (2026-01-21)

### Miscellaneous Chores

* Migrate the rest of mixins to typescript ([#465](https://github.com/appium/appium-remote-debugger/issues/465)) ([1588bf9](https://github.com/appium/appium-remote-debugger/commit/1588bf90c85ac165f563353cacd03e6b85efd66b))

## [15.2.10](https://github.com/appium/appium-remote-debugger/compare/v15.2.9...v15.2.10) (2026-01-20)

### Miscellaneous Chores

* Migrate various mixins to typescript (part 1) ([#464](https://github.com/appium/appium-remote-debugger/issues/464)) ([5398180](https://github.com/appium/appium-remote-debugger/commit/539818017a9f312ee5bca183323140d94e20e421))

## [15.2.9](https://github.com/appium/appium-remote-debugger/compare/v15.2.8...v15.2.9) (2025-12-22)

### Miscellaneous Chores

* bump teen_process ([#463](https://github.com/appium/appium-remote-debugger/issues/463)) ([ae30d12](https://github.com/appium/appium-remote-debugger/commit/ae30d128bcd6f62c5730e7f14bf39061aac07711))

## [15.2.8](https://github.com/appium/appium-remote-debugger/compare/v15.2.7...v15.2.8) (2025-12-18)

### Miscellaneous Chores

* **deps:** bump asyncbox from 3.0.0 to 4.0.1 ([#462](https://github.com/appium/appium-remote-debugger/issues/462)) ([e89edfa](https://github.com/appium/appium-remote-debugger/commit/e89edfa11462680e4cbbcc5a0065fe9f0c4832a9))

## [15.2.7](https://github.com/appium/appium-remote-debugger/compare/v15.2.6...v15.2.7) (2025-12-13)

### Miscellaneous Chores

* **deps:** remove source-map-support ([#460](https://github.com/appium/appium-remote-debugger/issues/460)) ([9e97f2b](https://github.com/appium/appium-remote-debugger/commit/9e97f2bafcf2950f907121d53533685b93969a1c))

## [15.2.6](https://github.com/appium/appium-remote-debugger/compare/v15.2.5...v15.2.6) (2025-12-11)

### Miscellaneous Chores

* **deps-dev:** bump @types/node from 24.10.3 to 25.0.0 ([#459](https://github.com/appium/appium-remote-debugger/issues/459)) ([2c23f04](https://github.com/appium/appium-remote-debugger/commit/2c23f0428d4a23e86358ada9f58a64c36976338e))

## [15.2.5](https://github.com/appium/appium-remote-debugger/compare/v15.2.4...v15.2.5) (2025-11-25)

### ⚠ BREAKING CHANGES

* **deps-dev:** The minimum supported Xcode version is set to 14

Bumps [appium-ios-simulator](https://github.com/appium/appium-ios-simulator) from 7.0.3 to 8.0.0.
- [Release notes](https://github.com/appium/appium-ios-simulator/releases)
- [Changelog](https://github.com/appium/appium-ios-simulator/blob/master/CHANGELOG.md)
- [Commits](https://github.com/appium/appium-ios-simulator/compare/v7.0.3...v8.0.0)

### Miscellaneous Chores

* **deps-dev:** bump appium-ios-simulator from 7.0.3 to 8.0.0 ([#455](https://github.com/appium/appium-remote-debugger/issues/455)) ([4b278a3](https://github.com/appium/appium-remote-debugger/commit/4b278a316ffb0ce113a17a9df2670f6890958376))

## [15.2.4](https://github.com/appium/appium-remote-debugger/compare/v15.2.3...v15.2.4) (2025-11-21)

### Miscellaneous Chores

* **deps:** bump glob from 12.0.0 to 13.0.0 ([#454](https://github.com/appium/appium-remote-debugger/issues/454)) ([4bffa58](https://github.com/appium/appium-remote-debugger/commit/4bffa583c824fcc4dfe8fae828ae8b575c0e51f3))

## [15.2.3](https://github.com/appium/appium-remote-debugger/compare/v15.2.2...v15.2.3) (2025-11-19)

### Miscellaneous Chores

* **deps:** bump glob from 11.1.0 to 12.0.0 ([#453](https://github.com/appium/appium-remote-debugger/issues/453)) ([f8abf71](https://github.com/appium/appium-remote-debugger/commit/f8abf7101845b64ac2ed96d8d12fd004fd7b9eb5))

## [15.2.2](https://github.com/appium/appium-remote-debugger/compare/v15.2.1...v15.2.2) (2025-11-15)

### Miscellaneous Chores

* publish via trusted publisher ([#451](https://github.com/appium/appium-remote-debugger/issues/451)) ([6029458](https://github.com/appium/appium-remote-debugger/commit/6029458f16d25569e5fe50bfa7f59f9f7870d9c9))

## [15.2.1](https://github.com/appium/appium-remote-debugger/compare/v15.2.0...v15.2.1) (2025-11-11)

### Miscellaneous Chores

* Skip all Target.targetCreated events where type is not 'page' ([#450](https://github.com/appium/appium-remote-debugger/issues/450)) ([bbd6562](https://github.com/appium/appium-remote-debugger/commit/bbd656236d87dac91fe31349c0a5673d411337b1))

## [15.2.0](https://github.com/appium/appium-remote-debugger/compare/v15.1.1...v15.2.0) (2025-11-10)

### Features

* ignore frame target type for Target domain ([#449](https://github.com/appium/appium-remote-debugger/issues/449)) ([931081d](https://github.com/appium/appium-remote-debugger/commit/931081dd34363126b86ceca11a3843ac70f1560b))

## [15.1.1](https://github.com/appium/appium-remote-debugger/compare/v15.1.0...v15.1.1) (2025-10-17)

### Miscellaneous Chores

* **deps-dev:** bump semantic-release from 24.2.9 to 25.0.0 ([#448](https://github.com/appium/appium-remote-debugger/issues/448)) ([2bd343d](https://github.com/appium/appium-remote-debugger/commit/2bd343d72377dc86fc492217905b0786ec936652))

## [15.1.0](https://github.com/appium/appium-remote-debugger/compare/v15.0.3...v15.1.0) (2025-10-04)

### Features

* Add targetCreationTimeoutMs option ([#445](https://github.com/appium/appium-remote-debugger/issues/445)) ([6051f64](https://github.com/appium/appium-remote-debugger/commit/6051f642fbe9b70208b30d2afc8f0651c8e94ee6))

## [15.0.3](https://github.com/appium/appium-remote-debugger/compare/v15.0.2...v15.0.3) (2025-10-03)

### Bug Fixes

* Do not wait for existing targets ([#444](https://github.com/appium/appium-remote-debugger/issues/444)) ([f14558a](https://github.com/appium/appium-remote-debugger/commit/f14558aad74f558948d0bdfbf1d4850da4d66dc5))

## [15.0.2](https://github.com/appium/appium-remote-debugger/compare/v15.0.1...v15.0.2) (2025-09-16)

### Bug Fixes

* Introduce locking upon page selection ([#442](https://github.com/appium/appium-remote-debugger/issues/442)) ([88ca6ec](https://github.com/appium/appium-remote-debugger/commit/88ca6ecacfbe48eb0e4be594644c122ec466ca67))

## [15.0.1](https://github.com/appium/appium-remote-debugger/compare/v15.0.0...v15.0.1) (2025-09-07)

### Bug Fixes

* Combine page initialization and readiness checks ([#441](https://github.com/appium/appium-remote-debugger/issues/441)) ([c2bc662](https://github.com/appium/appium-remote-debugger/commit/c2bc66236d3349af05d247a8c11fece538ba51d8))

## [15.0.0](https://github.com/appium/appium-remote-debugger/compare/v14.0.5...v15.0.0) (2025-09-06)

### ⚠ BREAKING CHANGES

* Changed constructor signature of RemoteMessages class. It does not accept any arguments now
* Removed the obsolete isTargetBased getter and setter from RemoteMessages class instances
* Removed the obsolete needsTarget getter and isTargetBased property from RpcClient class instances
* Removed the obsolete isTargetBased getter and setter from RpcClient class instances
* Changed constructor signature of RpcMessageHandler class. It does not accept any arguments now
* Removed the obsolete isTargetBased getter and setter from RpcMessageHandler class instances

### Features

* Drop the obsolete non-target based communication protocol support ([#440](https://github.com/appium/appium-remote-debugger/issues/440)) ([e70e7fe](https://github.com/appium/appium-remote-debugger/commit/e70e7fe20b73b8a9ff293d54a55708a5984437e3))

## [14.0.5](https://github.com/appium/appium-remote-debugger/compare/v14.0.4...v14.0.5) (2025-08-29)

### Bug Fixes

* Update page initialization logic to avoid conflicts ([#438](https://github.com/appium/appium-remote-debugger/issues/438)) ([cb03aa3](https://github.com/appium/appium-remote-debugger/commit/cb03aa394b3df07db70e5cdbd0efd00f96430a78))

## [14.0.4](https://github.com/appium/appium-remote-debugger/compare/v14.0.3...v14.0.4) (2025-08-28)

### Bug Fixes

* Avoid deadlocks ([#437](https://github.com/appium/appium-remote-debugger/issues/437)) ([6634146](https://github.com/appium/appium-remote-debugger/commit/66341464459dc60bfd96d6e97e13aa63ad7c0205))

## [14.0.3](https://github.com/appium/appium-remote-debugger/compare/v14.0.2...v14.0.3) (2025-08-27)

### Bug Fixes

* Apply initialisation lock per app ([#436](https://github.com/appium/appium-remote-debugger/issues/436)) ([fd8a341](https://github.com/appium/appium-remote-debugger/commit/fd8a341d9a7b59acc758a3f37b09e2cc73f2c84a))

## [14.0.2](https://github.com/appium/appium-remote-debugger/compare/v14.0.1...v14.0.2) (2025-08-23)

### Miscellaneous Chores

* **deps-dev:** bump chai from 5.3.2 to 6.0.0 ([#435](https://github.com/appium/appium-remote-debugger/issues/435)) ([48c3c1a](https://github.com/appium/appium-remote-debugger/commit/48c3c1a32c93a84bc635ced3ba0c4be2488d1381))

## [14.0.1](https://github.com/appium/appium-remote-debugger/compare/v14.0.0...v14.0.1) (2025-08-17)

### Miscellaneous Chores

* **deps:** bump glob from 10.4.5 to 11.0.3 ([#424](https://github.com/appium/appium-remote-debugger/issues/424)) ([44b2d30](https://github.com/appium/appium-remote-debugger/commit/44b2d30e794c2d43e274c44c2c2e797303841897))

## [14.0.0](https://github.com/appium/appium-remote-debugger/compare/v13.1.2...v14.0.0) (2025-08-17)

### ⚠ BREAKING CHANGES

* Required Node.js version has been bumped to ^20.19.0 || ^22.12.0 || >=24.0.0
* Required npm version has been bumped to >=10
* Required base driver version has been bumped to >=10.0.0-rc.1

### Features

* Update server compatibility ([#434](https://github.com/appium/appium-remote-debugger/issues/434)) ([e1ca8cc](https://github.com/appium/appium-remote-debugger/commit/e1ca8cc5ba238d68d0c73cd187e03cdbbcfdb25e))

## [13.1.2](https://github.com/appium/appium-remote-debugger/compare/v13.1.1...v13.1.2) (2025-08-15)

### Miscellaneous Chores

* Bump the default timeout for the target creation event ([#433](https://github.com/appium/appium-remote-debugger/issues/433)) ([1204613](https://github.com/appium/appium-remote-debugger/commit/120461359bcf69a7534ee0f21a575aacb44a02a0))

## [13.1.1](https://github.com/appium/appium-remote-debugger/compare/v13.1.0...v13.1.1) (2025-08-04)

### Miscellaneous Chores

* bump appium-ios-device to 2.9.0 ([#432](https://github.com/appium/appium-remote-debugger/issues/432)) ([2ab211b](https://github.com/appium/appium-remote-debugger/commit/2ab211b3b8509fbe7ec8aa7f2c99edac0bc58a1d))

## [13.1.0](https://github.com/appium/appium-remote-debugger/compare/v13.0.0...v13.1.0) (2025-07-12)

### Features

* Add a helper method to verify if javascript execution is blocked ([#431](https://github.com/appium/appium-remote-debugger/issues/431)) ([5c9ea37](https://github.com/appium/appium-remote-debugger/commit/5c9ea3710b186f258759e4e8c38f6a2183316b78))

## [13.0.0](https://github.com/appium/appium-remote-debugger/compare/v12.2.10...v13.0.0) (2025-07-10)

### ⚠ BREAKING CHANGES

* Removed the obsolete ON_TARGET_PROVISIONED_EVENT exported constant

### Code Refactoring

* Introduce pauseOnStart for targets creation ([#430](https://github.com/appium/appium-remote-debugger/issues/430)) ([92668b4](https://github.com/appium/appium-remote-debugger/commit/92668b4f288991e624efa4a479f2f25bdec2c7f9))

## [12.2.10](https://github.com/appium/appium-remote-debugger/compare/v12.2.9...v12.2.10) (2025-07-05)

### Bug Fixes

* Improve errors handling in data messages ([#429](https://github.com/appium/appium-remote-debugger/issues/429)) ([7479e6e](https://github.com/appium/appium-remote-debugger/commit/7479e6e50995a2341bbd23f0d71f2dbc89acd536))

## [12.2.9](https://github.com/appium/appium-remote-debugger/compare/v12.2.8...v12.2.9) (2025-07-05)

### Bug Fixes

* Tune error handling in debugger responses ([#428](https://github.com/appium/appium-remote-debugger/issues/428)) ([984c937](https://github.com/appium/appium-remote-debugger/commit/984c937cc32e81596fed3c6889eb543cec931091))

## [12.2.8](https://github.com/appium/appium-remote-debugger/compare/v12.2.7...v12.2.8) (2025-07-04)

### Bug Fixes

* Update event listener typedefs ([#427](https://github.com/appium/appium-remote-debugger/issues/427)) ([2e8c292](https://github.com/appium/appium-remote-debugger/commit/2e8c2927230310cd3ff42de4ce8e2fb484b0b61d))

## [12.2.7](https://github.com/appium/appium-remote-debugger/compare/v12.2.6...v12.2.7) (2025-07-03)

### Bug Fixes

* Tune page initialization ([#426](https://github.com/appium/appium-remote-debugger/issues/426)) ([4c946be](https://github.com/appium/appium-remote-debugger/commit/4c946be43d85e55578d78e6877a7fcb362c4cd39))

## [12.2.6](https://github.com/appium/appium-remote-debugger/compare/v12.2.5...v12.2.6) (2025-07-03)

### Bug Fixes

* Wait for target before enabling inspector features ([#425](https://github.com/appium/appium-remote-debugger/issues/425)) ([9c0e1d9](https://github.com/appium/appium-remote-debugger/commit/9c0e1d99784af90aa1498707bea601e04efafcd2))

## [12.2.5](https://github.com/appium/appium-remote-debugger/compare/v12.2.4...v12.2.5) (2025-06-13)

### Miscellaneous Chores

* **deps-dev:** bump sinon from 20.0.0 to 21.0.0 ([#423](https://github.com/appium/appium-remote-debugger/issues/423)) ([1339caa](https://github.com/appium/appium-remote-debugger/commit/1339caa190fa8950136ca5e08e607f13dae98996))

## [12.2.4](https://github.com/appium/appium-remote-debugger/compare/v12.2.3...v12.2.4) (2025-06-10)

### Miscellaneous Chores

* **deps-dev:** bump @types/node from 22.15.31 to 24.0.0 ([#422](https://github.com/appium/appium-remote-debugger/issues/422)) ([80758fb](https://github.com/appium/appium-remote-debugger/commit/80758fb5f54221359453c2193ddc49ebcaadf3a7))

## [12.2.3](https://github.com/appium/appium-remote-debugger/compare/v12.2.2...v12.2.3) (2025-05-21)

### Miscellaneous Chores

* **deps-dev:** bump conventional-changelog-conventionalcommits ([#421](https://github.com/appium/appium-remote-debugger/issues/421)) ([b2e41a7](https://github.com/appium/appium-remote-debugger/commit/b2e41a77db613111b6a48019c66b81d452abc4ef))

## [12.2.2](https://github.com/appium/appium-remote-debugger/compare/v12.2.1...v12.2.2) (2025-03-28)

### Miscellaneous Chores

* **deps-dev:** bump serve-static from 1.16.2 to 2.2.0 ([#418](https://github.com/appium/appium-remote-debugger/issues/418)) ([a143bfc](https://github.com/appium/appium-remote-debugger/commit/a143bfc8b977bab42a23858fd32b44c984a31c96))

## [12.2.1](https://github.com/appium/appium-remote-debugger/compare/v12.2.0...v12.2.1) (2025-03-25)

### Miscellaneous Chores

* **deps-dev:** bump sinon from 19.0.5 to 20.0.0 ([#417](https://github.com/appium/appium-remote-debugger/issues/417)) ([0a97a3b](https://github.com/appium/appium-remote-debugger/commit/0a97a3b1f4376728e040517e7f46ac084d8e8f30))

## [12.2.0](https://github.com/appium/appium-remote-debugger/compare/v12.1.8...v12.2.0) (2025-03-13)

### Features

* build with latest atoms ([#412](https://github.com/appium/appium-remote-debugger/issues/412)) ([60474d8](https://github.com/appium/appium-remote-debugger/commit/60474d841b62e8c8d2ccd262569cbf9ec8b17d3b))

## [12.1.8](https://github.com/appium/appium-remote-debugger/compare/v12.1.7...v12.1.8) (2025-03-04)

### Miscellaneous Chores

* Remove obsolete linter config ([#415](https://github.com/appium/appium-remote-debugger/issues/415)) ([a20a743](https://github.com/appium/appium-remote-debugger/commit/a20a74324259fb24d296eb56fe20af2b4cc0b96c))
* remove unused arg ([#414](https://github.com/appium/appium-remote-debugger/issues/414)) ([7a5f1b1](https://github.com/appium/appium-remote-debugger/commit/7a5f1b11bd2e9f56ec92c6b6825566324c8edb44))

## [12.1.7](https://github.com/appium/appium-remote-debugger/compare/v12.1.6...v12.1.7) (2025-03-04)

### Bug Fixes

* fix atom building script ([#413](https://github.com/appium/appium-remote-debugger/issues/413)) ([adb6f15](https://github.com/appium/appium-remote-debugger/commit/adb6f15912cc8b1943ca502a8b88ac4347793237))

## [12.1.6](https://github.com/appium/appium-remote-debugger/compare/v12.1.5...v12.1.6) (2025-02-25)

### Bug Fixes

* Properly handle wildcard while selecting apps ([#411](https://github.com/appium/appium-remote-debugger/issues/411)) ([a6571a8](https://github.com/appium/appium-remote-debugger/commit/a6571a83daa51f94c9f17c02a3f120370642f704))

## [12.1.5](https://github.com/appium/appium-remote-debugger/compare/v12.1.4...v12.1.5) (2025-01-06)

### Miscellaneous Chores

* **deps-dev:** bump @appium/eslint-config-appium-ts from 0.3.3 to 1.0.1 ([#409](https://github.com/appium/appium-remote-debugger/issues/409)) ([81cc84d](https://github.com/appium/appium-remote-debugger/commit/81cc84d670f83fe4383ef275c022af0ce4c38120))

## [12.1.4](https://github.com/appium/appium-remote-debugger/compare/v12.1.3...v12.1.4) (2024-12-06)

### Miscellaneous Chores

* **deps:** bump @appium/support from 5.1.8 to 6.0.0 ([#408](https://github.com/appium/appium-remote-debugger/issues/408)) ([3b7e773](https://github.com/appium/appium-remote-debugger/commit/3b7e7739b62334462cbe3b8f8d6a8f767e16a687))

## [12.1.3](https://github.com/appium/appium-remote-debugger/compare/v12.1.2...v12.1.3) (2024-12-03)

### Miscellaneous Chores

* **deps-dev:** bump mocha from 10.8.2 to 11.0.1 ([#407](https://github.com/appium/appium-remote-debugger/issues/407)) ([4f9c6ae](https://github.com/appium/appium-remote-debugger/commit/4f9c6ae01a4425d17c182fd44efaec7004ca911a))

## [12.1.2](https://github.com/appium/appium-remote-debugger/compare/v12.1.1...v12.1.2) (2024-09-13)

### Miscellaneous Chores

* **deps-dev:** bump sinon from 18.0.1 to 19.0.0 ([#406](https://github.com/appium/appium-remote-debugger/issues/406)) ([ff35ca3](https://github.com/appium/appium-remote-debugger/commit/ff35ca3275bd06207a74cb358048b1dfe0256785))

## [12.1.1](https://github.com/appium/appium-remote-debugger/compare/v12.1.0...v12.1.1) (2024-08-11)

### Bug Fixes

* Only try to select Safari if it is enabled for automation ([#404](https://github.com/appium/appium-remote-debugger/issues/404)) ([4621589](https://github.com/appium/appium-remote-debugger/commit/462158987f54ac44048c2b46d589f251f1487279))

## [12.1.0](https://github.com/appium/appium-remote-debugger/compare/v12.0.4...v12.1.0) (2024-08-11)

### Features

* Expose appDict ([#405](https://github.com/appium/appium-remote-debugger/issues/405)) ([1ec4be5](https://github.com/appium/appium-remote-debugger/commit/1ec4be5f0657a9d233cb258a3bc3001a67b6888b))

## [12.0.4](https://github.com/appium/appium-remote-debugger/compare/v12.0.3...v12.0.4) (2024-08-08)

### Miscellaneous Chores

* Tune log messages ([fa0a862](https://github.com/appium/appium-remote-debugger/commit/fa0a862f33edcfe987b601a598a062e5426218c7))

## [12.0.3](https://github.com/appium/appium-remote-debugger/compare/v12.0.2...v12.0.3) (2024-08-08)

### Bug Fixes

* Make index typed ([#403](https://github.com/appium/appium-remote-debugger/issues/403)) ([04dafea](https://github.com/appium/appium-remote-debugger/commit/04dafea83f237f2ee1e0f425718ef941f852da9e))

## [12.0.2](https://github.com/appium/appium-remote-debugger/compare/v12.0.1...v12.0.2) (2024-08-08)

### Bug Fixes

* Start page status monitoring on page change event as well ([#402](https://github.com/appium/appium-remote-debugger/issues/402)) ([8f71d19](https://github.com/appium/appium-remote-debugger/commit/8f71d19405fc54e4a04c4863623b766f217917d4))

## [12.0.1](https://github.com/appium/appium-remote-debugger/compare/v12.0.0...v12.0.1) (2024-08-04)

### Bug Fixes

* Properly handle protected accessors from mixin methods ([#401](https://github.com/appium/appium-remote-debugger/issues/401)) ([f47f6af](https://github.com/appium/appium-remote-debugger/commit/f47f6af3d73ec0566fdca769d23bcac12f045607))

## [12.0.0](https://github.com/appium/appium-remote-debugger/compare/v11.5.9...v12.0.0) (2024-08-04)

### ⚠ BREAKING CHANGES

* The following class properties have been renamed (got a leading underscore) and made protected:
skippedApps
clientEventListeners
appDict
appIdKey
pageIdKey
connectedDrivers
currentState
pageLoadDelay
rpcClient
pageLoading
navigatingToPage
pageLoadStrategy
bundleId
additionalBundleIds
platformVersion
isSafari
includeSafari
useNewSafari
pageLoadMs
garbageCollectOnExecute
host
port
socketPath
remoteDebugProxy
pageReadyTimeout
logAllCommunication
logAllCommunicationHexDump
socketChunkSize
webInspectorMaxFrameLength
fullPageInitialization
udid
* The following class methods have been made private:
searchForApp
searchForPage
* Remove the unused RPC_RESPONSE_TIMEOUT_MS export

### Features

* Rewrite the RemoteDebugger class into typescript ([#400](https://github.com/appium/appium-remote-debugger/issues/400)) ([ef277b3](https://github.com/appium/appium-remote-debugger/commit/ef277b3991c57ed34740d946bab1c3505674adec))

## [11.5.9](https://github.com/appium/appium-remote-debugger/compare/v11.5.8...v11.5.9) (2024-08-02)

### Miscellaneous Chores

* Replace fancy-log dependency with appium logger ([#398](https://github.com/appium/appium-remote-debugger/issues/398)) ([0abefda](https://github.com/appium/appium-remote-debugger/commit/0abefda18cfcaa0c535b8bf3e982ad67ca5c3bc3))

## [11.5.8](https://github.com/appium/appium-remote-debugger/compare/v11.5.7...v11.5.8) (2024-08-01)

### Miscellaneous Chores

* Improve various type declarations ([#397](https://github.com/appium/appium-remote-debugger/issues/397)) ([93ed417](https://github.com/appium/appium-remote-debugger/commit/93ed41750c46d3b1ba28e992bd38e241b73ded71))

## [11.5.7](https://github.com/appium/appium-remote-debugger/compare/v11.5.6...v11.5.7) (2024-07-31)

### Bug Fixes

* Add missing await ([#396](https://github.com/appium/appium-remote-debugger/issues/396)) ([b213787](https://github.com/appium/appium-remote-debugger/commit/b213787ec9cac767c8a3a3474f5e7f7393eeeb4c))

## [11.5.6](https://github.com/appium/appium-remote-debugger/compare/v11.5.5...v11.5.6) (2024-07-31)

### Miscellaneous Chores

* **deps-dev:** bump @types/node from 20.14.13 to 22.0.0 ([#394](https://github.com/appium/appium-remote-debugger/issues/394)) ([6c56dec](https://github.com/appium/appium-remote-debugger/commit/6c56dec764ff2438e6d2451361a85996de7cc9c2))

## [11.5.5](https://github.com/appium/appium-remote-debugger/compare/v11.5.4...v11.5.5) (2024-07-31)

### Bug Fixes

* Tune page array retrieval ([#395](https://github.com/appium/appium-remote-debugger/issues/395)) ([8bb5ce3](https://github.com/appium/appium-remote-debugger/commit/8bb5ce397a0d1f642558e7012db5e6916157079e))

## [11.5.4](https://github.com/appium/appium-remote-debugger/compare/v11.5.3...v11.5.4) (2024-07-26)

### Miscellaneous Chores

* Improve typing on RpcClient ([#393](https://github.com/appium/appium-remote-debugger/issues/393)) ([3a15572](https://github.com/appium/appium-remote-debugger/commit/3a15572aced7d3dde0dff9d9cdefd68a60a78648))

## [11.5.3](https://github.com/appium/appium-remote-debugger/compare/v11.5.2...v11.5.3) (2024-07-25)

### Bug Fixes

* getCookie types ([fe6bef2](https://github.com/appium/appium-remote-debugger/commit/fe6bef22fc539ce0dd7cd99adea7fd9363221776))

## [11.5.2](https://github.com/appium/appium-remote-debugger/compare/v11.5.1...v11.5.2) (2024-07-25)

### Bug Fixes

* setCookie types ([1af49b8](https://github.com/appium/appium-remote-debugger/commit/1af49b85f9c913eb9a764287310337e86ca5b94d))

## [11.5.1](https://github.com/appium/appium-remote-debugger/compare/v11.5.0...v11.5.1) (2024-07-25)

### Bug Fixes

* Returned types for cookies ([13c8f15](https://github.com/appium/appium-remote-debugger/commit/13c8f152901b568ed93ada9b8c7c1a98b08709d4))

## [11.5.0](https://github.com/appium/appium-remote-debugger/compare/v11.4.2...v11.5.0) (2024-07-25)

### Features

* Refactor mixins and improve their typing ([#392](https://github.com/appium/appium-remote-debugger/issues/392)) ([d1fda80](https://github.com/appium/appium-remote-debugger/commit/d1fda8080afaafe4880c36e008bfd248d039965a))

## [11.4.2](https://github.com/appium/appium-remote-debugger/compare/v11.4.1...v11.4.2) (2024-07-24)

### Miscellaneous Chores

* More type fixes ([#391](https://github.com/appium/appium-remote-debugger/issues/391)) ([08aaf8a](https://github.com/appium/appium-remote-debugger/commit/08aaf8acc12f896d8a16dc96077c6576d477c77e))

## [11.4.1](https://github.com/appium/appium-remote-debugger/compare/v11.4.0...v11.4.1) (2024-07-24)

### Miscellaneous Chores

* Publish missing methods types ([#390](https://github.com/appium/appium-remote-debugger/issues/390)) ([4ed8f35](https://github.com/appium/appium-remote-debugger/commit/4ed8f3501c5656269c7a47721f538dca72508f6c))

## [11.4.0](https://github.com/appium/appium-remote-debugger/compare/v11.3.2...v11.4.0) (2024-07-24)

### Features

* Export type declarations ([#389](https://github.com/appium/appium-remote-debugger/issues/389)) ([d86b7a4](https://github.com/appium/appium-remote-debugger/commit/d86b7a48a824dea6ddcd21566a6f38f97092c475))

## [11.3.2](https://github.com/appium/appium-remote-debugger/compare/v11.3.1...v11.3.2) (2024-07-09)

### Miscellaneous Chores

* Remove extra import ([1a9cfe2](https://github.com/appium/appium-remote-debugger/commit/1a9cfe24c3321312ade04ef15f30aa72327b2ae1))

## [11.3.1](https://github.com/appium/appium-remote-debugger/compare/v11.3.0...v11.3.1) (2024-06-20)

### Miscellaneous Chores

* Bump chai and chai-as-promised ([#387](https://github.com/appium/appium-remote-debugger/issues/387)) ([3a361e2](https://github.com/appium/appium-remote-debugger/commit/3a361e286168902c957a3bd586ece8c576efee9b))

## [11.3.0](https://github.com/appium/appium-remote-debugger/compare/v11.2.0...v11.3.0) (2024-06-19)

### Features

* support pageLoadStrategy in readState check ([#385](https://github.com/appium/appium-remote-debugger/issues/385)) ([d20ba70](https://github.com/appium/appium-remote-debugger/commit/d20ba70ab2d6dd351ee98e25f09b5d7e4226210e))

## [11.2.0](https://github.com/appium/appium-remote-debugger/compare/v11.1.5...v11.2.0) (2024-06-19)

### Features

* add method to capture viewport ([#386](https://github.com/appium/appium-remote-debugger/issues/386)) ([f717ca5](https://github.com/appium/appium-remote-debugger/commit/f717ca5d49ed63fc256b11b3c1861d8dffd53140))

## [11.1.5](https://github.com/appium/appium-remote-debugger/compare/v11.1.4...v11.1.5) (2024-06-12)

### Miscellaneous Chores

* **deps:** bump @appium/support from 4.5.0 to 5.0.3 ([#382](https://github.com/appium/appium-remote-debugger/issues/382)) ([e7b3766](https://github.com/appium/appium-remote-debugger/commit/e7b3766b9096c8fe2211ded3605a2064e72aae00))

## [11.1.4](https://github.com/appium/appium-remote-debugger/compare/v11.1.3...v11.1.4) (2024-06-04)

### Miscellaneous Chores

* **deps-dev:** bump semantic-release from 23.1.1 to 24.0.0 and conventional-changelog-conventionalcommits to 8.0.0 ([#380](https://github.com/appium/appium-remote-debugger/issues/380)) ([7577471](https://github.com/appium/appium-remote-debugger/commit/757747102e224133819deaaa4bc005851e73724b))

## [11.1.3](https://github.com/appium/appium-remote-debugger/compare/v11.1.2...v11.1.3) (2024-05-16)


### Miscellaneous Chores

* Update dev dependendies ([f99850a](https://github.com/appium/appium-remote-debugger/commit/f99850a0ad4f000a3361a09f762e95995d857abd))

## [11.1.2](https://github.com/appium/appium-remote-debugger/compare/v11.1.1...v11.1.2) (2024-05-16)


### Miscellaneous Chores

* **deps-dev:** bump sinon from 17.0.2 to 18.0.0 ([#379](https://github.com/appium/appium-remote-debugger/issues/379)) ([2cccea7](https://github.com/appium/appium-remote-debugger/commit/2cccea7c2c8b84531a4bc8cf3508f490539bd161))

## [11.1.1](https://github.com/appium/appium-remote-debugger/compare/v11.1.0...v11.1.1) (2024-04-19)


### Miscellaneous Chores

* update atoms-note ([b65caec](https://github.com/appium/appium-remote-debugger/commit/b65caec57946f21ee7bf54647efeff989e485b2f))

## [11.1.0](https://github.com/appium/appium-remote-debugger/compare/v11.0.9...v11.1.0) (2024-04-16)


### Features

* update atoms to selenium 4.19.0 basis ([#375](https://github.com/appium/appium-remote-debugger/issues/375)) ([cc5a084](https://github.com/appium/appium-remote-debugger/commit/cc5a084060c2e12d78092ca16e9b4e3d72cc0374))

## [11.0.9](https://github.com/appium/appium-remote-debugger/compare/v11.0.8...v11.0.9) (2024-04-09)


### Miscellaneous Chores

* Remove extra imports ([ef721b0](https://github.com/appium/appium-remote-debugger/commit/ef721b050d746c134c3b5c5cde27354be1267b9a))

## [11.0.8](https://github.com/appium/appium-remote-debugger/compare/v11.0.7...v11.0.8) (2024-04-09)


### Miscellaneous Chores

* **deps-dev:** bump @typescript-eslint/parser from 6.21.0 to 7.6.0 ([#374](https://github.com/appium/appium-remote-debugger/issues/374)) ([ce01f8a](https://github.com/appium/appium-remote-debugger/commit/ce01f8ab99f275c3afa22ef9664c03d655114828))

## [11.0.7](https://github.com/appium/appium-remote-debugger/compare/v11.0.6...v11.0.7) (2024-03-27)


### Miscellaneous Chores

* **deps-dev:** bump appium-ios-simulator from 5.5.3 to 6.1.2 ([#372](https://github.com/appium/appium-remote-debugger/issues/372)) ([e20cbc3](https://github.com/appium/appium-remote-debugger/commit/e20cbc3aa8399b93ef1afd8174217907a2d2ff9b))

## [11.0.6](https://github.com/appium/appium-remote-debugger/compare/v11.0.5...v11.0.6) (2024-03-22)


### Bug Fixes

* Improve page load detection logic ([#369](https://github.com/appium/appium-remote-debugger/issues/369)) ([418093b](https://github.com/appium/appium-remote-debugger/commit/418093b257ce4f85527493fca045f53712823418))

## [11.0.5](https://github.com/appium/appium-remote-debugger/compare/v11.0.4...v11.0.5) (2024-03-22)


### Bug Fixes

* Select all available app ids for the given bundle name ([#368](https://github.com/appium/appium-remote-debugger/issues/368)) ([c4f02b7](https://github.com/appium/appium-remote-debugger/commit/c4f02b7e98477adfd4b426c7e5cc4973dbc9e73f))

## [11.0.4](https://github.com/appium/appium-remote-debugger/compare/v11.0.3...v11.0.4) (2024-03-07)


### Miscellaneous Chores

* bump typescript ([b734a4d](https://github.com/appium/appium-remote-debugger/commit/b734a4dc53e21cb6d6d07b67d14364440c478b81))

## [11.0.3](https://github.com/appium/appium-remote-debugger/compare/v11.0.2...v11.0.3) (2024-02-18)


### Miscellaneous Chores

* Perform URL validation ([#361](https://github.com/appium/appium-remote-debugger/issues/361)) ([5c2b926](https://github.com/appium/appium-remote-debugger/commit/5c2b9264604b82f599246610bf72f150fc972e43))

## [11.0.2](https://github.com/appium/appium-remote-debugger/compare/v11.0.1...v11.0.2) (2024-02-14)


### Bug Fixes

* Only wait for Console.enable RPC response if page load finishes ([#360](https://github.com/appium/appium-remote-debugger/issues/360)) ([7b9a107](https://github.com/appium/appium-remote-debugger/commit/7b9a107016983a90c1505ed8958d19c545709969))

## [11.0.1](https://github.com/appium/appium-remote-debugger/compare/v11.0.0...v11.0.1) (2024-02-14)


### Miscellaneous Chores

* throw timeout error if Console.enable times out ([#359](https://github.com/appium/appium-remote-debugger/issues/359)) ([1ea7086](https://github.com/appium/appium-remote-debugger/commit/1ea70862feacd5cf997a633999fa9dce441c757c))

## [11.0.0](https://github.com/appium/appium-remote-debugger/compare/v10.2.2...v11.0.0) (2024-02-14)


### ⚠ BREAKING CHANGES

* Removed the pageUnload API
* Removed the waitForFrameNavigated API
* Removed the pageLoadVerifyHook argument from waitForDom and from navToUrl APIs

### Features

* Properly perform page readiness validation ([#356](https://github.com/appium/appium-remote-debugger/issues/356)) ([a2fbd5a](https://github.com/appium/appium-remote-debugger/commit/a2fbd5aab52f246755fbdbf64cfecf1b6dd5a949))

## [10.2.2](https://github.com/appium/appium-remote-debugger/compare/v10.2.1...v10.2.2) (2024-02-06)


### Bug Fixes

* Properly log retries count ([#354](https://github.com/appium/appium-remote-debugger/issues/354)) ([33f6155](https://github.com/appium/appium-remote-debugger/commit/33f61553617d7af6ea8dd221d0865dfd88e81a70))

## [10.2.1](https://github.com/appium/appium-remote-debugger/compare/v10.2.0...v10.2.1) (2024-01-16)


### Miscellaneous Chores

* **deps-dev:** bump semantic-release from 22.0.12 to 23.0.0 ([#352](https://github.com/appium/appium-remote-debugger/issues/352)) ([c83fefd](https://github.com/appium/appium-remote-debugger/commit/c83fefd500d4ce47948b29bc1187cd13033056d1))

## [10.2.0](https://github.com/appium/appium-remote-debugger/compare/v10.1.7...v10.2.0) (2023-11-17)


### Features

* introduce a wildcard usage for additionalWebviewBundleIds to get webview contexts of other apps ([#346](https://github.com/appium/appium-remote-debugger/issues/346)) ([72ee224](https://github.com/appium/appium-remote-debugger/commit/72ee224ec2542e8e93354c6f533986223f2e84c7))

## [10.1.7](https://github.com/appium/appium-remote-debugger/compare/v10.1.6...v10.1.7) (2023-11-06)


### Miscellaneous Chores

* **deps-dev:** bump @types/sinon from 10.0.20 to 17.0.0 ([#345](https://github.com/appium/appium-remote-debugger/issues/345)) ([4d7a9b9](https://github.com/appium/appium-remote-debugger/commit/4d7a9b9fae324c6cad351344de4d43883272c929))

## [10.1.6](https://github.com/appium/appium-remote-debugger/compare/v10.1.5...v10.1.6) (2023-11-01)


### Miscellaneous Chores

* **deps:** bump asyncbox from 2.9.4 to 3.0.0 ([#344](https://github.com/appium/appium-remote-debugger/issues/344)) ([791d566](https://github.com/appium/appium-remote-debugger/commit/791d566970e7b3a26d3326428935c4636ff237ba))

## [10.1.5](https://github.com/appium/appium-remote-debugger/compare/v10.1.4...v10.1.5) (2023-10-31)


### Miscellaneous Chores

* **deps-dev:** bump semantic-release from 21.1.2 to 22.0.6 ([#343](https://github.com/appium/appium-remote-debugger/issues/343)) ([0b9608d](https://github.com/appium/appium-remote-debugger/commit/0b9608de6bda071d57abfec0eab91bab96a9518e))

## [10.1.4](https://github.com/appium/appium-remote-debugger/compare/v10.1.3...v10.1.4) (2023-10-25)


### Miscellaneous Chores

* **deps-dev:** bump @typescript-eslint/eslint-plugin from 5.62.0 to 6.9.0 ([#342](https://github.com/appium/appium-remote-debugger/issues/342)) ([e705788](https://github.com/appium/appium-remote-debugger/commit/e7057886bcc48a15980c298493c1e753107b8514))

## [10.1.3](https://github.com/appium/appium-remote-debugger/compare/v10.1.2...v10.1.3) (2023-10-24)


### Miscellaneous Chores

* **deps-dev:** bump sinon from 16.1.3 to 17.0.0 ([#341](https://github.com/appium/appium-remote-debugger/issues/341)) ([379395e](https://github.com/appium/appium-remote-debugger/commit/379395eb00ed8ce5eb421bd28eb8ead177294fb3))

## [10.1.2](https://github.com/appium/appium-remote-debugger/compare/v10.1.1...v10.1.2) (2023-10-19)


### Miscellaneous Chores

* Apply minor dependency version tunings ([#340](https://github.com/appium/appium-remote-debugger/issues/340)) ([77eb83f](https://github.com/appium/appium-remote-debugger/commit/77eb83ffaf3a0ab37b1fa543bf42d418cbd44262))
* **deps-dev:** bump eslint-config-prettier from 8.10.0 to 9.0.0 ([#336](https://github.com/appium/appium-remote-debugger/issues/336)) ([2c3c677](https://github.com/appium/appium-remote-debugger/commit/2c3c6770eecaecdb749569c6e071a387a6a94406))
* **deps-dev:** bump lint-staged from 14.0.1 to 15.0.2 ([#335](https://github.com/appium/appium-remote-debugger/issues/335)) ([962ee2b](https://github.com/appium/appium-remote-debugger/commit/962ee2bed6051715a61614fcc676dee34eaf40de))
* **deps-dev:** bump sinon from 15.2.0 to 16.1.3 ([#337](https://github.com/appium/appium-remote-debugger/issues/337)) ([3213fba](https://github.com/appium/appium-remote-debugger/commit/3213fba13f454c753a3528dfed866011b7e2d712))

## [10.1.1](https://github.com/appium/appium-remote-debugger/compare/v10.1.0...v10.1.1) (2023-09-14)


### Miscellaneous Chores

* Update tests ([f9c2822](https://github.com/appium/appium-remote-debugger/commit/f9c2822afaff6265d1051629f3afe3553bda30e9))

## [10.1.0](https://github.com/appium/appium-remote-debugger/compare/v10.0.3...v10.1.0) (2023-08-30)


### Features

* Switch babel to typescript ([#318](https://github.com/appium/appium-remote-debugger/issues/318)) ([f19984e](https://github.com/appium/appium-remote-debugger/commit/f19984e37471949057fbdf4333b816c8132fbc87)), closes [#319](https://github.com/appium/appium-remote-debugger/issues/319)

## [10.0.3](https://github.com/appium/appium-remote-debugger/compare/v10.0.2...v10.0.3) (2023-08-28)


### Miscellaneous Chores

* **deps-dev:** bump conventional-changelog-conventionalcommits ([#319](https://github.com/appium/appium-remote-debugger/issues/319)) ([75d2307](https://github.com/appium/appium-remote-debugger/commit/75d230754e49a015fc68a1f9a131970c16751d44))

## [10.0.2](https://github.com/appium/appium-remote-debugger/compare/v10.0.1...v10.0.2) (2023-08-25)


### Miscellaneous Chores

* **deps-dev:** bump semantic-release from 20.1.3 to 21.0.7 ([#312](https://github.com/appium/appium-remote-debugger/issues/312)) ([cd78f4a](https://github.com/appium/appium-remote-debugger/commit/cd78f4a36caf0a48a1857c6eea2b72c0d42e74b0))

## [10.0.1](https://github.com/appium/appium-remote-debugger/compare/v10.0.0...v10.0.1) (2023-08-24)


### Bug Fixes

* use correct timeline rpc name ([#317](https://github.com/appium/appium-remote-debugger/issues/317)) ([c69bd64](https://github.com/appium/appium-remote-debugger/commit/c69bd6484e4fd7ff5030e2e50d981c0fc1bbd80c)), closes [appium/appium#15685](https://github.com/appium/appium/issues/15685)

## [9.1.18](https://github.com/appium/appium-remote-debugger/compare/v9.1.17...v9.1.18) (2023-08-14)


### Miscellaneous Chores

* **deps-dev:** bump lint-staged from 13.3.0 to 14.0.0 ([#316](https://github.com/appium/appium-remote-debugger/issues/316)) ([28b877f](https://github.com/appium/appium-remote-debugger/commit/28b877fa63f7ba185b0ef4a83b23fe88fd3fbf8e))

## [9.1.17](https://github.com/appium/appium-remote-debugger/compare/v9.1.16...v9.1.17) (2023-07-07)


### Miscellaneous Chores

* **deps-dev:** bump prettier from 2.8.8 to 3.0.0 ([#313](https://github.com/appium/appium-remote-debugger/issues/313)) ([9a07e14](https://github.com/appium/appium-remote-debugger/commit/9a07e147751c6a376a08fcd556f2b8cf7f16a3df))

## [9.1.16](https://github.com/appium/appium-remote-debugger/compare/v9.1.15...v9.1.16) (2023-06-07)


### Miscellaneous Chores

* **deps-dev:** bump conventional-changelog-conventionalcommits ([#307](https://github.com/appium/appium-remote-debugger/issues/307)) ([3ece7d7](https://github.com/appium/appium-remote-debugger/commit/3ece7d740df9a675ae9d8f9861d9b881bb078342))

## [9.1.15](https://github.com/appium/appium-remote-debugger/compare/v9.1.14...v9.1.15) (2023-05-18)


### Miscellaneous Chores

* **deps:** bump @appium/support from 3.1.11 to 4.0.0 ([#303](https://github.com/appium/appium-remote-debugger/issues/303)) ([40cb4ec](https://github.com/appium/appium-remote-debugger/commit/40cb4ec15d72d879d97e1f3051341ed3c9386d41))

## [9.1.14](https://github.com/appium/appium-remote-debugger/compare/v9.1.13...v9.1.14) (2023-03-03)


### Miscellaneous Chores

* Improve error messages on missing params ([#288](https://github.com/appium/appium-remote-debugger/issues/288)) ([a5fc3f0](https://github.com/appium/appium-remote-debugger/commit/a5fc3f0e43c62228f3098c139bd77cd372e461ae))

## [9.1.13](https://github.com/appium/appium-remote-debugger/compare/v9.1.12...v9.1.13) (2023-02-27)


### Miscellaneous Chores

* add commands for Page ([#283](https://github.com/appium/appium-remote-debugger/issues/283)) ([042bd15](https://github.com/appium/appium-remote-debugger/commit/042bd15e718b401a73d449005b7df2959dd5fec9))

## [9.1.12](https://github.com/appium/appium-remote-debugger/compare/v9.1.11...v9.1.12) (2023-01-17)


### Miscellaneous Chores

* **deps-dev:** bump semantic-release from 19.0.5 to 20.0.2 ([#282](https://github.com/appium/appium-remote-debugger/issues/282)) ([14e9aa5](https://github.com/appium/appium-remote-debugger/commit/14e9aa5956528dc173b02518e0a55991b22e4365))

## [9.1.11](https://github.com/appium/appium-remote-debugger/compare/v9.1.10...v9.1.11) (2022-12-16)


### Miscellaneous Chores

* **deps-dev:** bump appium-ios-simulator from 4.2.1 to 5.0.1 ([#281](https://github.com/appium/appium-remote-debugger/issues/281)) ([c8018be](https://github.com/appium/appium-remote-debugger/commit/c8018bec84d47ec7340f5ddf61522fcb4fe59c67))
* **deps:** bump @appium/base-driver from 8.7.3 to 9.0.0 ([#280](https://github.com/appium/appium-remote-debugger/issues/280)) ([c325b4b](https://github.com/appium/appium-remote-debugger/commit/c325b4b2a7624c765f4aa648b00804611e329357))

## [9.1.10](https://github.com/appium/appium-remote-debugger/compare/v9.1.9...v9.1.10) (2022-12-14)


### Miscellaneous Chores

* **deps:** bump @appium/support from 2.61.1 to 3.0.0 ([#279](https://github.com/appium/appium-remote-debugger/issues/279)) ([e9de675](https://github.com/appium/appium-remote-debugger/commit/e9de675d15322cae110804b5f08a5b9b46c54b0a))

## [9.1.9](https://github.com/appium/appium-remote-debugger/compare/v9.1.8...v9.1.9) (2022-12-01)


### Miscellaneous Chores

* update releaserc ([#278](https://github.com/appium/appium-remote-debugger/issues/278)) ([f8e406b](https://github.com/appium/appium-remote-debugger/commit/f8e406bcfe6683d921952dd6153512c6e6b5afbd))

## [9.1.8](https://github.com/appium/appium-remote-debugger/compare/v9.1.7...v9.1.8) (2022-11-29)

## [9.1.7](https://github.com/appium/appium-remote-debugger/compare/v9.1.6...v9.1.7) (2022-11-28)


### Bug Fixes

* fix scripts for atoms ([#276](https://github.com/appium/appium-remote-debugger/issues/276)) ([72da4b3](https://github.com/appium/appium-remote-debugger/commit/72da4b3949c2d942ff50367c9540244494249a6b))

## [9.1.6](https://github.com/appium/appium-remote-debugger/compare/v9.1.5...v9.1.6) (2022-11-27)

## [9.1.5](https://github.com/appium/appium-remote-debugger/compare/v9.1.4...v9.1.5) (2022-11-22)

## [9.1.4](https://github.com/appium/appium-remote-debugger/compare/v9.1.3...v9.1.4) (2022-11-06)
