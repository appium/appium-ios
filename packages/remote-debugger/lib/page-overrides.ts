/** Page settings with observable effects verified on iPadOS 27.2 Safari and iOS 27.2 Simulator. */
export const PAGE_SETTING_NAMES = [
  'AuthorAndUserStylesEnabled',
  'ImagesEnabled',
  'ScriptEnabled',
  'WebSecurityEnabled',
  'MediaCaptureRequiresSecureConnection',
  'ICECandidateFilteringEnabled',
] as const;

export type PageSettingName = (typeof PAGE_SETTING_NAMES)[number];
export type PageSettings = Partial<Record<PageSettingName, boolean>>;

export const USER_PREFERENCE_VALUES = {
  PrefersReducedMotion: ['Reduce', 'NoPreference'],
  PrefersContrast: ['More', 'NoPreference'],
  PrefersColorScheme: ['Light', 'Dark'],
} as const;

export type UserPreferenceName = keyof typeof USER_PREFERENCE_VALUES;
export type PageUserPreferences = {
  [Name in UserPreferenceName]?: (typeof USER_PREFERENCE_VALUES)[Name][number];
};

// Not exposed: iPad mini (A17 Pro), iPadOS 27.2 Safari and the matching Simulator
// accepted these overrides without observable effects after reload:
// - InputTypeMonthEnabled / InputTypeWeekEnabled: both input types stayed enabled.
// - FullScreenEnabled: document.fullscreenEnabled stayed true. On physical iPad,
//   requestFullscreen also succeeded with false in an HTTPS follow-up test.
// - PointerLockEnabled / NotificationsEnabled / PushAPIEnabled: enabling did not
//   expose the APIs (also checked on HTTPS on physical iPad, localhost on Simulator).
// Installed web apps were not tested.
// Do not interpret command acceptance as proof of functionality.
//
// Also not exposed because effects were NOT verified (rather than proven broken):
// MockCaptureDevicesEnabled (enumeration unchanged; capture not requested),
// FixedBackgroundsPaintRelativeToDocument, ShowDebugBorders, ShowRepaintCounter,
// NeedsSiteSpecificQuirks, PrivateClickMeasurementDebugModeEnabled, ITPDebugModeEnabled.
