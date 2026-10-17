import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {PlistDictionary} from '../../../src/lib/types.js';
import {InterfaceOrientation, SpringBoardService} from '../../../src/services/ios/springboard-service/index.js';
import {
  type FakeShimDaemon,
  type ShimReply,
  holdFirstReply,
  startFakeShimDaemon,
} from '../../helpers/fake-shim-daemon.js';

const UDID = 'phone-udid';
const PNG = Buffer.from('png');

/**
 * SpringBoardService that resolves its shim service to the fake daemon instead of a tunnel.
 */
class TestSpringBoardService extends SpringBoardService {
  constructor(private readonly port: number) {
    super(UDID);
  }

  protected override async resolveServiceAddress(): Promise<[string, number]> {
    return ['127.0.0.1', this.port];
  }
}

/**
 * Answers springboardservices requests the way the daemon does on success.
 */
function springboardReply(request: PlistDictionary): PlistDictionary {
  if (request.command === 'getInterfaceOrientation') {
    return {interfaceOrientation: InterfaceOrientation.LANDSCAPE};
  }
  return {pngData: PNG};
}

/**
 * Runs `body` against a service wired to a fresh fake daemon, then tears both down.
 */
async function withService(
  body: (service: TestSpringBoardService, daemon: FakeShimDaemon) => Promise<void>,
  reply: ShimReply = springboardReply,
): Promise<void> {
  const daemon = await startFakeShimDaemon(reply);
  const service = new TestSpringBoardService(daemon.port);
  try {
    await body(service, daemon);
  } finally {
    service.close();
    await daemon.close();
  }
}

describe('SpringBoardService', function () {
  it('sends each request to the daemon once', async function () {
    await withService(async (service, daemon) => {
      assert.equal(await service.getInterfaceOrientation(), InterfaceOrientation.LANDSCAPE);
      await daemon.settle();

      assert.deepEqual(
        daemon.requests.map((request) => request.command),
        ['getInterfaceOrientation'],
      );
    });
  });

  it('sends one request per call on a reused connection', async function () {
    await withService(async (service, daemon) => {
      await service.getInterfaceOrientation();
      assert.deepEqual(await service.getIconPNGData('com.apple.Preferences'), PNG);
      await daemon.settle();

      assert.deepEqual(
        daemon.requests.map((request) => request.command),
        ['getInterfaceOrientation', 'getIconPNGData'],
      );
    });
  });

  it('leaves no unread reply on the connection', async function () {
    await withService(async (service) => {
      await service.getInterfaceOrientation();
      const conn = await service.connectToSpringboardService();

      await assert.rejects(conn.receive(200), /Timed out waiting for plist response/);
    });
  });

  it('closes its connection and reconnects on the next call', async function () {
    await withService(async (service) => {
      await service.getInterfaceOrientation();
      const first = await service.connectToSpringboardService();
      service.close();

      assert.ok(first.getSocket().writableEnded);
      assert.notEqual(await service.connectToSpringboardService(), first);
    });
  });

  it('reconnects after a timed out request so its late reply is not read by the next call', async function (t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const held = holdFirstReply((request, index) => ({
      interfaceOrientation: index === 0 ? InterfaceOrientation.PORTRAIT : InterfaceOrientation.LANDSCAPE,
    }));
    await withService(async (service) => {
      const timedOut = assert.rejects(service.getInterfaceOrientation(), /Timed out waiting for plist response/);
      await held.received;
      t.mock.timers.tick(10_000);
      await timedOut;
      held.release();

      assert.equal(await service.getInterfaceOrientation(), InterfaceOrientation.LANDSCAPE);
    }, held.reply);
  });
});
