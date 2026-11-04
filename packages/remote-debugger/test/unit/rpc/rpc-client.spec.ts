import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {AsyncLock} from 'asyncbox';
import sinon from 'sinon';

import {RpcClient} from '../../../lib/rpc/rpc-client.js';

describe('rpc-client', function () {
  describe('page web security', function () {
    for (const fullPageInitialization of [false, true]) {
      for (const disableWebSecurity of [undefined, false, true]) {
        it(`initializes new and provisional targets with full=${fullPageInitialization}, disableWebSecurity=${disableWebSecurity}`, async function () {
          const client = new RpcClient({fullPageInitialization, disableWebSecurity});
          const send = sinon.stub(client, 'send').resolves();
          sinon.stub(client, 'sendToDevice').callsFake(send);
          (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey: '1'};

          for (const [targetId, isProvisional] of [
            ['page-1', false],
            ['page-2', true],
          ] as const) {
            send.resetHistory();
            await client.addTarget(undefined, 'app', {targetId, type: 'page', isProvisional, isPaused: true});

            const overrides = send.getCalls().filter(({args}) => args[0] === 'Page.overrideSetting');
            assert.strictEqual(overrides.length, disableWebSecurity ? 1 : 0);
            if (disableWebSecurity) {
              assert.deepStrictEqual(overrides[0].args[1], {
                appIdKey: 'app',
                pageIdKey: '1',
                targetId,
                setting: 'WebSecurityEnabled',
                value: false,
              });
              const methods = send.getCalls().map(({args}) => args[0]);
              assert.ok(methods.indexOf('Page.enable') < methods.indexOf('Page.overrideSetting'));
              assert.ok(methods.indexOf('Page.overrideSetting') < methods.indexOf('Inspector.initialized'));
              assert.ok(methods.indexOf('Page.overrideSetting') < methods.indexOf('Target.resume'));
            }
            sinon.assert.calledWith(send, 'Target.resume', {appIdKey: 'app', pageIdKey: '1', targetId});
          }
        });
      }

      it(`resumes a target when the override is unsupported (full=${fullPageInitialization})`, async function () {
        const client = new RpcClient({fullPageInitialization, disableWebSecurity: true});
        const send = sinon.stub(client, 'send').resolves();
        sinon.stub(client, 'sendToDevice').callsFake(send);
        send.withArgs('Page.overrideSetting').rejects(new Error('Unknown method'));
        (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey: '1'};
        await client.addTarget(undefined, 'app', {
          targetId: 'page-1',
          type: 'page',
          isProvisional: true,
          isPaused: true,
        });
        sinon.assert.calledWith(send, 'Inspector.initialized');
        sinon.assert.calledWith(send, 'Target.resume');
      });
    }
  });

  describe('runtime web security settings', function () {
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return {promise, resolve};
    }

    async function addPage(client: RpcClient, targetId: string, pageIdKey = '1', isProvisional = false) {
      (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey};
      await client.addTarget(undefined, 'app', {targetId, type: 'page', isProvisional, isPaused: true});
    }

    it('updates all inspected pages and provisional targets, then clears the override', async function () {
      const client = new RpcClient();
      sinon.stub(client, 'send').resolves();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'page-1');
      await addPage(client, 'page-2', '2');
      await addPage(client, 'page-3', '2', true);
      await client.setDisableWebSecurity(true);
      assert.deepStrictEqual(
        send.getCalls().map(({args}) => args[1]),
        [
          {appIdKey: 'app', pageIdKey: '1', targetId: 'page-1', setting: 'WebSecurityEnabled', value: false},
          {appIdKey: 'app', pageIdKey: '2', targetId: 'page-2', setting: 'WebSecurityEnabled', value: false},
          {appIdKey: 'app', pageIdKey: '2', targetId: 'page-3', setting: 'WebSecurityEnabled', value: false},
        ],
      );
      send.resetHistory();
      await client.setDisableWebSecurity(false);
      assert.strictEqual(send.callCount, 3);
      for (const {args} of send.getCalls()) {
        assert.strictEqual(args[0], 'Page.overrideSetting');
        assert.strictEqual(Object.hasOwn(args[1], 'value'), false);
      }
    });

    it('uses the updated policy for future targets and forgets destroyed targets', async function () {
      const client = new RpcClient();
      const initialize = sinon.stub(client, 'send').resolves();
      const update = sinon.stub(client, 'sendToDevice').resolves();
      await client.setDisableWebSecurity(true);
      await addPage(client, 'page-1');
      sinon.assert.calledWith(update, 'Page.overrideSetting', sinon.match({value: false}));
      update.resetHistory();
      await client.removeTarget(undefined, 'app', {targetId: 'page-1'} as any);
      await client.setDisableWebSecurity(false);
      sinon.assert.notCalled(update);
      initialize.resetHistory();
      await addPage(client, 'page-2');
      sinon.assert.notCalled(update);
    });

    for (const fullPageInitialization of [false, true]) {
      for (const blockedDomain of ['Inspector.enable', 'Runtime.enable']) {
        for (const nextValue of [false, true]) {
          it(`allows updates during ${blockedDomain} without stale overrides (full=${fullPageInitialization}, next=${nextValue})`, async function () {
            const client = new RpcClient({fullPageInitialization, disableWebSecurity: !nextValue});
            const blocked = deferred();
            const entered = deferred();
            const initialize = sinon.stub(client, 'send').resolves();
            initialize.withArgs(blockedDomain).callsFake(async () => {
              entered.resolve();
              await blocked.promise;
            });
            const update = sinon.stub(client, 'sendToDevice').resolves();
            const creation = addPage(client, 'provisional', '1', true);
            await entered.promise;
            try {
              // Must complete while the unrelated domain remains blocked.
              await client.setDisableWebSecurity(nextValue);
              assert.strictEqual((client as any).disableWebSecurity, nextValue);
            } finally {
              blocked.resolve();
            }
            await creation;
            const values = update.getCalls().map(({args}) => args[1].value);
            assert.deepStrictEqual(
              values,
              blockedDomain === 'Inspector.enable'
                ? nextValue
                  ? [false]
                  : []
                : nextValue
                  ? [false]
                  : [false, undefined],
            );
          });
        }
      }

      it(`serializes an in-flight security override with runtime updates (full=${fullPageInitialization})`, async function () {
        const client = new RpcClient({fullPageInitialization, disableWebSecurity: true});
        sinon.stub(client, 'send').resolves();
        const blocked = deferred();
        const entered = deferred();
        const update = sinon.stub(client, 'sendToDevice').resolves();
        update.onFirstCall().callsFake(async () => {
          entered.resolve();
          await blocked.promise;
        });
        const creation = addPage(client, 'provisional', '1', true);
        await entered.promise;
        const setting = client.setDisableWebSecurity(false);
        await Promise.resolve();
        sinon.assert.calledOnce(update);
        blocked.resolve();
        await Promise.all([creation, setting]);
        assert.deepStrictEqual(
          update.getCalls().map(({args}) => args[1].value),
          [false, undefined],
        );
        assert.strictEqual((client as any).disableWebSecurity, false);
      });
    }

    it('rolls back updated pages and retains the previous policy when a target rejects the update', async function () {
      const client = new RpcClient();
      sinon.stub(client, 'send').resolves();
      await addPage(client, 'page-1');
      await addPage(client, 'page-2', '2');
      const update = sinon.stub(client, 'sendToDevice').resolves();
      update.onSecondCall().rejects(new Error('Override unavailable'));
      await assert.rejects(client.setDisableWebSecurity(true), /Override unavailable/);
      assert.strictEqual((client as any).disableWebSecurity, false);
      assert.deepStrictEqual(update.thirdCall.args, [
        'Page.overrideSetting',
        {
          appIdKey: 'app',
          pageIdKey: '1',
          targetId: 'page-1',
          setting: 'WebSecurityEnabled',
        },
      ]);
    });

    it('ignores a target that disappeared without retrying against a replacement', async function () {
      const client = new RpcClient();
      sinon.stub(client, 'send').resolves();
      await addPage(client, 'page-1');
      const update = sinon.stub(client, 'sendToDevice').rejects(new Error('Missing target for given targetId'));
      await client.setDisableWebSecurity(true);
      sinon.assert.calledOnce(update);
      await client.setDisableWebSecurity(false);
      sinon.assert.calledOnce(update);
    });
  });

  describe('.send', function () {
    it('should send RPC message to device', async function () {});
    it('should send RPC message to device and retry if target id not found', async function () {
      const {send} = RpcClient.prototype;
      let sendToDeviceCallCount = 0;
      const mockRpcClient = {
        sendToDevice() {
          sendToDeviceCallCount++;
          if (sendToDeviceCallCount === 1) {
            throw new Error('Missing target for given targetId');
          } else if (sendToDeviceCallCount === 2) {
            return 'success';
          }
        },
        waitForTarget() {},
      };
      const sendToDeviceSpy = sinon.spy(mockRpcClient, 'sendToDevice');
      const waitForTargetSpy = sinon.spy(mockRpcClient, 'waitForTarget');
      const opts = {appIdKey: 'appId', pageIdKey: 'pageKey'};
      const res = await send.call(mockRpcClient, 'command', opts, true);
      assert.strictEqual(res, 'success');
      assert.deepStrictEqual(sendToDeviceSpy.firstCall.args, ['command', opts, true]);
      assert.deepStrictEqual(sendToDeviceSpy.secondCall.args, ['command', opts, true]);
      assert.deepStrictEqual(waitForTargetSpy.firstCall.args, ['appId', 'pageKey']);
    });
  });

  describe('.sendToDevice', function () {
    it('should let opts.senderId override the connection senderId while pinning connId', async function () {
      const {sendToDevice} = RpcClient.prototype;
      const getRemoteCommandSpy = sinon.spy((_command: string, opts: any) => ({
        __argument: {...opts},
        __selector: '_rpc_reportIdentifier:',
      }));
      const mockRpcClient = {
        msgId: 1,
        connId: 'connection-id',
        senderId: 'default-sender-id',
        messageHandler: {
          on: sinon.stub(),
          once: sinon.stub(),
          listenerCount: sinon.stub().returns(0),
          prependOnceListener: sinon.stub(),
        },
        remoteMessages: {getRemoteCommand: getRemoteCommandSpy},
        getTarget: sinon.stub().returns(undefined),
        sendMessage: sinon.stub().resolves(),
      };
      const fullOpts = await sendToDevice.call(
        mockRpcClient as any,
        'setConnectionKey',
        {
          senderId: 'automation-session-id',
        } as any,
        false,
      );
      assert.strictEqual(fullOpts.senderId, 'automation-session-id');
      assert.strictEqual(fullOpts.connId, 'connection-id');
    });

    it('should fall back to the connection senderId when opts does not specify one', async function () {
      const {sendToDevice} = RpcClient.prototype;
      const getRemoteCommandSpy = sinon.spy((_command: string, opts: any) => ({
        __argument: {...opts},
        __selector: '_rpc_reportIdentifier:',
      }));
      const mockRpcClient = {
        msgId: 1,
        connId: 'connection-id',
        senderId: 'default-sender-id',
        messageHandler: {
          on: sinon.stub(),
          once: sinon.stub(),
          listenerCount: sinon.stub().returns(0),
          prependOnceListener: sinon.stub(),
        },
        remoteMessages: {getRemoteCommand: getRemoteCommandSpy},
        getTarget: sinon.stub().returns(undefined),
        sendMessage: sinon.stub().resolves(),
      };
      const fullOpts = await sendToDevice.call(mockRpcClient as any, 'setConnectionKey', {} as any, false);
      assert.strictEqual(fullOpts.senderId, 'default-sender-id');
      assert.strictEqual(fullOpts.connId, 'connection-id');
    });
  });

  describe('.selectPage', function () {
    it('should not hang forever waiting for a page-initialized event that never fires', async function () {
      // If the target page was already created earlier (e.g. a Safari process/page reused
      // across separate connections), WebKit never re-emits a "target created" event for it, so
      // the internal ON_PAGE_INITIALIZED_EVENT this waits on never fires either. The fallback
      // timeout must still fire and let the wait continue rather than hang indefinitely.
      const {selectPage} = RpcClient.prototype;
      const mockRpcClient = {
        _pageSelectionLock: new AsyncLock(),
        _pageSelectionMonitor: new EventEmitter(),
        _provisionedPages: new Set(),
        _pendingTargetNotification: null,
        _targetCreationTimeoutMs: 50,
        getTarget: sinon.stub().returns(undefined),
        send: sinon.stub().resolves(),
      };

      await selectPage.call(mockRpcClient as any, 'appId', 'pageKey');
      // Resolving at all (rather than timing out this test) is the assertion.
    });

    it('should resolve immediately once the matching page-initialized event fires', async function () {
      const {selectPage} = RpcClient.prototype;
      const mockRpcClient = {
        _pageSelectionLock: new AsyncLock(),
        _pageSelectionMonitor: new EventEmitter(),
        _provisionedPages: new Set(),
        _pendingTargetNotification: null,
        _targetCreationTimeoutMs: 10 * 60 * 1000,
        getTarget: sinon.stub().returns(undefined),
        send: sinon.stub().resolves(),
      };

      const listenerAttached = new Promise<void>((resolve) => {
        mockRpcClient._pageSelectionMonitor.once('newListener', (event) => {
          if (event === 'onPageInitialized') {
            resolve();
          }
        });
      });
      const selectPagePromise = selectPage.call(mockRpcClient as any, 'appId', 'pageKey');
      await listenerAttached;
      // A non-matching event first, to confirm it's ignored rather than resolving early.
      mockRpcClient._pageSelectionMonitor.emit('onPageInitialized', 'otherApp', 'otherPage');
      mockRpcClient._pageSelectionMonitor.emit('onPageInitialized', 'appId', 'pageKey');
      await selectPagePromise;
    });
  });
});
