import {randomUUID} from 'node:crypto';
import {rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {NativeSimctl} from '../native-simctl.js';
import {runCatchingAsync} from '../utils/index.js';

declare module '../native-simctl.js' {
  interface NativeSimctl {
    addCertificate(udid: string, cert: string | Buffer): Promise<void>;
    addRootCertificate(udid: string, cert: string | Buffer): Promise<void>;
    resetKeychain(udid: string): Promise<void>;
  }
}

/**
 * Adds a certificate to the given device's keychain (not trusted as root).
 *
 * @param udid — UDID of the target device
 * @param cert — path to a `.cert`/`.pem` file on disk, or the raw certificate content
 */
export async function addCertificate(this: NativeSimctl, udid: string, cert: string | Buffer): Promise<void> {
  const {path: certPath, cleanup} = await resolveCertPath(cert);
  try {
    return await runCatchingAsync(async () => (await this._findDevice(udid)).addCertificate(certPath, false));
  } finally {
    await cleanup();
  }
}

/**
 * Adds a certificate to the given device's Trusted Root Store.
 *
 * @param udid — UDID of the target device
 * @param cert — path to a `.cert`/`.pem` file on disk, or the raw certificate content
 */
export async function addRootCertificate(this: NativeSimctl, udid: string, cert: string | Buffer): Promise<void> {
  const {path: certPath, cleanup} = await resolveCertPath(cert);
  try {
    return await runCatchingAsync(async () => (await this._findDevice(udid)).addCertificate(certPath, true));
  } finally {
    await cleanup();
  }
}

/** @param udid — UDID of the device whose keychain should be reset */
export async function resetKeychain(this: NativeSimctl, udid: string): Promise<void> {
  return runCatchingAsync(async () => (await this._findDevice(udid)).resetKeychain());
}

/**
 * The native call only accepts a file path — a `Buffer` is written to a throwaway temp file first,
 * cleaned up by the caller once done.
 */
async function resolveCertPath(cert: string | Buffer): Promise<{path: string; cleanup: () => Promise<void>}> {
  if (typeof cert === 'string') {
    return {path: cert, cleanup: async () => {}};
  }
  const tmpPath = path.join(os.tmpdir(), `${randomUUID()}.pem`);
  await writeFile(tmpPath, cert);
  return {path: tmpPath, cleanup: () => rm(tmpPath, {force: true})};
}
