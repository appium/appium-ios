import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {logger, node} from '@appium/support';
import mimeTypes from 'mime-types';

const FIXTURES_DIR = path.resolve(
  node.getModuleRootSync('appium-remote-debugger', fileURLToPath(import.meta.url))!,
  'test',
  'fixtures',
);

const HTML_DIR = path.join(FIXTURES_DIR, 'html');

function sendResponse(res: http.ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, {'content-type': type});
  res.end(body);
}

/** Serves files from the fixtures `html` dir, ignoring the query string; `/` maps to `index.html` */
async function serveFixture(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const {pathname} = new URL(req.url ?? '/', 'http://localhost');
  const relPath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const filePath = path.resolve(HTML_DIR, relPath);
  if (!filePath.startsWith(HTML_DIR + path.sep)) {
    return sendResponse(res, 403, http.STATUS_CODES[403]!, 'text/plain; charset=utf-8');
  }
  try {
    const type = mimeTypes.contentType(path.extname(filePath)) || 'application/octet-stream';
    sendResponse(res, 200, await fs.readFile(filePath), type);
  } catch {
    sendResponse(res, 404, http.STATUS_CODES[404]!, 'text/plain; charset=utf-8');
  }
}

const log = logger.getLogger('TestHttpServer');

const PORT = 1234;

let server: http.Server | undefined;

export async function startHttpServer(port: number = PORT): Promise<number> {
  // start a simple http server to serve pages (so no interwebs needed)
  server = http.createServer(function requestHandler(req, res) {
    log.debug(`${req.method} ${req.url}`);
    void serveFixture(req, res);
  });
  const activeServer = server;

  await new Promise<void>((resolve, reject) => {
    activeServer.once('error', reject);
    activeServer.listen(port, resolve);
  });
  log.debug(`HTTP server listening on port '${port}'`);

  return port;
}

export function stopHttpServer(): void {
  if (server) {
    server.close();
  }
}
