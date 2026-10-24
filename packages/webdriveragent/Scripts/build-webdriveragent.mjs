import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {logger, fs} from '@appium/support';
import * as xcode from 'appium-xcode';
import {exec} from 'teen_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;

const LOG = new logger.getLogger('WDABuild');
const ROOT_DIR = path.resolve(__dirname, '..');
const DERIVED_DATA_PATH = `${ROOT_DIR}/wdaBuild`;

const BUNDLE_INFO = {
  runner: {bundle: 'WebDriverAgentRunner-Runner.app', productDir: 'Debug-iphonesimulator'},
  tv_runner: {bundle: 'WebDriverAgentRunner_tvOS-Runner.app', productDir: 'Debug-appletvsimulator'},
  watch_runner: {bundle: 'WebDriverAgentRunner_watchOS-Runner.app', productDir: 'Debug-watchsimulator'},
};

const TARGETS = ['runner', 'tv_runner', 'watch_runner'];
const SDKS = ['sim', 'tv_sim', 'watch_sim'];

/**
 * The environment for the `Scripts/build.sh` child process.
 *
 * `teen_process` replaces the child environment wholesale when `env` is given, so this is the
 * complete set `build.sh` may depend on. Only what the build genuinely needs is forwarded: build.sh
 * reads a large number of ambient variables (`ACTION` decides the whole dispatch, `DEST` plus the
 * `*_MODEL`/`*_VERSION` names pick a Simulator destination, `CODE_SIGN`, `ARCHS` and `EXTRA_XC_ARGS`
 * are appended to the `xcodebuild` command line), and inheriting them would let leftover values in
 * the caller's shell change what gets built - or whether anything is built at all - while this
 * script still reported success and zipped whatever an earlier build had left behind.
 *
 * @param {string} target The `build.sh` build target, e.g. `watch_runner`
 * @param {string} sdk The `build.sh` SDK name, e.g. `watch_sim`
 * @returns {NodeJS.ProcessEnv}
 */
function buildScriptEnv(target, sdk) {
  const {PATH, HOME, TMPDIR, DEVELOPER_DIR} = process.env;
  return {
    PATH,
    HOME,
    TMPDIR,
    ...(DEVELOPER_DIR ? {DEVELOPER_DIR} : {}),
    TARGET: target,
    SDK: sdk,
    DERIVED_DATA_PATH,
  };
}

/**
 * Build WebDriverAgent and pack the app bundle into a zip archive.
 *
 * @param {string} [xcodeVersion] Xcode version to include in archive name.
 */
async function buildWebDriverAgent(xcodeVersion) {
  const target = process.env.TARGET;
  const sdk = process.env.SDK;

  if (!TARGETS.includes(target)) {
    throw Error(`Please set TARGETS environment variable from the supported targets ${JSON.stringify(TARGETS)}`);
  }

  if (!SDKS.includes(sdk)) {
    throw Error(`Please set SDK environment variable from the supported SDKs ${JSON.stringify(SDKS)}`);
  }

  LOG.info(`Cleaning ${DERIVED_DATA_PATH} if exists`);
  try {
    await exec('xcodebuild', ['clean', '-derivedDataPath', DERIVED_DATA_PATH, '-scheme', 'WebDriverAgentRunner'], {
      cwd: ROOT_DIR,
    });
  } catch {}

  // Get Xcode version
  xcodeVersion = xcodeVersion || (await xcode.getVersion());
  LOG.info(`Building the '${target}' target for the '${sdk}' sdk using Xcode version '${xcodeVersion}'`);

  // Clean and build. `exec` replaces the child environment wholesale once `env` is set, so the
  // variables build.sh actually needs are listed explicitly: PATH so it can resolve xcodebuild,
  // DEVELOPER_DIR so the /usr/bin shim picks a real Xcode instead of the Command Line Tools copy
  // (which refuses to build), and HOME/TMPDIR for Xcode's own preferences and provisioning lookup.
  // Everything else is deliberately dropped: build.sh dispatches on an ambient ACTION
  // (`ACTION=analyze ./Scripts/build.sh` is the documented local flow, so a leftover value would
  // silently turn this build into a static-analysis run or a fastlane device test while the
  // bundler still reported success), selects a Simulator from DEST/IPHONE_MODEL/IOS_VERSION/
  // TV_MODEL/TV_VERSION/WATCH_MODEL/WATCH_VERSION, and forwards CODE_SIGN/ARCHS/EXTRA_XC_ARGS
  // straight to xcodebuild.
  try {
    await exec('/bin/bash', ['./Scripts/build.sh'], {
      env: buildScriptEnv(target, sdk),
      cwd: ROOT_DIR,
    });
  } catch (e) {
    LOG.error(`===FAILED TO BUILD FOR ${xcodeVersion}`);
    LOG.error(e.stderr);
    throw e;
  }

  const {bundle, productDir} = BUNDLE_INFO[target];
  const bundle_path = path.join(DERIVED_DATA_PATH, 'Build', 'Products', productDir);

  const zipName = `WebDriverAgentRunner-Runner-${sdk}-${xcodeVersion}.zip`;
  LOG.info(`Creating ${zipName} which includes ${bundle}`);
  const appBundleZipPath = path.join(ROOT_DIR, zipName);
  await fs.rimraf(appBundleZipPath);
  LOG.info(`Created './${zipName}'`);
  try {
    await exec('xattr', ['-cr', bundle], {cwd: bundle_path});
    await exec('zip', ['-qr', appBundleZipPath, bundle], {cwd: bundle_path});
  } catch (e) {
    LOG.error(`===FAILED TO ZIP ARCHIVE`);
    LOG.error(e.stderr);
    throw e;
  }
  LOG.info(`Zip bundled at "${appBundleZipPath}"`);
}

if (isMainModule) {
  try {
    await buildWebDriverAgent();
  } catch (e) {
    LOG.error(e);
    process.exit(1);
  }
}

export default buildWebDriverAgent;
