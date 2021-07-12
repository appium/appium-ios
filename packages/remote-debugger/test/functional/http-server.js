import http from 'http';
import B from 'bluebird';
import { logger } from '@appium/support';
import finalhandler from 'finalhandler';
import serveStatic from 'serve-static';
import path from 'path';
import getPort from 'get-port';

const log = logger.getLogger('TestHttpServer');
const staticDir = path.join(__dirname, 'html');
log.debug(`Serving pages from ${staticDir}`);
const serve = serveStatic(staticDir);


let server;

async function startHttpServer (port) {
  // start a simple http server to serve pages (so no interwebs needed)
  server = http.createServer((req, res) => {
    log.debug(`${req.method} ${req.url}`);
    serve(req, res, finalhandler(req, res));
  });

  port = port || await getPort();
  await (B.promisify(server.listen, {context: server}))(port, '127.0.0.1');
  log.debug(`HTTP server listening on port '${port}'`);

  server.on('error', (err) => {
    log.error(`HTTP server error: ${err}`);
  }).on('connection', (socket) => {
    log.debug(`HTTP server connection: ${socket.remoteAddress}`);
    socket.on('close', () => {
      log.debug(`HTTP server connection closed: ${socket.remoteAddress}`);
    }).on('error', (err) => {
      log.error(`HTTP server connection error: ${err}`);
    });
  }).on('close', () => {
    log.debug('HTTP server closed');
  });


  return port;
}

function stopHttpServer () {
  if (server) {
    server.close();
  }
}

export { startHttpServer, stopHttpServer };
