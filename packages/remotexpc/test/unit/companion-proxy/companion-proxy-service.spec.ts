import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import type {Socket} from 'node:net';
import {type TestContext, describe, it} from 'node:test';
import {setImmediate as nextTick} from 'node:timers/promises';

import {LockdownStartServiceError} from '../../../src/lib/lockdown/index.js';
import type {PlistDictionary} from '../../../src/lib/types.js';
import {CompanionProxyError} from '../../../src/services/ios/companion-proxy/errors.js';
import {type CompanionDeviceEvent, CompanionProxyService} from '../../../src/services/ios/companion-proxy/index.js';
import {mockImport} from '../../helpers/mock-module.js';

const UDID = 'phone-udid';
const WATCH_UDID = 'watch-udid';
const RSD_SERVICE_NAME = 'com.apple.companion_proxy.shim.remote';
const attach: CompanionDeviceEvent = {
  Command: 'GizmoAttach',
  GizmoUDIDKey: WATCH_UDID,
  CompanionLockdownProxyPort: 62078,
};
const detach: CompanionDeviceEvent = {Command: 'GizmoDetach', GizmoUDIDKey: WATCH_UDID};
/** Inbound marker: `receive()` stays pending until `close()` rejects it, like the real PlistService */
const PENDING = Symbol('pending');

interface FakeConnection {
  sentRequests: PlistDictionary[];
  sentMessages: PlistDictionary[];
  timeouts: Array<number | undefined>;
  closeCount: number;
  socket: EventEmitter;
  pendingRejects: Array<(error: Error) => void>;
  sendPlistRequest(request: PlistDictionary, timeout?: number): Promise<PlistDictionary>;
  sendPlist(message: PlistDictionary): void;
  receive(timeout?: number): Promise<PlistDictionary>;
  getSocket(): EventEmitter;
  close(): void;
}

/**
 * Fake ServiceConnection whose inbound frames are served in order to both
 * `receive()` and `sendPlistRequest()` (which the real class implements as send + receive).
 */
function createFakeConnection(inbound: Array<PlistDictionary | Error | typeof PENDING>): FakeConnection {
  const frames = [...inbound];
  const conn: FakeConnection = {
    sentRequests: [],
    sentMessages: [],
    timeouts: [],
    closeCount: 0,
    socket: new EventEmitter(),
    pendingRejects: [],
    async sendPlistRequest(request, timeout) {
      conn.sentRequests.push(request);
      return await conn.receive(timeout);
    },
    sendPlist(message) {
      conn.sentMessages.push(message);
    },
    async receive(timeout) {
      conn.timeouts.push(timeout);
      const frame = frames.shift();
      if (frame === undefined) {
        throw new Error('fake connection has no more inbound frames');
      }
      if (frame === PENDING) {
        return await new Promise<PlistDictionary>((_, reject) => conn.pendingRejects.push(reject));
      }
      if (frame instanceof Error) {
        throw frame;
      }
      return frame;
    },
    getSocket() {
      return conn.socket;
    },
    close() {
      conn.closeCount++;
      for (const reject of conn.pendingRejects.splice(0)) {
        reject(new Error('Connection closed while waiting for plist response'));
      }
    },
  };
  return conn;
}

interface Harness {
  service: CompanionProxyService;
  startedServices: string[];
  connectViaTunnelCalls: Array<[string, number]>;
  tunnelSocket: Socket;
}

/**
 * Imports the service with BaseService replaced so each `startLockdownService` call hands
 * out the next fake connection or rejects with the next error, and connectViaTunnel replaced
 * with a recording stub.
 */
async function createService(
  t: TestContext,
  connections: Array<FakeConnection | Error>,
  timeout?: number,
): Promise<Harness> {
  const pending = [...connections];
  const startedServices: string[] = [];
  const connectViaTunnelCalls: Array<[string, number]> = [];
  const tunnelSocket = {} as Socket;

  const {CompanionProxyService: MockedService} = await mockImport<{
    CompanionProxyService: typeof CompanionProxyService;
  }>(t, '../../../src/services/ios/companion-proxy/index.js', import.meta.url, {
    '../../../src/services/ios/base-service.js': {
      BaseService: class {
        constructor(readonly udid: string) {}
        async startLockdownService(serviceName: string): Promise<FakeConnection> {
          startedServices.push(serviceName);
          const conn = pending.shift();
          if (!conn) {
            throw new Error('no fake connection left for startLockdownService');
          }
          if (conn instanceof Error) {
            throw conn;
          }
          return conn;
        }
      },
    },
    '../../../src/lib/port-forwarding/connectors.js': {
      connectViaTunnel: async (udid: string, port: number): Promise<Socket> => {
        connectViaTunnelCalls.push([udid, port]);
        return tunnelSocket;
      },
    },
  });

  return {
    service: new MockedService(UDID, timeout),
    startedServices,
    connectViaTunnelCalls,
    tunnelSocket,
  };
}

async function take<T>(generator: AsyncGenerator<T>, count: number): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) {
    items.push(item);
    if (items.length === count) {
      break;
    }
  }
  return items;
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CompanionProxyError, `expected CompanionProxyError, got ${String(error)}`);
    assert.strictEqual(error.name, 'CompanionProxyError');
    assert.strictEqual(error.code, code);
    return true;
  });
}

describe('CompanionProxyService', function () {
  describe('request builders', function () {
    const service = new CompanionProxyService(UDID);
    const builders = service as unknown as {
      buildGetValueRequest(udid: string, key: string): PlistDictionary;
      buildStartForwardingRequest(port: number, options?: PlistDictionary): PlistDictionary;
      buildStopForwardingRequest(port: number): PlistDictionary;
    };

    it('exposes the RSD shim service name', function () {
      assert.strictEqual(CompanionProxyService.RSD_SERVICE_NAME, RSD_SERVICE_NAME);
    });

    it('builds GetValueFromRegistry with the exact wire keys', function () {
      assert.deepStrictEqual(builders.buildGetValueRequest(WATCH_UDID, 'DeviceName'), {
        Command: 'GetValueFromRegistry',
        GetValueGizmoUDIDKey: WATCH_UDID,
        GetValueKeyKey: 'DeviceName',
      });
    });

    it('builds StartForwardingServicePort with defaults and no ForwardedServiceName', function () {
      assert.deepStrictEqual(builders.buildStartForwardingRequest(62078), {
        Command: 'StartForwardingServicePort',
        GizmoRemotePortNumber: 62078,
        IsServiceLowPriority: false,
        PreferWifi: false,
      });
    });

    it('builds StartForwardingServicePort with every option and merges extra keys', function () {
      const request = builders.buildStartForwardingRequest(8080, {
        serviceName: 'com.example.service',
        isServiceLowPriority: true,
        preferWifi: true,
        ExtraKey: 'extra',
      });
      assert.deepStrictEqual(request, {
        Command: 'StartForwardingServicePort',
        GizmoRemotePortNumber: 8080,
        IsServiceLowPriority: true,
        PreferWifi: true,
        ForwardedServiceName: 'com.example.service',
        ExtraKey: 'extra',
      });
    });

    it('builds StopForwardingServicePort with the watch port', function () {
      assert.deepStrictEqual(builders.buildStopForwardingRequest(62078), {
        Command: 'StopForwardingServicePort',
        GizmoRemotePortNumber: 62078,
      });
    });

    it('rejects a watchPort outside 1..65535 or non-integer', function () {
      for (const port of [0, 65536, 1.5, -1, Number.NaN]) {
        assert.throws(() => builders.buildStartForwardingRequest(port), TypeError, `start ${port}`);
        assert.throws(() => builders.buildStopForwardingRequest(port), TypeError, `stop ${port}`);
      }
    });
  });

  describe('connection lifecycle', function () {
    it('checks in, sends the command with the configured timeout, then closes', async function (t) {
      const conn = createFakeConnection([{PairedDevicesArray: [WATCH_UDID]}]);
      const {service, startedServices} = await createService(t, [conn], 1234);

      await service.list();

      assert.deepStrictEqual(startedServices, [RSD_SERVICE_NAME]);
      assert.deepStrictEqual(conn.sentRequests, [{Command: 'GetDeviceRegistry'}]);
      assert.deepStrictEqual(conn.sentMessages, []);
      assert.deepStrictEqual(conn.timeouts, [1234]);
      assert.strictEqual(conn.closeCount, 1);
    });

    it('opens a fresh connection for every command', async function (t) {
      const first = createFakeConnection([{PairedDevicesArray: [WATCH_UDID]}]);
      const second = createFakeConnection([{RetrievedValueDictionary: {DeviceName: 'Watch'}}]);
      const {service, startedServices} = await createService(t, [first, second]);

      await service.list();
      await service.getValue(WATCH_UDID, 'DeviceName');

      assert.deepStrictEqual(startedServices, [RSD_SERVICE_NAME, RSD_SERVICE_NAME]);
      assert.strictEqual(first.closeCount, 1);
      assert.strictEqual(second.closeCount, 1);
    });

    it('surfaces a refusal to start the service (USB-only) as a CompanionProxyError carrying the code', async function (t) {
      const refusal = new LockdownStartServiceError(RSD_SERVICE_NAME, 'ServiceProhibited', 'Service is not allowed');
      const {service} = await createService(t, [refusal]);

      await rejectsWithCode(service.list(), 'ServiceProhibited');
    });

    it('keeps the error description and the refusal as its cause', async function (t) {
      const refusal = new LockdownStartServiceError(RSD_SERVICE_NAME, 'ServiceProhibited', 'Service is not allowed');
      const {service} = await createService(t, [refusal]);

      await assert.rejects(service.list(), (error: unknown) => {
        assert.ok(error instanceof CompanionProxyError);
        assert.strictEqual(error.cause, refusal);
        assert.match(error.message, /ServiceProhibited \(Service is not allowed\)/);
        return true;
      });
    });

    it('passes any other connection failure through unchanged', async function (t) {
      const failure = new Error('connect ECONNREFUSED');
      const {service} = await createService(t, [failure]);

      await assert.rejects(service.list(), failure);
    });

    it('closes the connection when the command reply times out', async function (t) {
      const conn = createFakeConnection([new Error('Timed out waiting for plist response')]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(service.list(), /Timed out/);

      assert.strictEqual(conn.closeCount, 1);
    });
  });

  describe('list', function () {
    it('returns PairedDevicesArray', async function (t) {
      const conn = createFakeConnection([{PairedDevicesArray: [WATCH_UDID, 'second-watch']}]);
      const {service} = await createService(t, [conn]);

      assert.deepStrictEqual(await service.list(), [WATCH_UDID, 'second-watch']);
    });

    it('returns [] on NoPairedWatches', async function (t) {
      const conn = createFakeConnection([{Error: 'NoPairedWatches'}]);
      const {service} = await createService(t, [conn]);

      assert.deepStrictEqual(await service.list(), []);
    });

    it('returns [] when PairedDevicesArray is missing', async function (t) {
      const conn = createFakeConnection([{}]);
      const {service} = await createService(t, [conn]);

      assert.deepStrictEqual(await service.list(), []);
    });

    it('throws CompanionProxyError with the daemon code on any other Error', async function (t) {
      const conn = createFakeConnection([{Error: 'UnexpectedReply'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithCode(service.list(), 'UnexpectedReply');
    });

    it('appends ErrorDescription to the message when the daemon sends one', async function (t) {
      const conn = createFakeConnection([{Error: 'ErrorReply', ErrorDescription: 'watch unreachable'}]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(service.list(), {
        name: 'CompanionProxyError',
        message: 'GetDeviceRegistry failed: ErrorReply - watch unreachable',
      });
    });
  });

  describe('getValue', function () {
    it('sends GetValueFromRegistry and unwraps RetrievedValueDictionary[key]', async function (t) {
      const conn = createFakeConnection([{RetrievedValueDictionary: {BatteryCurrentCapacity: 87}}]);
      const {service} = await createService(t, [conn]);

      assert.strictEqual(await service.getValue(WATCH_UDID, 'BatteryCurrentCapacity'), 87);
      assert.deepStrictEqual(conn.sentRequests, [
        {
          Command: 'GetValueFromRegistry',
          GetValueGizmoUDIDKey: WATCH_UDID,
          GetValueKeyKey: 'BatteryCurrentCapacity',
        },
      ]);
    });

    it('throws with the daemon code on NoMatchingWatch', async function (t) {
      const conn = createFakeConnection([{Error: 'NoMatchingWatch'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithCode(service.getValue('unknown', 'DeviceName'), 'NoMatchingWatch');
    });

    it('throws when the reply has no RetrievedValueDictionary', async function (t) {
      const conn = createFakeConnection([{Command: 'Whatever'}]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(service.getValue(WATCH_UDID, 'DeviceName'), CompanionProxyError);
    });
  });

  describe('startForwardingServicePort', function () {
    it('sends the request and returns CompanionProxyServicePort', async function (t) {
      const conn = createFakeConnection([{Command: 'CompanionServiceSetup', CompanionProxyServicePort: 51234}]);
      const {service} = await createService(t, [conn]);

      assert.strictEqual(await service.startForwardingServicePort(62078, {preferWifi: true}), 51234);
      assert.deepStrictEqual(conn.sentRequests, [
        {
          Command: 'StartForwardingServicePort',
          GizmoRemotePortNumber: 62078,
          IsServiceLowPriority: false,
          PreferWifi: true,
        },
      ]);
    });

    it('throws with the daemon code on ServiceProxySetup', async function (t) {
      const conn = createFakeConnection([{Error: 'ServiceProxySetup'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithCode(service.startForwardingServicePort(62078), 'ServiceProxySetup');
    });

    it('throws when the reply carries no port', async function (t) {
      const conn = createFakeConnection([{Command: 'CompanionServiceSetup'}]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(service.startForwardingServicePort(62078), CompanionProxyError);
    });

    it('rejects an invalid watchPort before opening a connection', async function (t) {
      const {service, startedServices} = await createService(t, []);

      await assert.rejects(service.startForwardingServicePort(0), TypeError);

      assert.deepStrictEqual(startedServices, []);
    });
  });

  describe('stopForwardingServicePort', function () {
    for (const reply of ['ComandSuccess', 'CommandSuccess']) {
      it(`accepts ${reply}`, async function (t) {
        const conn = createFakeConnection([{Command: reply}]);
        const {service} = await createService(t, [conn]);

        await service.stopForwardingServicePort(62078);

        assert.deepStrictEqual(conn.sentRequests, [
          {Command: 'StopForwardingServicePort', GizmoRemotePortNumber: 62078},
        ]);
        assert.strictEqual(conn.closeCount, 1);
      });
    }

    it('throws with the daemon code on MalformedCommand', async function (t) {
      const conn = createFakeConnection([{Error: 'MalformedCommand'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithCode(service.stopForwardingServicePort(62078), 'MalformedCommand');
    });

    it('throws on an unexpected reply', async function (t) {
      const conn = createFakeConnection([{Command: 'Nope'}]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(service.stopForwardingServicePort(62078), CompanionProxyError);
    });
  });

  describe('listen', function () {
    it('fires StartListeningForDevices once, yields typed events in order, and closes when the consumer stops', async function (t) {
      const conn = createFakeConnection([attach, detach]);
      const {service} = await createService(t, [conn], 1234);

      const events = await take(service.listen(777), 2);

      assert.deepStrictEqual(events, [attach, detach]);
      assert.deepStrictEqual(conn.sentMessages, [{Command: 'StartListeningForDevices'}]);
      assert.deepStrictEqual(conn.sentRequests, []);
      assert.deepStrictEqual(conn.timeouts, [777, 777]);
      assert.strictEqual(conn.closeCount, 1);
    });

    it('throws with the daemon code when the stream answers NoSocket', async function (t) {
      const conn = createFakeConnection([{Error: 'NoSocket'}]);
      const {service} = await createService(t, [conn]);

      await rejectsWithCode(take(service.listen(), 1), 'NoSocket');
    });

    it('throws on a frame that is not a companion event', async function (t) {
      const conn = createFakeConnection([{Command: 'GizmoAttach'}]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(take(service.listen(), 1), CompanionProxyError);
    });

    it('propagates receive errors to the consumer and closes the connection', async function (t) {
      const conn = createFakeConnection([new Error('socket lost')]);
      const {service} = await createService(t, [conn]);

      await assert.rejects(take(service.listen(), 1), /socket lost/);

      assert.strictEqual(conn.closeCount, 1);
    });

    it('opens a dedicated connection per listen() call and closes it when iteration ends', async function (t) {
      const first = createFakeConnection([attach]);
      const second = createFakeConnection([detach]);
      const {service, startedServices} = await createService(t, [first, second]);

      assert.deepStrictEqual(await take(service.listen(), 1), [attach]);
      assert.strictEqual(first.closeCount, 1);
      assert.deepStrictEqual(await take(service.listen(), 1), [detach]);
      assert.strictEqual(second.closeCount, 1);

      assert.deepStrictEqual(startedServices, [RSD_SERVICE_NAME, RSD_SERVICE_NAME]);
      assert.deepStrictEqual(first.sentMessages, [{Command: 'StartListeningForDevices'}]);
      assert.deepStrictEqual(second.sentMessages, [{Command: 'StartListeningForDevices'}]);
    });

    it('exits when the daemon closes the socket instead of waiting out the event timeout', async function (t) {
      const conn = createFakeConnection([PENDING]);
      const {service} = await createService(t, [conn]);

      const consumed = take(service.listen(), 1);
      while (conn.pendingRejects.length === 0) {
        await nextTick();
      }
      conn.socket.emit('close');

      await assert.rejects(consumed, /Connection closed/);
      assert.strictEqual(conn.closeCount, 1);
    });

    it('does not share a connection between concurrent listeners', async function (t) {
      const first = createFakeConnection([attach]);
      const second = createFakeConnection([detach]);
      const {service, startedServices} = await createService(t, [first, second]);

      const events = await Promise.all([take(service.listen(), 1), take(service.listen(), 1)]);

      assert.deepStrictEqual(events, [[attach], [detach]]);
      assert.deepStrictEqual(startedServices, [RSD_SERVICE_NAME, RSD_SERVICE_NAME]);
      assert.strictEqual(first.closeCount, 1);
      assert.strictEqual(second.closeCount, 1);
    });

    it('settles a pending iteration with AbortError and closes only its own connection when the signal aborts', async function (t) {
      const aborted = createFakeConnection([PENDING]);
      const untouched = createFakeConnection([PENDING, attach]);
      const {service} = await createService(t, [aborted, untouched]);
      const controller = new AbortController();
      const consumed = take(service.listen(undefined, controller.signal), 1);
      const other = service.listen(undefined, new AbortController().signal);
      const otherNext = other.next();
      while (aborted.pendingRejects.length === 0 || untouched.pendingRejects.length === 0) {
        await nextTick();
      }

      controller.abort();

      await assert.rejects(consumed, {name: 'AbortError'});
      assert.strictEqual(aborted.closeCount, 1);
      assert.strictEqual(untouched.closeCount, 0);
      untouched.pendingRejects.splice(0).forEach((reject) => reject(new Error('unblock')));
      await assert.rejects(otherNext, /unblock/);
      assert.strictEqual(untouched.closeCount, 1);
    });

    it('settles the next pull with AbortError and skips another receive when aborted between events', async function (t) {
      const conn = createFakeConnection([attach, PENDING]);
      const {service} = await createService(t, [conn]);
      const controller = new AbortController();
      const events = service.listen(undefined, controller.signal);
      assert.deepStrictEqual(await events.next(), {value: attach, done: false});

      controller.abort();

      await assert.rejects(events.next(), {name: 'AbortError'});
      assert.strictEqual(conn.timeouts.length, 1);
      assert.strictEqual(conn.closeCount, 1);
    });

    it('throws the abort reason without streaming when the signal is already aborted', async function (t) {
      const conn = createFakeConnection([]);
      const {service} = await createService(t, [conn]);
      const reason = new Error('caller gave up');

      await assert.rejects(take(service.listen(undefined, AbortSignal.abort(reason)), 1), reason);

      assert.deepStrictEqual(conn.sentMessages, []);
      assert.strictEqual(conn.closeCount, 1);
    });
  });

  describe('connectToForwardedPort', function () {
    it('dials the phone port over the tunnel for this udid and returns the raw socket', async function (t) {
      const {service, connectViaTunnelCalls, tunnelSocket} = await createService(t, []);

      const socket = await service.connectToForwardedPort(51234);

      assert.strictEqual(socket, tunnelSocket);
      assert.deepStrictEqual(connectViaTunnelCalls, [[UDID, 51234]]);
    });
  });

  describe('close', function () {
    it('is a no-op when listen() was never called', async function (t) {
      const {service, startedServices} = await createService(t, []);

      service.close();

      assert.deepStrictEqual(startedServices, []);
    });

    it('closes every active listen() connection exactly once', async function (t) {
      const first = createFakeConnection([attach, detach]);
      const second = createFakeConnection([attach, detach]);
      const {service} = await createService(t, [first, second]);
      const firstEvents = service.listen();
      const secondEvents = service.listen();
      await firstEvents.next();
      await secondEvents.next();

      service.close();

      assert.strictEqual(first.closeCount, 1);
      assert.strictEqual(second.closeCount, 1);
      await firstEvents.return(undefined);
      await secondEvents.return(undefined);
      assert.strictEqual(first.closeCount, 1);
      assert.strictEqual(second.closeCount, 1);
    });

    it('swallows errors thrown by the underlying connection close', async function (t) {
      const conn = createFakeConnection([{Command: 'GizmoPaired', GizmoUDIDKey: WATCH_UDID}]);
      conn.close = () => {
        throw new Error('already closed');
      };
      const {service} = await createService(t, [conn]);
      const events = service.listen();
      await events.next();

      service.close();
      await events.return(undefined);
    });
  });
});
