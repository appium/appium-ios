import assert from 'node:assert/strict';
import {once} from 'node:events';
import net, {type AddressInfo} from 'node:net';
import {describe, it} from 'node:test';

import {LockdownStartServiceError} from '../../../src/lib/lockdown/index.js';
import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {createRawServiceSocket, readExact} from '../../../src/services/ios/afc/codec.js';

const SERVICE_NAME = 'com.apple.crashreportmover.shim.remote';
const ECHO: PlistDictionary = {Request: 'RSDCheckin'};
const GREETING: PlistDictionary = {Request: 'StartService'};

function frame(message: PlistDictionary): Buffer {
  const body = Buffer.from(createPlist(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Starts a raw RSD service that answers the check-in with `afterCheckin` in a single write,
 * the way a device can deliver the handshake and the first service bytes in one segment.
 */
async function withRawService(
  afterCheckin: Buffer,
  body: (port: number, sockets: net.Socket[]) => Promise<void>,
): Promise<void> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.once('data', () => socket.write(afterCheckin));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await body((server.address() as AddressInfo).port, sockets);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('createRawServiceSocket', function () {
  it('returns the socket positioned at the first service byte after the handshake', async function () {
    const ping = Buffer.from('ping\0', 'utf8');
    await withRawService(Buffer.concat([frame(ECHO), frame(GREETING), ping]), async (port) => {
      const socket = await createRawServiceSocket('127.0.0.1', port, SERVICE_NAME);
      try {
        assert.deepEqual(await readExact(socket, ping.length, 1000), ping);
      } finally {
        socket.destroy();
      }
    });
  });

  it('reports a refusal to start the service and closes the connection', async function () {
    const refusal = {Request: 'StartService', Error: 'ServiceProhibited'};
    await withRawService(Buffer.concat([frame(ECHO), frame(refusal)]), async (port, sockets) => {
      await assert.rejects(
        createRawServiceSocket('127.0.0.1', port, SERVICE_NAME),
        (error: unknown) =>
          error instanceof LockdownStartServiceError &&
          error.serviceName === SERVICE_NAME &&
          error.reason === 'ServiceProhibited',
      );
      await once(sockets[0], 'end');
    });
  });
});
