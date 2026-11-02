import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import WebInspectorService from '../../../src/services/ios/webinspector/index.js';

describe('WebInspectorService', function () {
  describe('listenMessage', function () {
    it('should throw receive errors to the consumer instead of crashing the process', async function () {
      const service = new WebInspectorService('test-udid');
      const receiveError = new Error('socket lost');

      const fakeConnection = {
        receive: async (): Promise<never> => {
          throw receiveError;
        },
      };
      (service as unknown as {connection: unknown}).connection = fakeConnection;

      await assert.rejects(async () => {
        for await (const _ of service.listenMessage()) {
          // no messages expected
        }
      }, /socket lost/);
    });
  });

  describe('connect', function () {
    function stubLockdown(service: WebInspectorService, impl: () => Promise<unknown>) {
      (service as unknown as {startLockdownService: unknown}).startLockdownService = impl;
    }

    it('surfaces connection failures and allows a retry', async function () {
      const service = new WebInspectorService('test-udid');
      stubLockdown(service, async () => {
        throw new Error('service refused');
      });
      await assert.rejects(service.connect(), /service refused/);

      const sent: unknown[] = [];
      stubLockdown(service, async () => ({
        receive: async (): Promise<never> => {
          throw new Error('timeout');
        },
        sendPlist: (msg: unknown) => sent.push(msg),
      }));
      await service.connect();
      assert.equal(sent.length, 1);
    });
  });
});
