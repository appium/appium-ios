import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {PlistDictionary} from '../../../src/lib/types.js';
import {MisagentService} from '../../../src/services/ios/misagent/index.js';
import {
  type FakeShimDaemon,
  type ShimReply,
  holdFirstReply,
  startFakeShimDaemon,
} from '../../helpers/fake-shim-daemon.js';

const UDID = 'phone-udid';
const PROFILE_UUID = '00000000-1111-2222-3333-444444444444';

/**
 * MisagentService that resolves its shim service to the fake daemon instead of a tunnel.
 */
class TestMisagentService extends MisagentService {
  constructor(private readonly port: number) {
    super(UDID);
  }

  protected override async resolveServiceAddress(): Promise<[string, number]> {
    return ['127.0.0.1', this.port];
  }
}

/**
 * Answers misagent requests the way the daemon does on success.
 */
function misagentReply(request: PlistDictionary): PlistDictionary {
  if (request.MessageType === 'CopyAll') {
    return {Payload: [], Status: 0};
  }
  return {Status: 0};
}

/**
 * Runs `body` against a service wired to a fresh fake daemon, then tears both down.
 */
async function withService(
  body: (service: TestMisagentService, daemon: FakeShimDaemon) => Promise<void>,
  reply: ShimReply = misagentReply,
): Promise<void> {
  const daemon = await startFakeShimDaemon(reply);
  const service = new TestMisagentService(daemon.port);
  try {
    await body(service, daemon);
  } finally {
    service.close();
    await daemon.close();
  }
}

describe('MisagentService', function () {
  it('sends each request to the daemon once', async function () {
    await withService(async (service, daemon) => {
      assert.deepEqual(await service.fetchAll(), []);
      await daemon.settle();

      assert.deepEqual(
        daemon.requests.map((request) => request.MessageType),
        ['CopyAll'],
      );
    });
  });

  it('installs and removes a profile once each on a reused connection', async function () {
    await withService(async (service, daemon) => {
      await service.installProfile(Buffer.from('profile'));
      await service.removeProfile(PROFILE_UUID);
      await daemon.settle();

      assert.deepEqual(
        daemon.requests.map((request) => request.MessageType),
        ['Install', 'Remove'],
      );
    });
  });

  it('leaves no unread reply on the connection', async function () {
    await withService(async (service) => {
      await service.fetchAll();
      const conn = await service.connectToMisagentService();

      await assert.rejects(conn.receive(200), /Timed out waiting for plist response/);
    });
  });

  it('closes its connection and reconnects on the next call', async function () {
    await withService(async (service) => {
      await service.fetchAll();
      const first = await service.connectToMisagentService();
      service.close();

      assert.ok(first.getSocket().writableEnded);
      assert.notEqual(await service.connectToMisagentService(), first);
    });
  });

  it('reconnects after a timed out request so its late reply is not read by the next call', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const held = holdFirstReply((request, index) => (index === 0 ? misagentReply(request) : {Status: 1}));
    await withService(async (service) => {
      const timedOut = assert.rejects(service.fetchAll(), /Timed out waiting for plist response/);
      await held.received;
      t.mock.timers.tick(10_000);
      await timedOut;
      held.release();

      await assert.rejects(service.removeProfile(PROFILE_UUID), /Failed to remove profile: Invalid response/);
    }, held.reply);
  });
});
