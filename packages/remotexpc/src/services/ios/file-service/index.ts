import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type {Socket} from 'node:net';
import path from 'node:path';
import type {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import {getLogger} from '../../../lib/logger.js';
import {connectToTunnelHost} from '../../../lib/port-forwarding/connectors.js';
import type {RemoteXpcFramedTransport} from '../../../lib/remote-xpc/remote-xpc-framed-transport.js';
import {asNumber} from '../../../lib/remote-xpc/xpc-value.js';
import type {XPCDictionary, XPCValue} from '../../../lib/types.js';
import {
  CoreDeviceError,
  type CoreDevicePeerMessageHandler,
  CoreDeviceService,
  DEFAULT_INVOKE_TIMEOUT_MS,
} from '../core-device/core-device-service.js';
import {
  DEFAULT_FILE_SERVICE_USERNAME,
  DOMAINS_REQUIRING_IDENTIFIER,
  END_SESSION_TIMEOUT_MS,
  FILE_SERVICE_COMMAND,
  FILE_SERVICE_DOMAIN,
} from './constants.js';
import {FileDataDecoder, buildFileDataRequest} from './data-channel.js';
import {assertSuccessfulReply, parseFileNodes, parseRetrievedFileMetadata} from './replies.js';
import type {
  FileServiceEntry,
  FileServiceFileMetadata,
  FileServiceListOptions,
  FileServiceRequestOptions,
  FileServiceSessionOptions,
} from './types.js';

export {FILE_SERVICE_DOMAIN} from './constants.js';
export type {
  FileServiceDomain,
  FileServiceEntry,
  FileServiceFileMetadata,
  FileServiceListOptions,
  FileServiceRequestOptions,
  FileServiceSessionOptions,
} from './types.js';

const log = getLogger('CoreDeviceFileService');

/** How often the data channel's idle timeout is checked. */
const WATCHDOG_INTERVAL_MS = 250;

interface FileServiceSession {
  transport: RemoteXpcFramedTransport;
  id: Promise<string>;
}

/**
 * Client for the CoreDevice file service (`com.apple.coredevice.fileservice.*`),
 * the backend of `devicectl device info files` and `devicectl device copy from`.
 *
 * The control service speaks a `Cmd`-keyed protocol rather than the CoreDevice
 * feature-invocation envelope. A session rooted at one domain (for example an
 * app's data container) is created on first use and lives as long as the
 * control connection, so all calls on an instance share it. File bytes travel
 * over a separate raw TCP connection to the data service.
 *
 * Call {@link close} when done.
 */
export class CoreDeviceFileService extends CoreDeviceService {
  static readonly RSD_SERVICE_NAME = 'com.apple.coredevice.fileservice.control';
  static readonly DATA_SERVICE_NAME = 'com.apple.coredevice.fileservice.data';

  private readonly sessionOptions: FileServiceSessionOptions;
  private session: FileServiceSession | undefined;

  constructor(udid: string, sessionOptions: FileServiceSessionOptions) {
    super(udid, CoreDeviceFileService.RSD_SERVICE_NAME);
    const {domain, identifier} = sessionOptions;
    if (!Object.hasOwn(FILE_SERVICE_DOMAIN, domain)) {
      throw new TypeError(
        `Unsupported file service domain '${domain}'. ` +
          `Supported domains: ${Object.keys(FILE_SERVICE_DOMAIN).join(', ')}`,
      );
    }
    if ((DOMAINS_REQUIRING_IDENTIFIER as readonly string[]).includes(domain) && !identifier) {
      throw new TypeError(`The '${domain}' file service domain requires an identifier`);
    }
    this.sessionOptions = sessionOptions;
  }

  /**
   * Lists a directory with metadata, like `devicectl device info files`.
   *
   * @param path Directory relative to the session root. Defaults to the root.
   * @param options Set `recursive` to include everything below `path` instead of
   * only its direct children.
   * @returns Files and directories with paths relative to `path`. When `path` is
   * a regular file, the only entry is that file's path, relative to the session
   * root and without metadata.
   */
  async listDirectory(remotePath = '.', options: FileServiceListOptions = {}): Promise<FileServiceEntry[]> {
    const {recursive = false, ...requestOptions} = options;
    const fileList = await this.requestFileList(
      FILE_SERVICE_COMMAND.LIST_DIRECTORY_FILE_NODES,
      remotePath,
      requestOptions,
    );
    const entries = parseFileNodes(fileList);
    // A listed regular file comes back as its own entry without metadata
    return recursive ? entries : entries.filter((entry) => !entry.metadata || isDirectChild(entry.path));
  }

  /**
   * Lists the regular files in a directory, without metadata.
   *
   * @param path Directory relative to the session root. Defaults to the root.
   * @param options Set `recursive` to include the files in all subdirectories.
   * @returns File paths relative to `path`. When `path` is a regular file, the
   * only item is that file's path, relative to the session root.
   */
  async listFilePaths(remotePath = '.', options: FileServiceListOptions = {}): Promise<string[]> {
    const {recursive = false, ...requestOptions} = options;
    const fileList = await this.requestFileList(
      FILE_SERVICE_COMMAND.RETRIEVE_DIRECTORY_LIST,
      remotePath,
      requestOptions,
    );
    const paths = fileList.filter((item): item is string => typeof item === 'string');
    // A listed regular file comes back as its own path, relative to the session root
    if (recursive || (paths.length === 1 && paths[0] === toSessionRelativePath(remotePath))) {
      return paths;
    }
    return paths.filter(isDirectChild);
  }

  /**
   * Downloads a file, like `devicectl device copy from`.
   *
   * @param remotePath File path relative to the session root.
   * @param destination Local file path (missing parent directories are created
   * and an existing file is overwritten), or a writable stream that is ended once
   * the file has been written. A partially written local file is removed on failure.
   * @returns The metadata of the downloaded file.
   * @throws {CoreDeviceError} If `remotePath` does not exist or is a directory.
   */
  async pull(
    remotePath: string,
    destination: string | Writable,
    options: FileServiceRequestOptions = {},
  ): Promise<FileServiceFileMetadata> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    if (typeof destination !== 'string') {
      assertWritableDestination(destination);
    }
    // Open the local file first, so a bad destination fails before the device is asked for anything
    const output = typeof destination === 'string' ? await openLocalFile(destination) : destination;
    let socket: Socket | undefined;
    let isTransferStarted = false;
    try {
      const [host, port] = await this.resolveServiceAddress(CoreDeviceFileService.DATA_SERVICE_NAME);
      // devicectl connects the data channel before it asks for the file.
      socket = await connectToTunnelHost(host, port, timeoutMs);
      const reply = await this.request(FILE_SERVICE_COMMAND.RETRIEVE_FILE, {Path: remotePath}, options);
      if (isDirectoryMode(reply.FilePermissions)) {
        throw new CoreDeviceError(`'${remotePath}' is a directory, not a file`, reply);
      }
      const fileId = asFileId(reply.NewFileID);
      socket.write(buildFileDataRequest(fileId));
      isTransferStarted = true;
      const size = await receiveFile(socket, output, fileId, timeoutMs);
      log.debug(`Pulled '${remotePath}' (${size} bytes)`);
      return parseRetrievedFileMetadata(reply, size);
    } catch (err) {
      if (typeof destination === 'string') {
        output.destroy();
        await fsp.rm(destination, {force: true});
      }
      if (isTransferStarted) {
        // The device resets the control connection when a transfer is cut short
        await this.dropTransport();
      }
      throw err;
    } finally {
      socket?.destroy();
    }
  }

  /**
   * Ends the session and closes the connection.
   */
  override async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (session && session.transport === this.transport && session.transport.isConnected) {
      try {
        const sessionId = await session.id;
        await this.sendReceiveOnConnection(
          {Cmd: FILE_SERVICE_COMMAND.END_SESSION, MessageUUID: randomUUID().toUpperCase(), SessionID: sessionId},
          {actionIdentifier: FILE_SERVICE_COMMAND.END_SESSION, timeoutMs: END_SESSION_TIMEOUT_MS},
        );
      } catch (err) {
        log.debug(`Could not end the file service session: ${(err as Error).message}`);
      }
    }
    await super.close();
  }

  /**
   * The device numbers its own requests (the listing messages) 2, 4, 6, ... and
   * devicectl numbers its requests 1, 3, 5, ... With an even request id the
   * device aborts while replying to `RetrieveFile`
   * (`Attempted to send non-reply msg 2 on the reply channel`).
   */
  protected override allocateMessageId(): number {
    const id = this.nextMessageId;
    this.nextMessageId += 2;
    return id;
  }

  /**
   * Runs a listing command. The device does not return the listing in its
   * reply: it first sends it as one or more requests of its own that carry the
   * command's `MessageUUID` and a `FileList`. Each must be answered, or the
   * device stops reading from the connection; the reply to the command follows.
   */
  private async requestFileList(
    command: string,
    remotePath: string,
    options: FileServiceRequestOptions,
  ): Promise<XPCValue[]> {
    const messageUuid = randomUUID().toUpperCase();
    const fileList: XPCValue[] = [];
    await this.request(command, {Path: remotePath, MessageUUID: messageUuid}, options, (body, respond) => {
      if (body.MessageUUID !== messageUuid) {
        log.debug(`Ignoring an unexpected file service message: ${Object.keys(body).join(', ')}`);
        return;
      }
      if (Array.isArray(body.FileList)) {
        fileList.push(...body.FileList);
      }
      respond({MessageUUID: messageUuid});
    });
    return fileList;
  }

  private async request(
    command: string,
    fields: XPCDictionary,
    options: FileServiceRequestOptions,
    onPeerMessage?: CoreDevicePeerMessageHandler,
  ): Promise<XPCDictionary> {
    const sessionId = await this.ensureSession(options);
    const reply = await this.sendReceiveOnConnection(
      {MessageUUID: randomUUID().toUpperCase(), ...fields, Cmd: command, SessionID: sessionId},
      {actionIdentifier: command, timeoutMs: options.timeoutMs},
      onPeerMessage,
    );
    return assertSuccessfulReply(command, reply);
  }

  /**
   * Returns the id of the session on the current connection, creating the
   * connection and the session when needed. Sessions die with their connection.
   */
  private async ensureSession(options: FileServiceRequestOptions): Promise<string> {
    const transport = await this.getTransport();
    if (this.session?.transport !== transport) {
      const session: FileServiceSession = {transport, id: this.createSession(options)};
      session.id.catch(() => {
        if (this.session === session) {
          this.session = undefined;
        }
      });
      this.session = session;
    }
    return await this.session.id;
  }

  private async createSession(options: FileServiceRequestOptions): Promise<string> {
    const {domain, identifier = '', username = DEFAULT_FILE_SERVICE_USERNAME} = this.sessionOptions;
    const command = FILE_SERVICE_COMMAND.CREATE_SESSION;
    const reply = assertSuccessfulReply(
      command,
      await this.sendReceiveOnConnection(
        {
          Cmd: command,
          Domain: BigInt(FILE_SERVICE_DOMAIN[domain]),
          Identifier: identifier,
          Session: '',
          User: username,
        },
        {actionIdentifier: command, timeoutMs: options.timeoutMs},
      ),
    );
    if (typeof reply.NewSessionID !== 'string' || !reply.NewSessionID) {
      throw new CoreDeviceError(`File service '${command}' returned no session id`, reply);
    }
    log.debug(`Created a file service session for ${domain} '${identifier}'`);
    return reply.NewSessionID;
  }
}

/**
 * Streams the device's reply to a file data request into `output` and ends it.
 *
 * The transfer fails when the device sends nothing for `timeoutMs`. Time spent
 * waiting for a slow `output` does not count.
 *
 * @returns The number of bytes written.
 */
async function receiveFile(socket: Socket, output: Writable, fileId: bigint, timeoutMs: number): Promise<number> {
  const decoder = new FileDataDecoder(fileId);
  let lastActivityAt = Date.now();
  let isWaitingForOutput = false;
  const watchdog = setInterval(
    () => {
      if (!isWaitingForOutput && Date.now() - lastActivityAt >= timeoutMs) {
        socket.destroy(new Error(`File service data channel was idle for ${timeoutMs}ms`));
      }
    },
    Math.min(timeoutMs, WATCHDOG_INTERVAL_MS),
  );
  async function* fileBytes(): AsyncGenerator<Buffer> {
    for await (const chunk of socket) {
      lastActivityAt = Date.now();
      for (const part of decoder.push(chunk as Buffer)) {
        isWaitingForOutput = true;
        yield part;
        isWaitingForOutput = false;
        lastActivityAt = Date.now();
      }
      if (decoder.isDone) {
        return;
      }
    }
    throw new Error('The file service data channel closed before the file transfer completed');
  }
  try {
    await pipeline(fileBytes, output);
  } finally {
    clearInterval(watchdog);
  }
  return Number(decoder.size);
}

/**
 * Rejects a destination stream that cannot take the file's bytes, before the
 * device is asked for anything: a transfer into it would never complete.
 */
function assertWritableDestination(destination: Writable | undefined): void {
  if (typeof destination?.write !== 'function') {
    throw new TypeError('The destination must be a local file path or a writable stream');
  }
  if (destination.writableEnded || destination.destroyed) {
    throw new TypeError('The destination stream has already been ended or destroyed');
  }
}

/**
 * Opens a local file for writing, creating its parent directories.
 */
async function openLocalFile(localPath: string): Promise<fs.WriteStream> {
  await fsp.mkdir(path.dirname(localPath), {recursive: true});
  const stream = fs.createWriteStream(localPath);
  await once(stream, 'open');
  return stream;
}

/**
 * Converts a caller's path to the form the device uses for a listed file:
 * relative to the session root, without leading or trailing slashes.
 */
function toSessionRelativePath(remotePath: string): string {
  return path.posix.normalize(remotePath).replace(/^\/+|\/+$/g, '');
}

function isDirectChild(relativePath: string): boolean {
  return !relativePath.includes('/');
}

/**
 * Whether a `RetrieveFile` reply's `FilePermissions` (a POSIX mode, including
 * the file type bits) describes a directory.
 */
function isDirectoryMode(mode: XPCValue | undefined): boolean {
  return ((asNumber(mode) ?? 0) & fs.constants.S_IFMT) === fs.constants.S_IFDIR;
}

function asFileId(value: XPCValue | undefined): bigint {
  const fileId = typeof value === 'bigint' ? value : asNumber(value);
  if (fileId === undefined || fileId < 0 || !Number.isInteger(Number(fileId))) {
    throw new CoreDeviceError(`File service '${FILE_SERVICE_COMMAND.RETRIEVE_FILE}' returned no file id`);
  }
  return BigInt(fileId);
}

export default CoreDeviceFileService;
