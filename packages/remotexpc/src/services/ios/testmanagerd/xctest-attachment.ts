import crypto from 'node:crypto';

import {getLogger} from '../../../lib/logger.js';
import type {TestmanagerdService} from '../../../lib/types.js';
import * as Services from '../../../services.js';
import {MessageAux} from '../dvt/dtx-message.js';
import {extractNSKeyedArchiverObjects, hasNSErrorIndicators} from '../dvt/utils.js';
import type {CoreDeviceFileService} from '../file-service/index.js';
import {canonicalizeUuidString} from './uuid.js';
import {DEFAULT_EXEC_CAPABILITIES, SELECTOR, TESTMANAGERD_CHANNEL} from './xctest-common.js';
import {createNSUUID} from './xctestconfiguration.js';

const log = getLogger('XCTestAttachment');

const MIN_NSERROR_DESCRIPTION_LEN = 20;

/** Bundle id of the data container testmanagerd stores attachments in. */
const TESTMANAGERD_BUNDLE_ID = 'com.apple.testmanagerd';
/** Attachment folders in that container: Xcode 26.5+ (`tmp/Attachments`) and the legacy one. */
const ATTACHMENT_DIRECTORIES = ['tmp/Attachments', 'Attachments'] as const;

/**
 * IDE-side XCTest attachment management for a device (e.g. delete screen
 * recordings by UUID under testmanagerd's Attachments). Opens a short-lived
 * testmanagerd session; private Apple API.
 */
export class XCTestAttachment {
  private readonly udid: string;

  constructor(udid: string) {
    if (!udid?.trim()) {
      throw new Error('udid is required');
    }
    this.udid = udid;
  }

  /** Device UDID passed to the constructor. */
  get deviceId(): string {
    return this.udid;
  }

  /**
   * Delete attachments by UUID (`_IDE_deleteAttachmentsWithUUIDs:`).
   * Opens testmanagerd, initiates an IDE exec session, sends delete, then closes.
   *
   * testmanagerd (iOS 27+) only deletes attachments registered by the test session that
   * received them, and acknowledges any other request without removing the file.
   * So the files that are still there afterwards are removed via the CoreDevice file service.
   */
  async delete(uuids: string[]): Promise<unknown> {
    if (!uuids?.length) {
      throw new Error('delete requires at least one UUID');
    }

    let result: unknown;
    const testmanagerdService = await Services.startTestmanagerdService(this.udid);
    try {
      const channel = await testmanagerdService.makeChannel(TESTMANAGERD_CHANNEL);
      const channelCode = channel.getCode();

      const sessionId = crypto.randomUUID();
      const initArgs = new MessageAux();
      initArgs.appendObj(createNSUUID(sessionId));
      initArgs.appendObj({
        __type: 'XCTCapabilities',
        capabilities: DEFAULT_EXEC_CAPABILITIES,
      });

      await testmanagerdService.sendMessage(channelCode, SELECTOR.initiateSession, {args: initArgs});
      const [initResult] = await testmanagerdService.recvPlist(channelCode);
      log.debug('Exec session for attachment delete:', initResult);

      result = await deleteAttachmentsOnChannel(testmanagerdService, channelCode, uuids);
    } finally {
      try {
        await testmanagerdService.close();
      } catch {
        /* ignore */
      }
    }
    await this.removeLeftoverFiles(uuids);
    return result;
  }

  /** Remove the attachment files testmanagerd kept. Needs the CoreDevice file service (tunnel). */
  private async removeLeftoverFiles(uuids: string[]): Promise<void> {
    const names = new Set(uuids.map((u) => canonicalizeUuidString(u).toUpperCase()));
    let fileService: CoreDeviceFileService;
    try {
      fileService = await Services.startCoreDeviceFileService(this.udid, {
        domain: 'appDataContainer',
        identifier: TESTMANAGERD_BUNDLE_ID,
        username: 'mobile',
      });
    } catch (err) {
      log.warn(`Cannot verify the attachment removal, the file service is unavailable: ${(err as Error).message}`);
      return;
    }
    try {
      for (const directory of ATTACHMENT_DIRECTORIES) {
        let present: string[];
        try {
          present = await fileService.listFilePaths(directory);
        } catch {
          continue;
        }
        for (const name of present.filter((n) => names.has(n.toUpperCase()))) {
          log.debug(`testmanagerd kept '${directory}/${name}', removing it`);
          await fileService.rm(`${directory}/${name}`);
        }
      }
    } finally {
      await fileService.close().catch(() => {});
    }
  }
}

/**
 * Throw when a testmanagerd callback payload contains NSError-like data.
 */
function throwIfNSErrorReply(result: unknown, context: string): void {
  if (result == null || typeof result !== 'object') {
    return;
  }
  const objects = extractNSKeyedArchiverObjects(result);
  if (objects) {
    const hasErr = objects.some((o) => hasNSErrorIndicators(o));
    if (hasErr) {
      const msg =
        objects.find((o): o is string => typeof o === 'string' && o.length > MIN_NSERROR_DESCRIPTION_LEN) ??
        'NSError from testmanagerd';
      throw new Error(`${context}: ${msg}`);
    }
  }
  if (hasNSErrorIndicators(result)) {
    throw new Error(`${context}: ${JSON.stringify(result)}`);
  }
}

/**
 * Send `_IDE_deleteAttachmentsWithUUIDs:` on an existing testmanagerd channel.
 * Used by {@link XCTestAttachment.delete}.
 */
async function deleteAttachmentsOnChannel(
  connection: TestmanagerdService,
  channelCode: number,
  uuids: string[],
): Promise<unknown> {
  if (!uuids.length) {
    throw new Error('deleteAttachmentsOnChannel requires at least one UUID');
  }

  const normalized = uuids.map((u) => canonicalizeUuidString(u));
  const unique = [...new Set(normalized)];

  const args = new MessageAux();
  // NSSet<NSUUID> — matches `_IDE_deleteAttachmentsWithUUIDs:` on the IDE side.
  args.appendObj(new Set(unique.map((u) => createNSUUID(u))));

  await connection.sendMessage(channelCode, SELECTOR.deleteAttachmentsWithUUIDs, {args, expectsReply: true});

  const [result] = await connection.recvPlist(channelCode);
  throwIfNSErrorReply(result, 'deleteAttachmentsOnChannel');
  return result;
}
