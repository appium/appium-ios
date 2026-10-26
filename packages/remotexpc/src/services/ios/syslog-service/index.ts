import {EventEmitter} from 'node:events';
import type net from 'node:net';

import {getLogger} from '../../../lib/logger.js';
import {framePlist} from '../../../lib/plist/index.js';
import type {SyslogOptions, SyslogService as SyslogServiceInterface} from '../../../lib/types.js';
import {BaseService, type BaseServiceOptions, type Service} from '../base-service.js';
import {
  type ActivityReply,
  type SyslogEntry,
  SyslogProtocolParser,
  formatSyslogEntry,
  formatSyslogEntryColored,
  parseActivityReply,
} from './syslog-entry-parser.js';

const syslogLog = getLogger('SyslogMessages');
const log = getLogger('Syslog');

const DEFAULT_SYSLOG_REQUEST = {
  Request: 'StartActivity',
  MessageFilter: 65535,
  StreamFlags: 60,
} as const;

/** How long to wait for the device to answer StartActivity */
const START_ACTIVITY_TIMEOUT_MS = 10000;

/** Delimiter used by syslog_relay text protocol: newline + null byte */
const SYSLOG_LINE_SPLITTER = Buffer.from([0x0a, 0x00]);

/**
 * Reads the StartActivity reply from `socket`. The socket is left paused, and any bytes that
 * arrived after the reply are returned in `rest`.
 */
function readActivityReply(socket: net.Socket): Promise<ActivityReply> {
  return new Promise<ActivityReply>((resolve, reject) => {
    let received = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.pause();
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      let reply: ActivityReply | null;
      try {
        reply = parseActivityReply(received);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (reply) {
        cleanup();
        resolve(reply);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Connection closed before the StartActivity reply'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for the StartActivity reply after ${START_ACTIVITY_TIMEOUT_MS}ms`));
    }, START_ACTIVITY_TIMEOUT_MS);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}

/**
 * syslog-service provides functionality to capture and process syslog messages
 * from a remote device using Apple's XPC services.
 */
class SyslogService extends EventEmitter implements SyslogServiceInterface {
  private readonly baseService: BaseService;
  private socket: net.Socket | null = null;
  private isCapturing = false;
  private captureGeneration = 0;
  private enableVerboseLogging = false;
  private rawDataHandler: ((data: Buffer) => void) | null = null;
  private readonly syslogParser: SyslogProtocolParser;

  /**
   * Creates a new syslog-service instance
   * @param udid Device UDID
   */
  constructor(
    private readonly udid: string,
    options?: BaseServiceOptions,
  ) {
    super();
    this.baseService = new BaseService(udid, options);
    this.syslogParser = new SyslogProtocolParser(
      (entry: SyslogEntry) => this.handleSyslogEntry(entry),
      (error: Error) => log.debug(`Syslog parse error: ${error.message}`),
    );
  }

  /**
   * Starts capturing syslog data from the device
   * @param service Service information
   * @param options Configuration options for syslog capture
   */
  async start(service: Service, options: SyslogOptions = {}): Promise<void> {
    if (this.isCapturing) {
      log.info('Syslog capture already in progress. Stopping previous capture.');
      await this.stop();
    }

    const {pid = -1, enableVerboseLogging = false, textMode = false} = options;
    this.enableVerboseLogging = enableVerboseLogging;
    this.isCapturing = true;
    const generation = this.captureGeneration;

    try {
      if (textMode) {
        // syslog_relay.shim.remote: after RSDCheckin the device immediately
        // streams \n\x00-delimited plain-text log lines. No further request.
        const socket = await this.baseService.startRawShimService(service.serviceName);
        this.adoptSocket(socket, generation);
        let textBuf = Buffer.alloc(0);
        this.rawDataHandler = (data: Buffer) => {
          if (!this.isCapturing) {
            return;
          }
          textBuf = Buffer.concat([textBuf, data]);
          let idx: number;
          while ((idx = textBuf.indexOf(SYSLOG_LINE_SPLITTER)) !== -1) {
            const line = textBuf.subarray(0, idx).toString('utf8').trim();
            textBuf = textBuf.subarray(idx + SYSLOG_LINE_SPLITTER.length);
            if (line.length > 0) {
              this.emit('message', line);
            }
          }
        };
        socket.on('data', this.rawDataHandler);
        socket.resume();
        log.info('Syslog text-relay capture started');
        return;
      }

      const {socket, response, rest} = await this.startActivity(service.serviceName, pid);
      this.adoptSocket(socket, generation);
      this.rawDataHandler = (data: Buffer) => {
        if (!this.isCapturing) {
          return;
        }
        this.syslogParser.addData(data);
      };
      socket.on('data', this.rawDataHandler);
      this.syslogParser.addData(rest);
      socket.resume();

      log.info(`Syslog capture started: ${JSON.stringify(response)}`);
      this.emit('start', response);
    } catch (error) {
      if (generation === this.captureGeneration) {
        this.isCapturing = false;
      }
      throw error;
    }
  }

  /**
   * Stops capturing syslog data
   */
  async stop(): Promise<void> {
    if (!this.isCapturing) {
      log.info('No syslog capture in progress.');
      return;
    }
    this.captureGeneration++;

    if (this.rawDataHandler && this.socket) {
      this.socket.removeListener('data', this.rawDataHandler);
      this.rawDataHandler = null;
    }

    // The syslog relay is a server-push stream: the device never closes it, so a
    // graceful half-close (FIN) leaves the socket open and keeps the event loop alive.
    // Destroy it to fully release the handle.
    this.socket?.destroy();
    this.socket = null;
    this.syslogParser.reset();

    this.isCapturing = false;
    log.info('Syslog capture stopped');
    this.emit('stop');
  }

  /**
   * Restart the device
   * @param service Service information
   */
  async restart(service: Service): Promise<void> {
    try {
      const conn = await this.baseService.startLockdownService(service.serviceName);
      try {
        conn.sendPlist({Request: 'Restart'});
      } finally {
        conn.close();
      }
      log.info('Restart request sent');
    } catch (error) {
      log.error(`Error during restart: ${error}`);
      throw error;
    }
  }

  /**
   * Makes `socket` the capture socket, or closes it and throws if stop() ran while start()
   * was waiting for it
   */
  private adoptSocket(socket: net.Socket, generation: number): void {
    if (generation !== this.captureGeneration) {
      socket.destroy();
      throw new Error('Syslog capture was stopped while starting');
    }
    socket.on('error', (error: Error) => log.debug(`Syslog socket error: ${error.message}`));
    this.socket = socket;
  }

  /**
   * Starts the os_trace_relay activity stream and returns its socket, paused right after the
   * StartActivity reply. The socket is closed if the device does not start the activity.
   */
  private async startActivity(serviceName: string, pid: number): Promise<ActivityReply & {socket: net.Socket}> {
    const socket = await this.baseService.startRawShimService(serviceName);
    try {
      socket.write(framePlist({...DEFAULT_SYSLOG_REQUEST, Pid: pid}));
      const reply = await readActivityReply(socket);
      if (reply.response.Status !== 'RequestSuccessful') {
        throw new Error(`StartActivity failed: ${JSON.stringify(reply.response)}`);
      }
      return {socket, ...reply};
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  /**
   * Handles a parsed syslog entry by formatting it and emitting events.
   * Terminal output uses colored formatting for readability.
   * The 'message' event emits a plain (uncolored) string for programmatic use.
   */
  private handleSyslogEntry(entry: SyslogEntry): void {
    this.emit('syslogEntry', entry);
    const formatted = formatSyslogEntry(entry);

    if (this.enableVerboseLogging) {
      syslogLog.info(formatSyslogEntryColored(entry));
    }

    this.emit('message', formatted);
  }
}

export default SyslogService;
