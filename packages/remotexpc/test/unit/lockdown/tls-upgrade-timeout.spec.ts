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

  it('rejects without leaving a live timer when tls.connect throws synchronously', async function () {
    const socket = new net.Socket();
    const timeoutMs = 50;
    const uncaught: Error[] = [];
    const onUncaught = (err: Error) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);

    try {
      await assert.rejects(
        upgradeSocketToTLS(socket, {key: 'not-a-pem', cert: 'not-a-pem'}, timeoutMs),
        /TLS socket error/,
      );
      // outlive the would-be timer
      await new Promise((resolve) => setTimeout(resolve, timeoutMs * 3));
      assert.deepEqual(uncaught, []);
    } finally {
      process.off('uncaughtException', onUncaught);
      socket.destroy();
    }
  });
});
