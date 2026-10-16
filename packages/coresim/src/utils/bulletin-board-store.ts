import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {promisify} from 'node:util';

import {fs, plist} from '@appium/support';

import {bulletinBoardModelV2} from './bulletin-board-model-v2.js';
import {bulletinBoardModelV3} from './bulletin-board-model-v3.js';
import type {BulletinBoardModel, BulletinBoardStoreContent, NotificationsStatus} from './bulletin-board-model.js';

const execFileAsync = promisify(execFile);

// All the known data models, the oldest first.
const KNOWN_MODELS: readonly BulletinBoardModel[] = [bulletinBoardModelV2, bulletinBoardModelV3];

// The last pending update of each store, see BulletinBoardStore.withLock.
const pendingUpdates = new Map<string, Promise<void>>();

/**
 * SpringBoard's BulletinBoard store of a device (`Library/BulletinBoard/VersionedSectionInfo.plist`),
 * which keeps the notifications settings of every app as one archived `BBSectionInfo` per bundle id.
 */
export class BulletinBoardStore {
  readonly path: string;
  private readonly models: readonly BulletinBoardModel[];

  /**
   * @param dataPath — data directory of the device
   * @param versions — the `sectionInfoVersionNumber`s supported by the runtime, the oldest first
   * (all the known ones by default). A store of any other version is refused, as the format may
   * change in a future runtime. A missing store (a never-booted device) is created in the first
   * one, as SpringBoard migrates older versions but not newer ones.
   * @throws {Error} if a version is unknown
   */
  constructor(dataPath: string, versions: readonly number[] = KNOWN_MODELS.map(({version}) => version)) {
    this.models = versions.map((version) => {
      const model = KNOWN_MODELS.find((m) => m.version === version);
      if (!model) {
        throw new Error(`Unknown BulletinBoard store version ${version}`);
      }
      return model;
    });
    this.path = path.join(dataPath, 'Library', 'BulletinBoard', 'VersionedSectionInfo.plist');
  }

  /**
   * Runs `update` once every earlier update of the same store has settled: concurrent updates for
   * different apps would otherwise read the same store, and the last write would drop the other app's
   * section. Only the calls made by this process are serialized.
   */
  async withLock<T>(update: () => Promise<T>): Promise<T> {
    const result = (pendingUpdates.get(this.path) ?? Promise.resolve()).then(update);
    const settled = result.then(
      () => {},
      () => {},
    );
    pendingUpdates.set(this.path, settled);
    try {
      return await result;
    } finally {
      if (pendingUpdates.get(this.path) === settled) {
        pendingUpdates.delete(this.path);
      }
    }
  }

  /**
   * Adds, replaces or (`unset`) removes the app's section. The store is replaced atomically, so a
   * failed write leaves the previous one intact. A device that has never been booted has no store
   * yet: it is created with just this section, and SpringBoard adds the rest on boot.
   *
   * @returns `false` if there was nothing to write (`unset` without a store)
   * @throws {Error} if the existing store is of an unsupported format version
   */
  async setNotificationsStatus(bundleId: string, status: NotificationsStatus): Promise<boolean> {
    let store: BulletinBoardStoreContent;
    let model: BulletinBoardModel;
    if (await fs.exists(this.path)) {
      store = (await plist.parsePlistFile(this.path)) as BulletinBoardStoreContent;
      model = this.modelOf(store);
    } else if (status === 'unset') {
      return false;
    } else {
      await fs.mkdir(path.dirname(this.path), {recursive: true});
      model = this.models[0];
      store = model.createStore();
    }
    model.setNotificationsStatus(store, bundleId, status);
    await this.replace(store);
    return true;
  }

  /**
   * Makes the store immutable (`uchg`) so that nothing, including a dying SpringBoard, can rewrite it.
   * Best effort.
   */
  async setImmutable(immutable: boolean): Promise<void> {
    try {
      await execFileAsync('chflags', [immutable ? 'uchg' : 'nouchg', this.path]);
    } catch {}
  }

  private modelOf(store: BulletinBoardStoreContent): BulletinBoardModel {
    const model = this.models.find(({version}) => version === store.sectionInfoVersionNumber);
    if (!model) {
      throw new Error(
        `Unsupported version of ${this.path}: sectionInfoVersionNumber is ${store.sectionInfoVersionNumber}, ` +
          `supported: ${this.models.map(({version}) => version).join(', ')}`,
      );
    }
    return model;
  }

  private async replace(store: BulletinBoardStoreContent): Promise<void> {
    // In the same directory, so that the rename is atomic.
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmpPath, plist.createPlist(store, false), {flag: 'wx'});
      await fs.rename(tmpPath, this.path);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
