import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {UsbmuxServiceTransport} from '../../../src/lib/service-transport/index.js';
import {InstallationProxyService} from '../../../src/services/ios/installation-proxy/index.js';
import {NotificationProxyService} from '../../../src/services/ios/notification-proxy/index.js';

const UDID = 'udid';

const timeoutOf = (service: object): number => (service as unknown as {timeout: number}).timeout;
const transportOf = (service: object) => (service as unknown as {serviceTransport: unknown}).serviceTransport;

for (const [name, Service, defaultTimeout] of [
  ['InstallationProxyService', InstallationProxyService, 30000],
  ['NotificationProxyService', NotificationProxyService, 10000],
] as const) {
  describe(`${name} constructor`, function () {
    it('uses the default timeout and the tunnel transport without arguments', function () {
      const service = new Service(UDID);

      assert.equal(timeoutOf(service), defaultTimeout);
      assert.equal((transportOf(service) as {kind: string}).kind, 'tunnel');
    });

    it('accepts a legacy numeric timeout', function () {
      assert.equal(timeoutOf(new Service(UDID, 1234)), 1234);
    });

    it('accepts an options object with a timeout and a transport', function () {
      const transport = new UsbmuxServiceTransport(UDID);
      const service = new Service(UDID, {timeout: 4321, transport});

      assert.equal(timeoutOf(service), 4321);
      assert.equal(transportOf(service), transport);
    });

    it('falls back to the default timeout when the options object has none', function () {
      assert.equal(timeoutOf(new Service(UDID, {})), defaultTimeout);
    });
  });
}
