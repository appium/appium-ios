import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {toPageOverrides, type WebInspectorPageSettings} from '../../lib/page-overrides.js';
import {RpcClient} from '../../lib/rpc/rpc-client.js';
import {stubPageClient, addPage, deferred, reply, assertNoResponseListeners} from './helpers/page-settings.js';
import {commandFrom, dataMessage, targetMessage} from './helpers/rpc-messages.js';

describe('page settings connection lifecycle', function () {
  for (const fullPageInitialization of [false, true]) {
    for (const update of ['unchanged', 'extended', 'cleared']) {
      it(`repairs failed initialization overrides before an ${update} update (full=${fullPageInitialization})`, async function () {
        const settings: WebInspectorPageSettings = {
          pageSettings: {ImagesEnabled: false, WebSecurityEnabled: false},
          userPreferences: {PrefersColorScheme: 'Dark'},
          userAgent: 'Initial/1',
        };
        const {client, initialize} = stubPageClient({fullPageInitialization, webInspectorSettings: settings});
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
        const {client} = stubPageClient({webInspectorSettings: settings});
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
        await addPage(client, 'future', {pageIdKey: '2'});
        assert.equal(send.callCount, clear ? 0 : 1);
      });
    }
  }

  it('retains pending repairs when replacing them succeeds but a later target rejects the batch', async function () {
    const {client} = stubPageClient({webInspectorSettings: {userAgent: 'Old/1'}});
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
    await addPage(client, 'second', {pageIdKey: '2'});
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
      const {client, initialize} = stubPageClient({webInspectorSettings: settings});
      const send = sinon.stub(client, 'sendMessage').callsFake(async (messageToSend) => {
        const command = commandFrom(messageToSend);
        if (command.method === 'Page.overrideSetting') {
          await (client as any).messageHandler.handleMessage(
            targetMessage(command.targetId, {id: command.id, error: {code, message}}),
          );
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
        const {client, initialize} = stubPageClient({
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
          await addPage(client, 'same-target', {pageIdKey: '2'});
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
      const {client, initialize} = stubPageClient({
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
        const healthy = addPage(client, 'healthy', {pageIdKey: '2'});
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
    const {client} = stubPageClient({webInspectorSettings: {userAgent: 'Initial/1'}});
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
    await addPage(client, 'fresh', {pageIdKey: '2'});
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {targetId: 'fresh', value: 'Initial/1'});
    sinon.assert.notCalled(wire);
  });

  it('bounds a runtime update, rolls healthy targets back, and unblocks queued updates', async function () {
    const {client} = stubPageClient({webInspectorSettings: {userAgent: 'Old/1'}});
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
    await addPage(client, 'hung', {pageIdKey: '2'});
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
      await addPage(client, 'next', {pageIdKey: '3'});
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
        const {client} = stubPageClient({webInspectorSettings: previous});
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
        await addPage(client, 'second', {pageIdKey: '2'});
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
      const {client} = stubPageClient({webInspectorSettings: {userAgent: 'Old/1'}});
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'first');
      await addPage(client, 'second', {pageIdKey: '2'});
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
      await addPage(client, 'first', {pageIdKey: '3'});
      send.resetHistory();
      await client.setWebInspectorPageSettings({userAgent: 'Old/1'});
      sinon.assert.notCalled(send);
      await client.setWebInspectorPageSettings({userAgent: 'Accepted/3'});
      assert.ok(send.getCalls().every(({args}) => args[1].value === 'Accepted/3'));
      assert.equal(send.callCount, disconnect ? 1 : 2);
    });
  }

  for (const removal of ['wrapper error', 'target error', 'app disconnect', 'target destruction']) {
    it(`cancels disappeared targets' pending waits without rolling back healthy targets (${removal})`, async function () {
      const {client} = stubPageClient();
      await addPage(client, 'gone-1', {appIdKey: 'PID:123'});
      await addPage(client, 'gone-2', {pageIdKey: '2', appIdKey: 'PID:123'});
      await addPage(client, 'healthy', {appIdKey: 'PID:456'});
      const handler = (client as any).messageHandler;
      const pending = new Map<string, {id: number; wrapperId: number}>();
      const send = sinon.stub(client, 'sendMessage').callsFake(async (message) => {
        const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
        const command = commandFrom(message);
        if (command.targetId.startsWith('gone-')) {
          pending.set(command.targetId, {id: command.id, wrapperId: wrapper.id});
          return;
        }
        await handler.handleMessage(targetMessage(command.targetId, {id: command.id, result: {}}, 'PID:456'));
      });
      const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      let outcome: unknown = 'pending';
      const update = client.setWebInspectorPageSettings({userAgent: 'New/1'}).then(
        () => {
          outcome = 'resolved';
        },
        (error) => {
          outcome = error;
        },
      );
      try {
        await clock.tickAsync(0);
        assert.equal(pending.size, 2, 'both requests must already be waiting');
        const first = pending.get('gone-1')!;
        const error = {code: -32000, message: 'Application PID:123 does not exist'};
        if (removal === 'wrapper error') {
          await handler.handleMessage(dataMessage({id: first.wrapperId, error}, 'PID:123'));
        } else if (removal === 'target error') {
          await handler.handleMessage(targetMessage('gone-1', {id: first.id, error}, 'PID:123'));
        } else if (removal === 'app disconnect') {
          await handler.handleMessage({
            __selector: '_rpc_applicationDisconnected:',
            __argument: {WIRApplicationIdentifierKey: 'PID:123'},
          });
        } else {
          await handler.handleMessage(
            dataMessage({method: 'Target.targetDestroyed', params: {targetId: 'gone-1'}}, 'PID:123'),
          );
          await clock.tickAsync(0);
          assert.equal(outcome, 'pending', 'another target of the same app must still wait for its response');
          await handler.handleMessage(targetMessage('gone-2', {id: pending.get('gone-2')!.id, result: {}}, 'PID:123'));
        }
        await clock.tickAsync(0);
        assert.equal(outcome, 'resolved', 'known disappearance must not wait for the 10-second deadline');
        assert.equal(send.callCount, 3, 'healthy targets must not be rolled back');
        assertNoResponseListeners(client);
        assert.equal(clock.countTimers(), 0);
        send.resetHistory();
        await client.setWebInspectorPageSettings({userAgent: 'New/1'});
        sinon.assert.notCalled(send);
        await addPage(client, 'new-page', {pageIdKey: '2', appIdKey: 'PID:456'});
        sinon.assert.calledOnce(send);
        assert.equal(commandFrom(send.firstCall.args[0]).params.value, 'New/1');
      } finally {
        client.isConnected = false;
        await update;
        clock.restore();
      }
    });
  }

  for (const removal of ['app disconnect', 'target destruction']) {
    it(`stops initialization immediately when its target disappears (${removal})`, async function () {
      const {client, initialize} = stubPageClient({webInspectorSettings: {userAgent: 'New/1'}});
      const send = sinon.stub(client, 'sendMessage').resolves();
      const clock = sinon.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      let initialized = false;
      const creation = addPage(client, 'gone', {appIdKey: 'PID:123'}).then(() => {
        initialized = true;
      });
      try {
        await clock.tickAsync(0);
        sinon.assert.calledOnce(send);
        const handler = (client as any).messageHandler;
        await handler.handleMessage(
          removal === 'app disconnect'
            ? {
                __selector: '_rpc_applicationDisconnected:',
                __argument: {WIRApplicationIdentifierKey: 'PID:123'},
              }
            : dataMessage({method: 'Target.targetDestroyed', params: {targetId: 'gone'}}, 'PID:123'),
        );
        await clock.tickAsync(0);
        assert.equal(initialized, true, 'initialization must finish without a deadline');
        assert.ok(!initialize.calledWith('Runtime.enable'));
        assert.ok(!initialize.calledWith('Inspector.initialized'));
        assertNoResponseListeners(client);
        assert.equal(clock.countTimers(), 0);
      } finally {
        client.isConnected = false;
        await creation;
        clock.restore();
      }
    });
  }

  for (const message of [
    'app not found',
    'Application PID:123 does not exist',
    "Remote debugger error with code '-32000': Application PID:123 does not exist.",
  ]) {
    it(`removes a missing app during initialization: ${message}`, async function () {
      const {client} = stubPageClient({webInspectorSettings: {userAgent: 'First/1'}});
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'existing', {appIdKey: 'PID:123'});
      await addPage(client, 'healthy', {appIdKey: 'alive'});
      send.withArgs('Page.overrideUserAgent', sinon.match({appIdKey: 'PID:123'})).rejects(new Error(message));
      await addPage(client, 'gone', {pageIdKey: '2', appIdKey: 'PID:123'});
      send.resetHistory();
      await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
      sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'alive', value: 'Next/2'});
    });

    it(`removes every stale target of a missing app: ${message}`, async function () {
      const {client} = stubPageClient();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'stale-1', {appIdKey: 'PID:123'});
      await addPage(client, 'stale-2', {pageIdKey: '2', appIdKey: 'PID:123'});
      await addPage(client, 'healthy', {appIdKey: 'alive'});
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
        const {client} = stubPageClient({
          webInspectorSettings: duringInitialization ? {userAgent: 'Rejected/1'} : {},
        });
        const send = sinon.stub(client, 'sendToDevice').resolves();
        send.withArgs('Page.overrideUserAgent', sinon.match({value: 'Rejected/1'})).rejects(new Error(message));
        await addPage(client, 'first', {appIdKey: 'PID:123'});
        await addPage(client, 'second', {pageIdKey: '2', appIdKey: 'PID:123'});
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
    const {client} = stubPageClient();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'first', {appIdKey: 123});
    await addPage(client, 'second', {pageIdKey: '2', appIdKey: 123});
    await addPage(client, 'healthy', {appIdKey: 'other'});
    (client as any).messageHandler.emit('_rpc_applicationDisconnected:', null, {WIRApplicationIdentifierKey: '123'});
    await client.setWebInspectorPageSettings({userAgent: 'Test/1'});
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'other'});
  });

  it('normalizes app keys and keeps identical target IDs in different apps separate', async function () {
    const {client} = stubPageClient();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'same', {appIdKey: 123});
    await addPage(client, 'same', {appIdKey: 'other'});
    await client.removeTarget(undefined, '123', {targetId: 'same'} as any);
    await client.setWebInspectorPageSettings({userAgent: 'Test/1'});
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'other', targetId: 'same'});
  });
});

describe('target lifetime during initialization', function () {
  for (const fullPageInitialization of [false, true]) {
    for (const isProvisional of [false, true]) {
      for (const blockedDomain of ['Inspector.enable', 'Page.enable', 'Runtime.enable']) {
        for (const removal of ['target', 'app']) {
          it(`cancels ${blockedDomain} on ${removal} removal (full=${fullPageInitialization}, provisional=${isProvisional})`, async function () {
            const client = new RpcClient({fullPageInitialization, webInspectorSettings: {userAgent: 'Test/1'}});
            client.isConnected = true;
            const entered = deferred();
            const methods: string[] = [];
            sinon.stub(client, 'sendMessage').callsFake(async (message) => {
              const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
              const command =
                wrapper.method === 'Target.sendMessageToTarget' ? JSON.parse(wrapper.params.message) : wrapper;
              methods.push(command.method);
              if (command.method === blockedDomain) {
                entered.resolve();
                return; // The device never responds; removal must cancel the wait.
              }
              await (client as any).messageHandler.handleMessage(
                wrapper.method === 'Target.sendMessageToTarget'
                  ? targetMessage('gone', {id: command.id, result: {}})
                  : dataMessage({id: command.id, result: {}}),
              );
            });
            (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey: '1'};
            const creation = client.addTarget(undefined, 'app', {
              targetId: 'gone',
              type: 'page',
              isProvisional,
              isPaused: true,
            });
            await entered.promise;
            if (removal === 'target') {
              await client.removeTarget(undefined, 'app', {targetId: 'gone'} as any);
            } else {
              (client as any).messageHandler.emit('_rpc_applicationDisconnected:', null, {
                WIRApplicationIdentifierKey: 'app',
              });
            }
            await creation;
            assert.equal(methods.at(-1), blockedDomain);
            assert.ok(!methods.includes('Target.resume'));
            assert.ok(!methods.includes('Inspector.initialized'));
            assert.equal(client.getTarget('app', '1'), undefined);
            assert.equal((client as any).initializedPageTargets.size, 0);
            assertNoResponseListeners(client);
            const count = methods.length;
            await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
            assert.equal(methods.length, count, 'dead targets must not receive later overrides');
          });
        }
      }
    }
  }

  it('does not register a destroyed target queued behind a settings update', async function () {
    const {client} = stubPageClient();
    const entered = deferred();
    const release = deferred();
    const send = sinon.stub(client, 'sendToDevice').callsFake(async (_method, opts) => {
      if (opts.targetId === 'healthy' && opts.value === 'Next/2') {
        entered.resolve();
        await release.promise;
      }
    });
    await addPage(client, 'healthy');
    const update = client.setWebInspectorPageSettings({userAgent: 'Next/2'});
    await entered.promise;
    const creation = addPage(client, 'gone', {pageIdKey: '2'});
    // Let the core domains finish and initialization queue for the settings lock.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await client.removeTarget(undefined, 'app', {targetId: 'gone'} as any);
    release.resolve();
    await Promise.all([creation, update]);
    assert.ok(send.getCalls().every(({args}) => args[1].targetId === 'healthy'));
    assert.equal(client.getTarget('app', '2'), undefined);
  });

  for (const error of ['Missing target for given targetId', 'app not found']) {
    it(`invalidates routing after an override reports ${error}`, async function () {
      const {client, initialize} = stubPageClient();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'gone');
      send.withArgs('Page.overrideUserAgent', sinon.match({targetId: 'gone'})).rejects(new Error(error));
      await client.setWebInspectorPageSettings({userAgent: 'New/1'});
      assert.equal(client.getTarget('app', '1'), undefined);
      initialize.resetHistory();
      initialize.withArgs('setSenderKey').callsFake(async () => {
        // Real notifications arrive after socket setup has returned.
        setImmediate(() => {
          void addPage(client, 'replacement');
        });
      });
      await client.selectPage('app', '1');
      sinon.assert.calledWith(initialize, 'setSenderKey');
      assert.equal(client.getTarget('app', '1'), 'replacement');
      sinon.assert.calledWithMatch(send, 'Page.overrideUserAgent', {targetId: 'replacement', value: 'New/1'});
    });
  }

  it('preserves a committed provisional replacement and resumes its later creation notification', async function () {
    const {client, initialize} = stubPageClient({webInspectorSettings: {userAgent: 'Test/1'}});
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'old');
    await client.addTarget(undefined, 'app', {targetId: 'new', type: 'page', isProvisional: true, isPaused: true});
    await client.updateTarget(undefined, 'app', {oldTargetId: 'old', newTargetId: 'new'});
    await client.removeTarget(undefined, 'app', {targetId: 'old'} as any);
    assert.equal(client.getTarget('app', '1'), 'new');
    initialize.resetHistory();
    send.resetHistory();
    await addPage(client, 'new');
    sinon.assert.notCalled(send);
    assert.ok(!initialize.calledWith('Page.enable'), 'successfully provisioned targets need no second initialization');
    sinon.assert.calledWithMatch(initialize, 'Target.resume', {targetId: 'new'});
    await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
    sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {targetId: 'new', value: 'Next/2'});
  });

  it('clears provisional routing when its replacement disappears', async function () {
    const {client} = stubPageClient();
    await addPage(client, 'old');
    await client.addTarget(undefined, 'app', {targetId: 'new', type: 'page', isProvisional: true, isPaused: true});
    await client.updateTarget(undefined, 'app', {oldTargetId: 'old', newTargetId: 'new'});
    await client.removeTarget(undefined, 'app', {targetId: 'new'} as any);
    assert.equal(client.targets.app.provisional, undefined);
    await client.removeTarget(undefined, 'app', {targetId: 'old'} as any);
    assert.equal(client.getTarget('app', '1'), undefined);
  });

  for (const isProvisional of [false, true]) {
    it(`does not resume a target after a missing-app initialization error (provisional=${isProvisional})`, async function () {
      const {client, initialize} = stubPageClient({webInspectorSettings: {userAgent: 'Test/1'}});
      sinon.stub(client, 'sendToDevice').rejects(new Error('app not found'));
      (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey: '1'};
      await client.addTarget(undefined, 'app', {targetId: 'gone', type: 'page', isProvisional, isPaused: true});
      assert.ok(!initialize.calledWith('Target.resume'));
      assert.equal(client.getTarget('app', '1'), undefined);
    });
  }
});

describe('initialization polling cancellation', function () {
  for (const fullPageInitialization of [false, true]) {
    for (const stage of ['target lookup', 'readiness response', 'readiness interval']) {
      for (const removal of ['target', 'reconnect']) {
        it(
          `releases the page lock during ${stage} on ${removal} (full=${fullPageInitialization})`,
          {timeout: 3000},
          async function () {
            const client = new RpcClient({fullPageInitialization});
            client.isConnected = true;
            const entered = deferred();
            const commands: {targetId: string; method: string}[] = [];
            const lookup = sinon.spy(client, 'waitForTarget');
            const wire = sinon.stub(client, 'sendMessage').callsFake(async (message) => {
              const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
              const command =
                wrapper.method === 'Target.sendMessageToTarget' ? JSON.parse(wrapper.params.message) : wrapper;
              const targetId = wrapper.params?.targetId ?? command.params?.targetId;
              commands.push({targetId, method: command.method});
              let result = {};
              let error;
              if (targetId === 'old') {
                if (stage === 'target lookup' && command.method === 'Inspector.enable') {
                  error = {code: -32000, message: 'Missing target for given targetId'};
                  entered.resolve();
                } else if (command.method === 'Runtime.evaluate') {
                  entered.resolve();
                  if (stage === 'readiness response') {
                    return; // Cancellation must release an unanswered RPC too.
                  }
                  result = {result: {type: 'string', value: 'loading'}};
                }
              }
              // Core RPC retries use direct errors; wrapped errors preserve legacy resolution.
              const response = {id: command.id, ...(error ? {error} : {result})};
              await (client as any).messageHandler.handleMessage(
                wrapper.method === 'Target.sendMessageToTarget' && !error
                  ? targetMessage(targetId, response)
                  : dataMessage(response),
              );
            });
            (client as any)._pendingTargetNotification = {
              appIdKey: 'app',
              pageIdKey: '1',
              pageReadinessDetector: {timeoutMs: 30000, readinessDetector: () => false},
            };
            // Provisional initialization has no normal page mapping, exposing the retry wait.
            const old = client.addTarget(undefined, 'app', {
              targetId: 'old',
              type: 'page',
              isProvisional: true,
              isPaused: true,
            });
            await entered.promise;
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (stage === 'target lookup') {
              sinon.assert.calledOnce(lookup);
            }
            // Queue a replacement on the same page lock before cancelling the old work.
            const replacement = addPage(client, 'replacement', {isProvisional: true});
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.ok(!commands.some(({targetId}) => targetId === 'replacement'));
            if (removal === 'target') {
              await client.removeTarget(undefined, 'app', {targetId: 'old'} as any);
            } else {
              client.isConnected = false;
              client.isConnected = true;
            }
            const oldCount = commands.filter(({targetId}) => targetId === 'old').length;
            await Promise.all([old, replacement]);
            if (removal === 'reconnect') {
              await addPage(client, 'new-connection');
            } else {
              assert.ok(
                commands.some(({targetId, method}) => targetId === 'replacement' && method === 'Target.resume'),
              );
            }
            assert.equal(commands.filter(({targetId}) => targetId === 'old').length, oldCount);
            assertNoResponseListeners(client);
            wire.restore();
          },
        );
      }
    }
  }
});

describe('page initialization and RPC compatibility', function () {
  for (const fullPageInitialization of [false, true]) {
    for (const isProvisional of [false, true]) {
      for (const throws of [false, true]) {
        it(`resumes a live target after failed initialization (full=${fullPageInitialization}, provisional=${isProvisional}, throws=${throws})`, async function () {
          const {client, initialize} = stubPageClient({fullPageInitialization});
          const failingStep = throws ? '_initializePage' : 'initializePageOverrides';
          sinon.stub(client as any, failingStep).rejects(new Error('Registration failed'));
          await addPage(client, 'live', {isProvisional});
          sinon.assert.calledWithMatch(initialize, 'Target.resume', {targetId: 'live'});
        });
      }
    }
    for (const removal of ['target', 'app', 'disconnect']) {
      it(`releases selection after initialization cancellation (full=${fullPageInitialization}, removal=${removal})`, async function () {
        const {client, initialize} = stubPageClient({fullPageInitialization});
        const entered = deferred();
        const release = deferred();
        initialize.withArgs('Page.enable').callsFake(async () => {
          entered.resolve();
          await release.promise;
        });
        const selection = client.selectPage('app', '1');
        await new Promise<void>((resolve) => setImmediate(resolve));
        const creation = addPage(client, 'gone');
        await entered.promise;
        if (removal === 'disconnect') {
          client.disconnect();
        } else if (removal === 'app') {
          (client as any).removePageTargetsForApp('app');
        } else {
          await client.removeTarget(undefined, 'app', {targetId: 'gone'} as any);
        }
        release.resolve();
        await creation;
        let selected = false;
        void selection.then(() => {
          selected = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(selected, true, 'must release selection without waiting for the timeout');
        assert.equal((client as any)._pageSelectionMonitor.eventNames().length, 0);
        assert.ok(!initialize.calledWith('Target.resume'));
        await selection;
      });
    }
  }

  for (const method of ['Page.enable', 'Runtime.evaluate', 'Debugger.enable', 'Target.setPauseOnStart']) {
    for (const nested of [false, true]) {
      it(`preserves existing RPC error behavior (${method}, nested=${nested})`, async function () {
        const client = new RpcClient();
        client.isConnected = true;
        const error = {code: -32000, message: 'Existing command failure'};
        const log = await import('../../lib/logger.js');
        const errorLog = sinon.spy(log.log, 'error');
        try {
          sinon.stub(client, 'sendMessage').callsFake(async (message) => {
            const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
            const command = wrapper.params?.message ? commandFrom(message) : wrapper;
            const response = {id: command.id, error};
            await (client as any).messageHandler.handleMessage(
              nested ? targetMessage('page', response) : dataMessage(response),
            );
          });
          const wait = method !== 'Target.setPauseOnStart';
          const result = client.send(method, {appIdKey: 'app', pageIdKey: '1', targetId: 'page'}, wait);
          if (!nested) {
            await assert.rejects(result, /Existing command failure/);
          } else {
            const value = await result;
            if (wait) {
              assert.deepStrictEqual(value.error, error);
            }
            sinon.assert.notCalled(errorLog);
          }
        } finally {
          errorLog.restore();
        }
      });
    }
  }
});
