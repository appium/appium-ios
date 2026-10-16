import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {executeAtom, executeAtomAsync, callFunction, execute} from '../../../lib/mixins/execute.js';
import {RemoteMessages} from '../../../lib/rpc/remote-messages.js';

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
