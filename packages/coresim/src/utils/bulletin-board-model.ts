export type NotificationsStatus = 'granted' | 'denied' | 'critical' | 'unset';

/** Content of `VersionedSectionInfo.plist`. */
export interface BulletinBoardStoreContent {
  sectionInfoVersionNumber?: number;
  sectionInfo?: Record<string, Uint8Array>;
}

/**
 * The data model of one `sectionInfoVersionNumber` of the BulletinBoard store. The store operations
 * (locking, atomic replace, ...) don't depend on it, so a new format version only needs a new model.
 */
export interface BulletinBoardModel {
  /** The `sectionInfoVersionNumber` this model reads and writes. */
  readonly version: number;
  /** An empty store, as SpringBoard of this version would start it. */
  createStore(): BulletinBoardStoreContent;
  /** Adds, replaces or (`unset`) removes the app's notifications section in place. */
  setNotificationsStatus(store: BulletinBoardStoreContent, bundleId: string, status: NotificationsStatus): void;
}
