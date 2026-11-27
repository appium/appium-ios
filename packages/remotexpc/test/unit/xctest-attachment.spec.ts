import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {XCTestAttachment as XCTestAttachmentType} from '../../src/services/ios/testmanagerd/xctest-attachment.js';
import {mockImport} from '../helpers/mock-module.js';

const UDID = '00008030-000A49391460202E';
const UUID = 'BE70429E-74DD-4849-898D-DD587214BA96';
const OTHER = '956233E5-1A74-48C9-92C1-818E511CEF26';

interface Setup {
  XCTestAttachment: typeof XCTestAttachmentType;
  removed: string[];
  state: State;
}

interface State {
  fileServiceError?: Error;
  rmError?: Error;
  closed: boolean;
}

async function setup(t: any, files: Record<string, string[]>, state: State = {closed: false}): Promise<Setup> {
  const removed: string[] = [];
  const testmanagerd = {
    makeChannel: async () => ({getCode: () => 1}),
    sendMessage: async () => {},
    recvPlist: async () => [[true, []]],
    close: async () => {},
  };
  const fileService = {
    listFilePaths: async (dir: string) => {
      if (!(dir in files)) {
        throw new Error('no such directory');
      }
      return files[dir];
    },
    rm: async (p: string) => {
      if (state.rmError) {
        throw state.rmError;
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
        startTestmanagerdService: async () => testmanagerd,
        startCoreDeviceFileService: async () => {
          if (state.fileServiceError) {
            throw state.fileServiceError;
          }
          return fileService;
        },
      },
    },
  );
  return {XCTestAttachment, removed, state};
}

describe('XCTestAttachment.delete', function () {
  it('removes the files testmanagerd kept', async function (t) {
    const {XCTestAttachment, removed, state} = await setup(t, {
      'tmp/Attachments': [OTHER, UUID.toLowerCase()],
    });
    const result = await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(result, [true, []]);
    assert.deepEqual(removed, [`tmp/Attachments/${UUID.toLowerCase()}`]);
    assert.ok(state.closed);
  });

  it('removes nothing if testmanagerd deleted the files', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {'tmp/Attachments': [OTHER]});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, []);
  });

  it('also checks the legacy directory', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {Attachments: [UUID]});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, [`Attachments/${UUID}`]);
  });

  it('does not fail if the file service is unavailable', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {}, {closed: false, fileServiceError: new Error('no tunnel')});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, []);
  });

  it('removes the file from both directories', async function (t) {
    const {XCTestAttachment, removed} = await setup(t, {'tmp/Attachments': [UUID], Attachments: [UUID]});
    await new XCTestAttachment(UDID).delete([UUID]);
    assert.deepEqual(removed, [`tmp/Attachments/${UUID}`, `Attachments/${UUID}`]);
  });

  it('fails and closes the file service if the removal fails', async function (t) {
    const {XCTestAttachment, state} = await setup(
      t,
      {'tmp/Attachments': [UUID]},
      {closed: false, rmError: new Error('permission denied')},
    );
    await assert.rejects(new XCTestAttachment(UDID).delete([UUID]), /permission denied/);
    assert.ok(state.closed);
  });

  it('fails before opening the file service for an invalid UUID', async function (t) {
    const {XCTestAttachment, state} = await setup(t, {'tmp/Attachments': [UUID]});
    await assert.rejects(new XCTestAttachment(UDID).delete(['not-a-uuid']));
    assert.ok(!state.closed);
  });
});
