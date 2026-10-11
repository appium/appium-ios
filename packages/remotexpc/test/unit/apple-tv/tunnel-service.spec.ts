import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import type {TestContext} from 'node:test';

import * as sinon from 'sinon';

import type {PairRecord} from '../../../src/lib/apple-tv/storage/types.js';
import type {AppleTVDevice} from '../../../src/lib/apple-tv/types.js';
import {computeAuthTag} from '../../../src/lib/apple-tv/utils/siphash.js';
import type {DiscoveredDevice} from '../../../src/lib/discovery/types.js';
import {mockImport} from '../../helpers/mock-module.js';

const ALT_IRK = Buffer.from(Array.from({length: 16}, (_, i) => i));
const OTHER_ALT_IRK = Buffer.from(Array.from({length: 16}, (_, i) => i + 16));

function advertisedDevice(name: string, ip: string, altIRK?: Buffer): AppleTVDevice {
  const serviceIdentifier = `${name}-service-id`;
  return {
    name,
    identifier: `${name}-bonjour-id`,
    identifierSource: 'bonjour',
    hostname: `${name}.local`,
    ip,
    port: 49152,
    model: 'AppleTV',
    version: '17.0',
    serviceIdentifier,
    authTag: altIRK ? computeAuthTag(altIRK, serviceIdentifier).toString('base64') : undefined,
  };
}

function pairRecord(remotePairingUdid: string, altIRK?: Buffer): PairRecord {
  return {
    publicKey: Buffer.alloc(32),
    privateKey: Buffer.alloc(32),
    remoteUnlockHostKey: '',
    remotePairingUdid,
    altIRK,
  };
}

describe('AppleTVTunnelService', function () {
  /** Loads the service with stubbed storage, network, remoted and pair-verify so startTunnel runs offline. */
  async function loadTunnelServiceWithRecords(t: TestContext, records: Record<string, PairRecord>) {
    const connect = sinon.stub().resolves();
    const verify = sinon.stub().rejects(new Error('verify failed'));
    const suspend = sinon.stub().resolves();
    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
        '../../../src/lib/apple-tv/network/index.js': {
          NetworkClient: class {
            connect = connect;
            sendPacket = sinon.stub().resolves();
            receiveResponse = sinon.stub().resolves({});
            disconnect() {}
          },
        },
        '../../../src/lib/apple-tv/pairing-protocol/index.js': {
          PairVerificationProtocol: class {
            verify = verify;
            setSequenceNumber() {}
            getSequenceNumber(): number {
              return 0;
            }
          },
        },
        '../../../src/lib/apple-tv/storage/pairing-storage.js': {
          PairingStorage: class {
            async getAvailableDeviceIds(): Promise<string[]> {
              return Object.keys(records);
            }
            async load(deviceId: string): Promise<PairRecord | null> {
              return records[deviceId] ?? null;
            }
          },
        },
        '../../../src/lib/apple-tv/tunnel/remoted-controller.js': {
          RemotedController: class {
            suspend = suspend;
            resume() {}
          },
        },
      },
    );
    return {tunnelService: new AppleTVTunnelService(), connect, verify, suspend};
  }

  async function loadTunnelService(t: TestContext) {
    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
        '../../../src/lib/apple-tv/network/index.js': {
          NetworkClient: class {
            disconnect() {}
          },
        },
        '../../../src/lib/apple-tv/storage/pairing-storage.js': {
          PairingStorage: class {},
        },
        '../../../src/lib/apple-tv/tunnel/remoted-controller.js': {
          RemotedController: class {
            resume() {}
          },
        },
      },
    );
    return AppleTVTunnelService;
  }

  it('uses the provided device discovery timeout', async function (t) {
    const discoverDevices = sinon.stub().resolves([
      {
        id: 'device-1',
        name: 'Apple TV',
        hostname: 'apple-tv.local',
        ip: '192.168.1.10',
        port: 49152,
        metadata: {
          identifier: 'device-1',
          model: 'AppleTV',
          version: '17.0',
        },
      },
    ] satisfies DiscoveredDevice[]);
    const devices: AppleTVDevice[] = [
      {
        name: 'Apple TV',
        identifier: 'device-1',
        hostname: 'apple-tv.local',
        ip: '192.168.1.10',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      },
    ];

    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
        '../../../src/lib/discovery/discovery-backend-factory.js': {
          createDiscoveryBackend: () => ({discoverDevices}),
        },
        '../../../src/lib/apple-tv/devicectl-enrichment.js': {
          enrichDiscoveredDevicesWithDevicectl: async (discoveredDevices: DiscoveredDevice[]) => discoveredDevices,
        },
        '../../../src/lib/apple-tv/discovered-device-mapper.js': {
          toAppleTVDevices: () => devices,
        },
        '../../../src/lib/apple-tv/network/index.js': {
          NetworkClient: class {
            disconnect() {}
          },
        },
        '../../../src/lib/apple-tv/storage/pairing-storage.js': {
          PairingStorage: class {},
        },
        '../../../src/lib/apple-tv/tunnel/remoted-controller.js': {
          RemotedController: class {
            resume() {}
          },
        },
      },
    );

    const tunnelService = new AppleTVTunnelService();
    const discovered = await tunnelService.discoverDevices({
      timeoutMs: 20_000,
    });

    assert.deepStrictEqual(discovered, devices);
    assert.strictEqual(discoverDevices.calledOnceWithExactly(20_000), true);
  });

  it('uses provided devices without running discovery', async function (t) {
    const discoverDevices = sinon.stub().rejects(new Error('unexpected discovery'));
    const devices: AppleTVDevice[] = [
      {
        name: 'Apple TV',
        identifier: 'device-1',
        hostname: 'apple-tv.local',
        ip: '192.168.1.10',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      },
    ];

    const {AppleTVTunnelService} = await mockImport(
      t,
      '../../../src/lib/apple-tv/tunnel/tunnel-service.js',
      import.meta.url,
      {
        '../../../src/lib/discovery/discovery-backend-factory.js': {
          createDiscoveryBackend: () => ({discoverDevices}),
        },
        '../../../src/lib/apple-tv/network/index.js': {
          NetworkClient: class {
            disconnect() {}
          },
        },
        '../../../src/lib/apple-tv/storage/pairing-storage.js': {
          PairingStorage: class {
            async getAvailableDeviceIds(): Promise<string[]> {
              return [];
            }
          },
        },
        '../../../src/lib/apple-tv/tunnel/remoted-controller.js': {
          RemotedController: class {
            resume() {}
          },
        },
      },
    );

    const tunnelService = new AppleTVTunnelService();
    let error: Error | undefined;
    try {
      await tunnelService.startTunnel(undefined, undefined, {devices});
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }

    assert.strictEqual(error?.message, 'No pair records found');
    assert.strictEqual(discoverDevices.called, false);
  });

  it('connects to each discovered device with the pair record its authTag matches', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const other = advertisedDevice('other', '10.0.0.1', OTHER_ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {
      MINE: pairRecord('MINE', ALT_IRK),
      OTHER: pairRecord('OTHER', OTHER_ALT_IRK),
    });

    await assert.rejects(
      tunnelService.startTunnel(undefined, undefined, {devices: [other, mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.1', '10.0.0.2'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['OTHER', 'MINE'],
    );
  });

  it('never contacts a device whose authTag matches no pair record', async function (t) {
    const stranger = advertisedDevice('stranger', '10.0.0.9', OTHER_ALT_IRK);
    const silent = advertisedDevice('silent', '10.0.0.8');
    const {tunnelService, connect, suspend} = await loadTunnelServiceWithRecords(t, {
      MINE: pairRecord('MINE', ALT_IRK),
    });

    await assert.rejects(
      tunnelService.startTunnel(undefined, undefined, {devices: [stranger, silent]}),
      /No discovered device matched a pair record by authTag \(2 devices discovered, 1 without authTag; 1 pair record\)/,
    );

    assert.strictEqual(connect.called, false);
    assert.strictEqual(suspend.called, false);
  });

  it('tries a pair record without an altIRK against every device no record matched', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {STALE: pairRecord('STALE')});

    await assert.rejects(
      tunnelService.startTunnel(undefined, undefined, {devices: [mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.2'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['STALE'],
    );
  });

  it('does not try a pair record without an altIRK against a device another record matched', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const stranger = advertisedDevice('stranger', '10.0.0.9', OTHER_ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {
      MINE: pairRecord('MINE', ALT_IRK),
      STALE: pairRecord('STALE'),
    });

    await assert.rejects(
      tunnelService.startTunnel(undefined, undefined, {devices: [stranger, mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.2', '10.0.0.9'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['MINE', 'STALE'],
    );
  });

  it('narrows to the pair record id given as the specific device identifier', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const other = advertisedDevice('other', '10.0.0.1', OTHER_ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {
      MINE: pairRecord('MINE', ALT_IRK),
      OTHER: pairRecord('OTHER', OTHER_ALT_IRK),
    });

    await assert.rejects(
      tunnelService.startTunnel(undefined, 'MINE', {devices: [other, mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.2'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['MINE'],
    );
  });

  it('narrows to the discovered identifier given as the specific device identifier', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const other = advertisedDevice('other', '10.0.0.1', OTHER_ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {
      MINE: pairRecord('MINE', ALT_IRK),
      OTHER: pairRecord('OTHER', OTHER_ALT_IRK),
    });

    await assert.rejects(
      tunnelService.startTunnel(undefined, mine.identifier, {devices: [other, mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.2'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['MINE'],
    );
  });

  it('matches the pair record named by deviceId against the discovered devices', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const other = advertisedDevice('other', '10.0.0.1', OTHER_ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {
      MINE: pairRecord('MINE', ALT_IRK),
      OTHER: pairRecord('OTHER', OTHER_ALT_IRK),
    });

    await assert.rejects(
      tunnelService.startTunnel('MINE', undefined, {devices: [other, mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.2'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['MINE'],
    );
  });

  it('falls back to the old path when the record named by deviceId has no altIRK', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const {tunnelService, connect, verify} = await loadTunnelServiceWithRecords(t, {
      STALE: pairRecord('STALE'),
      OTHER: pairRecord('OTHER', OTHER_ALT_IRK),
    });

    await assert.rejects(
      tunnelService.startTunnel('STALE', undefined, {devices: [mine]}),
      /All authentication attempts failed/,
    );

    assert.deepStrictEqual(
      connect.args.map(([host]) => host),
      ['10.0.0.2'],
    );
    assert.deepStrictEqual(
      verify.args.map(([, identifier]) => identifier),
      ['STALE'],
    );
  });

  it('throws without connecting when the specific device identifier matches no paired device', async function (t) {
    const mine = advertisedDevice('mine', '10.0.0.2', ALT_IRK);
    const {tunnelService, connect} = await loadTunnelServiceWithRecords(t, {MINE: pairRecord('MINE', ALT_IRK)});

    await assert.rejects(
      tunnelService.startTunnel(undefined, 'unknown-id', {devices: [mine]}),
      /Device with identifier unknown-id not found/,
    );

    assert.strictEqual(connect.called, false);
  });

  it('uses remotePairingUdid from the pair record as the tunnel identifier', async function (t) {
    const AppleTVTunnelService = await loadTunnelService(t);
    const tunnelService = new AppleTVTunnelService();
    const device: AppleTVDevice = {
      name: 'Apple TV',
      identifier: 'devicectl-udid',
      identifierSource: 'devicectl',
      hostname: 'apple-tv.local',
      port: 49152,
      model: 'AppleTV',
      version: '17.0',
    };

    const tunnelDevice = (tunnelService as any).withTunnelIdentifier(device, {
      publicKey: Buffer.alloc(0),
      privateKey: Buffer.alloc(0),
      remoteUnlockHostKey: '',
      remotePairingUdid: 'synthetic-remote-pairing-udid',
    });

    assert.strictEqual(tunnelDevice.identifier, 'SYNTHETIC-REMOTE-PAIRING-UDID');
  });

  it('falls back to devicectl identifiers only on macOS', async function (t) {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });
    try {
      const AppleTVTunnelService = await loadTunnelService(t);
      const tunnelService = new AppleTVTunnelService();
      const device: AppleTVDevice = {
        name: 'Apple TV',
        identifier: 'synthetic-devicectl-udid',
        identifierSource: 'devicectl',
        hostname: 'apple-tv.local',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      };

      const tunnelDevice = (tunnelService as any).withTunnelIdentifier(device, {
        publicKey: Buffer.alloc(0),
        privateKey: Buffer.alloc(0),
        remoteUnlockHostKey: '',
      });

      assert.strictEqual(tunnelDevice.identifier, 'SYNTHETIC-DEVICECTL-UDID');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('throws if no remotePairingUdid or macOS devicectl fallback is available', async function (t) {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      const AppleTVTunnelService = await loadTunnelService(t);
      const tunnelService = new AppleTVTunnelService();
      const device: AppleTVDevice = {
        name: 'Apple TV',
        identifier: 'bonjour-id',
        identifierSource: 'bonjour',
        hostname: 'apple-tv.local',
        port: 49152,
        model: 'AppleTV',
        version: '17.0',
      };

      assert.throws(
        () =>
          (tunnelService as any).withTunnelIdentifier(device, {
            publicKey: Buffer.alloc(0),
            privateKey: Buffer.alloc(0),
            remoteUnlockHostKey: '',
          }),
        (err: any) =>
          err.message.includes(
            'Pair record does not include remote_pairing_udid and no macOS devicectl fallback is available',
          ),
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
