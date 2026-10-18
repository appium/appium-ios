import assert from 'node:assert/strict';
import {once} from 'node:events';
import net, {type AddressInfo, type Socket} from 'node:net';
import {describe, it} from 'node:test';
import type {TestContext} from 'node:test';

import * as sinon from 'sinon';

import type * as LockdownModule from '../../../src/lib/lockdown/index.js';
import {PlistService} from '../../../src/lib/plist/plist-service.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {ServiceConnection} from '../../../src/service-connection.js';
import {mockImport} from '../../helpers/mock-module.js';

const UDID = 'test-udid';
const PRODUCT_VERSION = '26.0';

interface FakeLockdownd {
  port: number;
  close: () => Promise<void>;
}

/**
 * Replies to requests on one fake lockdownd connection until it is closed.
 */
async function respond(service: PlistService, startService: PlistDictionary): Promise<void> {
  for (;;) {
    const request = await service.receivePlist(60_000).catch((): null => null);
    if (!request) {
      return;
    }
    if (request.Request === 'RSDCheckin') {
      service.sendPlist({Request: 'RSDCheckin'});
      service.sendPlist(startService);
    } else if (request.Request === 'GetValue') {
      service.sendPlist({Request: 'GetValue', Value: PRODUCT_VERSION});
    }
  }
}

/**
 * Starts a TCP server speaking remote lockdown: it answers the RSD handshake with
 * RSDCheckin and `startService`, then answers every GetValue request.
 */
async function startFakeLockdownd(startService: PlistDictionary = {Request: 'StartService'}): Promise<FakeLockdownd> {
  const services: PlistService[] = [];
  const server = net.createServer((socket: Socket) => {
    const service = new PlistService(socket);
    services.push(service);
    void respond(service, startService);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const service of services) {
        service.close();
        service.getSocket().destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Imports the lockdown module with tunnel service resolution pointed at the fake lockdownd.
 */
async function loadLockdown(t: TestContext, port: number): Promise<typeof LockdownModule> {
  return mockImport<typeof LockdownModule>(t, '../../../src/lib/lockdown/index.js', import.meta.url, {
    '../../../src/lib/tunnel/tunnel-service-resolver.js': {
      resolveTunnelService: async () => ({host: '127.0.0.1', port, udid: UDID}),
    },
  });
}

describe('createLockdownServiceForTunnel', function () {
  it('stops the handshake connection from receiving lockdown responses', async function (t) {
    const lockdownd = await startFakeLockdownd();
    const createUsingTCP = sinon.spy(ServiceConnection, 'createUsingTCP');
    let lockdown: LockdownModule.LockdownService | undefined;
    try {
      const {createLockdownServiceForTunnel} = await loadLockdown(t, lockdownd.port);
      lockdown = await createLockdownServiceForTunnel(UDID);

      assert.equal(await lockdown.getProductVersion(), PRODUCT_VERSION);

      const handshakeConnection = await createUsingTCP.firstCall.returnValue;
      await assert.rejects(
        handshakeConnection.receive(200),
        /Timed out waiting for plist response/,
        'the handshake connection also decoded and queued the GetValue response',
      );
    } finally {
      createUsingTCP.restore();
      lockdown?.close();
      await lockdownd.close();
    }
  });

  it('leaves a single plist reader on the socket', async function (t) {
    const lockdownd = await startFakeLockdownd();
    let lockdown: LockdownModule.LockdownService | undefined;
    try {
      const {createLockdownServiceForTunnel} = await loadLockdown(t, lockdownd.port);
      lockdown = await createLockdownServiceForTunnel(UDID);

      assert.equal(lockdown.getSocket().listenerCount('data'), 1);
    } finally {
      lockdown?.close();
      await lockdownd.close();
    }
  });

  it('closes the handshake connection when StartService fails', async function (t) {
    const lockdownd = await startFakeLockdownd({
      Request: 'StartService',
      Error: 'ServiceProhibited',
      ErrorDescription: 'Service is not allowed',
    });
    const createUsingTCP = sinon.spy(ServiceConnection, 'createUsingTCP');
    try {
      const {createLockdownServiceForTunnel} = await loadLockdown(t, lockdownd.port);

      await assert.rejects(
        createLockdownServiceForTunnel(UDID),
        /RSD remote lockdown service failed: ServiceProhibited/,
      );

      const socket = (await createUsingTCP.firstCall.returnValue).getSocket();
      assert.ok(socket.writableEnded || socket.destroyed, 'the handshake connection was left open');
    } finally {
      createUsingTCP.restore();
      await lockdownd.close();
    }
  });
});
