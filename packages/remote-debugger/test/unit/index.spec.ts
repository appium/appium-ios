import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
  ATOM_NAMES,
  AutomationSession,
  createRemoteDebugger,
  REMOTE_DEBUGGER_PORT,
  RemoteDebugger,
  RemoteDebuggerRealDevice,
  validateWebInspectorPageSettings,
} from '../../lib/index.js';

describe('package public exports', function () {
  it('validates and narrows settings without constructing a debugger or modifying input', function () {
    const settings: unknown = Object.freeze({
      pageSettings: Object.freeze({WebSecurityEnabled: false}),
      userPreferences: Object.freeze({PrefersColorScheme: 'Dark'}),
      userAgent: 'Test/1.0',
    });
    validateWebInspectorPageSettings(settings);
    assert.strictEqual(settings.pageSettings?.WebSecurityEnabled, false);
    assert.strictEqual(settings.userPreferences?.PrefersColorScheme, 'Dark');
    assert.strictEqual(settings.userAgent, 'Test/1.0');
    assert.doesNotThrow(() => validateWebInspectorPageSettings({}));
  });

  it('rejects invalid settings through the public validator with TypeError', function () {
    for (const settings of [null, {unknown: true}, {pageSettings: {WebSecurityEnabled: 'false'}}]) {
      assert.throws(() => validateWebInspectorPageSettings(settings), TypeError);
    }
  });

  it('exports the debugger classes/values used by consumers', function () {
    assert.strictEqual(typeof createRemoteDebugger, 'function');
    assert.strictEqual(RemoteDebugger.name, 'RemoteDebugger');
    assert.strictEqual(RemoteDebuggerRealDevice.name, 'RemoteDebuggerRealDevice');
    assert.strictEqual(typeof REMOTE_DEBUGGER_PORT, 'number');
    assert.ok(Array.isArray(ATOM_NAMES));
  });

  it('exports AutomationSession so consumers can name its type without a deep import', function () {
    assert.strictEqual(AutomationSession.name, 'AutomationSession');
  });

  it('creates a RemoteDebugger whose automationSession is an AutomationSession once started', async function () {
    const rd = createRemoteDebugger({} as any, false);
    (rd as any)._automationSession = new AutomationSession(
      {send: async () => undefined} as any,
      {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as any,
    );
    assert.ok(rd.automationSession instanceof AutomationSession);
  });
});
