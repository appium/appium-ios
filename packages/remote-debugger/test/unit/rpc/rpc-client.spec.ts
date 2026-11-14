import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {AsyncLock} from 'asyncbox';
import sinon from 'sinon';

import {NEW_APP_CONNECTED_ERROR, RpcClient} from '../../../lib/rpc/rpc-client.js';
import {connectedClient, addPage, deferred} from '../helpers/page-settings.js';

describe('rpc-client', function () {
  describe('page web security', function () {
    for (const fullPageInitialization of [false, true]) {
      for (const webSecurityEnabled of [undefined, false, true]) {
        it(`initializes new and provisional targets with full=${fullPageInitialization}, WebSecurityEnabled=${webSecurityEnabled}`, async function () {
          const client = connectedClient({
            fullPageInitialization,
            webInspectorSettings: {pageSettings: {WebSecurityEnabled: webSecurityEnabled}},
          });
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
            assert.strictEqual(overrides.length, webSecurityEnabled === undefined ? 0 : 1);
            if (webSecurityEnabled !== undefined) {
              assert.deepStrictEqual(overrides[0].args[1], {
                appIdKey: 'app',
                pageIdKey: '1',
                targetId,
                setting: 'WebSecurityEnabled',
                value: webSecurityEnabled,
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
        const client = connectedClient({
          fullPageInitialization,
          webInspectorSettings: {pageSettings: {WebSecurityEnabled: false}},
        });
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
    it('updates all inspected pages and provisional targets, then clears the override', async function () {
      const client = connectedClient();
      sinon.stub(client, 'send').resolves();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'page-1');
      await addPage(client, 'page-2', {pageIdKey: '2'});
      await addPage(client, 'page-3', {pageIdKey: '2', isProvisional: true});
      await client.setWebInspectorPageSettings({pageSettings: {WebSecurityEnabled: false}});
      assert.deepStrictEqual(
        send.getCalls().map(({args}) => args[1]),
        [
          {appIdKey: 'app', pageIdKey: '1', targetId: 'page-1', setting: 'WebSecurityEnabled', value: false},
          {appIdKey: 'app', pageIdKey: '2', targetId: 'page-2', setting: 'WebSecurityEnabled', value: false},
          {appIdKey: 'app', pageIdKey: '2', targetId: 'page-3', setting: 'WebSecurityEnabled', value: false},
        ],
      );
      send.resetHistory();
      await client.setWebInspectorPageSettings({});
      assert.strictEqual(send.callCount, 3);
      for (const {args} of send.getCalls()) {
        assert.strictEqual(args[0], 'Page.overrideSetting');
        assert.strictEqual(Object.hasOwn(args[1], 'value'), false);
      }
    });

    it('uses the updated policy for future targets and forgets destroyed targets', async function () {
      const client = connectedClient();
      const initialize = sinon.stub(client, 'send').resolves();
      const update = sinon.stub(client, 'sendToDevice').resolves();
      await client.setWebInspectorPageSettings({pageSettings: {WebSecurityEnabled: false}});
      await addPage(client, 'page-1');
      sinon.assert.calledWith(update, 'Page.overrideSetting', sinon.match({value: false}));
      update.resetHistory();
      await client.removeTarget(undefined, 'app', {targetId: 'page-1'} as any);
      await client.setWebInspectorPageSettings({});
      sinon.assert.notCalled(update);
      initialize.resetHistory();
      await addPage(client, 'page-2');
      sinon.assert.notCalled(update);
    });

    for (const fullPageInitialization of [false, true]) {
      for (const blockedDomain of ['Inspector.enable', 'Runtime.enable']) {
        for (const nextValue of [false, true]) {
          it(`allows updates during ${blockedDomain} without stale overrides (full=${fullPageInitialization}, next=${nextValue})`, async function () {
            const client = connectedClient({
              fullPageInitialization,
              webInspectorSettings: nextValue ? {} : {pageSettings: {WebSecurityEnabled: false}},
            });
            const blocked = deferred();
            const entered = deferred();
            const initialize = sinon.stub(client, 'send').resolves();
            initialize.withArgs(blockedDomain).callsFake(async () => {
              entered.resolve();
              await blocked.promise;
            });
            const update = sinon.stub(client, 'sendToDevice').resolves();
            const creation = addPage(client, 'provisional', {isProvisional: true});
            await entered.promise;
            try {
              // Must complete while the unrelated domain remains blocked.
              await client.setWebInspectorPageSettings(nextValue ? {pageSettings: {WebSecurityEnabled: false}} : {});
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
        const client = connectedClient({
          fullPageInitialization,
          webInspectorSettings: {pageSettings: {WebSecurityEnabled: false}},
        });
        sinon.stub(client, 'send').resolves();
        const blocked = deferred();
        const entered = deferred();
        const update = sinon.stub(client, 'sendToDevice').resolves();
        update.onFirstCall().callsFake(async () => {
          entered.resolve();
          await blocked.promise;
        });
        const creation = addPage(client, 'provisional', {isProvisional: true});
        await entered.promise;
        const setting = client.setWebInspectorPageSettings({});
        await Promise.resolve();
        sinon.assert.calledOnce(update);
        blocked.resolve();
        await Promise.all([creation, setting]);
        assert.deepStrictEqual(
          update.getCalls().map(({args}) => args[1].value),
          [false, undefined],
        );
      });
    }

    it('rolls back updated pages and retains the previous policy when a target rejects the update', async function () {
      const client = connectedClient();
      sinon.stub(client, 'send').resolves();
      await addPage(client, 'page-1');
      await addPage(client, 'page-2', {pageIdKey: '2'});
      const update = sinon.stub(client, 'sendToDevice').resolves();
      update.onSecondCall().rejects(new Error('Override unavailable'));
      await assert.rejects(
        client.setWebInspectorPageSettings({pageSettings: {WebSecurityEnabled: false}}),
        /Override unavailable/,
      );
      assert.deepStrictEqual(update.thirdCall.args.slice(0, 2), [
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
      const client = connectedClient();
      sinon.stub(client, 'send').resolves();
      await addPage(client, 'page-1');
      const update = sinon.stub(client, 'sendToDevice').rejects(new Error('Missing target for given targetId'));
      await client.setWebInspectorPageSettings({pageSettings: {WebSecurityEnabled: false}});
      sinon.assert.calledOnce(update);
      await client.setWebInspectorPageSettings({});
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
      assert.deepStrictEqual(sendToDeviceSpy.firstCall.args, ['command', opts, true, undefined]);
      assert.deepStrictEqual(sendToDeviceSpy.secondCall.args, ['command', opts, true, undefined]);
      assert.deepStrictEqual(waitForTargetSpy.firstCall.args, ['appId', 'pageKey', undefined]);
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

    function replyingClient(argument: object, replies: [string, Error | null][], sendError?: Error) {
      const messageHandler = new EventEmitter();
      return {
        msgId: 1,
        connId: 'connection-id',
        senderId: 'sender-id',
        messageHandler,
        remoteMessages: {
          getRemoteCommand: () => ({
            __argument: structuredClone(argument),
            __selector: '_rpc_forwardSocketData:',
          }),
        },
        getTarget: sinon.stub().returns(undefined),
        sendMessage: sinon.stub().callsFake(async () => {
          if (sendError) {
            throw sendError;
          }
          setImmediate(() => {
            for (const [id, err] of replies) {
              messageHandler.emit(id, err, 'ok');
            }
          });
        }),
      };
    }

    const wrapped = {WIRSocketDataKey: {method: 'Target.sendMessageToTarget', params: {}}};

    const answered: [string, object, [string, Error | null][]][] = [
      [
        'wrapped',
        wrapped,
        [
          ['2', null],
          ['1', null],
        ],
      ],
      ['direct', {WIRSocketDataKey: {id: 1, method: 'Target.getTargets'}}, [['1', null]]],
    ];
    for (const [kind, argument, replies] of answered) {
      it(`should leave no listeners once a ${kind} command is answered`, async function () {
        const client = replyingClient(argument, replies);
        assert.strictEqual(
          await RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}),
          'ok',
        );
        assert.deepStrictEqual(client.messageHandler.eventNames(), []);
      });
    }

    it('should leave no listeners after a command that does not wait for a reply', async function () {
      const client = replyingClient({}, []);
      await RpcClient.prototype.sendToDevice.call(client as any, 'setConnectionKey', {}, false);
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should leave no listeners once a wrapped command that does not wait is acknowledged', async function () {
      const client = replyingClient(wrapped, [
        ['2', null],
        ['1', null],
      ]);
      await RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}, false);
      await new Promise(setImmediate);
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should leave no listeners when the wrapper reports an error', async function () {
      const client = replyingClient(wrapped, [['2', new Error('Missing target for given targetId')]]);
      await assert.rejects(RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}), {
        message: 'Missing target for given targetId',
      });
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should leave no listeners when the reply reports an error', async function () {
      const client = replyingClient(wrapped, [['1', new Error('Target closed')]]);
      await assert.rejects(RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}), {
        message: /Target closed/,
      });
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should reject when the wrapper reports an error after an acknowledgement', async function () {
      const client = replyingClient(wrapped, [
        ['2', null],
        ['2', new Error('Missing target for given targetId')],
      ]);
      await assert.rejects(RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}), {
        message: 'Missing target for given targetId',
      });
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should leave no listeners when the command cannot be sent', async function () {
      const client = replyingClient(wrapped, [], new Error('socket closed'));
      await assert.rejects(RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}), {
        message: 'socket closed',
      });
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should leave no listeners when a wrapped command that does not wait cannot be sent', async function () {
      const client = replyingClient(wrapped, [], new Error('socket closed'));
      await assert.rejects(
        RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}, false),
        {message: 'socket closed'},
      );
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });

    it('should keep listening for the acknowledgement of a command that does not wait and has a signal', async function () {
      const client = replyingClient(wrapped, [
        ['2', null],
        ['1', null],
      ]);
      const signal = new AbortController().signal;
      await RpcClient.prototype.sendToDevice.call(client as any, 'command', {appIdKey: 'PID:1'}, false, signal);
      assert.deepStrictEqual(
        client.messageHandler
          .eventNames()
          .map(String)
          .sort((a, b) => a.localeCompare(b)),
        ['1', '2'],
      );
      await new Promise(setImmediate);
      assert.deepStrictEqual(client.messageHandler.eventNames(), []);
    });
  });

  describe('.selectApp', function () {
    const page = {1: {WIRTitleKey: '', WIRURLKey: 'https://example.test/'}};
    const unrelated = {WIRApplicationIdentifierKey: 'PID:2'};
    const reconnect = {WIRApplicationIdentifierKey: 'PID:1'};

    function mockClient(
      connects: Record<string, string>[],
      sendResult = async (): Promise<unknown> => ['PID:1', page],
    ) {
      const messageHandler = new EventEmitter();
      const send = sinon.stub().callsFake(async () => {
        for (const dict of connects) {
          await new Promise(setImmediate);
          messageHandler.emit('_rpc_applicationConnected:', null, dict);
        }
        return await sendResult();
      });
      return {messageHandler, send};
    }

    it('should keep waiting when an unrelated application connects', async function () {
      const client = mockClient([
        unrelated,
        {WIRApplicationIdentifierKey: 'PID:3', WIRApplicationBundleIdentifierKey: 'com.apple.mobilesafari'},
      ]);
      const result = await RpcClient.prototype.selectApp.call(client as any, 'PID:1', 'io.appium.example');
      assert.deepStrictEqual(result, ['PID:1', page]);
      assert.deepStrictEqual(client.send.firstCall.args.slice(0, 2), ['connectToApp', {appIdKey: 'PID:1'}]);
    });

    for (const [kind, connects] of [
      ['the application reconnects', [reconnect]],
      [
        'a proxy for the application connects',
        [{WIRApplicationIdentifierKey: 'PID:4', WIRHostApplicationIdentifierKey: 'PID:1'}],
      ],
      ['the application reconnects after an unrelated one', [unrelated, reconnect]],
    ] as const) {
      it(`should reject when ${kind}`, async function () {
        await assert.rejects(RpcClient.prototype.selectApp.call(mockClient([...connects]) as any, 'PID:1'), {
          message: NEW_APP_CONNECTED_ERROR,
        });
      });
    }

    it('should reject when the application relaunches under a new identifier key', async function () {
      const relaunch = {WIRApplicationIdentifierKey: 'PID:5', WIRApplicationBundleIdentifierKey: 'io.appium.example'};
      await assert.rejects(
        RpcClient.prototype.selectApp.call(mockClient([relaunch]) as any, 'PID:1', 'io.appium.example'),
        {message: NEW_APP_CONNECTED_ERROR},
      );
    });

    it('should stop listening once the connect request resolves', async function () {
      const client = mockClient([unrelated]);
      await RpcClient.prototype.selectApp.call(client as any, 'PID:1');
      assert.strictEqual(client.messageHandler.listenerCount('_rpc_applicationConnected:'), 0);
    });

    it('should stop listening once the connect request rejects', async function () {
      const client = mockClient([unrelated], async () => {
        throw new Error('socket closed');
      });
      await assert.rejects(RpcClient.prototype.selectApp.call(client as any, 'PID:1'), {message: 'socket closed'});
      assert.strictEqual(client.messageHandler.listenerCount('_rpc_applicationConnected:'), 0);
    });

    it('should keep listening while the connect request is pending and only unrelated applications connect', async function () {
      const client = mockClient([unrelated], () => new Promise(() => {}));
      let settled = false;
      void RpcClient.prototype.selectApp.call(client as any, 'PID:1').then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      assert.strictEqual(settled, false);
      assert.strictEqual(client.messageHandler.listenerCount('_rpc_applicationConnected:'), 1);
    });

    it('should give up and stop listening when the connect request gets no reply', async function () {
      const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      try {
        const client = mockClient([unrelated], () => new Promise(() => {}));
        let error: Error | undefined;
        void RpcClient.prototype.selectApp.call(client as any, 'PID:1').catch((err: Error) => (error = err));
        await new Promise(setImmediate);
        await new Promise(setImmediate);
        await clock.runAllAsync();
        await new Promise(setImmediate);
        assert.match(String(error?.message), /PID:1.*connectToApp/);
        assert.strictEqual(client.messageHandler.listenerCount('_rpc_applicationConnected:'), 0);
        assert.strictEqual(client.send.firstCall.args[3]?.aborted, true);
      } finally {
        clock.restore();
      }
    });

    it('should stop listening as soon as the application reconnects while the connect request is pending', async function () {
      const client = mockClient([reconnect], () => new Promise(() => {}));
      await assert.rejects(RpcClient.prototype.selectApp.call(client as any, 'PID:1'), {
        message: NEW_APP_CONNECTED_ERROR,
      });
      assert.strictEqual(client.messageHandler.listenerCount('_rpc_applicationConnected:'), 0);
      assert.strictEqual(client.send.firstCall.args[3]?.aborted, true);
    });

    it('should stop listening as soon as the connect notification fails while the connect request is pending', async function () {
      const messageHandler = new EventEmitter();
      const send = sinon.stub().callsFake(async () => {
        await new Promise(setImmediate);
        messageHandler.emit('_rpc_applicationConnected:', new Error('bad message'));
        return await new Promise(() => {});
      });
      await assert.rejects(RpcClient.prototype.selectApp.call({messageHandler, send} as any, 'PID:1'), {
        message: 'bad message',
      });
      assert.strictEqual(messageHandler.listenerCount('_rpc_applicationConnected:'), 0);
      assert.strictEqual(send.firstCall.args[3]?.aborted, true);
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
