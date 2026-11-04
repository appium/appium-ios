/** Web Inspector methods shared by initial policy construction and runtime updates. */
export const PAGE_OVERRIDE_METHODS = {
  setting: 'Page.overrideSetting',
  userPreference: 'Page.overrideUserPreference',
  userAgent: 'Page.overrideUserAgent',
} as const;

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

export const WEB_INSPECTOR_SETTING_KEYS = ['pageSettings', 'userPreferences', 'userAgent'] as const;

export interface WebInspectorSettings {
  pageSettings?: PageSettings;
  userPreferences?: PageUserPreferences;
  userAgent?: string;
}

export interface PageOverride {
  method: (typeof PAGE_OVERRIDE_METHODS)[keyof typeof PAGE_OVERRIDE_METHODS];
  params: {setting?: PageSettingName; name?: UserPreferenceName};
  value: boolean | string | undefined;
}

/** Snapshot supported values; callers cannot mutate the retained policy afterward. */
export function toPageOverrides(settings: WebInspectorSettings): Map<string, PageOverride> {
  const result = new Map<string, PageOverride>();
  for (const setting of PAGE_SETTING_NAMES) {
    const value = settings.pageSettings?.[setting];
    if (value !== undefined) {
      result.set(`setting:${setting}`, {method: PAGE_OVERRIDE_METHODS.setting, params: {setting}, value});
    }
  }
  for (const name of Object.keys(USER_PREFERENCE_VALUES) as UserPreferenceName[]) {
    const value = settings.userPreferences?.[name];
    if (value !== undefined) {
      result.set(`preference:${name}`, {method: PAGE_OVERRIDE_METHODS.userPreference, params: {name}, value});
    }
  }
  if (settings.userAgent !== undefined) {
    result.set('userAgent', {method: PAGE_OVERRIDE_METHODS.userAgent, params: {}, value: settings.userAgent});
  }
  return result;
}

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
//
// https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Page.json
//
