import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it, beforeEach} from 'node:test';

import sinon from 'sinon';

import {startTimeline, stopTimeline} from '../../../lib/mixins/misc.js';
import {RemoteDebugger} from '../../../lib/remote-debugger.js';

describe('misc', function () {
  let rd: RemoteDebugger;
  let rpcClient: EventEmitter & {send: sinon.SinonStub};

  beforeEach(function () {
    rd = new RemoteDebugger();
    rpcClient = Object.assign(new EventEmitter(), {send: sinon.stub().resolves()});
    (rd as any)._rpcClient = rpcClient;
    (rd as any)._appIdKey = 'PID:42';
    (rd as any)._pageIdKey = 1;
  });

  describe('startTimeline / stopTimeline', function () {
    it('should register the timeline listener on start and remove it on stop', async function () {
      const listener = sinon.stub();

      await startTimeline.call(rd, listener);
      assert.strictEqual(rpcClient.listenerCount('Timeline.eventRecorded'), 1);
      assert.strictEqual(
        rpcClient.send.calledOnceWithExactly('Timeline.start', {appIdKey: 'PID:42', pageIdKey: 1}),
        true,
      );

      await stopTimeline.call(rd);
      assert.strictEqual(rpcClient.listenerCount('Timeline.eventRecorded'), 0);
      assert.strictEqual(rpcClient.send.lastCall.calledWithExactly('Timeline.stop', {appIdKey: 'PID:42', pageIdKey: 1}), true);
    });

    it('should not accumulate timeline listeners across restarts', async function () {
      await startTimeline.call(rd, sinon.stub());
      await stopTimeline.call(rd);
      await startTimeline.call(rd, sinon.stub());

      assert.strictEqual(rpcClient.listenerCount('Timeline.eventRecorded'), 1);
    });
  });
});
