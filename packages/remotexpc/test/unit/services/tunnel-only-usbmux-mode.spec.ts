import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {TRANSPORT_ENV_VAR, UnsupportedTransportError} from '../../../src/lib/service-transport/index.js';
import * as Services from '../../../src/services.js';

describe('tunnel-only starters in usbmux mode', function () {
  const savedEnv = process.env[TRANSPORT_ENV_VAR];

  beforeEach(function () {
    process.env[TRANSPORT_ENV_VAR] = 'usbmux';
  });

  afterEach(function () {
    if (savedEnv === undefined) {
      delete process.env[TRANSPORT_ENV_VAR];
    } else {
      process.env[TRANSPORT_ENV_VAR] = savedEnv;
    }
  });

  const starters: [string, () => Promise<unknown>][] = [
    ['startPasteboardService', () => Services.startPasteboardService('udid')],
    ['startDVTService', () => Services.startDVTService('udid')],
    ['startTestmanagerdService', () => Services.startTestmanagerdService('udid')],
    ['startXCTestServices', () => Services.startXCTestServices('udid')],
    ['startCrashReportsService', () => Services.startCrashReportsService('udid')],
    ['startSyslogBinaryService', () => Services.startSyslogBinaryService('udid')],
  ];

  for (const [name, start] of starters) {
    it(`${name} rejects with UnsupportedTransportError before touching the tunnel`, async function () {
      await assert.rejects(start(), UnsupportedTransportError);
    });
  }
});
