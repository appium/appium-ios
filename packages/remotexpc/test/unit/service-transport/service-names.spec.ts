import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {SERVICE_NAMES, getLockdownServiceName} from '../../../src/lib/service-transport/index.js';
import AfcService from '../../../src/services/ios/afc/index.js';
import DiagnosticsService from '../../../src/services/ios/diagnostic-service/index.js';
import {HouseArrestService} from '../../../src/services/ios/house-arrest/index.js';
import {InstallationProxyService} from '../../../src/services/ios/installation-proxy/index.js';
import {MobileConfigService} from '../../../src/services/ios/mobile-config/index.js';
import {NotificationProxyService} from '../../../src/services/ios/notification-proxy/index.js';
import {WebInspectorService} from '../../../src/services/ios/webinspector/index.js';
import ZipConduitService from '../../../src/services/ios/zipconduit/index.js';

describe('SERVICE_NAMES', function () {
  it('matches the RSD names the service classes use', function () {
    assert.deepEqual(SERVICE_NAMES, {
      afc: AfcService.RSD_SERVICE_NAME,
      houseArrest: HouseArrestService.RSD_SERVICE_NAME,
      installationProxy: InstallationProxyService.RSD_SERVICE_NAME,
      notificationProxy: NotificationProxyService.RSD_SERVICE_NAME,
      syslogText: 'com.apple.syslog_relay.shim.remote',
      zipConduit: ZipConduitService.RSD_SERVICE_NAME,
      mobileConfig: MobileConfigService.RSD_SERVICE_NAME,
      diagnostics: DiagnosticsService.RSD_SERVICE_NAME,
      webInspector: WebInspectorService.RSD_SERVICE_NAME,
    });
  });

  it('only lists services that can be started over usbmux', function () {
    for (const [key, rsdName] of Object.entries(SERVICE_NAMES)) {
      assert.ok(getLockdownServiceName(rsdName), `${key} has no lockdown name`);
    }
  });
});
