#!/usr/bin/env node
/* eslint-disable no-console */
// Copies the FFmpeg runtime libs next to the addon (prebuilds/<platform>-<arch>/), where the
// addon's rpath ($ORIGIN / @loader_path) and the Windows DLL search order find them.
// Real files only: npm drops symlinks from tarballs.
import {execFileSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = `${process.platform}-${process.env.TARGET_ARCH ?? process.arch}`;
const source = process.env.FFMPEG_PREFIX ?? join(root, 'third_party', 'ffmpeg', target);
// `--dest <dir>` bundles next to a dev build (build/Release) instead of into prebuilds/.
const destFlag = process.argv.indexOf('--dest');
const dest = destFlag >= 0 ? resolve(process.argv[destFlag + 1]) : join(root, 'prebuilds', target);

if (!existsSync(source)) {
  console.error(`No FFmpeg build for ${target} in ${source}; run scripts/build-ffmpeg.sh first.`);
  process.exit(1);
}
mkdirSync(dest, {recursive: true});

// Versioned runtime names only (libavcodec.62.dylib, libavcodec.so.62, avcodec-62.dll), not dev symlinks.
/** @type {Record<string, {dir: string, pattern: RegExp}>} */
const RUNTIME_BY_PLATFORM = {
  darwin: {dir: 'lib', pattern: /^lib(avcodec|avutil|swscale)\.\d+\.dylib$/},
  linux: {dir: 'lib', pattern: /^lib(avcodec|avutil|swscale)\.so\.\d+$/},
  win32: {dir: 'bin', pattern: /^(avcodec|avutil|swscale)-\d+\.dll$/},
};
const RUNTIME = RUNTIME_BY_PLATFORM[process.platform];
if (!RUNTIME) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

const libs = readdirSync(join(source, RUNTIME.dir)).filter((name) => RUNTIME.pattern.test(name));
if (libs.length !== 3) {
  console.error(
    `Expected avcodec, avutil and swscale in ${join(source, RUNTIME.dir)}, found: ${libs.join(', ') || 'none'}`,
  );
  process.exit(1);
}
for (const name of libs) {
  const out = join(dest, name);
  copyFileSync(join(source, RUNTIME.dir, name), out); // follows symlinks
  if (process.platform === 'darwin') {
    execFileSync('strip', ['-x', out]);
    execFileSync('codesign', ['--force', '--sign', '-', out]); // strip invalidates the signature
  } else if (process.platform === 'linux') {
    execFileSync('strip', ['--strip-unneeded', out]);
  }
  console.log(`bundled ${name}`);
}

// Ship the exact build recipe next to the binaries (LGPL: users can rebuild and relink).
const recipe = join(source, '.built-info');
if (existsSync(recipe)) {
  copyFileSync(recipe, join(dest, 'ffmpeg-build-info.txt'));
}
console.log(
  `FFmpeg ${readFileSync(join(root, 'scripts', 'build-ffmpeg.sh'), 'utf8').match(/FFMPEG_VERSION:-([\d.]+)/)?.[1]} libs in ${dest}`,
);
