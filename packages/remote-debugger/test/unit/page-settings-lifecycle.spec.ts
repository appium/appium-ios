import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {toPageOverrides, type WebInspectorPageSettings} from '../../lib/page-overrides.js';
import {RpcClient} from '../../lib/rpc/rpc-client.js';
import type {AppIdKey, RemoteCommand, RpcClientOptions} from '../../lib/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

function connectedClient(options: RpcClientOptions = {}) {
  const client = new RpcClient(options);
  client.isConnected = true;
  const initialize = sinon.stub(client, 'send').resolves();
  return {client, initialize};
}

async function addPage(client: RpcClient, targetId: string, pageIdKey = '1', appIdKey: AppIdKey = 'app') {
  (client as any)._pendingTargetNotification = {appIdKey, pageIdKey};
  await client.addTarget(undefined, appIdKey, {targetId, type: 'page', isProvisional: false, isPaused: true});
}

function commandFrom(message: RemoteCommand) {
  const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
  const command = JSON.parse(wrapper.params.message);
  return {...command, targetId: wrapper.params.targetId};
}

function reply(client: RpcClient, id: number) {
  (client as any).messageHandler.emit(String(id), null, {});
}

function assertNoResponseListeners(client: RpcClient) {
  const events: (string | symbol)[] = (client as any).messageHandler.eventNames();
  assert.deepStrictEqual(
    events.filter((name) => /^\d+$/.test(String(name))),
    [],
  );
}

describe('page settings connection lifecycle', function () {
  for (const fullPageInitialization of [false, true]) {
    for (const update of ['unchanged', 'extended', 'cleared']) {
      it(`repairs failed initialization overrides before an ${update} update (full=${fullPageInitialization})`, async function () {
        const settings: WebInspectorPageSettings = {
          pageSettings: {ImagesEnabled: false, WebSecurityEnabled: false},
          userPreferences: {PrefersColorScheme: 'Dark'},
          userAgent: 'Initial/1',
        };
        const {client, initialize} = connectedClient({fullPageInitialization, webInspectorSettings: settings});
        const state = new Map<string, unknown>();
        let failing = true;
        const send = sinon.stub(client, 'sendMessage').callsFake(async (message) => {
          const command = commandFrom(message);
          if (failing && command.params.setting !== 'ImagesEnabled') {
            (client as any).messageHandler.emit(String(command.id), {
              code: -32603,
              message: 'Temporary protocol failure',
            });
            return;
          }
          state.set(command.params.setting ?? command.params.name ?? 'userAgent', command.params.value);
          reply(client, command.id);
        });
        await addPage(client, 'first');
        sinon.assert.calledWith(initialize, 'Inspector.initialized');
        sinon.assert.calledWith(initialize, 'Target.resume');
        assert.deepStrictEqual([...state], [['ImagesEnabled', false]]);
        // An unsuccessful repair must reject, including an unchanged policy.
        await assert.rejects(client.setWebInspectorPageSettings(settings), /Temporary protocol failure/);
        failing = false;
        send.resetHistory();
        const next: WebInspectorPageSettings =
          update === 'cleared'
            ? {}
            : update === 'extended'
              ? {...settings, pageSettings: {...settings.pageSettings, ScriptEnabled: false}}
              : settings;
        await client.setWebInspectorPageSettings(next);
        assert.equal(send.callCount, update === 'unchanged' ? 3 : 4);
        const expected = new Map(
          [...toPageOverrides(next).values()].map((override) => [
            override.params.setting ?? override.params.name ?? 'userAgent',
            override.value,
          ]),
        );
        assert.deepStrictEqual(new Map([...state].filter(([, value]) => value !== undefined)), expected);
        send.resetHistory();
        await client.setWebInspectorPageSettings(next);
        sinon.assert.notCalled(send);
        assertNoResponseListeners(client);
      });
    }
  }

  for (const settings of [
    {pageSettings: {WebSecurityEnabled: false}},
    {userPreferences: {PrefersColorScheme: 'Dark' as const}},
    {userAgent: 'Rejected/1'},
  ]) {
    for (const clear of [false, true]) {
      it(`replaces persistently rejected initialization values (${JSON.stringify(settings)}, clear=${clear})`, async function () {
        const {client} = connectedClient({webInspectorSettings: settings});
        const initial = [...toPageOverrides(settings).values()][0];
        const send = sinon.stub(client, 'sendToDevice').callsFake(async (_method, opts) => {
          if (opts.value === initial.value) {
            throw Object.assign(new Error('Rejected value'), {code: -32000});
          }
        });
        await addPage(client, 'first');
        await assert.rejects(client.setWebInspectorPageSettings(settings), /Rejected value/);
        send.resetHistory();
        const next: WebInspectorPageSettings = clear
          ? {}
          : initial.method === 'Page.overrideSetting'
            ? {pageSettings: {WebSecurityEnabled: true}}
            : initial.method === 'Page.overrideUserPreference'
              ? {userPreferences: {PrefersColorScheme: 'Light'}}
              : {userAgent: 'Accepted/2'};
        await client.setWebInspectorPageSettings(next);
        sinon.assert.calledOnce(send);
        assert.equal(send.firstCall.args[1].value, [...toPageOverrides(next).values()][0]?.value);
        send.resetHistory();
        await client.setWebInspectorPageSettings(next);
        sinon.assert.notCalled(send);
        await addPage(client, 'future', '2');
        assert.equal(send.callCount, clear ? 0 : 1);
      });
    }
  }

  it('retains pending repairs when replacing them succeeds but a later target rejects the batch', async function () {
    const {client} = connectedClient({webInspectorSettings: {userAgent: 'Old/1'}});
    let failOld = true;
    let failNew = true;
    const state = new Map<string, unknown>();
    const send = sinon.stub(client, 'sendToDevice').callsFake(async (_method, opts) => {
      if ((failOld && opts.value === 'Old/1') || (failNew && opts.targetId === 'second' && opts.value === 'New/2')) {
        throw new Error('Rejected value');
      }
      state.set(String(opts.targetId), opts.value);
    });
    await addPage(client, 'first');
    await addPage(client, 'second', '2');
    await assert.rejects(client.setWebInspectorPageSettings({userAgent: 'New/2'}), /Rejected value/);
    assert.equal(state.get('first'), 'New/2');
    // The failed rollback must still be repaired even though the retained policy is unchanged.
    await assert.rejects(client.setWebInspectorPageSettings({userAgent: 'Old/1'}), /Rejected value/);
    failOld = false;
    failNew = false;
    await client.setWebInspectorPageSettings({userAgent: 'Old/1'});
    assert.deepStrictEqual([...state.values()], ['Old/1', 'Old/1']);
    send.resetHistory();
    await client.setWebInspectorPageSettings({userAgent: 'Old/1'});
    sinon.assert.notCalled(send);
  });

  for (const [code, message] of [
    [-32601, "'Page.overrideSetting' was not found"],
    [-32602, "Invalid parameters for method 'Page.overrideSetting'"],
  ] as const) {
    it(`does not queue unsupported initialization overrides for repair (${code})`, async function () {
      const settings = {pageSettings: {ImagesEnabled: false}};
      const {client, initialize} = connectedClient({webInspectorSettings: settings});
      const send = sinon.stub(client, 'sendMessage').callsFake(async (messageToSend) => {
        const command = commandFrom(messageToSend);
        if (command.method === 'Page.overrideSetting') {
          (client as any).messageHandler.emit(String(command.id), {code, message});
        } else {
          reply(client, command.id);
        }
      });
      await addPage(client, 'first');
      sinon.assert.calledWith(initialize, 'Target.resume');
      send.resetHistory();
      await client.setWebInspectorPageSettings(settings);
      sinon.assert.notCalled(send);
      await client.setWebInspectorPageSettings({...settings, userAgent: 'Test/1'});
      sinon.assert.calledOnce(send);
      assert.equal(commandFrom(send.firstCall.args[0]).method, 'Page.overrideUserAgent');
      assertNoResponseListeners(client);
    });
  }

  for (const fullPageInitialization of [false, true]) {
    for (const reconnect of [false, true]) {
      it(`does not register stale initialization after disconnect (full=${fullPageInitialization}, reconnect=${reconnect})`, async function () {
        const {client, initialize} = connectedClient({
          fullPageInitialization,
          webInspectorSettings: {userAgent: 'Old/1'},
        });
        const entered = deferred();
        const release = deferred();
        initialize
          .withArgs('Page.enable')
          .onFirstCall()
          .callsFake(async () => {
            entered.resolve();
            await release.promise;
          });
        const send = sinon.stub(client, 'sendToDevice').resolves();
        const creation = addPage(client, 'same-target');
        await entered.promise;
        await client.disconnect();
        if (reconnect) {
          client.isConnected = true;
          // Reuse the target key before old initialization finishes. Its finally
          // block must not remove this connection's newly registered entry.
          await addPage(client, 'same-target', '2');
          send.resetHistory();
        }
        release.resolve();
        await creation;
        sinon.assert.notCalled(send);
        if (reconnect) {
          await client.setWebInspectorPageSettings({userAgent: 'New/2'});
          sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {pageIdKey: '2', value: 'New/2'});
        } else {
          await assert.rejects(client.setWebInspectorPageSettings({userAgent: 'New/2'}), /disconnected/);
          sinon.assert.notCalled(send);
        }
        assert.ok(!initialize.getCalls().some(({args}) => args[0] === 'Target.resume' && args[1].pageIdKey === '1'));
      });
    }

    it(`times out initialization without blocking other targets (full=${fullPageInitialization})`, async function () {
      const {client, initialize} = connectedClient({
        fullPageInitialization,
        webInspectorSettings: {userAgent: 'Initial/1'},
      });
      const entered = deferred();
      const observed: {targetId: string; value: string}[] = [];
      sinon.stub(client, 'sendMessage').callsFake(async (message) => {
        const command = commandFrom(message);
        observed.push({targetId: command.targetId, value: command.params.value});
        if (command.targetId === 'hung') {
          entered.resolve();
        } else {
          reply(client, command.id);
        }
      });
      const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      try {
        const hung = addPage(client, 'hung');
        await entered.promise;
        const healthy = addPage(client, 'healthy', '2');
        await clock.tickAsync(10000);
        await Promise.all([hung, healthy]);
        for (const method of ['Runtime.enable', 'Inspector.initialized', 'Target.resume']) {
          sinon.assert.calledWith(initialize, method, sinon.match({targetId: 'hung'}));
        }
        await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
        assert.deepStrictEqual(observed, [
          {targetId: 'hung', value: 'Initial/1'},
          {targetId: 'healthy', value: 'Initial/1'},
          {targetId: 'healthy', value: 'Next/2'},
        ]);
        assertNoResponseListeners(client);
      } finally {
        clock.restore();
      }
    });
  }

  it('aborts a pending override and queued update immediately on transport disconnect', async function () {
    const {client} = connectedClient({webInspectorSettings: {userAgent: 'Initial/1'}});
    const entered = deferred();
    const wire = sinon.stub(client, 'sendMessage').callsFake(async () => {
      entered.resolve();
    });
    const creation = addPage(client, 'old');
    await entered.promise;
    const rejected = assert.rejects(client.setWebInspectorPageSettings({userAgent: 'Queued/2'}), /disconnected/);
    // A socket close sets isConnected even when disconnect() was not called.
    client.isConnected = false;
    await Promise.all([creation, rejected]);
    assertNoResponseListeners(client);
    wire.resetHistory();
    client.isConnected = true;
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'fresh', '2');
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {targetId: 'fresh', value: 'Initial/1'});
    sinon.assert.notCalled(wire);
  });

  it('bounds a runtime update, rolls healthy targets back, and unblocks queued updates', async function () {
    const {client} = connectedClient({webInspectorSettings: {userAgent: 'Old/1'}});
    let hang = false;
    const entered = deferred();
    const observed: {targetId: string; value: string}[] = [];
    sinon.stub(client, 'sendMessage').callsFake(async (message) => {
      const command = commandFrom(message);
      observed.push({targetId: command.targetId, value: command.params.value});
      if (hang && command.targetId === 'hung') {
        entered.resolve();
      } else {
        reply(client, command.id);
      }
    });
    await addPage(client, 'healthy');
    await addPage(client, 'hung', '2');
    observed.length = 0;
    hang = true;
    const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const rejected = assert.rejects(
        client.setWebInspectorPageSettings({userAgent: 'Rejected/2'}),
        /timed out after 10000ms/,
      );
      await entered.promise;
      const queued = client.setWebInspectorPageSettings({userAgent: 'Accepted/3'});
      await clock.tickAsync(10000);
      await Promise.all([rejected, queued]);
      assert.deepStrictEqual(observed, [
        {targetId: 'healthy', value: 'Rejected/2'},
        {targetId: 'hung', value: 'Rejected/2'},
        {targetId: 'healthy', value: 'Old/1'},
        {targetId: 'healthy', value: 'Accepted/3'},
      ]);
      assertNoResponseListeners(client);
      await addPage(client, 'next', '3');
      assert.deepStrictEqual(observed.at(-1), {targetId: 'next', value: 'Accepted/3'});
    } finally {
      clock.restore();
    }
  });

  const recoveryCases: {name: string; previous: WebInspectorPageSettings; next: WebInspectorPageSettings}[] = [
    {name: 'changed user agent', previous: {userAgent: 'Old/1'}, next: {userAgent: 'New/2'}},
    {name: 'added page setting', previous: {}, next: {pageSettings: {WebSecurityEnabled: false}}},
    {name: 'removed preference', previous: {userPreferences: {PrefersColorScheme: 'Dark'}}, next: {}},
  ];
  for (const {name, previous, next} of recoveryCases) {
    for (const retryNext of [false, true]) {
      it(`repairs a failed rollback before accepting a policy: ${name}, retryNext=${retryNext}`, async function () {
        const {client} = connectedClient({webInspectorSettings: previous});
        const before = [...toPageOverrides(previous).values()][0]?.value;
        const after = [...toPageOverrides(next).values()][0]?.value;
        const state = new Map<string, boolean | string | undefined>();
        let fail = false;
        let keepRejectingRestore = false;
        const send = sinon.stub(client, 'sendToDevice').callsFake(async (_method, opts) => {
          if (
            (fail && opts.targetId === 'second' && opts.value === after) ||
            ((fail || keepRejectingRestore) && opts.targetId === 'first' && opts.value === before)
          ) {
            throw new Error('Temporary protocol failure');
          }
          state.set(String(opts.targetId), opts.value as boolean | string | undefined);
        });
        await addPage(client, 'first');
        await addPage(client, 'second', '2');
        fail = true;
        await assert.rejects(client.setWebInspectorPageSettings(next), /Temporary protocol failure/);
        assert.equal(state.get('first'), after);
        // A failed repair must also reject; it must not be reported as a no-op success.
        await assert.rejects(client.setWebInspectorPageSettings(previous), /Temporary protocol failure/);
        fail = false;
        // Retrying the new policy must not require the old, still rejected value.
        keepRejectingRestore = retryNext;
        send.resetHistory();
        const requested = retryNext ? next : previous;
        await client.setWebInspectorPageSettings(requested);
        assert.equal(state.get('first'), retryNext ? after : before);
        assert.equal(state.get('second'), retryNext ? after : before);
        assert.equal(send.callCount, retryNext ? 2 : 1);
        // A successful repair clears the pending work.
        send.resetHistory();
        await client.setWebInspectorPageSettings(requested);
        sinon.assert.notCalled(send);
      });
    }
  }

  for (const disconnect of [false, true]) {
    it(`discards pending rollback repairs when a target is removed (disconnect=${disconnect})`, async function () {
      const {client} = connectedClient({webInspectorSettings: {userAgent: 'Old/1'}});
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'first');
      await addPage(client, 'second', '2');
      send
        .withArgs('Page.overrideUserAgent', sinon.match({targetId: 'second', value: 'New/2'}))
        .rejects(new Error('Update failed'));
      send
        .withArgs('Page.overrideUserAgent', sinon.match({targetId: 'first', value: 'Old/1'}))
        .rejects(new Error('Rollback failed'));
      await assert.rejects(client.setWebInspectorPageSettings({userAgent: 'New/2'}), /Update failed/);
      if (disconnect) {
        await client.disconnect();
        client.isConnected = true;
      } else {
        await client.removeTarget(undefined, 'app', {targetId: 'first'} as any);
      }
      send.reset();
      send.resolves();
      await addPage(client, 'first', '3');
      send.resetHistory();
      await client.setWebInspectorPageSettings({userAgent: 'Old/1'});
      sinon.assert.notCalled(send);
      await client.setWebInspectorPageSettings({userAgent: 'Accepted/3'});
      assert.ok(send.getCalls().every(({args}) => args[1].value === 'Accepted/3'));
      assert.equal(send.callCount, disconnect ? 1 : 2);
    });
  }

  for (const message of [
    'app not found',
    'Application PID:123 does not exist',
    "Remote debugger error with code '-32000': Application PID:123 does not exist.",
  ]) {
    it(`removes a missing app during initialization: ${message}`, async function () {
      const {client} = connectedClient({webInspectorSettings: {userAgent: 'First/1'}});
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'existing', '1', 'PID:123');
      await addPage(client, 'healthy', '1', 'alive');
      send.withArgs('Page.overrideUserAgent', sinon.match({appIdKey: 'PID:123'})).rejects(new Error(message));
      await addPage(client, 'gone', '2', 'PID:123');
      send.resetHistory();
      await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
      sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'alive', value: 'Next/2'});
    });

    it(`removes every stale target of a missing app: ${message}`, async function () {
      const {client} = connectedClient();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'stale-1', '1', 'PID:123');
      await addPage(client, 'stale-2', '2', 'PID:123');
      await addPage(client, 'healthy', '1', 'alive');
      send.withArgs('Page.overrideUserAgent', sinon.match({appIdKey: 'PID:123'})).rejects(new Error(message));
      await client.setWebInspectorPageSettings({userAgent: 'First/1'});
      assert.deepStrictEqual(
        send.getCalls().map(({args}) => args[1].targetId),
        // Both requests may be in flight before the app is reported missing.
        ['stale-1', 'stale-2', 'healthy'],
      );
      send.resetHistory();
      await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
      sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'alive', value: 'Next/2'});
    });
  }

  for (const message of [
    'Application setting not found',
    'The application database does not exist',
    'app not found while looking up an optional setting',
    'Application PID:999 does not exist',
    "Remote debugger error with code '-32000': Application setting not found",
  ]) {
    for (const duringInitialization of [false, true]) {
      it(`retains targets on unrelated errors (init=${duringInitialization}): ${message}`, async function () {
        const {client} = connectedClient({
          webInspectorSettings: duringInitialization ? {userAgent: 'Rejected/1'} : {},
        });
        const send = sinon.stub(client, 'sendToDevice').resolves();
        send.withArgs('Page.overrideUserAgent', sinon.match({value: 'Rejected/1'})).rejects(new Error(message));
        await addPage(client, 'first', '1', 'PID:123');
        await addPage(client, 'second', '2', 'PID:123');
        await assert.rejects(client.setWebInspectorPageSettings({userAgent: 'Rejected/1'}), {message});
        send.resetHistory();
        await client.setWebInspectorPageSettings({userAgent: 'Accepted/2'});
        assert.deepStrictEqual(
          send.getCalls().map(({args}) => args[1].targetId),
          ['first', 'second'],
        );
        assert.ok(send.getCalls().every(({args}) => args[1].value === 'Accepted/2'));
      });
    }
  }

  it('forgets all targets when the application disconnect notification arrives', async function () {
    const {client} = connectedClient();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'first', '1', 123);
    await addPage(client, 'second', '2', 123);
    await addPage(client, 'healthy', '1', 'other');
    (client as any).messageHandler.emit('_rpc_applicationDisconnected:', null, {WIRApplicationIdentifierKey: '123'});
    await client.setWebInspectorPageSettings({userAgent: 'Test/1'});
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'other'});
  });

  it('normalizes app keys and keeps identical target IDs in different apps separate', async function () {
    const {client} = connectedClient();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'same', '1', 123);
    await addPage(client, 'same', '1', 'other');
    await client.removeTarget(undefined, '123', {targetId: 'same'} as any);
    await client.setWebInspectorPageSettings({userAgent: 'Test/1'});
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'other', targetId: 'same'});
  });
});
