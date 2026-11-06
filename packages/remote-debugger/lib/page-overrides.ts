import {util} from '@appium/support';

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

export interface WebInspectorPageSettings {
  pageSettings?: PageSettings;
  userPreferences?: PageUserPreferences;
  userAgent?: string;
}

export interface PageOverride {
  method: (typeof PAGE_OVERRIDE_METHODS)[keyof typeof PAGE_OVERRIDE_METHODS];
  params: {setting?: PageSettingName; name?: UserPreferenceName};
  value: boolean | string | undefined;
}

function validateObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (!util.isPlainObject(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  for (const key of Object.keys(value as object)) {
    if (!keys.includes(key)) {
      throw new TypeError(`Unknown Web Inspector setting: ${path}.${key}`);
    }
  }
}

/** Validate JavaScript callers before retaining a policy or sending any commands. */
export function validateWebInspectorPageSettings(settings: unknown): asserts settings is WebInspectorPageSettings {
  validateObject(settings, 'webInspectorSettings', WEB_INSPECTOR_SETTING_KEYS);
  if (settings.pageSettings !== undefined) {
    validateObject(settings.pageSettings, 'pageSettings', PAGE_SETTING_NAMES);
    for (const [name, value] of Object.entries(settings.pageSettings)) {
      if (value !== undefined && typeof value !== 'boolean') {
        throw new TypeError(`pageSettings.${name} must be a boolean`);
      }
    }
  }
  if (settings.userPreferences !== undefined) {
    validateObject(settings.userPreferences, 'userPreferences', Object.keys(USER_PREFERENCE_VALUES));
    for (const [name, value] of Object.entries(settings.userPreferences)) {
      const allowed: readonly string[] = USER_PREFERENCE_VALUES[name as UserPreferenceName];
      if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value))) {
        throw new TypeError(`userPreferences.${name} must be one of: ${allowed.join(', ')}`);
      }
    }
  }
  if (settings.userAgent !== undefined && typeof settings.userAgent !== 'string') {
    throw new TypeError('userAgent must be a string');
  }
}

/** Snapshot supported values; callers cannot mutate the retained policy afterward. */
export function toPageOverrides(settings: WebInspectorPageSettings): Map<string, PageOverride> {
  validateWebInspectorPageSettings(settings);
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

// Verification scope and excluded protocol settings are documented in
// docs/web-inspector-settings.md.
