import assert from 'node:assert/strict';
import {beforeEach, describe, it} from 'node:test';
import {setImmediate} from 'node:timers/promises';

import type {NetworkAddress} from '../../../../src/index.js';
import {NetworkMonitor} from '../../../../src/services/ios/dvt/instruments/network-monitor.js';

describe('NetworkMonitor', function () {
  describe('parseAddress', function () {
    let monitor: NetworkMonitor;

    beforeEach(function () {
      monitor = new NetworkMonitor({} as any);
    });

    describe('IPv4 addresses', function () {
      it('should parse a basic IPv4 address', function () {
        // IPv4 sockaddr structure: 0x10 length, 0x02 family (AF_INET)
        // Port 80 (0x0050), IP 192.168.1.1
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family (AF_INET)
          0x00,
          0x50, // port 80 (big-endian)
          192,
          168,
          1,
          1, // IP address
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00, // padding
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.len, 0x10);
        assert.strictEqual(result.family, 2);
        assert.strictEqual(result.port, 80);
        assert.strictEqual(result.address, '192.168.1.1');
        assert.strictEqual(result.flowInfo, undefined);
        assert.strictEqual(result.scopeId, undefined);
      });

      it('should parse IPv4 with port 443', function () {
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family
          0x01,
          0xbb, // port 443 (big-endian)
          10,
          0,
          0,
          1, // IP 10.0.0.1
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.port, 443);
        assert.strictEqual(result.address, '10.0.0.1');
      });

      it('should parse IPv4 localhost', function () {
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family
          0x1f,
          0x90, // port 8080
          127,
          0,
          0,
          1, // localhost
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.address, '127.0.0.1');
        assert.strictEqual(result.port, 8080);
      });

      it('should parse IPv4 with port 0', function () {
        const buffer = Buffer.from([
          0x10, // length
          0x02, // family
          0x00,
          0x00, // port 0
          0,
          0,
          0,
          0, // IP 0.0.0.0
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.address, '0.0.0.0');
        assert.strictEqual(result.port, 0);
      });
    });

    describe('IPv6 addresses', function () {
      it('should parse a basic IPv6 address', function () {
        // IPv6 sockaddr structure: 0x1c length, 0x1e family (AF_INET6)
        // Port 8080, IPv6 address 2001:0db8:0000:0000:0000:0000:0000:0001
        const buffer = Buffer.from([
          0x1c, // length
          0x1e, // family (AF_INET6)
          0x1f,
          0x90, // port 8080 (big-endian)
          0x00,
          0x00,
          0x00,
          0x00, // flow info (little-endian)
          0x20,
          0x01, // 2001
          0x0d,
          0xb8, // 0db8
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x01, // 0001
          0x00,
          0x00,
          0x00,
          0x00, // scope ID (little-endian)
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.len, 0x1c);
        assert.strictEqual(result.family, 30);
        assert.strictEqual(result.port, 8080);
        assert.strictEqual(result.address, '2001:db8:0:0:0:0:0:1');
        assert.strictEqual(result.flowInfo, 0);
        assert.strictEqual(result.scopeId, 0);
      });

      it('should parse IPv6 localhost', function () {
        // ::1 (IPv6 localhost)
        const buffer = Buffer.from([
          0x1c, // length
          0x1e, // family
          0x00,
          0x50, // port 80
          0x00,
          0x00,
          0x00,
          0x00, // flow info
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x00, // 0000
          0x00,
          0x01, // 0001
          0x00,
          0x00,
          0x00,
          0x00, // scope ID
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.address, '0:0:0:0:0:0:0:1');
        assert.strictEqual(result.port, 80);
      });

      it('should parse IPv6 with non-zero flow info and scope ID', function () {
        const buffer = Buffer.from([
          0x1c, // length
          0x1e, // family
          0x1f,
          0x90, // port 8080
          0x01,
          0x02,
          0x03,
          0x04, // flow info: 0x04030201 (little-endian)
          0xfe,
          0x80, // fe80 (link-local)
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x02,
          0x15,
          0x5d,
          0xff,
          0xfe,
          0x12,
          0x34,
          0x56,
          0x05,
          0x00,
          0x00,
          0x00, // scope ID: 5 (little-endian)
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.family, 30);
        assert.strictEqual(result.port, 8080);
        assert.strictEqual(result.address, 'fe80:0:0:0:215:5dff:fe12:3456');
        assert.strictEqual(result.flowInfo, 0x04030201);
        assert.strictEqual(result.scopeId, 5);
      });
    });

    describe('edge cases', function () {
      it('should handle Uint8Array input', function () {
        const uint8Array = new Uint8Array([
          0x10, // length
          0x02, // family
          0x00,
          0x50, // port 80
          192,
          168,
          1,
          1,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(uint8Array);

        assert.strictEqual(result.address, '192.168.1.1');
        assert.strictEqual(result.port, 80);
      });

      it('should handle high port numbers', function () {
        // Port 65535 (0xFFFF)
        const buffer = Buffer.from([
          0x10,
          0x02,
          0xff,
          0xff, // port 65535
          127,
          0,
          0,
          1,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.port, 65535);
      });

      it('should format IPv6 addresses with hex values', function () {
        // Test that IPv6 uses hex formatting
        const buffer = Buffer.from([
          0x1c,
          0x1e,
          0x00,
          0x50, // port 80
          0x00,
          0x00,
          0x00,
          0x00, // flow info
          0xab,
          0xcd, // abcd
          0x12,
          0x34, // 1234
          0x56,
          0x78, // 5678
          0x9a,
          0xbc, // 9abc
          0xde,
          0xf0, // def0
          0x11,
          0x22, // 1122
          0x33,
          0x44, // 3344
          0x55,
          0x66, // 5566
          0x00,
          0x00,
          0x00,
          0x00, // scope ID
        ]);

        const result: NetworkAddress = (monitor as any).parseAddress(buffer);

        assert.strictEqual(result.address, 'abcd:1234:5678:9abc:def0:1122:3344:5566');
      });
    });
  });

  describe('start', function () {
    /** DVT stub whose channel records calls and whose receivePlist blocks until aborted */
    function fakeDvt(calls: string[], failStart = false): any {
      const channel = {
        call: (selector: string) => async () => {
          calls.push(selector);
          if (failStart && selector === 'startMonitoring') {
            throw new Error('startMonitoring failed');
          }
        },
        receivePlist: (signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      };
      return {makeChannel: async () => channel};
    }

    it('should send startMonitoring once when started before iterating events()', async function () {
      const calls: string[] = [];
      const monitor = new NetworkMonitor(fakeDvt(calls));

      await monitor.start();
      const iterator = monitor.events();
      const pending = iterator.next();
      await setImmediate();
      await monitor.stop();
      await pending;

      assert.deepStrictEqual(
        calls.filter((c) => c === 'startMonitoring'),
        ['startMonitoring'],
      );
    });

    it('should send startMonitoring again after stop()', async function () {
      const calls: string[] = [];
      const monitor = new NetworkMonitor(fakeDvt(calls));

      await monitor.start();
      await monitor.stop();
      await monitor.start();

      assert.deepStrictEqual(
        calls.filter((c) => c === 'startMonitoring'),
        ['startMonitoring', 'startMonitoring'],
      );
    });

    it('should reject when startMonitoring fails and allow a retry', async function () {
      const calls: string[] = [];
      const monitor = new NetworkMonitor(fakeDvt(calls, true));

      await assert.rejects(monitor.start(), /startMonitoring failed/);
      await assert.rejects(monitor.start(), /startMonitoring failed/);

      assert.deepStrictEqual(calls.filter((c) => c === 'startMonitoring').length, 2);
    });

    it('should not mark itself started when stop() runs during startMonitoring', async function () {
      const calls: string[] = [];
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const dvt = fakeDvt(calls);
      const channel = await dvt.makeChannel();
      const call = channel.call;
      channel.call = (selector: string) => async () => {
        if (selector === 'startMonitoring' && calls.filter((c) => c === 'startMonitoring').length === 0) {
          calls.push(selector);
          await released;
          return;
        }
        return call(selector)();
      };
      const monitor = new NetworkMonitor(dvt);

      const starting = monitor.start();
      await setImmediate();
      await monitor.stop();
      release();
      await starting;
      await monitor.start();

      assert.deepStrictEqual(calls, ['startMonitoring', 'stopMonitoring', 'startMonitoring']);
    });

    it('should resolve without starting when stop() runs while the channel is opening', async function () {
      const calls: string[] = [];
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = resolve));
      const dvt = fakeDvt(calls);
      const makeChannel = dvt.makeChannel;
      dvt.makeChannel = async () => {
        await opened;
        return makeChannel();
      };
      const monitor = new NetworkMonitor(dvt);

      const starting = monitor.start();
      await monitor.stop();
      open();
      await starting;

      assert.deepStrictEqual(calls, []);
    });
  });
});
