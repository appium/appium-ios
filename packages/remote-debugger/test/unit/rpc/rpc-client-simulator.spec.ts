import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {RpcClientSimulator} from '../../../lib/rpc/rpc-client-simulator.js';
import {WebInspectorFrameDecoder, encodeWebInspectorFrame} from '../../../lib/rpc/web-inspector-framing.js';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('RpcClientSimulator', function () {
  let tmpDir: string;
  let socketPath: string;
  let server: net.Server;
  let serverSocket: net.Socket | undefined;
  let received: any[];
  let client: any;

  beforeEach(async function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-sim-'));
    socketPath = path.join(tmpDir, 'inspector.sock');
    received = [];
    server = net.createServer((sock) => {
      serverSocket = sock;
      const decoder = new WebInspectorFrameDecoder();
      sock.on('data', (chunk: Buffer) => received.push(...decoder.push(chunk)));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async function () {
    await client?.disconnect();
    serverSocket?.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('sends framed plists and receives split and batched frames', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    const handled: any[] = [];
    client.messageHandler.handleMessage = async (msg: any) => void handled.push(msg);
    await client.connect();

    const cmd = {__selector: '_rpc_reportIdentifier:', __argument: {WIRConnectionIdentifierKey: 'abc'}};
    await client.sendMessage(cmd);
    await waitFor(() => received.length === 1);
    assert.deepStrictEqual(received[0], cmd);

    await waitFor(() => !!serverSocket);
    // two frames, the first one split mid-way
    const reply = {
      __selector: '_rpc_applicationSentData:',
      __argument: {WIRMessageDataKey: Buffer.from('{"id":1}'), WIRDestinationKey: Buffer.from('dest')},
    };
    const frame = encodeWebInspectorFrame(reply);
    serverSocket!.write(frame.subarray(0, 7));
    await new Promise((r) => setTimeout(r, 20));
    serverSocket!.write(Buffer.concat([frame.subarray(7), encodeWebInspectorFrame(cmd)]));
    await waitFor(() => handled.length === 2);

    assert.strictEqual(handled[0].__selector, reply.__selector);
    assert.strictEqual(handled[0].__argument.WIRMessageDataKey.toString('utf8'), '{"id":1}');
    assert.deepStrictEqual(handled[1], cmd);
  });

  it('delivers messages decoded before a bad frame, then drops the socket', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    const handled: any[] = [];
    client.messageHandler.handleMessage = async (msg: any) => void handled.push(msg);
    await client.connect();
    await waitFor(() => !!serverSocket);
    const garbage = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from('abc')]);
    serverSocket!.write(Buffer.concat([encodeWebInspectorFrame({__selector: 'ok', __argument: {}}), garbage]));
    await waitFor(() => handled.length === 1);
    await waitFor(() => client.isConnected === false);
    assert.strictEqual(handled[0].__selector, 'ok');
  });

  it('rejects sendMessage right after a decode failure, before the socket close event', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    client.messageHandler.handleMessage = async () => {};
    await client.connect();
    await waitFor(() => !!serverSocket);
    const oversize = Buffer.alloc(4);
    oversize.writeUInt32BE(0x7fffffff, 0);
    const sentAfterFailure = new Promise<void>((resolve, reject) => {
      client.once('_rpc_never:', () => {});
      const origReceive = client.receive.bind(client);
      client.receive = async (msg: any) => {
        await origReceive(msg);
        // a handler reacting to the last good message sends a command
        client.sendMessage({__selector: 'late', __argument: {}}).then(
          () => reject(new Error('sendMessage resolved on a destroyed socket')),
          () => resolve(),
        );
      };
    });
    serverSocket!.write(Buffer.concat([encodeWebInspectorFrame({__selector: 'ok', __argument: {}}), oversize]));
    await sentAfterFailure;
    assert.strictEqual(client.isConnected, false);
  });

  it('rejects sendMessage right after disconnect()', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    await client.connect();
    await client.disconnect();
    await assert.rejects(client.sendMessage({__selector: 'x', __argument: {}}), /not connected/);
  });

  it('converts Buffer fields at the top level of a received message', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    const handled: any[] = [];
    client.messageHandler.handleMessage = async (msg: any) => void handled.push(msg);
    await client.connect();
    await client.receive({WIRMessageDataKey: Buffer.from('a'), WIRSocketDataKey: Buffer.from('b'), other: 1});
    assert.deepStrictEqual(handled, [{WIRMessageDataKey: 'a', WIRSocketDataKey: 'b', other: 1}]);
  });

  it('rejects sendMessage when not connected', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    await assert.rejects(client.sendMessage({__selector: 'x', __argument: {}}), /not connected/);
  });

  it('disconnects and closes the socket', async function () {
    client = new RpcClientSimulator({socketPath, udid: 'sim'});
    await client.connect();
    assert.strictEqual(client.isConnected, true);
    await client.disconnect();
    assert.strictEqual(client.isConnected, false);
    await waitFor(() => serverSocket?.destroyed === true || serverSocket?.readableEnded === true);
  });

  it('forwards the real socket path to the message proxy', async function () {
    const proxyPath = path.join(tmpDir, 'proxy.sock');
    const proxyGot: string[] = [];
    const proxy = net.createServer((sock) => sock.on('data', (d) => proxyGot.push(d.toString())));
    await new Promise<void>((resolve) => proxy.listen(proxyPath, resolve));
    try {
      client = new RpcClientSimulator({socketPath, messageProxy: proxyPath, udid: 'sim'});
      await client.connect();
      await waitFor(() => proxyGot.length > 0);
      assert.deepStrictEqual(JSON.parse(proxyGot[0]), {socketPath});
    } finally {
      await client.disconnect();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });
});
