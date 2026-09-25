import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {after, before, describe, it} from 'node:test';

import {CoreDeviceError, type CoreDeviceFileService} from '../../src/index.js';
import * as Services from '../../src/services.js';
import {requireDeviceUdid} from './helpers/device.js';

/**
 * Integration tests for the CoreDevice file service
 * (`com.apple.coredevice.fileservice.control` / `.data`).
 *
 * Requires a physical iOS device with a running tunnel registry. Set the UDID
 * env var to the target device, and optionally FILE_SERVICE_BUNDLE_ID to an
 * installed app whose data container is used (defaults to the
 * WebDriverAgent runner).
 */
describe('CoreDeviceFileService', {timeout: 120000}, function () {
  const bundleId = process.env.FILE_SERVICE_BUNDLE_ID?.trim() || 'com.facebook.WebDriverAgentRunner.xctrunner';
  let udid: string;
  let service: CoreDeviceFileService | null = null;
  let tmpDir: string;

  before(async function () {
    udid = requireDeviceUdid();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-service-'));
    service = await Services.startCoreDeviceFileService(udid, {
      domain: 'appDataContainer',
      identifier: bundleId,
      username: 'mobile',
    });
  });

  after(async function () {
    try {
      await service?.close();
    } catch {
      // Ignore cleanup errors in tests
    }
    await fs.promises.rm(tmpDir, {recursive: true, force: true});
  });

  it('lists the app data container recursively with metadata', async function () {
    const entries = await service!.listDirectory('.', {recursive: true});
    const topLevel = entries.filter((e) => e.isDirectory && !e.path.includes('/')).map((e) => e.path);
    for (const name of ['Documents', 'Library', 'tmp']) {
      assert.ok(topLevel.includes(name), `expected '${name}' in ${JSON.stringify(topLevel)}`);
    }
    for (const entry of entries) {
      assert.ok(entry.metadata, `metadata for '${entry.path}'`);
      assert.ok(entry.metadata.modifiedAt instanceof Date);
    }
  });

  it('lists only direct children unless recursive', async function () {
    const children = await service!.listDirectory();
    const all = await service!.listDirectory('.', {recursive: true});
    assert.ok(children.length > 0 && children.length < all.length);
    assert.ok(children.every((e) => !e.path.includes('/')));
    assert.deepStrictEqual(
      children.map((e) => e.path).sort(),
      all
        .filter((e) => !e.path.includes('/'))
        .map((e) => e.path)
        .sort(),
    );
  });

  it('lists a subdirectory relative to itself', async function () {
    const entries = await service!.listDirectory('Library', {recursive: true});
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => !e.path.startsWith('Library/')));
  });

  it('lists a regular file as its own path in both modes', async function (t) {
    const file = (await service!.listDirectory('.', {recursive: true})).find((e) => !e.isDirectory);
    if (!file) {
      t.skip(`'${bundleId}' has no files in its data container`);
      return;
    }
    for (const recursive of [false, true]) {
      assert.deepStrictEqual(await service!.listFilePaths(file.path, {recursive}), [file.path]);
      assert.deepStrictEqual(
        (await service!.listDirectory(file.path, {recursive})).map((e) => e.path),
        [file.path],
      );
    }
  });

  it('keeps the session across several requests', async function () {
    for (let i = 0; i < 3; i++) {
      const paths = await service!.listFilePaths('.', {recursive: true});
      const files = (await service!.listDirectory('.', {recursive: true}))
        .filter((e) => !e.isDirectory)
        .map((e) => e.path);
      assert.deepStrictEqual([...paths].sort(), [...files].sort());
    }
  });

  it('downloads a file to a path and to a stream', async function (t) {
    const file = (await service!.listDirectory('.', {recursive: true})).find((e) => !e.isDirectory);
    if (!file) {
      t.skip(`'${bundleId}' has no files in its data container`);
      return;
    }

    const destination = path.join(tmpDir, 'pulled');
    const metadata = await service!.pull(file.path, destination);
    const onDisk = await fs.promises.readFile(destination);
    assert.strictEqual(onDisk.length, file.metadata!.size);
    assert.strictEqual(metadata.size, file.metadata!.size);

    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    await service!.pull(file.path, stream);
    assert.deepStrictEqual(Buffer.concat(chunks), onDisk);
  });

  it('creates and removes a directory tree', async function () {
    const root = `tmp/file-service-spec-${Date.now()}`;
    await service!.mkdir(root);
    await service!.mkdir(`${root}/a`);
    await service!.mkdir(`${root}/a/b`);
    assert.deepStrictEqual((await service!.listDirectory(root, {recursive: true})).map((e) => e.path).sort(), [
      'a',
      'a/b',
    ]);

    await assert.rejects(service!.rm(root), /the directory is not empty/);
    await service!.rm(`${root}/a/b`);
    await service!.rm(root, {recursive: true});

    await assert.rejects(service!.listDirectory(root), CoreDeviceError);
  });

  it('uploads files and reads them back', async function () {
    const root = `tmp/file-service-spec-${Date.now()}`;
    const payload = Buffer.from(Array.from({length: 5000}, (_, i) => `line ${i}`).join('\n'));
    try {
      await service!.push(payload, `${root}/nested/data.txt`);
      await service!.push(Buffer.alloc(0), `${root}/empty.txt`);
      const pulled = path.join(tmpDir, 'pushed');
      await service!.pull(`${root}/nested/data.txt`, pulled);
      assert.deepStrictEqual(await fs.promises.readFile(pulled), payload);
      const entries = await service!.listDirectory(root, {recursive: true});
      assert.strictEqual(entries.find((e) => e.path === 'empty.txt')?.metadata?.size, 0);
    } finally {
      await service!.rm(root, {recursive: true});
    }
  });

  it('renames a directory', async function () {
    const root = `tmp/file-service-spec-${Date.now()}`;
    await service!.mkdir(root);
    await service!.mkdir(`${root}/old`);
    try {
      await service!.rename(`${root}/old`, `${root}/new`);
      assert.deepStrictEqual(
        (await service!.listDirectory(root)).map((e) => e.path),
        ['new'],
      );
      await assert.rejects(service!.rename(`${root}/missing`, `${root}/x`), CoreDeviceError);
    } finally {
      await service!.rm(root, {recursive: true});
    }
  });

  it('reports a missing file as a CoreDeviceError', async function () {
    const destination = path.join(tmpDir, 'missing');
    await assert.rejects(service!.pull('tmp/does-not-exist', destination), CoreDeviceError);
    assert.strictEqual(fs.existsSync(destination), false);
  });

  it('lists XCTest attachments in the testmanagerd container', async function () {
    const testmanagerd = await Services.startCoreDeviceFileService(udid, {
      domain: 'appDataContainer',
      identifier: 'com.apple.testmanagerd',
    });
    try {
      const entries = await testmanagerd.listDirectory('tmp/Attachments');
      assert.ok(Array.isArray(entries));
    } catch (error) {
      // The directory exists only after testmanagerd has stored an attachment.
      assert.ok(error instanceof CoreDeviceError);
    } finally {
      await testmanagerd.close();
    }
  });

  it('lists system crash logs', async function () {
    const crashLogs = await Services.startCoreDeviceFileService(udid, {domain: 'systemCrashLogs'});
    try {
      const entries = await crashLogs.listDirectory();
      assert.ok(Array.isArray(entries));
    } finally {
      await crashLogs.close();
    }
  });
});
