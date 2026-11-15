import assert from 'node:assert/strict';
import {Socket} from 'node:net';
import {type TestContext, describe, it} from 'node:test';

import type {LockdownService} from '../../../src/lib/lockdown/index.js';
import type {PairRecord} from '../../../src/lib/pair-record/pair-record.js';
import type * as TunnelService from '../../../src/services/ios/tunnel-service/index.js';
import {mockImport} from '../../helpers/mock-module.js';

const UDID = '00008110-000000000000001E';
const DEVICE_ID = 7;
const SERVICE_PORT = 49152;

const PAIR_RECORD: PairRecord = {
  HostID: 'host-id',
  SystemBUID: 'system-buid',
  HostCertificate: 'host-certificate',
  HostPrivateKey: 'host-private-key',
  DeviceCertificate: 'device-certificate',
  RootCertificate: null,
  RootPrivateKey: null,
  WiFiMACAddress: null,
  EscrowBag: null,
};

/** Lockdown client that answers StartService with SERVICE_PORT. */
function fakeLockdownClient(): LockdownService {
  return {
    waitForTLSUpgrade: async () => {},
    sendAndReceive: async () => ({Port: SERVICE_PORT}),
    close: () => {},
  } as unknown as LockdownService;
}

/** Imports the tunnel service with a usbmux client that serves `pairRecord` and records its calls. */
async function importWithUsbmux(t: TestContext, pairRecord: PairRecord | null) {
  const socket = new Socket();
  const calls = {connect: [] as Array<[number, number]>, close: 0};
  const {startCoreDeviceProxyTcp} = await mockImport<typeof TunnelService>(
    t,
    '../../../src/services/ios/tunnel-service/index.js',
    import.meta.url,
    {
      '../../../src/lib/usbmux/index.js': {
        createUsbmux: async () => ({
          readPairRecord: async () => pairRecord,
          connect: async (deviceId: number, port: number) => {
            calls.connect.push([deviceId, port]);
            return socket;
          },
          close: async () => {
            calls.close++;
          },
        }),
      },
    },
  );
  return {startCoreDeviceProxyTcp, socket, calls};
}

describe('startCoreDeviceProxyTcp', function () {
  it('returns the device certificate of the pair record with the host credentials', async function (t) {
    const {startCoreDeviceProxyTcp, socket, calls} = await importWithUsbmux(t, PAIR_RECORD);

    const session = await startCoreDeviceProxyTcp(fakeLockdownClient(), DEVICE_ID, UDID);

    assert.deepStrictEqual(session, {
      socket,
      cert: 'host-certificate',
      key: 'host-private-key',
      deviceCert: 'device-certificate',
    });
    assert.deepStrictEqual(calls.connect, [[DEVICE_ID, SERVICE_PORT]]);
  });

  it('returns no device certificate when the pair record has none', async function (t) {
    const {startCoreDeviceProxyTcp, socket, calls} = await importWithUsbmux(t, {
      ...PAIR_RECORD,
      DeviceCertificate: null,
    });

    const session = await startCoreDeviceProxyTcp(fakeLockdownClient(), DEVICE_ID, UDID);

    assert.deepStrictEqual(session, {
      socket,
      cert: 'host-certificate',
      key: 'host-private-key',
      deviceCert: undefined,
    });
    assert.deepStrictEqual(calls.connect, [[DEVICE_ID, SERVICE_PORT]]);
  });
});
