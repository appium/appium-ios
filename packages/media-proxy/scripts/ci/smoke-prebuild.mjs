#!/usr/bin/env node
/* eslint-disable no-console */
// Loads the packaged prebuild exactly as shipped (nothing from build/ or third_party/ is on its search path).
import {readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REQUIRED = {decoders: 'hevc', encoders: 'mjpeg'};

async function main() {
  const {values} = parseArgs({options: {arch: {type: 'string', default: process.arch}}});
  if (values.arch !== process.arch) {
    console.log(`Skipping the load check: ${values.arch} prebuild on a ${process.arch} host.`);
    return;
  }
  const dir = join(PACKAGE_ROOT, 'prebuilds', `${process.platform}-${values.arch}`);
  const file = (await readdir(dir)).find((name) => name.endsWith('.node'));
  if (!file) {
    throw new Error(`No .node file in ${dir}`);
  }
  const addon = createRequire(import.meta.url)(join(dir, file));
  const caps = addon.capabilities();
  for (const [kind, codec] of Object.entries(REQUIRED)) {
    if (!caps[kind].includes(codec)) {
      throw new Error(`The prebuild lacks the ${codec} ${kind.slice(0, -1)}: ${JSON.stringify(caps)}`);
    }
  }
  console.log(`Loaded ${join(dir, file)}: ${JSON.stringify(caps)}`);
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
