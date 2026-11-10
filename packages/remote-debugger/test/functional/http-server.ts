import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {logger, node} from '@appium/support';
import serveStatic from 'serve-static';

const FIXTURES_DIR = path.resolve(
  node.getModuleRootSync('appium-remote-debugger', fileURLToPath(import.meta.url))!,
  'test',
  'fixtures',
);

const serve = serveStatic(path.join(FIXTURES_DIR, 'html'));

/** Called by `serve` for the requests it does not handle (404) or fails to handle (error) */
function sendFallbackResponse(res: http.ServerResponse, err?: {status?: number; statusCode?: number}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = err?.status ?? err?.statusCode ?? 404;
  res.writeHead(status, {'content-type': 'text/plain; charset=utf-8'});
  res.end(http.STATUS_CODES[status] ?? 'Error');
}

const log = logger.getLogger('TestHttpServer');

const PORT = 1234;

let server: http.Server | undefined;

export async function startHttpServer(port: number = PORT): Promise<number> {
  // start a simple http server to serve pages (so no interwebs needed)
  server = http.createServer(function requestHandler(req, res) {
    log.debug(`${req.method} ${req.url}`);
    serve(req, res, (err) => sendFallbackResponse(res, err));
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
