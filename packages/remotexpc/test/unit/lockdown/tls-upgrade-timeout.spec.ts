import assert from 'node:assert/strict';
import net from 'node:net';
import {describe, it} from 'node:test';

import {upgradeSocketToTLS} from '../../../src/lib/lockdown/index.js';

describe('upgradeSocketToTLS', function () {
  it('rejects when the peer never completes the TLS handshake', async function () {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted: net.Socket[] = [];
    server.on('connection', (s) => accepted.push(s));
    const socket = net.createConnection({host: '127.0.0.1', port: (server.address() as net.AddressInfo).port});
    await new Promise<void>((resolve) => socket.once('connect', resolve));

    try {
      await assert.rejects(upgradeSocketToTLS(socket, {}, 100), /TLS handshake timed out after 100ms/);
    } finally {
      socket.destroy();
      accepted.forEach((s) => s.destroy());
      server.close();
    }
  });
});
