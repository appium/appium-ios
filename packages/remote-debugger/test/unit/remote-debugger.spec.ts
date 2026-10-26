import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {RemoteDebuggerRealDevice} from '../../lib/remote-debugger-real-device.js';
import {RemoteDebugger} from '../../lib/remote-debugger.js';
import {RpcClientRealDevice} from '../../lib/rpc/index.js';

describe('RemoteDebugger', function () {
  describe('initRpcClient', function () {
    it('should forward targetCreationTimeoutMs to the underlying simulator RPC client', async function () {
      const rd = new RemoteDebugger({targetCreationTimeoutMs: 123456});
      await rd.initRpcClient();
      assert.strictEqual((rd.requireRpcClient() as any)._targetCreationTimeoutMs, 123456);
    });
  });
});

describe('RemoteDebuggerRealDevice', function () {
  let connectStub: sinon.SinonStub;

  beforeEach(function () {
    connectStub = sinon.stub(RpcClientRealDevice.prototype, 'connect').resolves();
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('initRpcClient', function () {
    it('should forward targetCreationTimeoutMs to the underlying real device RPC client', async function () {
      const rd = new RemoteDebuggerRealDevice({udid: 'some-udid', targetCreationTimeoutMs: 654321});
      await rd.initRpcClient();
      assert.ok(rd.requireRpcClient() instanceof RpcClientRealDevice);
      assert.strictEqual((rd.requireRpcClient() as any)._targetCreationTimeoutMs, 654321);
    });

    it('should forward the transport chosen by the caller to the real device RPC client', async function () {
      for (const transport of ['tunnel', 'usbmux'] as const) {
        const rd = new RemoteDebuggerRealDevice({udid: 'some-udid', transport});
        await rd.initRpcClient();
        assert.strictEqual((rd.requireRpcClient() as any).transport, transport);
      }
    });

    it('should leave the transport unset (tunnel) by default', async function () {
      const rd = new RemoteDebuggerRealDevice({udid: 'some-udid'});
      await rd.initRpcClient();
      assert.strictEqual((rd.requireRpcClient() as any).transport, undefined);
    });

    it('should not reject older platform versions explicitly', async function () {
      const rd = new RemoteDebuggerRealDevice({udid: 'some-udid', platformVersion: '17.5', transport: 'usbmux'});
      await rd.initRpcClient();
      assert.ok(rd.requireRpcClient() instanceof RpcClientRealDevice);
    });

    it('should leave connecting to the connect mixin, after its listeners are attached', async function () {
      const rd = new RemoteDebuggerRealDevice({udid: 'some-udid', platformVersion: '18.2'});
      await rd.initRpcClient();
      sinon.assert.notCalled(connectStub);
    });
  });
});
