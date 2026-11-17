import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {PlistDictionary} from '../../../src/lib/types.js';
import {
  type PowerAssertionOptions,
  PowerAssertionService,
  PowerAssertionType,
} from '../../../src/services/ios/power-assertion/index.js';
import {
  type FakeShimDaemon,
  type ShimReply,
  holdFirstReply,
  startFakeShimDaemon,
} from '../../helpers/fake-shim-daemon.js';

const UDID = 'phone-udid';
const ASSERTION: PowerAssertionOptions = {
  type: PowerAssertionType.PREVENT_SYSTEM_SLEEP,
  name: 'KeepAwake',
  timeout: 30,
};

/**
 * PowerAssertionService that resolves its shim service to the fake daemon instead of a tunnel.
 */
class TestPowerAssertionService extends PowerAssertionService {
  constructor(private readonly port: number) {
    super(UDID);
  }

  protected override async resolveServiceAddress(): Promise<[string, number]> {
    return ['127.0.0.1', this.port];
  }
}

/**
 * Answers a create request the way the assertion agent does on success.
 */
function assertionReply(): PlistDictionary {
  return {};
}

/**
 * Runs `body` against a service wired to a fresh fake daemon, then tears both down.
 */
async function withService(
  body: (service: TestPowerAssertionService, daemon: FakeShimDaemon) => Promise<void>,
  reply: ShimReply = assertionReply,
): Promise<void> {
  const daemon = await startFakeShimDaemon(reply);
  const service = new TestPowerAssertionService(daemon.port);
  try {
    await body(service, daemon);
  } finally {
    await service.close();
    await daemon.close();
  }
}

describe('PowerAssertionService', function () {
  describe('createPowerAssertion', function () {
    it('resolves only after the daemon has replied', async function () {
      const held = holdFirstReply(assertionReply);
      await withService(async (service, daemon) => {
        let created = false;
        const creation = service.createPowerAssertion(ASSERTION).then(() => {
          created = true;
        });
        try {
          await held.received;
          await daemon.settle();

          assert.equal(created, false);
        } finally {
          held.release();
          await creation;
        }
      }, held.reply);
    });

    it('rejects with the error the device replies with and releases the connection', async function () {
      await withService(
        async (service, daemon) => {
          await assert.rejects(
            service.createPowerAssertion(ASSERTION),
            /Failed to create power assertion "KeepAwake": InvalidRequest/,
          );
          await daemon.settle();

          assert.equal(daemon.openConnections(), 0);
        },
        () => ({ErrorKey: 'InvalidRequest'}),
      );
    });

    it('holds every assertion on a connection of its own', async function () {
      await withService(async (service, daemon) => {
        await service.createPowerAssertion(ASSERTION);
        await service.createPowerAssertion({...ASSERTION, name: 'KeepAwakeToo'});
        await daemon.settle();

        assert.deepEqual(
          daemon.requests.map((request) => request.AssertionNameKey),
          ['KeepAwake', 'KeepAwakeToo'],
        );
        assert.equal(daemon.openConnections(), 2);
      });
    });

    it('forgets an assertion once the device has closed its connection', async function () {
      await withService(async (service, daemon) => {
        await service.createPowerAssertion(ASSERTION);
        await daemon.close();
        await daemon.settle();

        assert.equal((service as any)._conns.size, 0);
      });
    });
  });

  describe('close', function () {
    it('stops an assertion that is still connecting from being created', async function () {
      await withService(async (service, daemon) => {
        const creation = service.createPowerAssertion(ASSERTION);
        await service.close();

        await assert.rejects(creation, /Power assertion "KeepAwake" was not created: the service was closed/);
        await daemon.settle();
        assert.deepEqual(daemon.requests, []);
        assert.equal(daemon.openConnections(), 0);
      });
    });

    it('releases every assertion that is still held', async function () {
      await withService(async (service, daemon) => {
        await service.createPowerAssertion(ASSERTION);
        await service.createPowerAssertion({...ASSERTION, name: 'KeepAwakeToo'});

        await service.close();
        await daemon.settle();

        assert.equal(daemon.openConnections(), 0);
      });
    });
  });

  describe('PowerAssertionService instantiation', function () {
    it('should create a service with valid udid', function () {
      const service = new PowerAssertionService('test-udid');
      assert.ok(service instanceof PowerAssertionService);
    });
  });

  describe('buildCreateAssertionRequest', function () {
    it('should build request without details', function () {
      const service = new PowerAssertionService('test-udid');
      const request = (service as any).buildCreateAssertionRequest({
        type: PowerAssertionType.PREVENT_USER_IDLE_SYSTEM_SLEEP,
        name: 'TestAssertion',
        timeout: 30,
      });

      assert.deepStrictEqual(request, {
        CommandKey: 'CommandCreateAssertion',
        AssertionTypeKey: 'PreventUserIdleSystemSleep',
        AssertionNameKey: 'TestAssertion',
        AssertionTimeoutKey: 30,
      });
    });

    it('should build request with details', function () {
      const service = new PowerAssertionService('test-udid');
      const request = (service as any).buildCreateAssertionRequest({
        type: PowerAssertionType.PREVENT_SYSTEM_SLEEP,
        name: 'TestAssertion',
        timeout: 60,
        details: 'Running important task',
      });

      assert.deepStrictEqual(request, {
        CommandKey: 'CommandCreateAssertion',
        AssertionTypeKey: 'PreventSystemSleep',
        AssertionNameKey: 'TestAssertion',
        AssertionTimeoutKey: 60,
        AssertionDetailKey: 'Running important task',
      });
    });
  });
});
