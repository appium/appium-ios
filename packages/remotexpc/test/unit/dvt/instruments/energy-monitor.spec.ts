import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {EnergyMonitor} from '../../../../src/services/ios/dvt/instruments/energy-monitor.js';

/**
 * Builds a DVT stub whose channel records each call and reply wait in order,
 * so a test can check that a sampling request waits for the device's reply.
 */
function recordingDvt(events: string[]): any {
  let nextId = 1;
  const channel = {
    call:
      (selector: string) =>
      async (_args: unknown, expectsReply: boolean = true) => {
        const id = nextId++;
        events.push(`call ${selector} id=${id} expectsReply=${expectsReply}`);
        return id;
      },
    receiveReply: async (id: number): Promise<number[]> => {
      events.push(`reply id=${id}`);
      return [];
    },
  };
  return {makeChannel: async () => channel};
}

describe('EnergyMonitor', function () {
  it('should wait for the device to acknowledge start and stop before resolving', async function () {
    const events: string[] = [];
    const monitor = new EnergyMonitor(recordingDvt(events));

    await monitor.startSampling([42]);
    await monitor.stopSampling([42]);
    await monitor.startSampling([42]);

    assert.deepStrictEqual(events, [
      'call startSamplingForPIDs_ id=1 expectsReply=true',
      'reply id=1',
      'call stopSamplingForPIDs_ id=2 expectsReply=true',
      'reply id=2',
      'call startSamplingForPIDs_ id=3 expectsReply=true',
      'reply id=3',
    ]);
  });
});
