import {buildSectionInfo} from './bulletin-board-model-v2.js';
import type {BulletinBoardModel} from './bulletin-board-model.js';

/** The format used by SpringBoard since iOS 27: v2 with `isLocked` in the `BBSectionInfo`. */
export const bulletinBoardModelV3: BulletinBoardModel = {
  version: 3,
  createStore: () => ({sectionInfoVersionNumber: 3}),
  setNotificationsStatus(store, bundleId, status) {
    const sectionInfo = (store.sectionInfo ??= {});
    if (status === 'unset') {
      delete sectionInfo[bundleId];
    } else {
      sectionInfo[bundleId] = buildSectionInfo(bundleId, status, {isLocked: false});
    }
  },
};
