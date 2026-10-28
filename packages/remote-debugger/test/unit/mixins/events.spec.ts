import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {describe, it, beforeEach} from 'node:test';

import sinon from 'sinon';

import {addClientEventListener, removeClientEventListener} from '../../../lib/mixins/events.js';
import {RemoteDebugger} from '../../../lib/remote-debugger.js';

describe('events', function () {
  let rd: RemoteDebugger;
  let rpcClient: EventEmitter;

  beforeEach(function () {
    rd = new RemoteDebugger();
    rpcClient = new EventEmitter();
    (rd as any)._rpcClient = rpcClient;
  });

  describe('removeClientEventListener', function () {
    it('should remove the tracked listeners from the rpc client and forget them', function () {
      const first = sinon.stub();
      const second = sinon.stub();
      addClientEventListener.call(rd, 'NetworkEvent', first);
      addClientEventListener.call(rd, 'NetworkEvent', second);
      assert.strictEqual(rpcClient.listenerCount('NetworkEvent'), 2);

      removeClientEventListener.call(rd, 'NetworkEvent');

      assert.strictEqual(rpcClient.listenerCount('NetworkEvent'), 0);
      assert.strictEqual((rd as any)._clientEventListeners.NetworkEvent, undefined);
    });

    it('should not accumulate listeners across repeated add/remove cycles', function () {
      for (let i = 0; i < 3; i++) {
        addClientEventListener.call(rd, 'Console.messageAdded', sinon.stub());
        removeClientEventListener.call(rd, 'Console.messageAdded');
      }
      addClientEventListener.call(rd, 'Console.messageAdded', sinon.stub());

      assert.strictEqual(rpcClient.listenerCount('Console.messageAdded'), 1);
      assert.strictEqual((rd as any)._clientEventListeners['Console.messageAdded'].length, 1);
    });

    it('should be a no-op when nothing was registered for the event', function () {
      removeClientEventListener.call(rd, 'NetworkEvent');
      assert.strictEqual(rpcClient.listenerCount('NetworkEvent'), 0);
    });
  });
});
