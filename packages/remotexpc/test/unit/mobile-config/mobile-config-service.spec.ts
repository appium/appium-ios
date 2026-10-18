import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {PlistDictionary} from '../../../src/lib/types.js';
import {MobileConfigService} from '../../../src/services/ios/mobile-config/index.js';
import {
  type FakeShimDaemon,
  type ShimReply,
  holdFirstReply,
  startFakeShimDaemon,
} from '../../helpers/fake-shim-daemon.js';

const UDID = 'phone-udid';
const PROFILE_ID = 'com.example.profile';

/**
 * MobileConfigService that resolves its shim service to the fake daemon instead of a tunnel.
 */
class TestMobileConfigService extends MobileConfigService {
  constructor(private readonly port: number) {
    super(UDID);
  }

  protected override async resolveServiceAddress(): Promise<[string, number]> {
    return ['127.0.0.1', this.port];
  }
}

/**
 * Builds a GetProfileList reply listing a single installed profile.
 */
function profileList(identifier: string): PlistDictionary {
  return {
    OrderedIdentifiers: [identifier],
    ProfileManifest: {[identifier]: {Description: 'Example', IsActive: true}},
    ProfileMetadata: {
      [identifier]: {
        PayloadDisplayName: 'Example',
        PayloadRemovalDisallowed: false,
        PayloadUUID: 'B30005CC-BC73-4E42-8545-8DA6C44A8A71',
        PayloadVersion: 1,
      },
    },
    Status: 'Acknowledged',
  };
}

/**
 * Answers MCInstall requests the way the daemon does when one profile is installed.
 */
function mobileConfigReply(request: PlistDictionary): PlistDictionary {
  if (request.RequestType === 'GetProfileList') {
    return profileList(PROFILE_ID);
  }
  return {Status: 'Acknowledged'};
}

/**
 * Runs `body` against a service wired to a fresh fake daemon, then tears both down.
 */
async function withService(
  body: (service: TestMobileConfigService, daemon: FakeShimDaemon) => Promise<void>,
  reply: ShimReply = mobileConfigReply,
): Promise<void> {
  const daemon = await startFakeShimDaemon(reply);
  const service = new TestMobileConfigService(daemon.port);
  try {
    await body(service, daemon);
  } finally {
    service.close();
    await daemon.close();
  }
}

describe('MobileConfigService', function () {
  it('sends each request to the daemon once', async function () {
    await withService(async (service, daemon) => {
      const list = await service.getProfileList();
      await daemon.settle();

      assert.deepEqual(list.OrderedIdentifiers, [PROFILE_ID]);
      assert.deepEqual(
        daemon.requests.map((request) => request.RequestType),
        ['GetProfileList'],
      );
    });
  });

  it('removes a profile with one list and one remove request', async function () {
    await withService(async (service, daemon) => {
      await service.removeProfile(PROFILE_ID);
      await daemon.settle();

      assert.deepEqual(
        daemon.requests.map((request) => request.RequestType),
        ['GetProfileList', 'RemoveProfile'],
      );
    });
  });

  it('leaves no unread reply on the connection', async function () {
    await withService(async (service) => {
      await service.getProfileList();
      const conn = await service.connectToMobileConfigService();

      await assert.rejects(conn.receive(200), /Timed out waiting for plist response/);
    });
  });

  it('closes its connection and reconnects on the next call', async function () {
    await withService(async (service) => {
      await service.getProfileList();
      const first = await service.connectToMobileConfigService();
      service.close();

      assert.ok(first.getSocket().writableEnded);
      assert.notEqual(await service.connectToMobileConfigService(), first);
    });
  });

  it('reconnects after a timed out request so its late reply is not read by the next call', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const held = holdFirstReply((request, index) => profileList(`reply-${index}`));
    await withService(async (service) => {
      const timedOut = assert.rejects(service.getProfileList(), /Timed out waiting for plist response/);
      await held.received;
      t.mock.timers.tick(10_000);
      await timedOut;
      held.release();

      const list = await service.getProfileList();
      assert.deepEqual(list.OrderedIdentifiers, ['reply-1']);
    }, held.reply);
  });
});
