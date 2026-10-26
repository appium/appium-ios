import assert from 'node:assert/strict';
import {once} from 'node:events';
import net, {type AddressInfo, type Socket} from 'node:net';
import {Duplex} from 'node:stream';
import {type TestContext, describe, it} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

import {LengthBasedSplitter} from '../../../src/lib/plist/length-based-splitter.js';
import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import {PlistServiceDecoder} from '../../../src/lib/plist/plist-decoder.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {BaseService} from '../../../src/services/ios/base-service.js';
import type SyslogServiceClass from '../../../src/services/ios/syslog-service/index.js';
import {SyslogLogLevel} from '../../../src/services/ios/syslog-service/syslog-entry-parser.js';
import {mockImport} from '../../helpers/mock-module.js';

const BINARY_SERVICE = {serviceName: 'com.apple.os_trace_relay.shim.remote', port: '1'};
const TEXT_SERVICE = {serviceName: 'com.apple.syslog_relay.shim.remote', port: '1'};
const STARTED = {Status: 'RequestSuccessful'};
const REFUSED = {Status: 'RequestFailed'};
const SETTLE_MS = 100;

interface FakeRelayDaemon {
  port: number;
  requests: PlistDictionary[];
  openConnections: () => number;
  close: () => Promise<void>;
}

interface FakeRelayOptions {
  reply?: (request: PlistDictionary) => Buffer | null;
  afterCheckin?: Buffer;
}

function createSyslogEntryBuffer(message: string): Buffer {
  const filename = '/usr/bin/myapp\0';
  const imageName = 'MyApp\0';
  const messageBytes = `${message}\0`;
  const headerSize = 129;
  const totalSize =
    headerSize + Buffer.byteLength(filename) + Buffer.byteLength(imageName) + Buffer.byteLength(messageBytes);
  const buffer = Buffer.alloc(totalSize);
  buffer.fill(0, 0, headerSize);
  buffer.writeUInt32LE(1234, 9);
  buffer.writeUInt32LE(1700000000, 55);
  buffer.writeUInt32LE(500000, 63);
  buffer.writeUInt8(SyslogLogLevel.Info, 68);
  buffer.writeUInt16LE(Buffer.byteLength(imageName), 107);
  buffer.writeUInt16LE(Buffer.byteLength(messageBytes), 109);
  let offset = headerSize;
  buffer.write(filename, offset);
  offset += Buffer.byteLength(filename);
  buffer.write(imageName, offset);
  offset += Buffer.byteLength(imageName);
  buffer.write(messageBytes, offset);
  return buffer;
}

function frameSyslogEntry(message: string): Buffer {
  const entry = createSyslogEntryBuffer(message);
  const header = Buffer.alloc(5);
  header.writeUInt8(0x02, 0);
  header.writeUInt32LE(entry.length, 1);
  return Buffer.concat([header, entry]);
}

/**
 * Length-prefixes a plist message the way lockdown services frame it on the wire.
 */
function framePlist(message: PlistDictionary): Buffer {
  const body = Buffer.from(createPlist(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Frames a StartActivity reply the way os_trace_relay does: a uint32 LE size of the length
 * field, the plist length in that many little-endian bytes, then the plist.
 */
function frameActivityReply(message: PlistDictionary): Buffer {
  const body = Buffer.from(createPlist(message), 'utf8');
  const lengthSize = Buffer.alloc(4);
  lengthSize.writeUInt32LE(4, 0);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length, 0);
  return Buffer.concat([lengthSize, length, body]);
}

/**
 * Starts a TCP server that behaves like a syslog relay shim. The RSDCheckin echo, the
 * StartService greeting and `afterCheckin` go out in one write, as does each reply, so
 * log data that follows a plist shares a TCP read with it. A `null` reply sends nothing.
 */
async function startFakeRelayDaemon({
  reply = () => frameActivityReply(STARTED),
  afterCheckin = Buffer.alloc(0),
}: FakeRelayOptions): Promise<FakeRelayDaemon> {
  const requests: PlistDictionary[] = [];
  const sockets = new Set<Socket>();
  const server = net.createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const decoder = socket.pipe(new LengthBasedSplitter()).pipe(new PlistServiceDecoder());
    decoder.on('data', (request: PlistDictionary) => {
      if (request.Request === 'RSDCheckin') {
        socket.write(
          Buffer.concat([framePlist({Request: 'RSDCheckin'}), framePlist({Request: 'StartService'}), afterCheckin]),
        );
        return;
      }
      requests.push(request);
      const response = reply(request);
      if (response) {
        socket.write(response);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    openConnections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Runs `body` against a SyslogService whose shim services resolve to a fresh fake daemon,
 * then tears both down.
 */
async function withSyslog(
  t: TestContext,
  options: FakeRelayOptions,
  body: (service: SyslogServiceClass, daemon: FakeRelayDaemon) => Promise<void>,
): Promise<void> {
  const daemon = await startFakeRelayDaemon(options);
  const {default: Service} = await mockImport<{default: typeof SyslogServiceClass}>(
    t,
    '../../../src/services/ios/syslog-service/index.js',
    import.meta.url,
    {
      '../../../src/services/ios/base-service.js': {
        BaseService: class extends BaseService {
          protected override async resolveServiceAddress(): Promise<[string, number]> {
            return ['127.0.0.1', daemon.port];
          }
        },
      },
    },
  );
  const service = new Service('test-udid');
  try {
    await body(service, daemon);
  } finally {
    await service.stop();
    await daemon.close();
  }
}

/**
 * Collects every 'message' event the service emits.
 */
function collectMessages(service: SyslogServiceClass): string[] {
  const messages: string[] = [];
  service.on('message', (message: string) => messages.push(message));
  return messages;
}

describe('SyslogService against a shim daemon', function () {
  it('reports the StartActivity reply, not the StartService greeting', async function (t) {
    await withSyslog(t, {}, async (service) => {
      const started = once(service, 'start');
      await service.start(BINARY_SERVICE);

      assert.deepEqual(await started, [STARTED]);
    });
  });

  it('rejects when the device refuses StartActivity', async function (t) {
    await withSyslog(t, {reply: () => frameActivityReply(REFUSED)}, async (service) => {
      await assert.rejects(service.start(BINARY_SERVICE), /StartActivity failed/);
    });
  });

  it('closes the connection when StartActivity is refused', async function (t) {
    await withSyslog(t, {reply: () => frameActivityReply(REFUSED)}, async (service, daemon) => {
      await assert.rejects(service.start(BINARY_SERVICE));
      await delay(SETTLE_MS);

      assert.equal(daemon.openConnections(), 0);
    });
  });

  it('closes the connection when stopped while starting', async function (t) {
    await withSyslog(t, {}, async (service, daemon) => {
      const starting = service.start(BINARY_SERVICE);
      await service.stop();

      await assert.rejects(starting, /stopped while starting/);
      await delay(SETTLE_MS);
      assert.equal(daemon.openConnections(), 0);
    });
  });

  it('closes the text relay connection when stopped while starting', async function (t) {
    await withSyslog(t, {}, async (service, daemon) => {
      const starting = service.start(TEXT_SERVICE, {textMode: true});
      await service.stop();

      await assert.rejects(starting, /stopped while starting/);
      await delay(SETTLE_MS);
      assert.equal(daemon.openConnections(), 0);
    });
  });

  it('keeps syslog entries that arrive with the StartActivity reply', async function (t) {
    const reply = () => Buffer.concat([frameActivityReply(STARTED), frameSyslogEntry('first entry')]);
    await withSyslog(t, {reply}, async (service) => {
      const messages = collectMessages(service);
      await service.start(BINARY_SERVICE);
      await delay(SETTLE_MS);

      assert.ok(messages.some((message) => message.includes('first entry')));
    });
  });

  it('keeps text lines that arrive with the StartService greeting', async function (t) {
    await withSyslog(t, {afterCheckin: Buffer.from('line one\n\0line two\n\0')}, async (service) => {
      const messages = collectMessages(service);
      await service.start(TEXT_SERVICE, {textMode: true});
      await delay(SETTLE_MS);

      assert.deepEqual(messages, ['line one', 'line two']);
    });
  });

  it('sends Restart without waiting for a reply', async function (t) {
    await withSyslog(t, {reply: () => null}, async (service, daemon) => {
      await service.restart(BINARY_SERVICE);
      await delay(SETTLE_MS);

      assert.deepEqual(daemon.requests, [{Request: 'Restart'}]);
    });
  });

  it('closes the connection used for Restart', async function (t) {
    await withSyslog(t, {reply: () => null}, async (service, daemon) => {
      await service.restart(BINARY_SERVICE);
      await delay(SETTLE_MS);

      assert.equal(daemon.openConnections(), 0);
    });
  });
});

describe('SyslogService binary mode', function () {
  it('reads framed syslog entries from the service socket after StartActivity', async function (t) {
    const socket = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        callback();
      },
    });
    socket.push(frameActivityReply(STARTED));

    const {default: SyslogService} = await mockImport(
      t,
      '../../../src/services/ios/syslog-service/index.js',
      import.meta.url,
      {
        '../../../src/services/ios/base-service.js': {
          BaseService: class {
            constructor(udid: string) {
              void udid;
            }
            async startRawShimService() {
              return socket;
            }
          },
        },
      },
    );

    const service = new SyslogService('test-udid');
    const messages: string[] = [];
    service.on('message', (msg: string) => messages.push(msg));

    const startPromise = service.start({serviceName: 'com.apple.os_trace_relay.shim.remote', port: '1'}, {pid: -1});

    await startPromise;

    socket.push(frameSyslogEntry('hello from socket'));

    await new Promise((resolve) => setTimeout(resolve, 50));

    await service.stop();

    assert.strictEqual(
      messages.some((m) => m.includes('hello from socket')),
      true,
    );
  });
});
