import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {CoreDeviceError, CoreDeviceFileService, type FileServiceSessionOptions} from '../../../src/index.js';
import {Http2Constants, XpcConstants} from '../../../src/lib/remote-xpc/constants.js';
import type {RemoteXpcMessageInfo} from '../../../src/lib/remote-xpc/remote-xpc-framed-transport.js';
import {decodeMessage} from '../../../src/lib/remote-xpc/xpc-protocol.js';
import type {XPCDictionary, XPCValue} from '../../../src/lib/types.js';
import {DATA_CHANNEL_MESSAGE_TYPE} from '../../../src/services/ios/file-service/constants.js';
import {decodeDataChannelHeader, encodeDataChannelHeader} from '../../../src/services/ios/file-service/data-channel.js';

interface SentMessage {
  streamId: number;
  flags: number;
  id: number;
  body: XPCDictionary;
}

const REPLY_FLAGS =
  XpcConstants.XPC_FLAGS_ALWAYS_SET | XpcConstants.XPC_FLAGS_DATA_PRESENT | XpcConstants.XPC_FLAGS_REPLY;
const PEER_REQUEST_FLAGS =
  XpcConstants.XPC_FLAGS_ALWAYS_SET | XpcConstants.XPC_FLAGS_DATA_PRESENT | XpcConstants.XPC_FLAGS_WANTING_REPLY;

/**
 * Fake control connection that behaves like `dtfileserviced`: it replies on the
 * reply channel, and delivers listings as its own requests (even ids) that must
 * be answered before it replies to the listing command.
 */
class FakeFileServiceTransport extends EventEmitter {
  isConnected = true;
  closeCalls = 0;
  readonly sent: SentMessage[] = [];
  listing: XPCValue[][] = [];
  fileReply: XPCDictionary = {NewFileID: 1, Response: 1, FilePermissions: 0o100644, FileLastModificationTime: 10};
  /** Sends a reply to an unrelated message id before replying to `CreateSession`. */
  sendStaleReply = false;
  /** Never answers listing commands. */
  isListingSilent = false;
  private peerMessageId = 2;
  private pendingListing: {id: number; acksLeft: number} | undefined;

  sendDataFrame(payload: Buffer, streamId = Http2Constants.ROOT_CHANNEL): void {
    const {message} = decodeMessage(payload);
    const sent = {streamId, flags: message.flags, id: Number(message.id), body: message.body as XPCDictionary};
    this.sent.push(sent);
    queueMicrotask(() => this.respond(sent));
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.isConnected = false;
  }

  requests(): SentMessage[] {
    return this.sent.filter(({streamId}) => streamId === Http2Constants.ROOT_CHANNEL);
  }

  private emitMessage(body: XPCDictionary, info: RemoteXpcMessageInfo): void {
    this.emit('message', body, info);
  }

  private reply(id: number, body: XPCDictionary): void {
    this.emitMessage(body, {streamId: Http2Constants.REPLY_CHANNEL, flags: REPLY_FLAGS, id: BigInt(id)});
  }

  private respond({streamId, id, body}: SentMessage): void {
    if (streamId === Http2Constants.REPLY_CHANNEL) {
      const pending = this.pendingListing;
      if (pending && --pending.acksLeft === 0) {
        this.pendingListing = undefined;
        this.reply(pending.id, {Response: 1});
      }
      return;
    }
    switch (body.Cmd) {
      case 'CreateSession':
        if (this.sendStaleReply) {
          this.reply(id + 100, {NewSessionID: 'STALE', Response: 1});
        }
        this.reply(id, {NewSessionID: 'SESSION-1', Response: 1});
        return;
      case 'ListDirectoryFileNodes':
      case 'RetrieveDirectoryList':
        if (this.isListingSilent) {
          return;
        }
        if (this.listing.length === 0) {
          this.reply(id, {Response: 1});
          return;
        }
        this.pendingListing = {id, acksLeft: this.listing.length};
        for (const fileList of this.listing) {
          const peerId = this.peerMessageId;
          this.peerMessageId += 2;
          this.emitMessage(
            {MessageUUID: body.MessageUUID, FileList: fileList},
            {streamId: Http2Constants.ROOT_CHANNEL, flags: PEER_REQUEST_FLAGS, id: BigInt(peerId)},
          );
        }
        return;
      case 'RetrieveFile':
        this.reply(id, this.fileReply);
        return;
      case 'EndSession':
        this.reply(id, {Response: 1});
        return;
      default:
        this.reply(id, {Error: 'The command provided by the client is not valid.', Response: 3});
    }
  }
}

class TestFileService extends CoreDeviceFileService {
  dataPort = 0;
  createTransportCalls = 0;
  /** Transports handed out after the first one, e.g. for reconnects. */
  readonly nextFakes: FakeFileServiceTransport[] = [];

  constructor(
    public fake: FakeFileServiceTransport,
    options: FileServiceSessionOptions = {domain: 'appDataContainer', identifier: 'com.example.app'},
  ) {
    super('test-udid', options);
  }

  protected async createTransport(): Promise<any> {
    // Yield once so concurrent callers overlap while a connection is being opened.
    await new Promise((resolve) => setImmediate(resolve));
    if (this.createTransportCalls++ > 0 && this.nextFakes.length > 0) {
      this.fake = this.nextFakes.shift()!;
    }
    return this.fake;
  }

  protected async resolveServiceAddress(): Promise<[string, number]> {
    return ['127.0.0.1', this.dataPort];
  }
}

function fileNode(relative: string, size: number): XPCDictionary {
  return {
    url: {base: {relative: 'file:///container/'}, relative},
    metadata: {lastModTime: 1, permissions: 0o644, size, ownerUid: 501, ownerGid: 501},
    resources: relative.endsWith('/') ? 13 : 12,
  };
}

describe('CoreDeviceFileService', function () {
  it('rejects an unknown domain', function () {
    for (const domain of ['bogus', 'toString']) {
      assert.throws(
        () => new TestFileService(new FakeFileServiceTransport(), {domain: domain as any}),
        /Unsupported file service domain/,
      );
    }
  });

  it('requires an identifier for app container domains', function () {
    for (const domain of ['appDataContainer', 'appGroupDataContainer'] as const) {
      assert.throws(
        () => new TestFileService(new FakeFileServiceTransport(), {domain}),
        new RegExp(`'${domain}' file service domain requires an identifier`),
      );
    }
    assert.doesNotThrow(() => new TestFileService(new FakeFileServiceTransport(), {domain: 'systemCrashLogs'}));
  });

  it('ignores a reply to another message', async function () {
    const fake = new FakeFileServiceTransport();
    fake.sendStaleReply = true;
    const service = new TestFileService(fake);

    await service.listFilePaths();

    assert.strictEqual(fake.requests()[1].body.SessionID, 'SESSION-1');
  });

  it('reconnects with a new session after a timed-out request', async function () {
    const stuck = new FakeFileServiceTransport();
    stuck.isListingSilent = true;
    const service = new TestFileService(stuck);
    const fresh = new FakeFileServiceTransport();
    fresh.listing = [['a.txt']];
    service.nextFakes.push(fresh);

    await assert.rejects(service.listFilePaths('.', {timeoutMs: 50}), /timed out after 50ms/);
    assert.strictEqual(stuck.closeCalls, 1);

    assert.deepStrictEqual(await service.listFilePaths(), ['a.txt']);
    assert.deepStrictEqual(
      fresh.requests().map(({body}) => body.Cmd),
      ['CreateSession', 'RetrieveDirectoryList'],
    );
  });

  it('opens a single connection for concurrent first calls', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [['a.txt']];
    const service = new TestFileService(fake);

    await Promise.all([service.listFilePaths(), service.listFilePaths(), service.listDirectory()]);

    assert.strictEqual(service.createTransportCalls, 1);
    assert.strictEqual(fake.requests().filter(({body}) => body.Cmd === 'CreateSession').length, 1);
  });

  it('creates one session and answers every listing message', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [[fileNode('tmp/', 64)], [fileNode('tmp/Attachments/A.mov', 1234)]];
    const service = new TestFileService(fake);

    const entries = await service.listDirectory('tmp', {recursive: true});
    const again = await service.listDirectory('tmp', {recursive: true});

    assert.deepStrictEqual(
      entries.map(({path: p, isDirectory, metadata}) => [p, isDirectory, metadata?.size]),
      [
        ['tmp', true, 64],
        ['tmp/Attachments/A.mov', false, 1234],
      ],
    );
    assert.deepStrictEqual(again, entries);

    const requests = fake.requests();
    assert.deepStrictEqual(
      requests.map(({body}) => body.Cmd),
      ['CreateSession', 'ListDirectoryFileNodes', 'ListDirectoryFileNodes'],
    );
    // devicectl-compatible odd request ids
    assert.deepStrictEqual(
      requests.map(({id}) => id),
      [1, 3, 5],
    );
    assert.deepStrictEqual(requests[0].body, {
      Cmd: 'CreateSession',
      // Sent as an XPC uint64, which decodes to a number.
      Domain: 1,
      Identifier: 'com.example.app',
      Session: '',
      User: 'mobile',
    });
    const list = requests[1].body;
    assert.strictEqual(list.Path, 'tmp');
    assert.strictEqual(list.SessionID, 'SESSION-1');
    assert.match(String(list.MessageUUID), /^[0-9A-F-]{36}$/);

    const acks = fake.sent.filter(({streamId}) => streamId === Http2Constants.REPLY_CHANNEL);
    assert.deepStrictEqual(
      acks.map(({id, flags, body}) => [id, flags, body.MessageUUID]),
      [
        [2, REPLY_FLAGS, requests[1].body.MessageUUID],
        [4, REPLY_FLAGS, requests[1].body.MessageUUID],
        [6, REPLY_FLAGS, requests[2].body.MessageUUID],
        [8, REPLY_FLAGS, requests[2].body.MessageUUID],
      ],
    );
  });

  it('listDirectory returns only direct children unless recursive', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [[fileNode('a.txt', 1), fileNode('b/', 64), fileNode('b/c.txt', 2)]];
    const service = new TestFileService(fake);

    assert.deepStrictEqual(
      (await service.listDirectory()).map((e) => e.path),
      ['a.txt', 'b'],
    );
  });

  it('listDirectory keeps a listed regular file in non-recursive mode', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [['b/c.txt']];
    const service = new TestFileService(fake);

    assert.deepStrictEqual(await service.listDirectory('b/c.txt'), [{path: 'b/c.txt', isDirectory: false}]);
  });

  it('listFilePaths returns only direct children unless recursive', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [['a.txt', 'b/c.txt']];
    const service = new TestFileService(fake);

    assert.deepStrictEqual(await service.listFilePaths(), ['a.txt']);
    assert.deepStrictEqual(await service.listFilePaths('.', {recursive: true}), ['a.txt', 'b/c.txt']);
  });

  it('listFilePaths keeps a listed regular file in non-recursive mode', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [['b/c.txt']];
    const service = new TestFileService(fake);

    for (const remotePath of ['b/c.txt', './b/c.txt', '/b/c.txt', 'b/c.txt/', 'b//c.txt']) {
      assert.deepStrictEqual(await service.listFilePaths(remotePath), ['b/c.txt'], remotePath);
    }
  });

  it('listFilePaths sends RetrieveDirectoryList for the root by default', async function () {
    const fake = new FakeFileServiceTransport();
    fake.listing = [['a.txt']];
    const service = new TestFileService(fake);

    assert.deepStrictEqual(await service.listFilePaths(), ['a.txt']);
    assert.strictEqual(fake.requests()[1].body.Cmd, 'RetrieveDirectoryList');
    assert.strictEqual(fake.requests()[1].body.Path, '.');
  });

  it('ends the session on close', async function () {
    const fake = new FakeFileServiceTransport();
    const service = new TestFileService(fake);
    await service.listFilePaths();

    await service.close();

    assert.strictEqual(fake.requests().at(-1)?.body.Cmd, 'EndSession');
    assert.strictEqual(fake.requests().at(-1)?.body.SessionID, 'SESSION-1');
    assert.strictEqual(fake.closeCalls, 1);
  });

  describe('pull', function () {
    let server: net.Server;
    let tmpDir: string;
    const payload = Buffer.from('movie bytes '.repeat(1000));

    beforeEach(async function () {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-service-'));
      server = net.createServer((socket) => {
        socket.once('data', (request: Buffer) => {
          const {fileId} = decodeDataChannelHeader(request);
          socket.write(
            encodeDataChannelHeader({
              type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA,
              fileId,
              size: BigInt(payload.length),
            }),
          );
          // Send the body in two writes so the client sees it split.
          socket.write(payload.subarray(0, 100));
          socket.write(payload.subarray(100));
          socket.write(encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE, fileId, size: 0n}));
        });
        socket.on('error', () => undefined);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
    });

    afterEach(async function () {
      server.close();
      await fs.promises.rm(tmpDir, {recursive: true, force: true});
    });

    function newService(): TestFileService {
      const service = new TestFileService(new FakeFileServiceTransport());
      service.dataPort = (server.address() as net.AddressInfo).port;
      return service;
    }

    it('downloads a file to a local path', async function () {
      const service = newService();
      const destination = path.join(tmpDir, 'out.mov');

      const metadata = await service.pull('tmp/Attachments/A', destination);

      assert.deepStrictEqual(await fs.promises.readFile(destination), payload);
      assert.deepStrictEqual(metadata, {
        size: payload.length,
        permissions: 0o644,
        ownerUid: 0,
        ownerGid: 0,
        modifiedAt: new Date(10_000),
      });
      const retrieve = service.fake.requests()[1].body;
      assert.strictEqual(retrieve.Cmd, 'RetrieveFile');
      assert.strictEqual(retrieve.Path, 'tmp/Attachments/A');
    });

    it('downloads a file to a stream', async function () {
      const service = newService();
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));

      await service.pull('a', stream);

      assert.deepStrictEqual(Buffer.concat(chunks), payload);
      assert.strictEqual(stream.writableEnded, true);
    });

    it('surfaces device errors as CoreDeviceError', async function () {
      const fake = new FakeFileServiceTransport();
      fake.fileReply = {
        EncodedError: {ErrorCode: 260, NSLocalizedDescription: 'no such file', ErrorDomain: 'NSCocoaErrorDomain'},
        Response: 3,
      };
      const service = new TestFileService(fake);
      service.dataPort = (server.address() as net.AddressInfo).port;

      await assert.rejects(
        service.pull('missing', new PassThrough()),
        (error: unknown) =>
          error instanceof CoreDeviceError && /no such file \[NSCocoaErrorDomain 260\]/.test(error.message),
      );
    });

    it('removes a partial local file when the transfer fails', async function () {
      server.removeAllListeners('connection');
      server.on('connection', (socket) => {
        socket.once('data', () => socket.end(Buffer.from('not a header at all, but long enough to parse!')));
      });
      const service = newService();
      const destination = path.join(tmpDir, 'broken.mov');

      await assert.rejects(service.pull('a', destination), /invalid magic/);
      assert.strictEqual(fs.existsSync(destination), false);
      // The device resets the control connection after an aborted transfer
      assert.strictEqual(service.fake.closeCalls, 1);
    });

    it('creates missing parent directories of the destination', async function () {
      const service = newService();
      const destination = path.join(tmpDir, 'a', 'b', 'out.mov');

      await service.pull('a', destination);

      assert.deepStrictEqual(await fs.promises.readFile(destination), payload);
    });

    it('fails before asking the device when the destination cannot be written', async function () {
      const service = newService();

      await assert.rejects(service.pull('a', tmpDir), {code: 'EISDIR'});
      assert.strictEqual(service.fake.sent.length, 0);
    });

    it('rejects a destination stream that cannot be written', async function () {
      const service = newService();
      const ended = new PassThrough();
      ended.end();

      await assert.rejects(service.pull('a', ended), /already been ended or destroyed/);
      await assert.rejects(service.pull('a', undefined as any), /must be a local file path or a writable stream/);
      assert.strictEqual(service.fake.sent.length, 0);
    });

    it('rejects a directory without waiting for the data channel', async function () {
      const service = newService();
      service.fake.fileReply = {NewFileID: 1, Response: 1, FilePermissions: 0o40755};
      const destination = path.join(tmpDir, 'dir');

      await assert.rejects(service.pull('Library', destination, {timeoutMs: 5000}), /'Library' is a directory/);
      assert.strictEqual(fs.existsSync(destination), false);
    });

    it('does not count time spent waiting for a slow destination as idle', async function () {
      const service = newService();
      const chunks: Buffer[] = [];
      const slow = new Writable({
        highWaterMark: 1,
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          setTimeout(callback, 150);
        },
      });

      await service.pull('a', slow, {timeoutMs: 100});

      assert.deepStrictEqual(Buffer.concat(chunks), payload);
    });
  });
});
