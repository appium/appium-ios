import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {errors} from '@appium/base-driver';
import sinon from 'sinon';

import type {ExecuteAtomOptions, RemoteDebuggerOptions} from '../../../lib/index.js';
import {executeAtom, executeAtomAsync, callFunction, execute} from '../../../lib/mixins/execute.js';
import {RemoteDebugger} from '../../../lib/remote-debugger.js';
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

    describe('execute_script', function () {
      function makeCtx(...responses: any[]) {
        const send = sinon.stub();
        responses.forEach((response, i) => send.onCall(i).resolves(response));
        const ctx: any = {
          _appIdKey: 'appId',
          _pageIdKey: 'pageId',
          log: {debug: () => {}},
          _rpcClient: {isConnected: true, send, waitForPage: async () => {}},
          requireRpcClient() {
            return this._rpcClient;
          },
        };
        return {ctx, send};
      }
      const promiseObject = {result: {type: 'object', className: 'Promise', objectId: 'promise-1'}};

      it('gives the value of a script that does not return a promise in one call', async function () {
        const {ctx, send} = makeCtx(JSON.stringify({status: 0, value: 2}));
        assert.strictEqual(await executeAtom.call(ctx, 'execute_script', ['return 1 + 1;', []]), 2);
        assert.strictEqual(send.callCount, 1);
        const [method, opts] = send.firstCall.args;
        assert.strictEqual(method, 'Runtime.evaluate');
        assert.strictEqual(opts.returnByValue, false);
        assert.match(opts.expression, /\("return 1 \+ 1;",\[\],true,undefined,undefined\)$/);
      });

      it('waits for a promise that the script returns with Runtime.awaitPromise', async function () {
        const {ctx, send} = makeCtx(promiseObject, JSON.stringify({status: 0, value: 5}));
        assert.strictEqual(await executeAtom.call(ctx, 'execute_script', ['return Promise.resolve(5);', []]), 5);
        assert.strictEqual(send.callCount, 2);
        const [method, opts] = send.secondCall.args;
        assert.strictEqual(method, 'Runtime.awaitPromise');
        assert.strictEqual(opts.promiseObjectId, 'promise-1');
        assert.strictEqual(opts.returnByValue, true);
        assert.strictEqual(opts.appIdKey, 'appId');
        assert.strictEqual(opts.pageIdKey, 'pageId');
      });

      it('waits for the promise on the page that created it', async function () {
        const {ctx, send} = makeCtx(promiseObject, JSON.stringify({status: 0, value: 5}));
        send.onCall(0).callsFake(async () => {
          ctx._pageIdKey = 'otherPage';
          return promiseObject;
        });
        await executeAtom.call(ctx, 'execute_script', ['return Promise.resolve(5);', []]);
        assert.strictEqual(send.secondCall.args[1].pageIdKey, 'pageId');
      });

      it('gives the error of the atom response for a promise', async function () {
        const response = {status: 28, value: {error: 'script timeout', message: 'Timed out'}};
        const {ctx} = makeCtx(promiseObject, JSON.stringify(response));
        await assert.rejects(
          executeAtom.call(ctx, 'execute_script', ['return new Promise(() => {});', []]),
          errors.ScriptTimeoutError,
        );
      });

      it('gives the script timeout to the atom', async function () {
        const {ctx, send} = makeCtx(JSON.stringify({status: 0, value: null}));
        await executeAtom.call(ctx, 'execute_script', ['return;', []], [], {timeoutMs: 500});
        assert.match(send.firstCall.args[1].expression, /\("return;",\[\],true,undefined,500\)$/);
      });

      describe('Node timer for the wait', function () {
        let clock: sinon.SinonFakeTimers;
        beforeEach(function () {
          clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        });
        afterEach(function () {
          clock.restore();
        });
        // wait until the given call is sent, without fake timers
        async function sent(send: sinon.SinonStub, count: number) {
          while (send.callCount < count) {
            await new Promise((resolve) => setImmediate(resolve));
          }
        }

        it('gives a script timeout when the page does not answer in time', async function () {
          const {ctx, send} = makeCtx(promiseObject);
          send.onCall(1).returns(new Promise(() => {}));
          const pending = executeAtom.call(ctx, 'execute_script', ['return new Promise(() => {});', []], [], {
            timeoutMs: 300,
          });
          const rejected = assert.rejects(pending, errors.ScriptTimeoutError);
          await sent(send, 2);
          await clock.tickAsync(1299);
          assert.strictEqual(clock.countTimers(), 1);
          await clock.tickAsync(1);
          await rejected;
        });

        it('keeps the page answer and clears the timer', async function () {
          const {ctx} = makeCtx(promiseObject, JSON.stringify({status: 0, value: 5}));
          const value = await executeAtom.call(ctx, 'execute_script', ['return Promise.resolve(5);', []], [], {
            timeoutMs: 300,
          });
          assert.strictEqual(value, 5);
          assert.strictEqual(clock.countTimers(), 0);
        });

        it('gives the script timeout, not the margin, in the message', async function () {
          const {ctx, send} = makeCtx(promiseObject);
          send.onCall(1).returns(new Promise(() => {}));
          const pending = executeAtom.call(ctx, 'execute_script', ['return new Promise(() => {});', []], [], {
            timeoutMs: 300,
          });
          const rejected = assert.rejects(pending, /after 300 ms/);
          await sent(send, 2);
          await clock.tickAsync(1300);
          await rejected;
        });

        it('has no timer without timeoutMs', async function () {
          const {ctx, send} = makeCtx(promiseObject);
          send.onCall(1).returns(new Promise(() => {}));
          void executeAtom.call(ctx, 'execute_script', ['return new Promise(() => {});', []]);
          await sent(send, 2);
          assert.strictEqual(clock.countTimers(), 0);
        });
      });

      it('logs the timeout that it applies to the wait', async function () {
        for (const [timeoutMs, expected] of [
          [30000, /Waiting up to 30000 ms for the promise/],
          [2 * 60 * 60 * 1000, /Waiting up to 3600000 ms for the promise/],
          [undefined, /Waiting for the promise returned by the script with no timeout/],
        ] as const) {
          const {ctx} = makeCtx(promiseObject, JSON.stringify({status: 0, value: 5}));
          ctx.log = {debug: sinon.spy()};
          await executeAtom.call(ctx, 'execute_script', ['return Promise.resolve(5);', []], [], {timeoutMs});
          assert.ok(
            ctx.log.debug.getCalls().some(({args}: {args: string[]}) => expected.test(args[0])),
            `${timeoutMs}: ${ctx.log.debug.getCalls().map(({args}: {args: string[]}) => args[0]).join(' | ')}`,
          );
        }
      });

      it('gives the gesture to the script evaluation only and the timeout to the atom only', async function () {
        const {ctx, send} = makeCtx(promiseObject, JSON.stringify({status: 0, value: 5}));
        await executeAtom.call(ctx, 'execute_script', ['return Promise.resolve(5);', []], [], {
          timeoutMs: 500,
          emulateUserGesture: true,
        });
        const [[evaluateMethod, evaluateOpts], [waitMethod, waitOpts]] = send.getCalls().map(({args}) => args);
        assert.strictEqual(evaluateMethod, 'Runtime.evaluate');
        assert.strictEqual(evaluateOpts.emulateUserGesture, true);
        assert.match(evaluateOpts.expression, /,true,undefined,500\)$/);
        assert.strictEqual(waitMethod, 'Runtime.awaitPromise');
        assert.ok(!('emulateUserGesture' in waitOpts));
        for (const opts of [evaluateOpts, waitOpts]) {
          assert.ok(!('timeoutMs' in opts));
        }
      });

      it('does not emulate a gesture for the script by default', async function () {
        const {ctx, send} = makeCtx(JSON.stringify({status: 0, value: 2}));
        await executeAtom.call(ctx, 'execute_script', ['return 1 + 1;', []]);
        assert.strictEqual(send.firstCall.args[1].emulateUserGesture, false);
      });

      it('throws an UnknownError, as the atom on unload, when the wait gives no atom response', async function () {
        const missing = {id: 7, error: {code: -32000, message: 'Missing injected script for given promiseObjectId'}};
        for (const [response, message] of [
          [missing, /Missing injected script/],
          [undefined, /page changed/],
        ] as const) {
          const {ctx} = makeCtx(promiseObject, response);
          await assert.rejects(executeAtom.call(ctx, 'execute_script', ['return Promise.resolve(1);', []]), (err) => {
            assert.ok(err instanceof errors.UnknownError);
            assert.match((err as Error).message, message);
            return true;
          });
        }
      });
    });

    it('keeps returnByValue for the other atoms', async function () {
      const send = sinon.stub().resolves({hello: 'world'});
      const ctx: any = {
        _appIdKey: 'appId',
        _pageIdKey: 'pageId',
        log: {debug: () => {}},
        execute,
        _rpcClient: {isConnected: true, send, waitForPage: async () => {}},
        requireRpcClient() {
          return this._rpcClient;
        },
      };
      await executeAtom.call(ctx, 'get_text', [{ELEMENT: 'foo'}]);
      assert.strictEqual(send.firstCall.args[1].returnByValue, true);
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

  it('accepts shared atom options and forwards only evaluation options', async function () {
    const {debuggerInstance, send} = createDebugger({
      platformVersion: '27.0',
      emulateUserGestureForInteractionAtoms: true,
    });
    const evaluate = sinon.spy(debuggerInstance, 'execute');
    // Model an atom-only option added by another feature without exposing it to
    // execute() or the WebKit Runtime.evaluate protocol.
    const options: ExecuteAtomOptions & {atomOnlyOption: number} = {
      emulateUserGesture: false,
      atomOnlyOption: 1000,
    };
    await debuggerInstance.executeAtom('click', [{ELEMENT: 'id'}], [], options);
    assert.deepStrictEqual(evaluate.firstCall.args.slice(1), [undefined, {emulateUserGesture: false}]);
    assert.strictEqual(send.firstCall.args[1].emulateUserGesture, false);
    assert.ok(!('atomOnlyOption' in send.firstCall.args[1]));
    assert.deepStrictEqual(options, {emulateUserGesture: false, atomOnlyOption: 1000});
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
