import assert from 'node:assert/strict';
import {describe, it, beforeEach} from 'node:test';

import {RpcClientRealDevice} from '../../../lib/rpc/rpc-client-real-device.js';

describe('RpcClientRealDevice', function () {
  let client: any;

  beforeEach(function () {
    client = new RpcClientRealDevice({udid: 'test-udid'});
  });

  describe('convertMessage', function () {
    it('should copy __selector to the converted message', function () {
      const result = client.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: {WIRApplicationIdentifierKey: 'com.example.app'},
      });
      assert.strictEqual(result.__selector, '_rpc_applicationConnected:');
    });

    it('should copy plain object __argument as-is', function () {
      const result = client.convertMessage({
        __selector: '_rpc_reportConnectedApplicationList:',
        __argument: {WIRApplicationIdentifierKey: 'com.example.app'},
      });
      assert.deepStrictEqual(result.__argument, {
        WIRApplicationIdentifierKey: 'com.example.app',
      });
    });

    it('should convert Buffer values in WIRMessageDataKey to utf8 string', function () {
      const result = client.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {WIRMessageDataKey: Buffer.from('hello', 'utf8')},
      });
      assert.strictEqual(result.__argument.WIRMessageDataKey, 'hello');
    });

    it('should convert Buffer values in WIRSocketDataKey to utf8 string', function () {
      const result = client.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {WIRSocketDataKey: Buffer.from('world', 'utf8')},
      });
      assert.strictEqual(result.__argument.WIRSocketDataKey, 'world');
    });

    it('should convert Buffer values in WIRDestinationKey to utf8 string', function () {
      const result = client.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {WIRDestinationKey: Buffer.from('target', 'utf8')},
      });
      assert.strictEqual(result.__argument.WIRDestinationKey, 'target');
    });

    it('should leave non-Buffer values unchanged', function () {
      const result = client.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: {
          WIRMessageDataKey: 'already a string',
          WIRApplicationIdentifierKey: 'com.example',
        },
      });
      assert.strictEqual(result.__argument.WIRMessageDataKey, 'already a string');
      assert.strictEqual(result.__argument.WIRApplicationIdentifierKey, 'com.example');
    });

    it('should convert multiple Buffer fields in a single message', function () {
      const result = client.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {
          WIRMessageDataKey: Buffer.from('msg', 'utf8'),
          WIRSocketDataKey: Buffer.from('sock', 'utf8'),
          WIRDestinationKey: Buffer.from('dest', 'utf8'),
        },
      });
      assert.strictEqual(result.__argument.WIRMessageDataKey, 'msg');
      assert.strictEqual(result.__argument.WIRSocketDataKey, 'sock');
      assert.strictEqual(result.__argument.WIRDestinationKey, 'dest');
    });

    it('should not convert Buffer values in non-special keys', function () {
      const buf = Buffer.from('data', 'utf8');
      const result = client.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: {WIRSomeOtherKey: buf},
      });
      assert.strictEqual(result.__argument.WIRSomeOtherKey, buf);
    });

    it('should omit __argument when it is not a plain object', function () {
      const result = client.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: null,
      });
      assert.ok(!('__argument' in result));
    });
  });

  describe('translateArguments', function () {
    it('should remove WIRConnectionIdentifierKey from the arguments', function () {
      const result = client.translateArguments({
        WIRConnectionIdentifierKey: 'some-uuid',
        WIRApplicationIdentifierKey: 'com.example.app',
      });
      assert.ok(!('WIRConnectionIdentifierKey' in result));
      assert.strictEqual(result.WIRApplicationIdentifierKey, 'com.example.app');
    });

    it('should return an empty object when args is not a plain object', function () {
      assert.deepStrictEqual(client.translateArguments(null), {});
      assert.deepStrictEqual(client.translateArguments(undefined), {});
      assert.deepStrictEqual(client.translateArguments('string'), {});
    });

    it('should return an empty object when only WIRConnectionIdentifierKey is present', function () {
      assert.deepStrictEqual(client.translateArguments({WIRConnectionIdentifierKey: 'some-uuid'}), {});
    });

    it('should return args unchanged when WIRConnectionIdentifierKey is absent', function () {
      const args = {WIRApplicationIdentifierKey: 'com.example.app'};
      assert.deepStrictEqual(client.translateArguments(args), args);
    });
  });

  describe('message listener and disconnect', function () {
    function makeService(messages: AsyncIterable<any>) {
      return {
        listenMessage: () => messages,
        stopListeningAsync: async () => {},
        close: async () => {},
        sendMessage: async () => {},
      };
    }

    async function* gen(items: any[], endAfter?: Promise<void>) {
      for (const item of items) {
        yield item;
      }
      if (endAfter) {
        await endAfter;
      }
    }

    function attach(client: any, service: any) {
      client.webInspectorService = service;
      client.isConnected = true;
      client.startMessageListener();
    }

    it('keeps listening after the message handler throws', async function () {
      const handled: any[] = [];
      client.messageHandler.handleMessage = async (msg: any) => {
        if (msg.__selector === 'bad') {
          throw new Error('boom');
        }
        handled.push(msg);
      };
      attach(
        client,
        makeService(
          gen([
            {__selector: 'bad', __argument: {}},
            {__selector: 'good', __argument: {}},
          ]),
        ),
      );
      await client.messageListenerTask;
      assert.deepStrictEqual(
        handled.map((m) => m.__selector),
        ['good'],
      );
    });

    function slowCloseService(items: any[] = []) {
      const state = {closeFinished: false, closeCalls: 0};
      const service: any = makeService(gen(items));
      service.close = async () => {
        state.closeCalls++;
        await new Promise((r) => setTimeout(r, 20));
        state.closeFinished = true;
      };
      return {service, state};
    }

    it('flags the client as disconnected but keeps the service when the message stream ends on its own', async function () {
      const {service, state} = slowCloseService();
      attach(client, service);
      await client.messageListenerTask;
      assert.strictEqual(client.isConnected, false);
      assert.strictEqual(client.webInspectorService, service);
      assert.strictEqual(state.closeCalls, 0);
    });

    it('still cleans up in disconnect() after the message stream ended on its own', async function () {
      const {service, state} = slowCloseService();
      attach(client, service);
      client.on('_rpc_reportConnectedApplicationList:', () => {});
      await client.messageListenerTask;
      await client.disconnect();
      assert.strictEqual(state.closeFinished, true);
      assert.strictEqual(state.closeCalls, 1);
      assert.strictEqual(client.messageHandler.listenerCount('_rpc_reportConnectedApplicationList:'), 0);
      assert.strictEqual(client.webInspectorService, undefined);
      assert.strictEqual(client.messageListenerTask, undefined);
    });

    it('waits for the stale service to be released before reconnecting after the stream ended', async function () {
      const {service, state} = slowCloseService();
      attach(client, service);
      await client.messageListenerTask;
      const fresh = makeService(gen([])) as any;
      fresh.connect = async () => {};
      client.startService = async () => {
        assert.strictEqual(state.closeFinished, true);
        return fresh;
      };
      await client.connect();
      assert.strictEqual(client.webInspectorService, fresh);
      await client.disconnect();
    });

    it('disconnects cleanly even if stopListeningAsync fails, and lets a stale listener finish quietly', async function () {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const service: any = makeService(gen([], gate));
      let closed = false;
      service.stopListeningAsync = async () => {
        throw new Error('stop failed');
      };
      service.close = async () => {
        closed = true;
        release();
      };
      attach(client, service);
      await client.disconnect();
      assert.strictEqual(closed, true);
      assert.strictEqual(client.isConnected, false);
      assert.strictEqual(client.webInspectorService, undefined);
    });
  });

  describe('connect', function () {
    function fakeService(overrides: Record<string, any> = {}) {
      // a live connection: the stream stays open until stopListeningAsync()
      let stop!: () => void;
      const pending = new Promise<{done: true; value: undefined}>((resolve) => {
        stop = () => resolve({done: true, value: undefined});
      });
      return {
        connect: async () => {},
        listenMessage: () => ({[Symbol.asyncIterator]: () => ({next: () => pending})}),
        stopListeningAsync: async () => stop(),
        close: async () => {},
        sendMessage: async () => {},
        ...overrides,
      };
    }

    it('reports a connection failure from connect() and closes the service', async function () {
      let closed = false;
      client.startService = async () =>
        fakeService({
          connect: async () => {
            throw new Error('service refused');
          },
          close: async () => {
            closed = true;
          },
        });
      await assert.rejects(client.connect(), /service refused/);
      assert.strictEqual(closed, true);
      assert.strictEqual(client.isConnected, false);
      assert.strictEqual(client.webInspectorService, undefined);
    });

    it('adds the device to the error and keeps its code', async function () {
      const err: any = new Error('no tunnel');
      err.code = 'ERR_TUNNEL_AVAILABILITY';
      client.startService = async () => {
        throw err;
      };
      await assert.rejects(client.connect(), (e: any) => {
        assert.strictEqual(e.code, 'ERR_TUNNEL_AVAILABILITY');
        assert.match(e.message, /test-udid.*no tunnel/);
        return true;
      });
    });

    it('rethrows non-Error rejections unchanged', async function () {
      client.startService = () => Promise.reject('plain failure');
      await assert.rejects(client.connect(), (e: any) => e === 'plain failure');
    });

    it('is connected once the service connected', async function () {
      const service = fakeService();
      client.startService = async () => service;
      await client.connect();
      assert.strictEqual(client.webInspectorService, service);
      assert.strictEqual(client.isConnected, true);
      await client.disconnect();
    });
  });

  describe('sendMessage', function () {
    it('fails clearly instead of reconnecting silently after the connection was lost', async function () {
      client.webInspectorService = {sendMessage: async () => {}};
      client.isConnected = false;
      await assert.rejects(client.sendMessage({__selector: 'x', __argument: {}}), /not connected/);
    });
  });
});
