import assert from 'node:assert/strict';
import net from 'node:net';
import {afterEach, describe, it, mock} from 'node:test';

import * as sinon from 'sinon';

import type {PairRecord} from '../../../src/lib/pair-record/index.js';
import * as usbmuxModule from '../../../src/lib/usbmux/index.js';
import {PAIR_RECORD} from '../../helpers/tls-certificates.js';

const UDID = 'udid';
const SETTLE_TIMEOUT_MS = 2000;

let storedPairRecord: PairRecord | null = null;
let pairRecordReadable: Promise<void> = Promise.resolve();
let onRelayConnection: () => void = () => {};

/** Keeps the real connect() and stop() of RelayService. Only start() does not dial usbmuxd. */
class LocalRelayService extends usbmuxModule.RelayService {
  override async start(): Promise<void> {
    const server = net.createServer((socket) => {
      socket.resume();
      onRelayConnection();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    Object.assign(this, {server, relayPort: (server.address() as net.AddressInfo).port});
  }
}

mock.module('../../../src/lib/usbmux/index.js', {
  namedExports: {
    ...usbmuxModule,
    createUsbmux: async () => ({
      listDevices: async () => [{DeviceID: 1, Properties: {SerialNumber: UDID}}],
      readPairRecord: async () => {
        await pairRecordReadable;
        return storedPairRecord;
      },
      close: async () => {},
    }),
    RelayService: LocalRelayService,
  },
});

const {LockdownService, createLockdownServiceByUDID} = await import('../../../src/lib/lockdown/index.js');

/** Resolves or rejects like `promise`, and rejects if it is still pending after `timeoutMs`. */
async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Still pending after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

describe('LockdownService automatic TLS upgrade', function () {
  afterEach(function () {
    sinon.restore();
    pairRecordReadable = Promise.resolve();
  });

  it('fails instead of continuing in plain text when a paired device does not enable TLS', async function () {
    storedPairRecord = PAIR_RECORD;
    sinon.stub(LockdownService.prototype, 'startSession').resolves({sessionID: '1', enableSessionSSL: false});
    const socket = new net.Socket();
    const lockdown = new LockdownService(socket, UDID);

    try {
      await assert.rejects(lockdown.waitForTLSUpgrade(), /did not enable TLS for a paired lockdown session/);
    } finally {
      socket.destroy();
    }
  });

  it('fails when the pair record cannot authenticate the device', async function () {
    storedPairRecord = {...PAIR_RECORD, DeviceCertificate: null};
    sinon.stub(LockdownService.prototype, 'startSession').resolves({sessionID: '1', enableSessionSSL: true});
    const socket = new net.Socket();
    const lockdown = new LockdownService(socket, UDID);

    try {
      await assert.rejects(lockdown.waitForTLSUpgrade(), /has no DeviceCertificate/);
    } finally {
      socket.destroy();
    }
  });

  it('stays in plain text only when the device has no pair record', async function () {
    storedPairRecord = null;
    const startSession = sinon.stub(LockdownService.prototype, 'startSession');
    const socket = new net.Socket();
    const lockdown = new LockdownService(socket, UDID);

    try {
      await lockdown.waitForTLSUpgrade();
      sinon.assert.notCalled(startSession);
    } finally {
      socket.destroy();
    }
  });

  it('rejects createLockdownServiceByUDID when the upgrade fails on a connected relay', async function () {
    storedPairRecord = {...PAIR_RECORD, HostID: null};
    pairRecordReadable = new Promise((resolve) => {
      onRelayConnection = resolve;
    });

    await assert.rejects(
      settlesWithin(createLockdownServiceByUDID(UDID), SETTLE_TIMEOUT_MS),
      /The pair record for udid is incomplete/,
    );
  });
});
