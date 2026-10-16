import {plist} from '@appium/support';

import type {BulletinBoardModel, NotificationsStatus} from './bulletin-board-model.js';

/** The format used by SpringBoard since iOS 18. */
export const bulletinBoardModelV2: BulletinBoardModel = {
  version: 2,
  createStore: () => ({sectionInfoVersionNumber: 2}),
  setNotificationsStatus(store, bundleId, status) {
    const sectionInfo = (store.sectionInfo ??= {});
    if (status === 'unset') {
      delete sectionInfo[bundleId];
    } else {
      sectionInfo[bundleId] = buildSectionInfo(bundleId, status);
    }
  },
};

/**
 * Builds the NSKeyedArchiver-encoded `BBSectionInfo` of `bundleId`, the same archive
 * AppleSimulatorUtils writes (SetNotificationsPermission.m). SpringBoard migrates its
 * `allowsNotifications` flag to the current `authorizationStatus` when it loads the section.
 */
export function buildSectionInfo(
  bundleId: string,
  status: Exclude<NotificationsStatus, 'unset'>,
  extraSectionKeys: Record<string, unknown> = {},
): Buffer {
  const nil = {UID: 0};
  return plist.createBinaryPlist({
    $version: 100000,
    $objects: [
      '$null',
      {
        suppressFromSettings: false,
        suppressedSettings: 0,
        hideWeeApp: false,
        sectionID: {UID: 2},
        displayName: {UID: 5},
        icon: nil,
        displaysCriticalBulletins: false,
        subsections: nil,
        sectionInfoSettings: {UID: 3},
        $class: {UID: 7},
        sectionCategory: 0,
        subsectionPriority: 0,
        version: {UID: 6},
        managedSectionInfoSettings: nil,
        appName: {UID: 5},
        sectionType: 0,
        factorySectionID: nil,
        dataProviderIDs: nil,
        subsectionID: nil,
        filters: nil,
        pathToWeeAppPluginBundle: nil,
        ...extraSectionKeys,
      },
      bundleId,
      {
        pushSettings: 63,
        showsInNotificationCenter: true,
        allowsNotifications: status !== 'denied',
        showsOnExternalDevices: true,
        contentPreviewSetting: 0,
        carPlaySetting: 0,
        $class: {UID: 4},
        showsInLockScreen: true,
        alertType: 1,
        criticalAlertSetting: status === 'critical' ? 2 : 0,
      },
      {$classname: 'BBSectionInfoSettings', $classes: ['BBSectionInfoSettings', 'NSObject']},
      bundleId,
      0,
      {$classname: 'BBSectionInfo', $classes: ['BBSectionInfo', 'NSObject']},
    ],
    $archiver: 'NSKeyedArchiver',
    $top: {root: {UID: 1}},
  });
}
