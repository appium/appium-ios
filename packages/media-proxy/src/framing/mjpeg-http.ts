import http from 'node:http';
import type {ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';

import type {JpegFrame} from '../types.js';
import {DEFAULT_MJPEG_BOUNDARY, formatMjpegPart, mjpegContentType} from './mjpeg-multipart.js';

export interface MjpegServerOptions {
  /** Defaults to 127.0.0.1. */
  host?: string;
  /** 0 (default) picks a free port. */
  port?: number;
  boundary?: string;
}

export interface MjpegServer {
  readonly port: number;
  readonly host: string;
  /** URL clients (browsers, `<img>`, ffplay) can open. */
  readonly url: string;
  readonly clientCount: number;
  /**
   * Settles when the frame source ends (resolves) or fails (rejects with its error), or resolves
   * on {@link close}. Already handled internally, so ignoring it never raises an unhandled rejection.
   */
  readonly done: Promise<void>;
  close(): Promise<void>;
}

/**
 * Serves `frames` as an MJPEG `multipart/x-mixed-replace` stream to any number of HTTP clients.
 * Each client keeps only the newest unsent frame: a slow client skips frames (every JPEG is
 * independently decodable) rather than building a backlog or stalling the others. Once the source
 * has ended or failed, new requests get `410 Gone`.
 */
export async function serveMjpeg(
  frames: AsyncIterable<JpegFrame>,
  opts: MjpegServerOptions = {},
): Promise<MjpegServer> {
  const host = opts.host ?? '127.0.0.1';
  const boundary = opts.boundary ?? DEFAULT_MJPEG_BOUNDARY;
  const clients = new Set<Client>();
  let sourceDone = false;
  let closing = false;

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (sourceDone) {
      res.writeHead(410).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': mjpegContentType(boundary),
      'Cache-Control': 'no-cache, no-store',
      Connection: 'close',
    });
    res.flushHeaders();
    const client = new Client(res, boundary);
    clients.add(client);
    res.on('close', () => clients.delete(client));
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const iterator = frames[Symbol.asyncIterator]();
  let signalClosed!: () => void;
  const closed = new Promise<void>((resolve) => (signalClosed = resolve));
  const pump = (async () => {
    try {
      for (;;) {
        const result = await iterator.next();
        if (result.done || closing) {
          break;
        }
        for (const client of clients) {
          client.offer(result.value);
        }
      }
    } finally {
      // Source ended or failed: finish all responses so clients see a clean end.
      sourceDone = true;
      for (const client of clients) {
        client.end();
      }
    }
  })();
  // Either the source settles, or close() was called while it is idle.
  const done = Promise.race([pump, closed]);
  // Surfaced through `done`; these keep an unobserved failure from becoming an unhandled rejection.
  pump.catch(() => {});
  done.catch(() => {});

  const {port} = server.address() as AddressInfo;
  return {
    port,
    host,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`,
    get clientCount() {
      return clients.size;
    },
    done,
    async close() {
      closing = true;
      sourceDone = true;
      signalClosed();
      // Ask the source to stop; not awaited, as an idle source may not settle until its next item.
      iterator.return?.()?.catch(() => {});
      for (const client of clients) {
        client.end();
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class Client {
  private pending: JpegFrame | undefined;
  private writing = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly boundary: string,
  ) {}

  offer(frame: JpegFrame): void {
    this.pending = frame;
    if (!this.writing) {
      this.flush();
    }
  }

  end(): void {
    this.pending = undefined;
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }

  private flush(): void {
    const frame = this.pending;
    if (!frame || this.res.writableEnded || this.res.destroyed) {
      return;
    }
    this.pending = undefined;
    this.writing = true;
    const [head, body, tail] = formatMjpegPart(frame, this.boundary);
    this.res.cork();
    this.res.write(head);
    this.res.write(body);
    const ok = this.res.write(tail);
    this.res.uncork();
    const done = () => {
      this.writing = false;
      this.flush();
    };
    if (ok) {
      done();
    } else {
      this.res.once('drain', done);
    }
  }
}
