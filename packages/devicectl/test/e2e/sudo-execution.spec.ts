import assert from 'node:assert/strict';
import {describe, it, type TestContext} from 'node:test';

import {Devicectl} from '../../lib/devicectl.js';

describe('manual sudo execution e2e', function () {
  it('runs devicectl as original non-root user under sudo', async function (ctx: TestContext) {
    if (
      process.env.CI ||
      process.platform !== 'darwin' ||
      !process.geteuid ||
      process.geteuid() !== 0 ||
      !process.env.SUDO_UID ||
      !process.env.SUDO_GID
    ) {
      return ctx.skip();
    }

    const devicectl = new Devicectl('');
    const result = await devicectl.execute(['list', 'devices'], {
      noDevice: true,
      asJson: true,
    });

    assert.strictEqual(typeof result.stdout, 'string');
    assert.ok(result.stdout.length > 0);
  });
});
