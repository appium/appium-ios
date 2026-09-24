import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {CoreDeviceError} from '../../../src/index.js';
import {
  assertSuccessfulReply,
  parseFileNodes,
  parseRetrievedFileMetadata,
} from '../../../src/services/ios/file-service/replies.js';

const CONTAINER = 'file:///private/var/mobile/Containers/Data/Application/A735498E/';

function node(relative: string, resources: number, metadata: Record<string, number>): Record<string, unknown> {
  return {
    url: {base: {relative: CONTAINER}, relative},
    metadata: {...metadata, extendedAttributes: {}},
    sessionRootPath: CONTAINER,
    resources,
  };
}

describe('file service replies', function () {
  describe('parseFileNodes', function () {
    it('parses directory and file nodes', function () {
      const entries = parseFileNodes([
        node('Library/', 13, {lastModTime: 1787305093, permissions: 493, size: 192, ownerUid: 501, ownerGid: 501}),
        node('Library/Saved%20Application%20State/data.data', 12, {
          lastModTime: 1790247630,
          permissions: 420,
          size: 756,
          ownerUid: 501,
          ownerGid: 501,
        }),
      ] as any);

      assert.deepStrictEqual(entries, [
        {
          path: 'Library',
          isDirectory: true,
          metadata: {
            size: 192,
            permissions: 0o755,
            ownerUid: 501,
            ownerGid: 501,
            modifiedAt: new Date(1787305093 * 1000),
          },
        },
        {
          path: 'Library/Saved Application State/data.data',
          isDirectory: false,
          metadata: {
            size: 756,
            permissions: 0o644,
            ownerUid: 501,
            ownerGid: 501,
            modifiedAt: new Date(1790247630 * 1000),
          },
        },
      ]);
    });

    it('treats a plain path string as a file without metadata', function () {
      assert.deepStrictEqual(parseFileNodes(['Library/Caches/a.dyld4']), [
        {path: 'Library/Caches/a.dyld4', isDirectory: false},
      ]);
    });

    it('skips malformed nodes and non-array input', function () {
      assert.deepStrictEqual(parseFileNodes([{metadata: {}}, 5]), []);
      assert.deepStrictEqual(parseFileNodes(undefined), []);
    });
  });

  describe('assertSuccessfulReply', function () {
    it('returns a successful reply', function () {
      const reply = {NewSessionID: 'ABC', Response: 1};
      assert.strictEqual(assertSuccessfulReply('CreateSession', reply), reply);
    });

    it('throws the error the device reported', function () {
      const reply = {
        EncodedError: {
          ErrorCode: 11007,
          NSLocalizedDescription: "Access restricted: '/x/Attachments' is outside the allowed container directories",
          ErrorDomain: 'com.apple.dt.remoteservices.error',
        },
        Error: "Access restricted: '/x/Attachments' is outside the allowed container directories",
        Response: 3,
      };
      assert.throws(
        () => assertSuccessfulReply('ListDirectoryFileNodes', reply),
        (error: unknown) =>
          error instanceof CoreDeviceError &&
          error.message ===
            "File service 'ListDirectoryFileNodes' failed: Access restricted: '/x/Attachments' is outside the " +
              'allowed container directories [com.apple.dt.remoteservices.error 11007]' &&
          error.response === reply,
      );
    });

    it('throws for an error response without details', function () {
      assert.throws(() => assertSuccessfulReply('RetrieveFile', {Response: 3}), /unknown error \[unknown\]/);
    });
  });

  it('parseRetrievedFileMetadata strips the file type bits', function () {
    const metadata = parseRetrievedFileMetadata(
      {
        FileOwnerGroupID: 501,
        NewFileID: 1,
        FileCreationTime: 0,
        FileOwnerUserID: 501,
        Response: 1,
        FilePermissions: 0o100400,
        FileLastModificationTime: 1789544015,
      },
      7016,
    );
    assert.deepStrictEqual(metadata, {
      size: 7016,
      permissions: 0o400,
      ownerUid: 501,
      ownerGid: 501,
      modifiedAt: new Date(1789544015 * 1000),
    });
  });
});
