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
  close(): Promise<void>;
}

/**
 * Serves `frames` as an MJPEG `multipart/x-mixed-replace` stream to any number of HTTP clients.
 * Each client keeps only the newest unsent frame: a slow client skips frames (every JPEG is
 * independently decodable) rather than building a backlog or stalling the others.
 */
export async function serveMjpeg(
  frames: AsyncIterable<JpegFrame>,
  opts: MjpegServerOptions = {},
): Promise<MjpegServer> {
  const host = opts.host ?? '127.0.0.1';
  const boundary = opts.boundary ?? DEFAULT_MJPEG_BOUNDARY;
  const clients = new Set<Client>();

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
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

  const stopController = new AbortController();
  const pump = (async () => {
    try {
      for await (const frame of frames) {
        if (stopController.signal.aborted) {
          break;
        }
        for (const client of clients) {
          client.offer(frame);
        }
      }
    } finally {
      // Source ended or failed: finish all responses so clients see a clean end.
      for (const client of clients) {
        client.end();
      }
    }
  })();
  pump.catch(() => {});

  const {port} = server.address() as AddressInfo;
  return {
    port,
    host,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`,
    get clientCount() {
      return clients.size;
    },
    async close() {
      stopController.abort();
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
