import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

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
      const {client} = connectedClient({fullPageInitialization, webInspectorSettings: {userAgent: 'Initial/1'}});
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

  for (const message of ['app not found', 'Application PID:123 does not exist']) {
    it(`removes every stale target of a missing app: ${message}`, async function () {
      const {client} = connectedClient();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'stale-1', '1', 'gone');
      await addPage(client, 'stale-2', '2', 'gone');
      await addPage(client, 'healthy', '1', 'alive');
      send.withArgs('Page.overrideUserAgent', sinon.match({appIdKey: 'gone'})).rejects(new Error(message));
      await client.setWebInspectorPageSettings({userAgent: 'First/1'});
      assert.deepStrictEqual(
        send.getCalls().map(({args}) => args[1].targetId),
        ['stale-1', 'healthy'],
      );
      send.resetHistory();
      await client.setWebInspectorPageSettings({userAgent: 'Next/2'});
      sinon.assert.calledOnceWithMatch(send, 'Page.overrideUserAgent', {appIdKey: 'alive', value: 'Next/2'});
    });
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
