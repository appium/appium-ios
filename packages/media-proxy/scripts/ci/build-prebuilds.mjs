#!/usr/bin/env node
// prebuildify for the addon, then bundle the matching FFmpeg libs. Forwards args (e.g. `--arch x64`) to prebuildify.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

import {run} from './run.mjs';

const BUNDLE_SCRIPT = fileURLToPath(new URL('./bundle-libs.mjs', import.meta.url));

/** @param {string[]} args */
function targetArch(args) {
  const flag = args.indexOf('--arch');
  return flag >= 0 ? args[flag + 1] : process.arch;
}

async function main() {
  const args = process.argv.slice(2);
  const prebuildify = createRequire(import.meta.url).resolve('prebuildify/bin.js');
  await run(process.execPath, [prebuildify, '--napi', '--strip', ...args]);
  await run(process.execPath, [BUNDLE_SCRIPT], {env: {...process.env, TARGET_ARCH: targetArch(args)}});
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
