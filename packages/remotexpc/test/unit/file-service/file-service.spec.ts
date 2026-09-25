import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {PassThrough, Readable, Writable} from 'node:stream';
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
  proposeReply: XPCDictionary = {NewFileID: 7, Response: 1};
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
      case 'ProposeFile':
        this.reply(id, this.proposeReply);
        return;
      case 'ProposeEmptyFile':
        this.reply(id, {Response: 1});
        return;
      case 'EndSession':
      case 'FileSystemOperation':
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

  describe('rm and mkdir', function () {
    function fileSystemOperations(fake: FakeFileServiceTransport): string[] {
      return fake
        .requests()
        .filter(({body}) => body.Cmd === 'FileSystemOperation')
        .map(({body}) => `${body.OperationType} ${body.Path}`);
    }

    it('removes a file', async function () {
      const fake = new FakeFileServiceTransport();
      fake.listing = [['tmp/a.mov']];
      const service = new TestFileService(fake);

      await service.rm('/tmp/a.mov');

      assert.deepStrictEqual(fileSystemOperations(fake), ['RemoveFile tmp/a.mov']);
    });

    it('removes an empty directory', async function () {
      const fake = new FakeFileServiceTransport();
      const service = new TestFileService(fake);

      await service.rm('tmp/empty/');

      assert.deepStrictEqual(fileSystemOperations(fake), ['RemoveDirectory tmp/empty']);
    });

    it('refuses to remove a non-empty directory unless recursive', async function () {
      const fake = new FakeFileServiceTransport();
      fake.listing = [[fileNode('a.txt', 1)]];
      const service = new TestFileService(fake);

      await assert.rejects(service.rm('tmp/dir'), /Cannot remove 'tmp\/dir': the directory is not empty/);
      assert.deepStrictEqual(fileSystemOperations(fake), []);
    });

    it('removes a directory tree files first, then directories deepest first', async function () {
      const fake = new FakeFileServiceTransport();
      fake.listing = [[fileNode('a/', 0), fileNode('a/b/', 0), fileNode('a/b/c.txt', 1), fileNode('d.txt', 1)]];
      const service = new TestFileService(fake);

      await service.rm('tmp/dir', {recursive: true});

      assert.deepStrictEqual(fileSystemOperations(fake), [
        'RemoveFile tmp/dir/a/b/c.txt',
        'RemoveFile tmp/dir/d.txt',
        'RemoveDirectory tmp/dir/a/b',
        'RemoveDirectory tmp/dir/a',
        'RemoveDirectory tmp/dir',
      ]);
    });

    it('refuses to remove the session root', async function () {
      const service = new TestFileService(new FakeFileServiceTransport());

      for (const remotePath of ['', '.', '/', './']) {
        await assert.rejects(service.rm(remotePath, {recursive: true}), /root of a file service session/);
      }
      assert.strictEqual(service.fake.sent.length, 0);
    });

    it('renames with the old and new paths', async function () {
      const fake = new FakeFileServiceTransport();
      const service = new TestFileService(fake);

      await service.rename('tmp/a.mov', 'Documents/b.mov');

      const [operation] = fake.requests().filter(({body}) => body.Cmd === 'FileSystemOperation');
      assert.strictEqual(operation.body.OperationType, 'Rename');
      assert.strictEqual(operation.body.OldPath, 'tmp/a.mov');
      assert.strictEqual(operation.body.NewPath, 'Documents/b.mov');
      assert.strictEqual(operation.body.Path, undefined);
    });

    it('refuses to rename outside the writable app container directories', async function () {
      const service = new TestFileService(new FakeFileServiceTransport());

      for (const [oldPath, newPath] of [
        ['tmp/a', 'SystemData/a'],
        ['SystemData/a', 'tmp/a'],
        ['.com.apple.mobile_container_manager.metadata.plist', 'tmp/x'],
        ['tmp', 'tmp2'],
        ['tmp/a', '/Library'],
      ]) {
        await assert.rejects(service.rename(oldPath, newPath), /Access restricted/, `${oldPath} -> ${newPath}`);
      }
      assert.strictEqual(service.fake.sent.length, 0);
    });

    it('leaves rename checks to the device for other domains', async function () {
      const fake = new FakeFileServiceTransport();
      const service = new TestFileService(fake, {domain: 'temporary'});

      await service.rename('a', 'b');

      assert.strictEqual(fake.requests().filter(({body}) => body.Cmd === 'FileSystemOperation').length, 1);
    });

    it('creates a directory', async function () {
      const fake = new FakeFileServiceTransport();
      const service = new TestFileService(fake);

      await service.mkdir('tmp/new');

      assert.deepStrictEqual(fileSystemOperations(fake), ['CreateDirectory tmp/new']);
    });
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

      await service.pull('a', slow, {idleTimeoutMs: 100});

      assert.deepStrictEqual(Buffer.concat(chunks), payload);
    });

    it('does not use the control timeout as the transfer idle timeout', async function () {
      const service = newService();
      const slowDevice = (socket: net.Socket): void => {
        socket.once('data', (request: Buffer) => {
          const {fileId} = decodeDataChannelHeader(request);
          const header = {type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA, fileId, size: BigInt(payload.length)};
          socket.write(encodeDataChannelHeader(header));
          setTimeout(() => {
            socket.write(payload);
            socket.write(
              encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE, fileId, size: 0n}),
            );
          }, 150);
        });
      };
      server.removeAllListeners('connection');
      server.on('connection', slowDevice);
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));

      await service.pull('a', stream, {timeoutMs: 50});

      assert.deepStrictEqual(Buffer.concat(chunks), payload);
    });

    it('destroys a destination stream when the device refuses the file', async function () {
      const service = newService();
      service.fake.fileReply = {Error: 'no such file', Response: 3};
      const stream = new PassThrough();

      await assert.rejects(service.pull('missing', stream), CoreDeviceError);
      assert.strictEqual(stream.destroyed, true);
    });

    it('finishes the transfer and keeps the connection when the destination fails', async function () {
      const service = newService();
      const failing = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('disk full'));
        },
      });

      await assert.rejects(service.pull('a', failing), /disk full/);
      assert.strictEqual(service.fake.closeCalls, 0);
      assert.strictEqual(failing.destroyed, true);
    });

    it('cuts a running transfer short on close()', async function () {
      server.removeAllListeners('connection');
      // The device announces the file but never sends it.
      server.on('connection', (socket) => {
        socket.once('data', (request: Buffer) => {
          const {fileId} = decodeDataChannelHeader(request);
          socket.write(encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA, fileId, size: 10n}));
        });
        socket.on('error', () => undefined);
      });
      const service = newService();
      const pulled = service.pull('a', new PassThrough());
      const outcome = assert.rejects(pulled, /closed during the transfer/);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await service.close();

      await outcome;
    });

    it('removes the local file when close() cuts a pull short', async function () {
      server.removeAllListeners('connection');
      // The device sends part of a large file and then stalls.
      server.on('connection', (socket) => {
        socket.once('data', (request: Buffer) => {
          const {fileId} = decodeDataChannelHeader(request);
          socket.write(encodeDataChannelHeader({type: DATA_CHANNEL_MESSAGE_TYPE.FILE_DATA, fileId, size: 1n << 30n}));
          socket.write(Buffer.alloc(4 * 1024 * 1024));
        });
        socket.on('error', () => undefined);
      });
      const service = newService();
      const destination = path.join(tmpDir, 'closing.bin');
      const outcome = assert.rejects(service.pull('a', destination), /closed during the transfer/);
      await new Promise((resolve) => setTimeout(resolve, 50));

      await service.close();

      await outcome;
      assert.strictEqual(fs.existsSync(destination), false);
    });
  });

  describe('push', function () {
    let server: net.Server;
    let tmpDir: string;
    /** What the fake device does once it has the header and the announced bytes. */
    let deviceBehavior: 'confirm' | 'no-confirmation' | 'stop-reading';
    let received: {header?: ReturnType<typeof decodeDataChannelHeader>; data: Buffer};

    beforeEach(async function () {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'file-service-push-'));
      deviceBehavior = 'confirm';
      received = {data: Buffer.alloc(0)};
      server = net.createServer((socket) => {
        if (deviceBehavior === 'stop-reading') {
          socket.pause();
          return;
        }
        let buffer = Buffer.alloc(0);
        socket.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          if (!received.header && buffer.length >= 40) {
            received.header = decodeDataChannelHeader(buffer.subarray(0, 40));
            buffer = buffer.subarray(40);
          }
          if (received.header && buffer.length >= Number(received.header.size)) {
            received.data = buffer;
            if (deviceBehavior === 'confirm') {
              socket.write(
                encodeDataChannelHeader({
                  type: DATA_CHANNEL_MESSAGE_TYPE.TRANSFER_COMPLETE,
                  fileId: received.header.fileId,
                  size: 0n,
                }),
              );
            }
          }
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

    function proposals(service: TestFileService): XPCDictionary[] {
      return service.fake
        .requests()
        .map(({body}) => body)
        .filter((body) => String(body.Cmd).startsWith('Propose'));
    }

    function removals(service: TestFileService): string[] {
      return service.fake
        .requests()
        .filter(({body}) => body.OperationType === 'RemoveFile')
        .map(({body}) => String(body.Path));
    }

    it('uploads a local file with its size and metadata', async function () {
      const service = newService();
      const source = path.join(tmpDir, 'in.txt');
      await fs.promises.writeFile(source, 'local bytes');
      await fs.promises.chmod(source, 0o640);
      await fs.promises.utimes(source, new Date(5000), new Date(5000));

      await service.push(source, 'tmp/in.txt');

      const [proposal] = proposals(service);
      assert.strictEqual(proposal.Cmd, 'ProposeFile');
      assert.strictEqual(proposal.Path, 'tmp/in.txt');
      // Sent as a uint64 (the device rejects an int64); the decoder turns small uint64s into numbers
      assert.strictEqual(Number(proposal.FileSize), 11);
      assert.strictEqual(proposal.FilePermissions, 0o640);
      assert.strictEqual(proposal.FileLastModificationTime, 5);
      assert.strictEqual(received.header?.type, DATA_CHANNEL_MESSAGE_TYPE.FILE_UPLOAD);
      assert.strictEqual(received.header?.fileId, 7n);
      assert.strictEqual(received.header?.size, 11n);
      assert.strictEqual(received.data.toString(), 'local bytes');
    });

    it('uploads a buffer and a sized stream', async function () {
      const service = newService();
      await service.push(Buffer.from('buffer bytes'), 'tmp/a.txt', {permissions: 0o600});
      assert.strictEqual(received.data.toString(), 'buffer bytes');
      assert.strictEqual(proposals(service)[0].FilePermissions, 0o600);

      received = {data: Buffer.alloc(0)};
      await service.push(Readable.from([Buffer.from('str'), Buffer.from('eam')]), 'tmp/b.txt', {size: 6});
      assert.strictEqual(received.data.toString(), 'stream');
    });

    it('creates an empty file without the data channel', async function () {
      const service = newService();

      await service.push(Buffer.alloc(0), 'tmp/empty.txt');

      assert.deepStrictEqual(
        proposals(service).map(({Cmd}) => Cmd),
        ['ProposeEmptyFile'],
      );
      assert.strictEqual(received.header, undefined);
    });

    it('fails when the device will not create the file', async function () {
      const service = newService();
      service.fake.proposeReply = {Response: 1};

      await assert.rejects(service.push(Buffer.from('x'), 'tmp/x.txt'), /refused to create 'tmp\/x.txt'/);
    });

    it('removes the incomplete file when the stream has fewer bytes than announced', async function () {
      const service = newService();

      await assert.rejects(
        service.push(Readable.from([Buffer.from('12345')]), 'tmp/short.txt', {size: 10}),
        /ended after 5 of the announced 10 bytes/,
      );
      assert.deepStrictEqual(removals(service), ['tmp/short.txt']);
    });

    it('removes the incomplete file when the stream has more bytes than announced', async function () {
      const service = newService();

      await assert.rejects(
        service.push(Readable.from([Buffer.from('1234567890')]), 'tmp/long.txt', {size: 4}),
        /more than the announced 4 bytes/,
      );
      assert.deepStrictEqual(removals(service), ['tmp/long.txt']);
    });

    it('fails when the device does not confirm the upload', async function () {
      deviceBehavior = 'no-confirmation';
      const service = newService();

      await assert.rejects(service.push(Buffer.from('abc'), 'tmp/c.txt', {idleTimeoutMs: 200}), /did not confirm/);
      assert.deepStrictEqual(removals(service), ['tmp/c.txt']);
    });

    it('fails when the device stops taking data', async function () {
      deviceBehavior = 'stop-reading';
      const service = newService();

      await assert.rejects(
        service.push(Buffer.alloc(64 * 1024 * 1024, 1), 'tmp/big.bin', {idleTimeoutMs: 300}),
        /took no upload data for 300ms/,
      );
    });

    it('rejects invalid sources and paths before contacting the device', async function () {
      const service = newService();

      await assert.rejects(service.push(Readable.from([Buffer.from('x')]), 'tmp/x.txt'), /size of the data to push/);
      await assert.rejects(service.push(tmpDir, 'tmp/x.txt'), /is not a regular file/);
      await assert.rejects(service.push(undefined as any, 'tmp/x.txt'), /must be a local file path/);
      for (const remotePath of ['SystemData/x.txt', 'x.txt', '../x.txt']) {
        await assert.rejects(service.push(Buffer.from('x'), remotePath), /Access restricted/, remotePath);
      }
      assert.strictEqual(service.fake.sent.length, 0);
    });
  });
});
