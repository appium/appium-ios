import {once} from 'node:events';
import net, {type AddressInfo, type Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

import {PlistService} from '../../src/lib/plist/plist-service.js';
import type {PlistDictionary} from '../../src/lib/types.js';

export type ShimReply = (request: PlistDictionary, index: number) => PlistDictionary | Promise<PlistDictionary>;

export interface FakeShimDaemon {
  port: number;
  requests: PlistDictionary[];
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

export interface HeldFirstReply {
  reply: ShimReply;
  received: Promise<void>;
  release: () => void;
}

/**
 * Replies to requests on one fake shim connection until it is closed. The RSD handshake is
 * answered with the RSDCheckin echo followed by the unsolicited StartService greeting, and
 * every later request is recorded and answered exactly once, in order. `index` counts
 * requests across all connections to the daemon.
 */
async function respond(service: PlistService, requests: PlistDictionary[], reply: ShimReply): Promise<void> {
  for (;;) {
    const request = await service.receivePlist(60_000).catch((): null => null);
    if (!request) {
      return;
    }
    if (request.Request === 'RSDCheckin') {
      service.sendPlist({Request: 'RSDCheckin'});
      service.sendPlist({Request: 'StartService'});
      continue;
    }
    const index = requests.length;
    requests.push(request);
    service.sendPlist(await reply(request, index));
  }
}

/**
 * Starts a TCP server that behaves like a `.shim.remote` lockdown service daemon.
 */
export async function startFakeShimDaemon(reply: ShimReply): Promise<FakeShimDaemon> {
  const requests: PlistDictionary[] = [];
  const services: PlistService[] = [];
  const server = net.createServer((socket: Socket) => {
    const service = new PlistService(socket);
    services.push(service);
    void respond(service, requests, reply);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    settle: async () => {
      await delay(100);
    },
    close: async () => {
      for (const service of services) {
        service.close();
        service.getSocket().destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Wraps `reply` so the daemon withholds its answer to the first request until `release()`
 * is called. `received` settles once that first request has reached the daemon.
 */
export function holdFirstReply(reply: ShimReply): HeldFirstReply {
  let markReceived: () => void = () => {};
  let markReleased: () => void = () => {};
  const received = new Promise<void>((resolve) => {
    markReceived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  return {
    received,
    release: () => markReleased(),
    reply: async (request, index) => {
      if (index === 0) {
        markReceived();
        await released;
      }
      return await reply(request, index);
    },
  };
}
