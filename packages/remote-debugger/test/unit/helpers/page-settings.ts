import assert from 'node:assert/strict';

import sinon from 'sinon';

import {RpcClient} from '../../../lib/rpc/rpc-client.js';
import type {AppIdKey, PageIdKey, RpcClientOptions} from '../../../lib/types.js';

export function connectedClient(options: RpcClientOptions = {}): RpcClient {
  const client = new RpcClient(options);
  client.isConnected = true;
  return client;
}

/** Stub core initialization while leaving override RPCs available for fault injection. */
export function stubPageClient(options: RpcClientOptions = {}) {
  const client = connectedClient(options);
  return {client, initialize: sinon.stub(client, 'send').resolves()};
}

export async function addPage(
  client: RpcClient,
  targetId: string,
  {
    pageIdKey = '1',
    appIdKey = 'app',
    isProvisional = false,
  }: {
    pageIdKey?: PageIdKey;
    appIdKey?: AppIdKey;
    isProvisional?: boolean;
  } = {},
) {
  (client as any)._pendingTargetNotification = {appIdKey, pageIdKey};
  await client.addTarget(undefined, appIdKey, {targetId, type: 'page', isProvisional, isPaused: true});
}

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}

export function reply(client: RpcClient, id: number) {
  (client as any).messageHandler.emit(String(id), null, {});
}

export function assertNoResponseListeners(client: RpcClient) {
  const events: (string | symbol)[] = (client as any).messageHandler.eventNames();
  assert.deepStrictEqual(
    events.filter((name) => /^\d+$/.test(String(name))),
    [],
  );
}
