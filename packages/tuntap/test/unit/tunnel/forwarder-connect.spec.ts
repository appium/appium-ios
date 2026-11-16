import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {type AddressInfo, type Socket, connect, createServer as createTcpServer} from 'node:net';
import {after, before, describe, it} from 'node:test';
import {type Server, createServer} from 'node:tls';

import {TunnelForwarder} from '../../../src/index.js';
import {log} from '../../../src/logger.js';
import {DEVICE_CERT, DEVICE_KEY, OTHER_CERT, OTHER_KEY} from '../../tls-certificates.js';

const PEER_RESET_DELAY_MS = 2000;
const TICK_INTERVAL_MS = 50;

/** Runs in a child process: an in-process timer could never fire while the loop under test is frozen. */
const SILENT_PEER_SCRIPT = `
  const net = require('node:net');
  const server = net.createServer((socket) => setTimeout(() => socket.destroy(), ${PEER_RESET_DELAY_MS}));
  server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));
`;

/** Starts a TCP peer that accepts, stays silent, then resets the connection; resolves with its port. */
async function startSilentPeer() {
  const peer = spawn(process.execPath, ['-e', SILENT_PEER_SCRIPT], {stdio: ['ignore', 'pipe', 'inherit']});
  const [chunk] = await once(peer.stdout, 'data');
  return {peer, port: Number(String(chunk))};
}

describe('TunnelForwarder.connectPsk', {skip: process.platform === 'win32' && 'POSIX fd handoff only'}, () => {
  it('keeps the event loop running while the TLS connect waits on the peer', async () => {
    const {peer, port} = await startSilentPeer();
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const forwarder = new TunnelForwarder();
    let ticks = 0;
    const ticker = setInterval(() => ticks++, TICK_INTERVAL_MS);
    const startedAt = Date.now();
    try {
      await assert.rejects(forwarder.connectPsk(socket, {psk: Buffer.alloc(32, 1)}), /SSL_connect/);
      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        elapsedMs >= PEER_RESET_DELAY_MS / 2,
        `connect returned after ${elapsedMs}ms without waiting on the peer`,
      );
      assert.ok(
        ticks > 0,
        `event loop was blocked for the whole ${elapsedMs}ms TLS connect (0 ticks of a ${TICK_INTERVAL_MS}ms interval)`,
      );
    } finally {
      clearInterval(ticker);
      forwarder.stop();
      socket.destroy();
      peer.kill();
    }
  });

  it('does not report a peer that drops the connection mid-connect as a timeout', async () => {
    const {peer, port} = await startSilentPeer();
    const socket = connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const forwarder = new TunnelForwarder();
    try {
      await assert.rejects(forwarder.connectPsk(socket, {psk: Buffer.alloc(32, 1)}), (err: Error) => {
        assert.match(err.message, /SSL_connect/);
        assert.doesNotMatch(err.message, /timed out/);
        return true;
      });
    } finally {
      forwarder.stop();
      socket.destroy();
      peer.kill();
    }
  });
});

type HandshakeOutcome = {completed: true} | {completed: false; error: NodeJS.ErrnoException};

describe('TunnelForwarder.connect', {skip: process.platform === 'win32' && 'POSIX fd handoff only'}, () => {
  let server: Server;
  const serverErrors: NodeJS.ErrnoException[] = [];
  const assertedErrors = new Set<Error>();

  before(async () => {
    server = createServer(
      {cert: DEVICE_CERT, key: DEVICE_KEY, requestCert: true, rejectUnauthorized: false},
      (socket) => socket.on('error', (err) => serverErrors.push(err)),
    );
    server.on('tlsClientError', (err) => serverErrors.push(err));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  /**
   * Rethrows every server-side error other than the ones a test asserted on and the reset a client
   * causes by dropping its connection.
   */
  after(() => {
    server.close();
    const unexpected = serverErrors.filter((err) => err.code !== 'ECONNRESET' && !assertedErrors.has(err));
    if (unexpected.length > 0) {
      throw new AggregateError(unexpected, 'Unexpected errors on the TLS test server');
    }
  });

  /** Opens a plain TCP connection to the TLS server that presents DEVICE_CERT. */
  async function connectToDevice() {
    const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
    await once(socket, 'connect');
    return socket;
  }

  /** Resolves with how the server saw the next TLS handshake end: completed, or failed with the client error. */
  async function nextHandshakeOutcome(): Promise<HandshakeOutcome> {
    const settled = new AbortController();
    try {
      return await Promise.race([
        once(server, 'secureConnection', {signal: settled.signal}).then((): HandshakeOutcome => ({completed: true})),
        once(server, 'tlsClientError', {signal: settled.signal}).then(([error]): HandshakeOutcome => ({
          completed: false,
          error,
        })),
      ]);
    } finally {
      settled.abort();
    }
  }

  it('connects when the device presents the pinned certificate', async () => {
    const outcome = nextHandshakeOutcome();
    const socket = await connectToDevice();
    const forwarder = new TunnelForwarder();
    try {
      await forwarder.connect(socket, {cert: OTHER_CERT, key: OTHER_KEY, deviceCert: DEVICE_CERT});
      assert.deepStrictEqual(await outcome, {completed: true});
    } finally {
      forwarder.stop();
      socket.destroy();
    }
  });

  it('aborts the handshake when the device presents a certificate other than the pinned one', async () => {
    const outcome = nextHandshakeOutcome();
    const socket = await connectToDevice();
    const forwarder = new TunnelForwarder();
    try {
      await assert.rejects(
        forwarder.connect(socket, {cert: OTHER_CERT, key: OTHER_KEY, deviceCert: OTHER_CERT}),
        /does not match the device certificate of its pair record/,
      );
      const seenByServer = await outcome;
      assert.ok(!seenByServer.completed, 'The server completed the handshake with a client that rejected it');
      assertedErrors.add(seenByServer.error);
      assert.match(seenByServer.error.message, /alert/i);
    } finally {
      forwarder.stop();
      socket.destroy();
    }
  });

  it('rejects a pinned certificate that is not valid PEM before sending any TLS data', async () => {
    const peer = createTcpServer();
    peer.listen(0, '127.0.0.1');
    await once(peer, 'listening');
    const accepted = once(peer, 'connection');
    const socket = connect((peer.address() as AddressInfo).port, '127.0.0.1');
    await once(socket, 'connect');
    const [peerSocket] = (await accepted) as [Socket];
    const received: Buffer[] = [];
    const peerErrors: Error[] = [];
    peerSocket.on('data', (chunk: Buffer) => received.push(chunk));
    peerSocket.on('error', (err) => peerErrors.push(err));
    const peerClosed = once(peerSocket, 'close');
    const forwarder = new TunnelForwarder();
    try {
      await assert.rejects(
        forwarder.connect(socket, {cert: OTHER_CERT, key: OTHER_KEY, deviceCert: 'not-a-pem'}),
        /Failed to load device certificate PEM/,
      );
      await peerClosed;
      assert.deepStrictEqual(peerErrors, []);
      assert.strictEqual(Buffer.concat(received).length, 0);
    } finally {
      forwarder.stop();
      socket.destroy();
      peer.close();
    }
  });

  it('connects without authenticating the device and warns when the credentials carry no deviceCert', async (t) => {
    const warn = t.mock.method(log, 'warn');
    const outcome = nextHandshakeOutcome();
    const socket = await connectToDevice();
    const forwarder = new TunnelForwarder();
    try {
      await forwarder.connect(socket, {cert: OTHER_CERT, key: OTHER_KEY});
      assert.deepStrictEqual(await outcome, {completed: true});
      assert.strictEqual(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /no deviceCert, so the device is not authenticated/);
    } finally {
      forwarder.stop();
      socket.destroy();
    }
  });
});
