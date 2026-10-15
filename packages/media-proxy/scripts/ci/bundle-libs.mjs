#!/usr/bin/env node
/* eslint-disable no-console */
// Copies the FFmpeg runtime libs next to the addon, where its rpath and the Windows DLL search find them.
// Real files only (npm drops symlinks). `--dest <dir>` targets a dev build instead of prebuilds/.
import {access, copyFile, mkdir, readdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

import {run} from './run.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Versioned runtime names only (libavcodec.62.dylib, libavcodec.so.62, avcodec-62.dll), not dev symlinks.
/** @type {Record<string, {dir: string, pattern: RegExp}>} */
const RUNTIME_BY_PLATFORM = {
  darwin: {dir: 'lib', pattern: /^lib(avcodec|avutil|swscale)\.\d+\.dylib$/},
  linux: {dir: 'lib', pattern: /^lib(avcodec|avutil|swscale)\.so\.\d+$/},
  win32: {dir: 'bin', pattern: /^(avcodec|avutil|swscale)-\d+\.dll$/},
};
const EXPECTED_LIB_COUNT = 3;

/** @param {string} path */
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

/** @param {{dest?: string}} options */
function resolvePaths({dest}) {
  const target = `${process.platform}-${process.env.TARGET_ARCH ?? process.arch}`;
  return {
    target,
    source: process.env.FFMPEG_PREFIX ?? join(PACKAGE_ROOT, 'third_party', 'ffmpeg', target),
    dest: dest ? resolve(dest) : join(PACKAGE_ROOT, 'prebuilds', target),
  };
}

/** @param {string} source */
async function findRuntimeLibs(source) {
  const runtime = RUNTIME_BY_PLATFORM[process.platform];
  if (!runtime) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  const dir = join(source, runtime.dir);
  const libs = (await readdir(dir)).filter((name) => runtime.pattern.test(name));
  if (libs.length !== EXPECTED_LIB_COUNT) {
    throw new Error(`Expected avcodec, avutil and swscale in ${dir}, found: ${libs.join(', ') || 'none'}`);
  }
  return libs.map((name) => ({name, path: join(dir, name)}));
}

/**
 * @param {{name: string, path: string}} lib
 * @param {string} dest
 */
async function bundleLib({name, path}, dest) {
  const out = join(dest, name);
  await copyFile(path, out); // follows symlinks
  if (process.platform === 'darwin') {
    await run('strip', ['-x', out]);
    await run('codesign', ['--force', '--sign', '-', out]); // strip invalidates the signature
  } else if (process.platform === 'linux') {
    await run('strip', ['--strip-unneeded', out]);
  }
  console.log(`bundled ${name}`);
}

async function main() {
  const {values} = parseArgs({options: {dest: {type: 'string'}}});
  const {target, source, dest} = resolvePaths(values);
  if (!(await exists(source))) {
    throw new Error(`No FFmpeg build for ${target} in ${source}; run scripts/ci/build-ffmpeg.sh first.`);
  }
  const libs = await findRuntimeLibs(source);
  await mkdir(dest, {recursive: true});
  for (const lib of libs) {
    await bundleLib(lib, dest);
  }
  // The exact configure line ships with the binaries so the LGPL libs can be rebuilt and relinked.
  const recipe = join(source, '.built-info');
  if (await exists(recipe)) {
    await copyFile(recipe, join(dest, 'ffmpeg-build-info.txt'));
  }
  console.log(`FFmpeg libs for ${target} in ${dest}`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
