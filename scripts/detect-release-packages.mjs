#!/usr/bin/env node
/* eslint-disable no-console */
// Detects which publishable packages the release will publish, so release.yml can skip the
// expensive native prebuilds (tuntap, coresim) when those packages aren't part of it.
// Union of: packages lerna would bump (skipped when RECOVER_MISSING_ONLY=true; includes private ones,
// e.g. ios-uicatalog, which still trigger the UIKitCatalog app release) and public packages whose
// current version is missing on npm (what the recovery paths publish).
// Writes `packages` (JSON names), `any`, `tuntap` and `coresim` to $GITHUB_OUTPUT.
import {execFile} from 'node:child_process';
import {appendFile, readFile, readdir} from 'node:fs/promises';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const PREBUILT = {tuntap: 'appium-ios-tuntap', coresim: '@appium/coresim'};

async function listPackages() {
  const dirs = await readdir('packages');
  const manifests = await Promise.all(
    dirs.map((d) => readFile(`packages/${d}/package.json`, 'utf8').then(JSON.parse, () => null)),
  );
  return manifests.filter((m) => m?.name && m.version);
}

async function lernaChanged() {
  try {
    const {stdout} = await execFileAsync('node', ['scripts/lerna-skip-dev-deps.mjs', 'changed', '--json']);
    return JSON.parse(stdout).map((p) => p.name);
  } catch (err) {
    // lerna exits non-zero when nothing changed
    if (/No changed packages/i.test(`${err.stderr}`)) {
      return [];
    }
    throw err;
  }
}

async function isMissingOnNpm({name, version}) {
  try {
    await execFileAsync('npm', ['view', `${name}@${version}`, 'version']);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const packages = await listPackages();
  const changed = process.env.RECOVER_MISSING_ONLY === 'true' ? [] : await lernaChanged();
  const npmPackages = packages.filter((p) => !p.private);
  const missing = (await Promise.all(npmPackages.map(async (p) => ((await isMissingOnNpm(p)) ? p.name : null)))).filter(
    Boolean,
  );
  const names = new Set([...changed, ...missing].filter((n) => packages.some((p) => p.name === n)));

  const outputs = {
    packages: JSON.stringify([...names]),
    any: String(names.size > 0),
    ...Object.fromEntries(Object.entries(PREBUILT).map(([key, name]) => [key, String(names.has(name))])),
  };
  console.log('Packages to release:', outputs.packages);
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, lines.join(''));
  } else {
    process.stdout.write(lines.join(''));
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
