import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {LockdownStartServiceError} from '../../src/lib/lockdown/index.js';
import type {PlistDictionary} from '../../src/lib/types.js';
import {BaseService} from '../../src/services/ios/base-service.js';
import {type FakeShimDaemon, startFakeShimDaemon} from '../helpers/fake-shim-daemon.js';

const UDID = 'phone-udid';
const SERVICE_NAME = 'com.apple.example.shim.remote';
const PONG: PlistDictionary = {Reply: 'Pong'};

/**
 * BaseService that resolves its service to the fake daemon instead of a tunnel.
 */
class TestService extends BaseService {
  constructor(private readonly port: number) {
    super(UDID);
  }

  protected override async resolveServiceAddress(): Promise<[string, number]> {
    return ['127.0.0.1', this.port];
  }
}

/**
 * Runs `body` against a service wired to a fresh fake daemon sending `greeting` after the
 * RSDCheckin echo, then tears the daemon down.
 */
async function withDaemon(
  body: (service: TestService, daemon: FakeShimDaemon) => Promise<void>,
  greeting?: PlistDictionary | null,
): Promise<void> {
  const daemon = await startFakeShimDaemon(() => PONG, greeting);
  try {
    await body(new TestService(daemon.port), daemon);
  } finally {
    await daemon.close();
  }
}

describe('BaseService', function () {
  describe('startLockdownService over the tunnel', function () {
    it('returns a connection with the whole handshake consumed', async function () {
      await withDaemon(async (service) => {
        const conn = await service.startLockdownService(SERVICE_NAME);

        await assert.rejects(conn.receive(200), /Timed out waiting for plist response/);
      });
    });

    it('pairs the first request with its own reply', async function () {
      await withDaemon(async (service, daemon) => {
        const conn = await service.startLockdownService(SERVICE_NAME);

        assert.deepEqual(await conn.sendPlistRequest({Command: 'Ping'}), PONG);
        assert.deepEqual(daemon.requests, [{Command: 'Ping'}]);
      });
    });

    it('reports a refusal to start the service and closes the connection', async function () {
      await withDaemon(
        async (service, daemon) => {
          await assert.rejects(service.startLockdownService(SERVICE_NAME), (error: unknown) => {
            assert.ok(error instanceof LockdownStartServiceError, `expected LockdownStartServiceError, got ${error}`);
            assert.equal(error.serviceName, SERVICE_NAME);
            assert.equal(error.reason, 'ServiceProhibited');
            assert.equal(error.description, 'Service is not allowed');
            assert.match(error.message, /ServiceProhibited \(Service is not allowed\)/);
            return true;
          });
          await daemon.settle();

          assert.equal(daemon.openConnections(), 0);
        },
        {Request: 'StartService', Error: 'ServiceProhibited', ErrorDescription: 'Service is not allowed'},
      );
    });

    it('rejects a greeting that is not StartService and closes the connection', async function () {
      await withDaemon(
        async (service, daemon) => {
          await assert.rejects(
            service.startLockdownService(SERVICE_NAME),
            /Expected StartService after RSDCheckin, got: {"Request":"Something"}/,
          );
          await daemon.settle();

          assert.equal(daemon.openConnections(), 0);
        },
        {Request: 'Something'},
      );
    });

    it('waits for the greeting no longer than handshakeTimeout and closes the connection', async function () {
      await withDaemon(async (service, daemon) => {
        await assert.rejects(
          service.startLockdownService(SERVICE_NAME, {handshakeTimeout: 100}),
          /Timed out waiting for plist response after 100ms/,
        );
        await daemon.settle();

        assert.equal(daemon.openConnections(), 0);
      }, null);
    });
  });
});
