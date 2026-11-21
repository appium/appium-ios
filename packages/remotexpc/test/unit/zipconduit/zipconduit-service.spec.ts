import assert from 'node:assert/strict';
import {once} from 'node:events';
import net, {type AddressInfo} from 'node:net';
import {describe, it} from 'node:test';

import {createPlist} from '../../../src/lib/plist/plist-creator.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {ZipConduitService} from '../../../src/services/ios/zipconduit/index.js';

const UDID = '00008030-000000000000002E';
const DATA_COMPLETE: PlistDictionary = {Status: 'DataComplete'};
const PROGRESS: PlistDictionary = {InstallProgressDict: {PercentComplete: 40, Status: 'Installing'}};

function frame(message: PlistDictionary): Buffer {
  const body = Buffer.from(createPlist(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Lets pending socket events and promise callbacks run without advancing mocked timers. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Connects a ZipConduitService to a localhost peer that plays the device side of an already
 * started zip_conduit connection.
 */
async function withConnectedService(
  body: (service: ZipConduitService, client: net.Socket, device: net.Socket) => Promise<void>,
): Promise<void> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = net.connect((server.address() as AddressInfo).port, '127.0.0.1');
  await once(client, 'connect');
  const [device] = (await accepted) as [net.Socket];
  device.on('error', () => {});
  const service = new ZipConduitService(UDID);
  (service as any).socket = client;
  try {
    await body(service, client, device);
  } finally {
    client.destroy();
    device.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

function waitForInstallation(service: ZipConduitService, client: net.Socket, timeoutMs: number): Promise<void> {
  return (service as any).waitForInstallation(client, {timeoutMs});
}

describe('ZipConduitService', function () {
  describe('install progress', function () {
    it('keeps waiting past 30s between progress updates while within the install timeout', async function (t) {
      await withConnectedService(async (service, client, device) => {
        t.mock.timers.enable({apis: ['setTimeout']});
        const installation = waitForInstallation(service, client, 10 * 60 * 1000);

        device.write(frame(PROGRESS));
        await flush();
        t.mock.timers.tick(31_000);
        device.write(frame(DATA_COMPLETE));

        await installation;
        assert.equal(client.destroyed, false);
      });
    });

    it('gives up only once the install timeout elapses and drops the connection', async function (t) {
      await withConnectedService(async (service, client) => {
        t.mock.timers.enable({apis: ['setTimeout']});
        const installation = waitForInstallation(service, client, 45_000);
        let settled = false;
        installation.then(
          () => (settled = true),
          () => (settled = true),
        );

        t.mock.timers.tick(44_000);
        await flush();
        assert.equal(settled, false, 'install wait ended before its timeout');

        t.mock.timers.tick(2_000);
        await assert.rejects(installation, /Timed out waiting for zip_conduit progress/);
        assert.equal(client.destroyed, true);
      });
    });
  });

  describe('close', function () {
    it('closes the connection when nothing was read from it', async function () {
      await withConnectedService(async (service, client, device) => {
        const deviceSawClose = once(device, 'close');
        service.close();

        assert.equal(client.destroyed, true);
        await deviceSawClose;
      });
    });

    it('closes the connection after the installation finished', async function () {
      await withConnectedService(async (service, client, device) => {
        device.write(frame(DATA_COMPLETE));
        await waitForInstallation(service, client, 10_000);
        const deviceSawClose = once(device, 'close');

        service.close();

        assert.equal(client.destroyed, true);
        await deviceSawClose;
      });
    });
  });
});
