import assert from 'node:assert/strict';
import net from 'node:net';
import {describe, it} from 'node:test';

import * as sinon from 'sinon';

import {LockdownService, LockdownStartServiceError} from '../../../src/lib/lockdown/index.js';

function createLockdown(response: Record<string, unknown>) {
  const socket = new net.Socket();
  const lockdown = new LockdownService(socket, 'udid', false);
  const sendAndReceive = sinon.stub(lockdown, 'sendAndReceive').resolves(response as never);
  return {lockdown, sendAndReceive, socket};
}

describe('LockdownService.startService', function () {
  it('sends StartService and returns the port and SSL flag', async function () {
    const {lockdown, sendAndReceive, socket} = createLockdown({Port: 49152, EnableServiceSSL: true});

    assert.deepEqual(await lockdown.startService('com.apple.afc'), {port: 49152, enableServiceSSL: true});
    sinon.assert.calledOnceWithMatch(sendAndReceive, {Request: 'StartService', Service: 'com.apple.afc'});
    socket.destroy();
  });

  it('treats a missing EnableServiceSSL as plain text', async function () {
    const {lockdown, socket} = createLockdown({Port: 50000});

    assert.deepEqual(await lockdown.startService('com.apple.syslog_relay'), {port: 50000, enableServiceSSL: false});
    socket.destroy();
  });

  it('turns a locked device into an actionable error', async function () {
    const {lockdown, socket} = createLockdown({Error: 'PasswordProtected'});

    await assert.rejects(
      lockdown.startService('com.apple.afc'),
      (err: Error) => err instanceof LockdownStartServiceError && /locked with a passcode/.test(err.message),
    );
    socket.destroy();
  });

  it('reports the lockdown error reason for refused services', async function () {
    const {lockdown, socket} = createLockdown({Error: 'InvalidService'});

    await assert.rejects(
      lockdown.startService('com.apple.nope'),
      (err: Error) =>
        err instanceof LockdownStartServiceError &&
        err.serviceName === 'com.apple.nope' &&
        err.reason === 'InvalidService',
    );
    socket.destroy();
  });

  it('rejects responses without a usable port', async function () {
    const {lockdown, socket} = createLockdown({Request: 'StartService'});

    await assert.rejects(lockdown.startService('com.apple.afc'), /Unexpected StartService response/);
    socket.destroy();
  });
});
