import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import RpcMessageHandler from '../../../lib/rpc/rpc-message-handler.js';
import {dataMessage, targetMessage} from '../helpers/rpc-messages.js';

describe('Web Inspector response parsing', function () {
  for (const nested of [false, true]) {
    const envelope = (message: Record<string, unknown>) =>
      nested ? targetMessage('page-1', message) : dataMessage(message);

    for (const code of [-32601, -32602, -32000]) {
      it(`preserves protocol error details (nested=${nested}, code=${code})`, async function () {
        const handler = new RpcMessageHandler();
        const error = {code, message: 'Rejected override', data: {setting: 'ImagesEnabled'}};
        let received = false;
        handler.once('0', (actual) => {
          received = true;
          assert.ok(actual instanceof Error);
          assert.equal(actual.message, error.message);
          assert.equal((actual as any).code, error.code);
          assert.deepStrictEqual((actual as any).data, error.data);
        });
        await handler.handleMessage(envelope({id: 0, error}));
        assert.ok(received);
      });
    }

    it(`preserves evaluation results and thrown exceptions (nested=${nested})`, async function () {
      const handler = new RpcMessageHandler();
      const received: unknown[] = [];
      handler.on('1', (error, result) => received.push({error, result}));
      await handler.handleMessage(envelope({id: 1, result: {result: {value: false}}}));
      await handler.handleMessage(envelope({id: 1, result: {wasThrown: true, result: {description: 'Script failed'}}}));
      assert.deepStrictEqual(received, [
        {error: undefined, result: false},
        {error: new Error('Script failed'), result: {wasThrown: true, result: {description: 'Script failed'}}},
      ]);
    });
  }

  it('continues dispatching nested events with their parameters', async function () {
    const handler = new RpcMessageHandler();
    const received: unknown[] = [];
    handler.on('Runtime.executionContextCreated', (error, context) => received.push({error, context}));
    await handler.handleMessage(
      targetMessage('page-1', {
        method: 'Runtime.executionContextCreated',
        params: {context: {id: 3}},
      }),
    );
    assert.deepStrictEqual(received, [{error: undefined, context: {id: 3}}]);
  });
});
