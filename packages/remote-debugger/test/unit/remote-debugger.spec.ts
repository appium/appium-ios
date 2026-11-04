import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {RemoteDebuggerRealDevice} from '../../lib/remote-debugger-real-device.js';
import {RemoteDebugger} from '../../lib/remote-debugger.js';
import {RpcClientRealDevice} from '../../lib/rpc/index.js';

describe('web security options', function () {
  for (const isRealDevice of [false, true]) {
    for (const disableWebSecurity of [undefined, false, true]) {
      it(`forwards disableWebSecurity=${disableWebSecurity} to the ${isRealDevice ? 'real device' : 'simulator'} client`, async function () {
        const rd = isRealDevice
          ? new RemoteDebuggerRealDevice({udid: 'some-udid', disableWebSecurity})
          : new RemoteDebugger({disableWebSecurity});
        await rd.initRpcClient();
        assert.strictEqual((rd.requireRpcClient() as any).disableWebSecurity, disableWebSecurity ?? false);
      });
    }
  }
});

describe('runtime web security settings', function () {
  it('retains settings applied before connection and across reconnects', async function () {
    const rd = new RemoteDebugger();
    await rd.setDisableWebSecurity(true);
    await rd.initRpcClient();
    assert.strictEqual((rd.requireRpcClient() as any).disableWebSecurity, true);
    await rd.setDisableWebSecurity(false);
    assert.strictEqual((rd.requireRpcClient() as any).disableWebSecurity, false);
    rd.teardown();
    await rd.initRpcClient();
    assert.strictEqual((rd.requireRpcClient() as any).disableWebSecurity, false);
  });

  it('does not retain a rejected update for the next connection', async function (t) {
    const rd = new RemoteDebugger();
    await rd.initRpcClient();
    t.mock.method(rd.requireRpcClient(), 'setDisableWebSecurity', async () => {
      throw new Error('Rejected');
    });
    await assert.rejects(rd.setDisableWebSecurity(true), /Rejected/);
    rd.teardown();
    await rd.initRpcClient();
    assert.strictEqual((rd.requireRpcClient() as any).disableWebSecurity, false);
    await assert.rejects(rd.setDisableWebSecurity(1 as any), TypeError);
  });
});

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

    it('should forward fullPageInitialization to the real device RPC client', async function () {
      const rd = new RemoteDebuggerRealDevice({udid: 'some-udid', fullPageInitialization: true});
      await rd.initRpcClient();
      assert.strictEqual((rd.requireRpcClient() as any).fullPageInitialization, true);
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
