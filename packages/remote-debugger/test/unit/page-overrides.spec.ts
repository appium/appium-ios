import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {PAGE_SETTING_NAMES, USER_PREFERENCE_VALUES, type UserPreferenceName} from '../../lib/page-overrides.js';
import {RemoteDebuggerRealDevice} from '../../lib/remote-debugger-real-device.js';
import {RemoteDebugger} from '../../lib/remote-debugger.js';
import {RpcClient} from '../../lib/rpc/rpc-client.js';

async function addPage(client: RpcClient, targetId: string, pageIdKey = '1', isProvisional = false) {
  (client as any)._pendingTargetNotification = {appIdKey: 'app', pageIdKey};
  await client.addTarget(undefined, 'app', {targetId, type: 'page', isProvisional, isPaused: true});
}

describe('page overrides', function () {
  for (const setting of PAGE_SETTING_NAMES) {
    it(`retains explicit false, updates and removes ${setting} on current and future targets`, async function () {
      const client = new RpcClient();
      sinon.stub(client, 'send').resolves();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await client.setPageSetting(setting, false);
      await addPage(client, 'first');
      sinon.assert.calledOnceWithExactly(send, 'Page.overrideSetting', {
        appIdKey: 'app',
        pageIdKey: '1',
        targetId: 'first',
        setting,
        value: false,
      });
      await addPage(client, 'provisional', '1', true);
      send.resetHistory();
      await client.setPageSetting(setting, true);
      assert.strictEqual(send.callCount, 2);
      assert.ok(send.getCalls().every(({args}) => args[1].value === true));
      send.resetHistory();
      await client.setPageSetting(setting, undefined);
      assert.strictEqual(send.callCount, 2);
      assert.ok(send.getCalls().every(({args}) => !Object.hasOwn(args[1], 'value')));
      send.resetHistory();
      await addPage(client, 'next', '2');
      sinon.assert.notCalled(send);
    });
  }

  for (const name of Object.keys(USER_PREFERENCE_VALUES) as UserPreferenceName[]) {
    it(`updates and resets ${name}, retaining it on provisional targets`, async function () {
      const client = new RpcClient();
      sinon.stub(client, 'send').resolves();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      for (const value of USER_PREFERENCE_VALUES[name]) {
        await client.setUserPreference(name, value);
        send.resetHistory();
        await addPage(client, `target-${value}`, '1', true);
        sinon.assert.calledOnceWithExactly(send, 'Page.overrideUserPreference', {
          appIdKey: 'app',
          pageIdKey: '1',
          targetId: `target-${value}`,
          name,
          value,
        });
      }
      send.resetHistory();
      await client.setUserPreference(name, undefined);
      assert.strictEqual(send.callCount, 2);
      assert.ok(send.getCalls().every(({args}) => !Object.hasOwn(args[1], 'value')));
      send.resetHistory();
      await addPage(client, 'next', '2');
      sinon.assert.notCalled(send);
    });
  }

  it('rolls a rejected preference update back without changing other overrides', async function () {
    const client = new RpcClient({pageSettings: {ImagesEnabled: false}, userPreferences: {PrefersContrast: 'More'}});
    sinon.stub(client, 'send').resolves();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'first');
    await addPage(client, 'second', '2');
    send.resetHistory();
    send.onSecondCall().rejects(new Error('Rejected'));
    await assert.rejects(client.setUserPreference('PrefersContrast', 'NoPreference'), /Rejected/);
    assert.deepStrictEqual(send.thirdCall.args[1], {
      appIdKey: 'app',
      pageIdKey: '1',
      targetId: 'first',
      name: 'PrefersContrast',
      value: 'More',
    });
    send.reset();
    send.resolves();
    await addPage(client, 'next', '3');
    sinon.assert.calledWith(send, 'Page.overrideSetting', sinon.match({setting: 'ImagesEnabled', value: false}));
    sinon.assert.calledWith(send, 'Page.overrideUserPreference', sinon.match({name: 'PrefersContrast', value: 'More'}));
  });

  it('continues applying remaining overrides and resumes when one is unsupported', async function () {
    const client = new RpcClient({
      pageSettings: {ImagesEnabled: false, ScriptEnabled: false},
      userPreferences: {PrefersColorScheme: 'Dark'},
    });
    const initialize = sinon.stub(client, 'send').resolves();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    send
      .withArgs('Page.overrideSetting', sinon.match({setting: 'ImagesEnabled'}))
      .rejects(new Error('Unknown setting'));
    await addPage(client, 'first');
    sinon.assert.calledWith(send, 'Page.overrideSetting', sinon.match({setting: 'ScriptEnabled', value: false}));
    sinon.assert.calledWith(
      send,
      'Page.overrideUserPreference',
      sinon.match({name: 'PrefersColorScheme', value: 'Dark'}),
    );
    sinon.assert.calledWith(initialize, 'Target.resume');
  });

  for (const realDevice of [false, true]) {
    it(`retains runtime policy after reconnect and removes cleared values (real=${realDevice})`, async function () {
      const remote = realDevice ? new RemoteDebuggerRealDevice({udid: 'test'}) : new RemoteDebugger();
      await remote.setPageSetting('ImagesEnabled', false);
      await remote.setUserPreference('PrefersColorScheme', 'Dark');
      for (let attempt = 0; attempt < 2; attempt++) {
        await remote.initRpcClient();
        const client = remote.requireRpcClient();
        sinon.stub(client, 'send').resolves();
        const send = sinon.stub(client, 'sendToDevice').resolves();
        await addPage(client, 'first');
        sinon.assert.calledWith(send, 'Page.overrideSetting', sinon.match({setting: 'ImagesEnabled', value: false}));
        sinon.assert.calledWith(
          send,
          'Page.overrideUserPreference',
          sinon.match({name: 'PrefersColorScheme', value: 'Dark'}),
        );
        remote.teardown();
      }
      await remote.setPageSetting('ImagesEnabled', undefined);
      await remote.setUserPreference('PrefersColorScheme', undefined);
      await remote.initRpcClient();
      const client = remote.requireRpcClient();
      sinon.stub(client, 'send').resolves();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'next');
      sinon.assert.notCalled(send);
    });
  }

  it('does not retain a rejected preference for reconnect', async function () {
    const remote = new RemoteDebugger({userPreferences: {PrefersContrast: 'More'}});
    await remote.initRpcClient();
    sinon.stub(remote.requireRpcClient(), 'setUserPreference').rejects(new Error('Rejected'));
    await assert.rejects(remote.setUserPreference('PrefersContrast', 'NoPreference'), /Rejected/);
    remote.teardown();
    await remote.initRpcClient();
    const client = remote.requireRpcClient();
    sinon.stub(client, 'send').resolves();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'next');
    sinon.assert.calledWith(send, 'Page.overrideUserPreference', sinon.match({name: 'PrefersContrast', value: 'More'}));
  });
  it('replaces the whole object, including clearing omitted entries and UA', async function () {
    const client = new RpcClient({
      webInspectorSettings: {
        pageSettings: {ImagesEnabled: false},
        userPreferences: {PrefersColorScheme: 'Dark'},
        userAgent: 'Old/1',
      },
    });
    sinon.stub(client, 'send').resolves();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'first');
    sinon.assert.calledWith(send, 'Page.overrideUserAgent', sinon.match({value: 'Old/1'}));
    send.resetHistory();
    await client.setWebInspectorSettings({userAgent: 'New/2'});
    assert.strictEqual(send.callCount, 3);
    sinon.assert.calledWith(send, 'Page.overrideUserAgent', sinon.match({value: 'New/2'}));
    for (const {args} of send.getCalls().filter(({args}) => args[0] !== 'Page.overrideUserAgent')) {
      assert.strictEqual(Object.hasOwn(args[1], 'value'), false);
    }
    send.resetHistory();
    await addPage(client, 'provisional', '1', true);
    sinon.assert.calledOnceWithExactly(send, 'Page.overrideUserAgent', {
      appIdKey: 'app',
      pageIdKey: '1',
      targetId: 'provisional',
      value: 'New/2',
    });
    send.resetHistory();
    await client.setWebInspectorSettings({});
    assert.strictEqual(send.callCount, 2);
    assert.ok(send.getCalls().every(({args}) => !Object.hasOwn(args[1], 'value')));
    send.resetHistory();
    await addPage(client, 'next', '2');
    sinon.assert.notCalled(send);
  });

  it('rolls all changed keys back on every updated target if a batch fails', async function () {
    const previous = {
      pageSettings: {ImagesEnabled: true},
      userPreferences: {PrefersColorScheme: 'Dark' as const},
      userAgent: 'Old/1',
    };
    const client = new RpcClient({webInspectorSettings: previous});
    sinon.stub(client, 'send').resolves();
    const state = new Map<string, Record<string, unknown>>();
    let failAt = -1;
    let calls = 0;
    sinon.stub(client, 'sendToDevice').callsFake(async (method, opts) => {
      if (++calls === failAt) {
        throw new Error('Rejected batch');
      }
      const target = String(opts.targetId);
      const values = state.get(target) ?? {};
      const key = `${method}:${opts.setting ?? opts.name ?? ''}`;
      if (Object.hasOwn(opts, 'value')) {
        values[key] = opts.value;
      } else {
        delete values[key];
      }
      state.set(target, values);
      return {};
    });
    await addPage(client, 'first');
    await addPage(client, 'second', '2');
    const baseline = structuredClone(state);
    failAt = calls + 6;
    await assert.rejects(
      client.setWebInspectorSettings({
        pageSettings: {ImagesEnabled: false, ScriptEnabled: false},
        userPreferences: {PrefersColorScheme: 'Light'},
        userAgent: 'New/2',
      }),
      /Rejected batch/,
    );
    assert.deepStrictEqual(state, baseline);
    await addPage(client, 'next', '3');
    assert.deepStrictEqual(state.get('next'), baseline.get('first'));
  });

  it('does not send unchanged values on a repeated whole-object update', async function () {
    const settings = {pageSettings: {ImagesEnabled: false}, userAgent: 'Test/1'};
    const client = new RpcClient({webInspectorSettings: settings});
    sinon.stub(client, 'send').resolves();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'first');
    send.resetHistory();
    await client.setWebInspectorSettings(structuredClone(settings));
    sinon.assert.notCalled(send);
  });

  for (const realDevice of [false, true]) {
    it(`snapshots a grouped policy and retains UA after reconnect (real=${realDevice})`, async function () {
      const remote = realDevice ? new RemoteDebuggerRealDevice({udid: 'test'}) : new RemoteDebugger();
      const settings = {pageSettings: {ImagesEnabled: false}, userAgent: 'Test/1'};
      await remote.setWebInspectorSettings(settings);
      settings.pageSettings.ImagesEnabled = true;
      settings.userAgent = 'Changed';
      for (let i = 0; i < 2; i++) {
        await remote.initRpcClient();
        const client = remote.requireRpcClient();
        sinon.stub(client, 'send').resolves();
        const send = sinon.stub(client, 'sendToDevice').resolves();
        await addPage(client, 'first');
        sinon.assert.calledWith(send, 'Page.overrideSetting', sinon.match({setting: 'ImagesEnabled', value: false}));
        sinon.assert.calledWith(send, 'Page.overrideUserAgent', sinon.match({value: 'Test/1'}));
        remote.teardown();
      }
      await remote.setWebInspectorSettings({});
      await remote.initRpcClient();
      const client = remote.requireRpcClient();
      sinon.stub(client, 'send').resolves();
      const send = sinon.stub(client, 'sendToDevice').resolves();
      await addPage(client, 'next');
      sinon.assert.notCalled(send);
    });
  }

  it('retains the previous complete object after rejection and reconnect', async function () {
    const remote = new RemoteDebugger({webInspectorSettings: {userAgent: 'Old/1'}});
    await remote.initRpcClient();
    sinon.stub(remote.requireRpcClient(), 'setWebInspectorSettings').rejects(new Error('Rejected'));
    await assert.rejects(remote.setWebInspectorSettings({userAgent: 'New/2'}), /Rejected/);
    remote.teardown();
    await remote.initRpcClient();
    const client = remote.requireRpcClient();
    sinon.stub(client, 'send').resolves();
    const send = sinon.stub(client, 'sendToDevice').resolves();
    await addPage(client, 'next');
    sinon.assert.calledOnceWithExactly(send, 'Page.overrideUserAgent', {
      appIdKey: 'app',
      pageIdKey: '1',
      targetId: 'next',
      value: 'Old/1',
    });
  });
});
