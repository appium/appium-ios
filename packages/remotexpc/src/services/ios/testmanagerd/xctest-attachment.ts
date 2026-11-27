import * as Services from '../../../services.js';
import {isAccessRestrictedError, isFileNotFoundError} from '../file-service/index.js';
import {canonicalizeUuidString} from './uuid.js';

/** Bundle id of the data container testmanagerd stores attachments in. */
const TESTMANAGERD_BUNDLE_ID = 'com.apple.testmanagerd';
/** Attachment folders in that container: Xcode 26.5+ (`tmp/Attachments`) and the legacy one. */
const ATTACHMENT_DIRECTORIES = ['tmp/Attachments', 'Attachments'] as const;

/**
 * XCTest attachment management for a device (e.g. delete screen recordings by UUID
 * from testmanagerd's attachment folders). Needs the CoreDevice file service (tunnel).
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
   * Delete attachments by UUID.
   *
   * testmanagerd only deletes attachments registered by the test session that received them
   * (`_IDE_deleteAttachmentsWithUUIDs:` is acknowledged without removing anything for any other
   * session), so the files are removed through the CoreDevice file service instead.
   * Attachments that do not exist are ignored.
   */
  async delete(uuids: string[]): Promise<void> {
    if (!uuids?.length) {
      throw new Error('delete requires at least one UUID');
    }

    const names = new Set(uuids.map((u) => canonicalizeUuidString(u).toUpperCase()));
    const fileService = await Services.startCoreDeviceFileService(this.udid, {
      domain: 'appDataContainer',
      identifier: TESTMANAGERD_BUNDLE_ID,
      username: 'mobile',
    });
    try {
      for (const directory of ATTACHMENT_DIRECTORIES) {
        let present: string[];
        try {
          present = await fileService.listFilePaths(directory);
        } catch (err) {
          // A missing directory, or one outside the container access policy (iOS 27: only tmp)
          if (isFileNotFoundError(err) || isAccessRestrictedError(err)) {
            continue;
          }
          throw err;
        }
        for (const name of present.filter((n) => names.has(n.toUpperCase()))) {
          try {
            await fileService.rm(`${directory}/${name}`);
          } catch (err) {
            // Removed by a concurrent call in the meantime
            if (!isFileNotFoundError(err)) {
              throw err;
            }
          }
        }
      }
    } finally {
      await fileService.close().catch(() => {});
    }
  }
}
