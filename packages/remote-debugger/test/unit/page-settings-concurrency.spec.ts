import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import sinon from 'sinon';

import {RpcClient} from '../../lib/rpc/rpc-client.js';
import type {RemoteCommand} from '../../lib/types.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

function connectedClient() {
  const client = new RpcClient();
  client.isConnected = true;
  sinon.stub(client, 'send').resolves();
  return client;
}

async function addPage(client: RpcClient, targetId: string) {
  (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey: targetId};
  await client.addTarget(undefined, 'app', {targetId, type: 'page', isProvisional: false, isPaused: true});
}

function commandFrom(message: RemoteCommand) {
  const wrapper = JSON.parse(String(message.__argument.WIRSocketDataKey));
  return {...JSON.parse(wrapper.params.message), targetId: wrapper.params.targetId};
}

describe('page settings concurrency', function () {
  it('bounds target concurrency while preserving command order within each target', async function () {
    const client = connectedClient();
    for (let i = 0; i < 6; i++) {
      await addPage(client, String(i + 1));
    }
    const release = Array.from({length: 6}, deferred);
    const firstWave = deferred();
    const nextWave = deferred();
    const active = new Set<string>();
    const commands = new Map<string, string[]>();
    let peak = 0;
    sinon.stub(client, 'sendToDevice').callsFake(async (method, opts) => {
      const target = String(opts.targetId);
      assert.ok(!active.has(target), 'commands on one target must not overlap');
      active.add(target);
      peak = Math.max(peak, active.size);
      const methods = commands.get(target) ?? [];
      methods.push(method);
      commands.set(target, methods);
      if (method === 'Page.overrideSetting') {
        if (commands.size === 4) {
          firstWave.resolve();
        }
        if (target === '5') {
          nextWave.resolve();
        }
        await release[Number(target) - 1].promise;
      }
      active.delete(target);
    });
    const update = client.setWebInspectorPageSettings({pageSettings: {ImagesEnabled: false}, userAgent: 'New/1'});
    try {
      await firstWave.promise;
      assert.equal(active.size, 4);
      assert.equal(commands.has('5'), false);
      release[0].resolve();
      await nextWave.promise;
      assert.equal(commands.has('6'), false);
      assert.deepStrictEqual(commands.get('1'), ['Page.overrideSetting', 'Page.overrideUserAgent']);
    } finally {
      release.forEach(({resolve}) => resolve());
      await update;
    }
    assert.equal(peak, 4);
    assert.equal(commands.size, 6);
    for (const methods of commands.values()) {
      assert.deepStrictEqual(methods, ['Page.overrideSetting', 'Page.overrideUserAgent']);
    }
  });

  for (const code of [-32601, -32602]) {
    it(`drains in-flight updates before rollback and rejects unsupported runtime changes (${code})`, async function () {
      const client = connectedClient();
      const previous = {pageSettings: {ImagesEnabled: true}, userAgent: 'Old/1'};
      await client.setWebInspectorPageSettings(previous);
      const state = new Map<string, Record<string, unknown>>();
      const events: string[] = [];
      const slowEntered = deferred();
      const failed = deferred();
      const release = deferred();
      sinon.stub(client, 'sendMessage').callsFake(async (message) => {
        const command = commandFrom(message);
        const key = command.params.setting ?? 'userAgent';
        const value = command.params.value;
        const handler = (client as any).messageHandler;
        if (value === 'New/2' && command.targetId === '1') {
          slowEntered.resolve();
          await release.promise;
        }
        if (value === 'New/2' && command.targetId === '2') {
          handler.emit(String(command.id), {code, message: 'Unsupported override'});
          failed.resolve();
          return;
        }
        events.push(`${command.targetId}:${key}:${value}`);
        state.set(command.targetId, {...state.get(command.targetId), [key]: value});
        handler.emit(String(command.id), null, {});
      });
      for (let i = 1; i <= 5; i++) {
        await addPage(client, String(i));
      }
      events.length = 0;
      let settled = false;
      const update = client.setWebInspectorPageSettings({pageSettings: {ImagesEnabled: false}, userAgent: 'New/2'});
      const rejected = assert.rejects(update, {code});
      void update.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.all([slowEntered.promise, failed.promise]);
      try {
        await setImmediate();
        assert.equal(settled, false);
        assert.ok(!events.some((event) => event.endsWith(':true') || event.endsWith(':Old/1')));
        assert.ok(!events.some((event) => event.startsWith('5:')), 'queued targets must not start after failure');
      } finally {
        release.resolve();
        await rejected;
      }
      for (const value of state.values()) {
        assert.deepStrictEqual(value, {ImagesEnabled: true, userAgent: 'Old/1'});
      }
      // Reverse per-target order on rollback, after the delayed write has finished.
      assert.deepStrictEqual(
        events.filter((event) => event.startsWith('1:')),
        ['1:ImagesEnabled:false', '1:userAgent:New/2', '1:userAgent:Old/1', '1:ImagesEnabled:true'],
      );
      events.length = 0;
      await client.setWebInspectorPageSettings(previous);
      assert.deepStrictEqual(events, []);
      await addPage(client, '6');
      assert.deepStrictEqual(state.get('6'), {ImagesEnabled: true, userAgent: 'Old/1'});
      assert.ok(!(client as any).messageHandler.eventNames().some((name: string) => /^\d+$/.test(name)));
    });
  }

  it('keeps queued policy updates and target initialization outside an active batch', async function () {
    const client = connectedClient();
    await addPage(client, '1');
    await addPage(client, '2');
    const entered = deferred();
    const release = deferred();
    const seen: {target: string; value: unknown}[] = [];
    sinon.stub(client, 'sendToDevice').callsFake(async (_method, opts) => {
      seen.push({target: String(opts.targetId), value: opts.value});
      if (opts.targetId === '1' && opts.value === 'First/1') {
        entered.resolve();
        await release.promise;
      }
    });
    const first = client.setWebInspectorPageSettings({userAgent: 'First/1'});
    await entered.promise;
    const second = client.setWebInspectorPageSettings({userAgent: 'Second/2'});
    const creation = addPage(client, '3');
    try {
      await setImmediate();
      assert.deepStrictEqual(seen, [
        {target: '1', value: 'First/1'},
        {target: '2', value: 'First/1'},
      ]);
    } finally {
      release.resolve();
      await Promise.all([first, second, creation]);
    }
    assert.deepStrictEqual(seen.slice(2), [
      {target: '1', value: 'Second/2'},
      {target: '2', value: 'Second/2'},
      {target: '3', value: 'Second/2'},
    ]);
  });

  it('aborts all parallel waits on disconnect and does not start queued targets', async function () {
    const client = connectedClient();
    for (let i = 1; i <= 5; i++) {
      await addPage(client, String(i));
    }
    const entered = deferred();
    const targets: string[] = [];
    sinon.stub(client, 'sendMessage').callsFake(async (message) => {
      targets.push(commandFrom(message).targetId);
      if (targets.length === 4) {
        entered.resolve();
      }
    });
    const rejected = assert.rejects(client.setWebInspectorPageSettings({userAgent: 'New/1'}), /disconnected/);
    await entered.promise;
    client.isConnected = false;
    await rejected;
    assert.deepStrictEqual(targets, ['1', '2', '3', '4']);
    assert.ok(!(client as any).messageHandler.eventNames().some((name: string) => /^\d+$/.test(name)));
  });

  it('bounds parallel rollback and keeps the next update queued until every restore finishes', async function () {
    const client = connectedClient();
    await client.setWebInspectorPageSettings({userAgent: 'Old/1'});
    const release = Array.from({length: 5}, deferred);
    const firstWave = deferred();
    const lastRestore = deferred();
    const state = new Map<string, unknown>();
    let updating = false;
    let restoring = 0;
    let peak = 0;
    const send = sinon.stub(client, 'sendToDevice').callsFake(async (_method, opts) => {
      const target = String(opts.targetId);
      if (updating && target === '6' && opts.value === 'New/2') {
        throw new Error('Rejected update');
      }
      if (updating && opts.value === 'Old/1') {
        restoring++;
        peak = Math.max(peak, restoring);
        if (restoring === 4) {
          firstWave.resolve();
        }
        if (target === '5') {
          lastRestore.resolve();
        }
        await release[Number(target) - 1].promise;
        restoring--;
      }
      if (opts.value === 'Accepted/3') {
        assert.equal(restoring, 0);
      }
      state.set(target, opts.value);
    });
    for (let i = 1; i <= 6; i++) {
      await addPage(client, String(i));
    }
    updating = true;
    const rejected = assert.rejects(client.setWebInspectorPageSettings({userAgent: 'New/2'}), /Rejected update/);
    await firstWave.promise;
    const queued = client.setWebInspectorPageSettings({userAgent: 'Accepted/3'});
    try {
      await setImmediate();
      assert.equal(restoring, 4);
      assert.ok(!send.getCalls().some(({args}) => args[1].value === 'Accepted/3'));
      release[0].resolve();
      await lastRestore.promise;
      assert.equal(restoring, 4);
    } finally {
      release.forEach(({resolve}) => resolve());
      await Promise.all([rejected, queued]);
    }
    assert.equal(peak, 4);
    assert.deepStrictEqual([...state.values()], Array(6).fill('Accepted/3'));
  });
});
