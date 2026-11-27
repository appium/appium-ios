import assert from 'node:assert/strict';
import {type TestContext, describe, it} from 'node:test';

import {CoreDeviceError} from '../../src/services/ios/core-device/core-device-service.js';
import type {XCTestAttachment as XCTestAttachmentType} from '../../src/services/ios/testmanagerd/xctest-attachment.js';
import {mockImport} from '../helpers/mock-module.js';

const UDID = '00008030-000A49391460202E';
const UUID = 'BE70429E-74DD-4849-898D-DD587214BA96';
const OTHER = '956233E5-1A74-48C9-92C1-818E511CEF26';

/** Error the device reports when a file or directory does not exist. */
const notFoundError = () =>
  new CoreDeviceError('not found', {
    EncodedError: {ErrorCode: 7000, NSUnderlyingError: {ErrorCode: 2, ErrorDomain: 'NSPOSIXErrorDomain'}},
  });

interface Options {
  /** Directory contents; a directory that is absent does not exist on the device. */
  files?: Record<string, string[]>;
  startError?: Error;
  listError?: Error;
  rmError?: Error;
}

async function setup(t: TestContext, {files = {}, startError, listError, rmError}: Options = {}) {
  const removed: string[] = [];
  const state = {started: 0, closed: false};
  const fileService = {
    listFilePaths: async (dir: string) => {
      if (listError) {
        throw listError;
      }
      if (!(dir in files)) {
        throw notFoundError();
      }
      return files[dir];
    },
    rm: async (p: string) => {
      if (rmError) {
        throw rmError;
      }
      removed.push(p);
    },
    close: async () => {
      state.closed = true;
    },
  };
  const {XCTestAttachment} = await mockImport<{XCTestAttachment: typeof XCTestAttachmentType}>(
    t,
    '../../src/services/ios/testmanagerd/xctest-attachment.js',
    import.meta.url,
    {
      '../../src/services.js': {
        startCoreDeviceFileService: async () => {
          state.started++;
          if (startError) {
            throw startError;
          }
          return fileService;
        },
      },
    },
  );
  return {XCTestAttachment, removed, state};
}

describe('XCTestAttachment.delete', function () {
  it('removes the attachment', async function (t) {
    const {XCTestAttachment, removed, state} = await setup(t, {
      files: {'tmp/Attachments': [OTHER, UUID.toLowerCase()]},
    });
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, [`tmp/Attachments/${UUID.toLowerCase()}`]);
    assert.ok(state.closed);
  });

  it('removes nothing if the attachment does not exist', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {files: {'tmp/Attachments': [OTHER]}});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, []);
  });

  it('removes the attachment from the legacy directory', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {files: {Attachments: [UUID]}});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, [`Attachments/${UUID}`]);
  });

  it('removes the attachment from both directories', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {files: {'tmp/Attachments': [UUID], Attachments: [UUID]}});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, [`tmp/Attachments/${UUID}`, `Attachments/${UUID}`]);
  });

  it('ignores an attachment removed in the meantime', async function (t) {
    const {XCTestAttachment, state} = await setup(t, {files: {'tmp/Attachments': [UUID]}, rmError: notFoundError()});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.ok(state.closed);
  });

  it('fails if the listing fails for another reason than a missing directory', async function (t) {
    const {XCTestAttachment, state} = await setup(t, {listError: new Error('permission denied')});
    await assert.rejects(new XCTestAttachment(UDID).delete([UUID]), /permission denied/);
    assert.ok(state.closed);
  });

  it('fails and closes the file service if the removal fails', async function (t) {
    const {XCTestAttachment, state} = await setup(t, {
      files: {'tmp/Attachments': [UUID]},
      rmError: new Error('permission denied'),
    });
    await assert.rejects(new XCTestAttachment(UDID).delete([UUID]), /permission denied/);
    assert.ok(state.closed);
  });

  it('fails if the file service is unavailable', async function (t) {
    const {XCTestAttachment} = await setup(t, {startError: new Error('no tunnel')});
    await assert.rejects(new XCTestAttachment(UDID).delete([UUID]), /no tunnel/);
  });

  it('fails without opening the file service for an invalid UUID', async function (t) {
    const {XCTestAttachment, state} = await setup(t);
    await assert.rejects(new XCTestAttachment(UDID).delete(['not-a-uuid']), /UUID/);
    assert.equal(state.started, 0);
  });
});
