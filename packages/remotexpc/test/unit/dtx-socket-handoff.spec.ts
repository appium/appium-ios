import assert from 'node:assert/strict';
import {Duplex} from 'node:stream';
import {type TestContext, describe, it} from 'node:test';

import {ServiceConnection} from '../../src/service-connection.js';
import {DTX_CONSTANTS} from '../../src/services/ios/dvt/dtx-message.js';
import {DVTSecureSocketProxyService} from '../../src/services/ios/dvt/index.js';
import {DvtTestmanagedProxyService} from '../../src/services/ios/testmanagerd/index.js';

type DtxService = DVTSecureSocketProxyService | DvtTestmanagedProxyService;

const BROADCAST_CHANNEL = 0;
const MESSAGE_COUNT = 16;
const PAYLOAD_LENGTH = 256 * 1024;
const CHUNK_LENGTH = 64 * 1024;
const RECEIVE_TIMEOUT_MS = 3000;

function buildDtxMessage(payloadLength: number): Buffer {
  const header = Buffer.alloc(DTX_CONSTANTS.MESSAGE_HEADER_SIZE);
  header.writeUInt32LE(DTX_CONSTANTS.MESSAGE_HEADER_MAGIC, 0);
  header.writeUInt32LE(DTX_CONSTANTS.MESSAGE_HEADER_SIZE, 4);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(1, 10);
  header.writeUInt32LE(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE + payloadLength, 12);
  header.writeInt32LE(BROADCAST_CHANNEL, 24);

  const payloadHeader = Buffer.alloc(DTX_CONSTANTS.PAYLOAD_HEADER_SIZE);
  payloadHeader.writeBigUInt64LE(BigInt(payloadLength), 8);

  return Buffer.concat([header, payloadHeader, Buffer.alloc(payloadLength)]);
}

function createSocketStub(): Duplex {
  return new Duplex({
    read: () => {},
    write: (_chunk, _encoding, callback) => callback(),
  });
}

/** Runs the real connect() on a socket stub, skipping the RSD lookup and the DTX handshake. */
async function connectOverStub(t: TestContext, service: DtxService): Promise<Duplex> {
  const socket = createSocketStub();
  const connection = new ServiceConnection(socket as any);
  t.mock.method(service, 'startLockdownWithoutCheckin', async () => connection);
  t.mock.method(service as any, 'performHandshake', async () => {});
  await service.connect();
  return socket;
}

/** Delivers data the way TCP would: one chunk per event loop turn. */
async function feed(socket: Duplex, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length; offset += CHUNK_LENGTH) {
    socket.push(data.subarray(offset, offset + CHUNK_LENGTH));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Receives messages back to back and returns how many arrived before the timeout. */
async function receiveMessages(service: DtxService, count: number): Promise<number> {
  let received = 0;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, RECEIVE_TIMEOUT_MS);
  });
  const receiving = (async () => {
    while (received < count) {
      await service.recvMessage(BROADCAST_CHANNEL);
      received++;
    }
  })();
  await Promise.race([receiving, timedOut]);
  clearTimeout(timer);
  return received;
}

describe('DTX services socket handoff on connect', function () {
  const traffic = Buffer.concat(Array.from({length: MESSAGE_COUNT}, () => buildDtxMessage(PAYLOAD_LENGTH)));

  it('DvtTestmanagedProxyService should keep receiving after a few MB of DTX traffic', async function (t) {
    const service = new DvtTestmanagedProxyService('test-udid');
    const socket = await connectOverStub(t, service);

    const receiving = receiveMessages(service, MESSAGE_COUNT);
    await feed(socket, traffic);

    assert.strictEqual(await receiving, MESSAGE_COUNT, 'testmanagerd stopped receiving DTX messages');
  });

  it('DvtTestmanagedProxyService should keep data that arrives while nothing is reading', async function (t) {
    const service = new DvtTestmanagedProxyService('test-udid');
    const socket = await connectOverStub(t, service);

    await feed(socket, buildDtxMessage(PAYLOAD_LENGTH));

    assert.strictEqual(await receiveMessages(service, 1), 1, 'testmanagerd lost data sent between reads');
  });

  it('DVTSecureSocketProxyService should be the only reader of the socket', async function (t) {
    const service = new DVTSecureSocketProxyService('test-udid');
    const socket = await connectOverStub(t, service);

    const receiving = receiveMessages(service, MESSAGE_COUNT);
    await feed(socket, traffic);

    assert.strictEqual(await receiving, MESSAGE_COUNT);
    assert.strictEqual(socket.listenerCount('data'), 1, 'the plist layer is still reading the DTX stream');
  });
});
