import assert from 'node:assert/strict';
import net from 'node:net';
import {describe, it} from 'node:test';

import {readUInt64LE} from '../../../src/services/ios/afc/codec.js';
import {AFC_HEADER_SIZE, AFC_OPERATION_TIMEOUT_MS} from '../../../src/services/ios/afc/constants.js';
import {AfcPacketDemux} from '../../../src/services/ios/afc/demux.js';
import {AfcOpcode} from '../../../src/services/ios/afc/enums.js';
import {AfcConnectionError} from '../../../src/services/ios/afc/errors.js';
import {AfcService} from '../../../src/services/ios/afc/index.js';

const JUST_BEFORE_TIMEOUT_MS = AFC_OPERATION_TIMEOUT_MS - 1000;
const JUST_PAST_TIMEOUT_MS = AFC_OPERATION_TIMEOUT_MS + 1000;

function encodeResponse(op: AfcOpcode, packetNum: bigint, payload: Buffer = Buffer.alloc(0)): Buffer {
  const entireLen = AFC_HEADER_SIZE + payload.length;
  const header = Buffer.alloc(AFC_HEADER_SIZE);
  Buffer.from('CFA6LPAA', 'ascii').copy(header, 0);
  header.writeBigUInt64LE(BigInt(entireLen), 8);
  header.writeBigUInt64LE(BigInt(entireLen), 16);
  header.writeBigUInt64LE(packetNum, 24);
  header.writeBigUInt64LE(BigInt(op), 32);
  return Buffer.concat([header, payload]);
}

/**
 * Reply to the next AFC request seen on the device side with a DATA packet.
 */
async function answerNextRequest(deviceSide: net.Socket, read: DeviceReader, payload: Buffer): Promise<void> {
  const requestHeader = await read(AFC_HEADER_SIZE);
  const requestLen = Number(readUInt64LE(requestHeader, 8));
  if (requestLen > AFC_HEADER_SIZE) {
    await read(requestLen - AFC_HEADER_SIZE);
  }
  deviceSide.write(encodeResponse(AfcOpcode.DATA, readUInt64LE(requestHeader, 24), payload));
}

async function flushIo(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('AFC idle connection', function () {
  it('keeps the demux socket alive just under the operation timeout while idle', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const {server, client, deviceSide, getSocket} = await createPairedSockets();
    const read = createDeviceReader(deviceSide);
    let fatalError: Error | null = null;
    const demux = new AfcPacketDemux(getSocket, (err) => {
      fatalError = err;
    });

    const first = demux.sendAndWait(AfcOpcode.GET_DEVINFO);
    await answerNextRequest(deviceSide, read, Buffer.from('ok\0\0'));
    await first;

    t.mock.timers.tick(JUST_BEFORE_TIMEOUT_MS);
    await flushIo();

    assert.strictEqual(client.destroyed, false);
    assert.strictEqual(fatalError, null);

    demux.stop();
    server.close();
    client.destroy();
    deviceSide.destroy();
  });

  it('keeps the demux socket alive past the operation timeout while idle', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const {server, client, deviceSide, getSocket} = await createPairedSockets();
    const read = createDeviceReader(deviceSide);
    let fatalError: Error | null = null;
    const demux = new AfcPacketDemux(getSocket, (err) => {
      fatalError = err;
    });

    const first = demux.sendAndWait(AfcOpcode.GET_DEVINFO);
    await answerNextRequest(deviceSide, read, Buffer.from('ok\0\0'));
    await first;

    t.mock.timers.tick(JUST_PAST_TIMEOUT_MS);
    await flushIo();

    try {
      assert.strictEqual(fatalError, null, `idle reader fatalized the connection: ${fatalError}`);
      assert.strictEqual(client.destroyed, false);

      const second = demux.sendAndWait(AfcOpcode.GET_DEVINFO);
      await answerNextRequest(deviceSide, read, Buffer.from('ok\0\0'));
      await second;
    } finally {
      demux.stop();
      server.close();
      client.destroy();
      deviceSide.destroy();
    }
  });

  it('lets a fromSocket AfcService (HouseArrest path) run an operation after idling past the timeout', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const {server, client, deviceSide} = await createPairedSockets();
    const read = createDeviceReader(deviceSide);
    const afc = AfcService.fromSocket(client, true);

    const first = afc.listdir('/');
    await answerNextRequest(deviceSide, read, Buffer.from('.\0..\0a.txt\0'));
    assert.deepStrictEqual(await first, ['a.txt']);

    t.mock.timers.tick(JUST_PAST_TIMEOUT_MS);
    await flushIo();

    try {
      const second = afc.listdir('/');
      const answered = answerNextRequest(deviceSide, read, Buffer.from('.\0..\0b.txt\0')).catch(() => {});
      assert.deepStrictEqual(await second, ['b.txt']);
      await answered;
    } finally {
      afc.close();
      server.close();
      deviceSide.destroy();
    }
  });

  it('still fails a pending request whose reply never arrives and drops the connection', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const {server, client, deviceSide} = await createPairedSockets();
    const read = createDeviceReader(deviceSide);
    const afc = AfcService.fromSocket(client, true);

    try {
      const pending = afc.listdir('/');
      await read(AFC_HEADER_SIZE);
      t.mock.timers.tick(JUST_PAST_TIMEOUT_MS);

      await assert.rejects(pending, (err: Error) => {
        assert.ok(err instanceof AfcConnectionError);
        assert.match(err.message, /READ_DIR timed out/);
        return true;
      });
      await flushIo();
      assert.strictEqual(client.destroyed, true);
      await assert.rejects(afc.listdir('/'), AfcConnectionError);
    } finally {
      afc.close();
      server.close();
      deviceSide.destroy();
    }
  });
});

async function createPairedSockets(): Promise<{
  server: net.Server;
  client: net.Socket;
  deviceSide: net.Socket;
  getSocket: () => Promise<net.Socket>;
}> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as net.AddressInfo;
  const accepted = new Promise<net.Socket>((resolve) => server.once('connection', resolve));
  const client = await new Promise<net.Socket>((resolve, reject) => {
    const conn = net.createConnection(address.port, address.address, () => resolve(conn));
    conn.once('error', reject);
  });
  const deviceSide = await accepted;
  return {server, client, deviceSide, getSocket: async () => client};
}

type DeviceReader = (n: number) => Promise<Buffer>;

/**
 * Buffer everything the device side receives so consecutive reads never drop bytes.
 */
function createDeviceReader(socket: net.Socket): DeviceReader {
  let buffer = Buffer.alloc(0);
  let waiter: {n: number; resolve: (buf: Buffer) => void; reject: (err: Error) => void} | null = null;
  const drain = () => {
    if (waiter && buffer.length >= waiter.n) {
      const {n, resolve} = waiter;
      waiter = null;
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      resolve(out);
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  socket.once('close', () => waiter?.reject(new Error('socket closed')));
  return (n: number) =>
    new Promise<Buffer>((resolve, reject) => {
      waiter = {n, resolve, reject};
      drain();
    });
}
