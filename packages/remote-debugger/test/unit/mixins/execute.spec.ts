import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {executeAtom, executeAtomAsync, callFunction, execute} from '../../../lib/mixins/execute.js';
import {RemoteDebugger} from '../../../lib/remote-debugger.js';
import {RemoteMessages} from '../../../lib/rpc/remote-messages.js';
import type {RemoteDebuggerOptions} from '../../../lib/types.js';

describe('execute', function () {
  describe('executeAtom', function () {
    it('should execute atom and call send event on rpc client', async function () {
      const ctx: any = {
        _appIdKey: 'appId',
        _pageIdKey: 'pageId',
        log: {debug: () => {}},
        execute,
        _rpcClient: {
          isConnected: true,
          send: () => ({hello: 'world'}),
          waitForPage: async () => {},
        },
        requireRpcClient() {
          return this._rpcClient;
        },
      };
      const res = await executeAtom.call(ctx, 'find_element', ['css selector', '#id', {ELEMENT: 'foo'}]);
      assert.deepStrictEqual(res, {hello: 'world'});
    });
  });
  describe('.executeAtomAsync', function () {
    it('calls rpcClient.send', async function () {
      const ctx: any = {
        _appIdKey: 'appId',
        _pageIdKey: 'pageId',
        log: {debug: () => {}},
        execute,
        _rpcClient: {
          isConnected: true,
          send: () => ({result: {objectId: 'fake-object-id'}}),
          waitForPage: async () => {},
        },
        requireRpcClient() {
          return this._rpcClient;
        },
      };
      const sendSpy = sinon.spy(ctx._rpcClient, 'send');
      await executeAtomAsync.call(ctx, 'find_element', ['a', 'b', 'c'], ['frame-1', 'frame-2']);
      const callArgs = sendSpy.firstCall.args;
      assert.strictEqual(callArgs[0], 'Runtime.evaluate');
      assert.strictEqual(callArgs[1].appIdKey, 'appId');
    });
  });
  describe('.callFunction', function () {
    it('call rpcClient.send', async function () {
      const ctx: any = {
        _appIdKey: 'fakeAppId',
        _pageIdKey: 'fakePageId',
        log: {debug: () => {}},
        _garbageCollectOnExecute: true,
        garbageCollect() {},
        _rpcClient: {
          send() {
            return {result: {objectId: 'fake-object-id'}};
          },
          isConnected: true,
          waitForPage: async () => {},
        },
        waitForDom() {},
        _pageLoading: true,
        requireRpcClient() {
          return this._rpcClient;
        },
      };
      const sendSpy = sinon.spy(ctx._rpcClient, 'send');
      await callFunction.call(ctx, 'fake-object-id', 'fake_function', ['a', 'b', 'c']);
      assert.strictEqual(sendSpy.firstCall.args[0], 'Runtime.callFunctionOn');
      assert.deepStrictEqual(sendSpy.firstCall.args[1], {
        appIdKey: 'fakeAppId',
        arguments: ['a', 'b', 'c'],
        functionDeclaration: 'fake_function',
        objectId: 'fake-object-id',
        pageIdKey: 'fakePageId',
        returnByValue: true,
      });
    });
  });
});

describe('per-evaluation user gestures', function () {
  function createContext() {
    const messages = new RemoteMessages();
    const evaluations: any[] = [];
    const ctx: any = {
      _appIdKey: 'appId',
      _pageIdKey: '1',
      log: {debug: () => {}},
      execute,
      requireRpcClient() {
        return {
          waitForPage: async () => {},
          send(method: string, opts: any) {
            const command = messages.getRemoteCommand(method, {
              ...opts,
              id: '1',
              connId: 'connection',
              senderId: 'sender',
              targetId: 'target',
            });
            const wire = command.__argument.WIRSocketDataKey;
            assert.ok(wire);
            evaluations.push(JSON.parse(wire.params.message));
            return {result: {value: null}};
          },
        };
      },
    };
    return {ctx, evaluations};
  }

  it('carries the click opt-in through protocol filtering without affecting later atoms or scripts', async function () {
    const {ctx, evaluations} = createContext();
    await executeAtom.call(ctx, 'click', [{ELEMENT: 'element'}], [], {emulateUserGesture: true});
    await executeAtom.call(ctx, 'click', [{ELEMENT: 'element'}]);
    await executeAtom.call(ctx, 'execute_script', ['return navigator.userActivation.isActive', []]);
    await execute.call(ctx, 'window.open("about:blank")');
    assert.deepStrictEqual(
      evaluations.map(({params}) => params.emulateUserGesture),
      [true, false, false, false],
    );
    assert.ok(evaluations.every(({method}) => method === 'Runtime.evaluate'));
  });

  it('supports direct opt-in, explicit false, and the legacy override argument', async function () {
    const {ctx, evaluations} = createContext();
    await execute.call(ctx, '1', undefined, {emulateUserGesture: true});
    await execute.call(ctx, '2', undefined, {emulateUserGesture: false});
    await execute.call(ctx, '3', true);
    await execute.call(ctx, '4', false);
    assert.deepStrictEqual(
      evaluations.map(({params}) => params.emulateUserGesture),
      [true, false, false, false],
    );
    assert.deepStrictEqual(
      evaluations.map(({params}) => params.expression),
      ['1', '2', '3', '4'],
    );
  });

  it('keeps omitted and explicit false protocol options disabled', function () {
    const messages = new RemoteMessages();
    for (const options of [{}, {emulateUserGesture: false}]) {
      const command = messages.getRemoteCommand('Runtime.evaluate', {
        id: '1',
        expression: '1',
        ...options,
      });
      const wire = command.__argument.WIRSocketDataKey;
      assert.ok(wire);
      assert.strictEqual(JSON.parse(wire.params.message).params.emulateUserGesture, false);
    }
  });
});

describe('opt-in iOS 27 interaction-atom policy', function () {
  function createDebugger(options: RemoteDebuggerOptions) {
    const debuggerInstance = new RemoteDebugger(options);
    const send = sinon.stub().resolves({result: {value: null}});
    sinon.stub(debuggerInstance, 'requireRpcClient').returns({
      waitForPage: async () => {},
      send,
    } as any);
    Object.assign(debuggerInstance, {_appIdKey: 'app', _pageIdKey: '1'});
    return {debuggerInstance, send};
  }

  for (const platformVersion of [undefined, '26.5', '27.0', '27.0.1', '28.0']) {
    for (const enabled of [undefined, false, true]) {
      it(`requires opt-in and iOS 27+: version=${platformVersion}, enabled=${enabled}`, async function () {
        const {debuggerInstance, send} = createDebugger({
          platformVersion,
          emulateUserGestureForInteractionAtoms: enabled,
        });
        await debuggerInstance.executeAtom('click', [{ELEMENT: 'id'}]);
        assert.strictEqual(
          send.firstCall.args[1].emulateUserGesture,
          enabled === true && platformVersion !== undefined && platformVersion !== '26.5',
        );
      });
    }
  }

  it('includes only the tested interaction atoms and ordinary text / Enter sequences', async function () {
    const {debuggerInstance, send} = createDebugger({
      platformVersion: '27.0',
      emulateUserGestureForInteractionAtoms: true,
    });
    for (const atom of ['click', 'clear', 'submit'] as const) {
      await debuggerInstance.executeAtom(atom, [{ELEMENT: 'id'}]);
    }
    for (const value of ['hello', ['hello', '\uE007'], '\uE006', '\n', 123, '日本語']) {
      await debuggerInstance.executeAtom('type', [{ELEMENT: 'id'}, value]);
    }
    assert.ok(send.getCalls().every(({args}) => args[1].emulateUserGesture === true));
    send.resetHistory();
    for (const value of ['', [], '\t', '\b', '\u001B', '\uE00C', ['\uE009', 'a'], ['hello', '\uE00C'], '\uE004']) {
      await debuggerInstance.executeAtom('type', [{ELEMENT: 'id'}, value]);
    }
    await debuggerInstance.executeAtom('execute_script', ['window.open("about:blank")', []]);
    await debuggerInstance.executeAtom('find_element', ['css selector', '#id']);
    await debuggerInstance.executeAtom('get_text', [{ELEMENT: 'id'}]);
    await debuggerInstance.execute('window.open("about:blank")');
    assert.ok(send.getCalls().every(({args}) => args[1].emulateUserGesture === false));
  });

  it('lets per-call overrides win without changing subsequent defaults', async function () {
    const {debuggerInstance, send} = createDebugger({
      platformVersion: '27.0',
      emulateUserGestureForInteractionAtoms: true,
    });
    await debuggerInstance.executeAtom('click', [{ELEMENT: 'id'}], [], {emulateUserGesture: false});
    await debuggerInstance.executeAtom('click', [{ELEMENT: 'id'}]);
    await debuggerInstance.executeAtom('execute_script', ['1', []], [], {emulateUserGesture: true});
    await debuggerInstance.executeAtom('execute_script', ['1', []]);
    assert.deepStrictEqual(
      send.getCalls().map(({args}) => args[1].emulateUserGesture),
      [false, true, true, false],
    );
    const legacy = createDebugger({platformVersion: '26.5', emulateUserGestureForInteractionAtoms: true});
    await legacy.debuggerInstance.executeAtom('click', [{ELEMENT: 'id'}], [], {emulateUserGesture: true});
    assert.strictEqual(legacy.send.firstCall.args[1].emulateUserGesture, true);
  });
});
