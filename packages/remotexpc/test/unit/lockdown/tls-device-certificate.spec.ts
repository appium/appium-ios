import assert from 'node:assert/strict';
import {once} from 'node:events';
import net from 'node:net';
import {after, before, describe, it} from 'node:test';
import tls from 'node:tls';

import {pairRecordTlsOptions, upgradeSocketToTLS} from '../../../src/lib/lockdown/index.js';
import {DEVICE_CERT, DEVICE_KEY, OTHER_CERT, OTHER_KEY, PAIR_RECORD} from '../../helpers/tls-certificates.js';

describe('upgradeSocketToTLS device certificate pinning', function () {
  let server: tls.Server;
  const serverErrors: NodeJS.ErrnoException[] = [];

  before(async function () {
    server = tls.createServer({cert: DEVICE_CERT, key: DEVICE_KEY}, (socket) =>
      socket.on('error', (err) => serverErrors.push(err)),
    );
    server.on('tlsClientError', (err) => serverErrors.push(err));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  /** Rethrows every server-side error other than the reset a client causes by dropping its connection. */
  after(function () {
    server.close();
    const unexpected = serverErrors.filter((err) => err.code !== 'ECONNRESET');
    if (unexpected.length > 0) {
      throw new AggregateError(unexpected, 'Unexpected errors on the TLS test server');
    }
  });

  /** Opens a plain TCP connection to the TLS server that presents DEVICE_CERT. */
  async function connectToDevice(): Promise<net.Socket> {
    const socket = net.createConnection({host: '127.0.0.1', port: (server.address() as net.AddressInfo).port});
    await once(socket, 'connect');
    return socket;
  }

  it('completes the upgrade when the device presents the pinned certificate', async function () {
    const socket = await connectToDevice();
    try {
      const secure = await upgradeSocketToTLS(socket, {deviceCertificate: DEVICE_CERT});
      assert.equal(secure.encrypted, true);
      secure.destroy();
    } finally {
      socket.destroy();
    }
  });

  it('rejects a device that presents a certificate other than the pinned one', async function () {
    const socket = await connectToDevice();
    try {
      await assert.rejects(
        upgradeSocketToTLS(socket, {deviceCertificate: OTHER_CERT}),
        /does not match the DeviceCertificate of its pair record/,
      );
      assert.equal(socket.destroyed, true);
    } finally {
      socket.destroy();
    }
  });

  it('rejects a pinned certificate that is not valid PEM', async function () {
    const socket = await connectToDevice();
    try {
      await assert.rejects(upgradeSocketToTLS(socket, {deviceCertificate: 'not-a-pem'}), /TLS socket error/);
    } finally {
      socket.destroy();
    }
  });

  it('completes the upgrade without authenticating the device when no certificate is pinned', async function () {
    const socket = await connectToDevice();
    try {
      const secure = await upgradeSocketToTLS(socket, {});
      assert.equal(secure.encrypted, true);
      secure.destroy();
    } finally {
      socket.destroy();
    }
  });
});

describe('pairRecordTlsOptions', function () {
  it('pins the device certificate of the pair record', function () {
    assert.deepEqual(pairRecordTlsOptions(PAIR_RECORD), {
      cert: OTHER_CERT,
      key: OTHER_KEY,
      deviceCertificate: DEVICE_CERT,
    });
  });

  it('pins nothing when the pair record has no device certificate', function () {
    assert.deepEqual(pairRecordTlsOptions({...PAIR_RECORD, DeviceCertificate: null}), {
      cert: OTHER_CERT,
      key: OTHER_KEY,
    });
  });
});
