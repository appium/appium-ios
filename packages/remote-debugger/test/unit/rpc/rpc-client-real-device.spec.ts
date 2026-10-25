import assert from 'node:assert/strict';
import {describe, it, beforeEach} from 'node:test';

import {RpcClientRealDevice} from '../../../lib/rpc/rpc-client-real-device.js';

describe('RpcClientRealDevice', function () {
  let shim: any;

  beforeEach(function () {
    shim = new RpcClientRealDevice({udid: 'test-udid'});
  });

  describe('convertMessage', function () {
    it('should copy __selector to the converted message', function () {
      const result = shim.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: {WIRApplicationIdentifierKey: 'com.example.app'},
      });
      assert.strictEqual(result.__selector, '_rpc_applicationConnected:');
    });

    it('should copy plain object __argument as-is', function () {
      const result = shim.convertMessage({
        __selector: '_rpc_reportConnectedApplicationList:',
        __argument: {WIRApplicationIdentifierKey: 'com.example.app'},
      });
      assert.deepStrictEqual(result.__argument, {
        WIRApplicationIdentifierKey: 'com.example.app',
      });
    });

    it('should convert Buffer values in WIRMessageDataKey to utf8 string', function () {
      const result = shim.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {WIRMessageDataKey: Buffer.from('hello', 'utf8')},
      });
      assert.strictEqual(result.__argument.WIRMessageDataKey, 'hello');
    });

    it('should convert Buffer values in WIRSocketDataKey to utf8 string', function () {
      const result = shim.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {WIRSocketDataKey: Buffer.from('world', 'utf8')},
      });
      assert.strictEqual(result.__argument.WIRSocketDataKey, 'world');
    });

    it('should convert Buffer values in WIRDestinationKey to utf8 string', function () {
      const result = shim.convertMessage({
        __selector: '_rpc_forwardSocketData:',
        __argument: {WIRDestinationKey: Buffer.from('target', 'utf8')},
      });
      assert.strictEqual(result.__argument.WIRDestinationKey, 'target');
    });

    it('should leave non-Buffer values unchanged', function () {
      const result = shim.convertMessage({
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
      const result = shim.convertMessage({
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
      const result = shim.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: {WIRSomeOtherKey: buf},
      });
      assert.strictEqual(result.__argument.WIRSomeOtherKey, buf);
    });

    it('should omit __argument when it is not a plain object', function () {
      const result = shim.convertMessage({
        __selector: '_rpc_applicationConnected:',
        __argument: null,
      });
      assert.ok(!('__argument' in result));
    });
  });

  describe('translateArguments', function () {
    it('should remove WIRConnectionIdentifierKey from the arguments', function () {
      const result = shim.translateArguments({
        WIRConnectionIdentifierKey: 'some-uuid',
        WIRApplicationIdentifierKey: 'com.example.app',
      });
      assert.ok(!('WIRConnectionIdentifierKey' in result));
      assert.strictEqual(result.WIRApplicationIdentifierKey, 'com.example.app');
    });

    it('should return an empty object when args is not a plain object', function () {
      assert.deepStrictEqual(shim.translateArguments(null), {});
      assert.deepStrictEqual(shim.translateArguments(undefined), {});
      assert.deepStrictEqual(shim.translateArguments('string'), {});
    });

    it('should return an empty object when only WIRConnectionIdentifierKey is present', function () {
      assert.deepStrictEqual(shim.translateArguments({WIRConnectionIdentifierKey: 'some-uuid'}), {});
    });

    it('should return args unchanged when WIRConnectionIdentifierKey is absent', function () {
      const args = {WIRApplicationIdentifierKey: 'com.example.app'};
      assert.deepStrictEqual(shim.translateArguments(args), args);
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
      shim.messageHandler.handleMessage = async (msg: any) => {
        if (msg.__selector === 'bad') {
          throw new Error('boom');
        }
        handled.push(msg);
      };
      attach(
        shim,
        makeService(
          gen([
            {__selector: 'bad', __argument: {}},
            {__selector: 'good', __argument: {}},
          ]),
        ),
      );
      await shim.messageListenerTask;
      assert.deepStrictEqual(
        handled.map((m) => m.__selector),
        ['good'],
      );
    });

    it('flags the client as disconnected when the message stream ends on its own', async function () {
      attach(shim, makeService(gen([])));
      await shim.messageListenerTask;
      assert.strictEqual(shim.isConnected, false);
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
      attach(shim, service);
      await shim.disconnect();
      assert.strictEqual(closed, true);
      assert.strictEqual(shim.isConnected, false);
      assert.strictEqual(shim.webInspectorService, undefined);
    });
  });
});
