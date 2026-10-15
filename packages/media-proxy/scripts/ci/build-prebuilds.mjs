#!/usr/bin/env node
// prebuildify for the addon, then bundle the matching FFmpeg libs. Accepts `--arch <x64|arm64>`
// (cross-builds on macOS) and forwards it to both steps.
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const archFlag = args.indexOf('--arch');
const arch = archFlag >= 0 ? args[archFlag + 1] : process.arch;
const prebuildify = createRequire(import.meta.url).resolve('prebuildify/bin.js');

execFileSync(process.execPath, [prebuildify, '--napi', '--strip', ...args], {stdio: 'inherit'});
execFileSync(process.execPath, [fileURLToPath(new URL('./bundle-libs.mjs', import.meta.url))], {
  stdio: 'inherit',
  env: {...process.env, TARGET_ARCH: arch},
});
