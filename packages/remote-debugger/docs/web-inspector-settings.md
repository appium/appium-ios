# Web Inspector page settings

Pass `webInspectorSettings` to the constructor, or call
`setWebInspectorPageSettings(settings)` to replace the retained override policy.
The policy applies to inspected pages, new and provisional page targets, and
subsequent debugger connections.

## Configure and replace a policy

The constructor accepts the initial policy. It validates and snapshots the object;
it does not contact Web Inspector or check device support yet.

```ts
import {RemoteDebugger} from 'appium-remote-debugger';

const remote = new RemoteDebugger({
  webInspectorSettings: {pageSettings: {WebSecurityEnabled: false}},
});
```

After connecting and selecting a page through the normal debugger setup, await
the setter to update currently tracked targets before navigating or issuing
commands that depend on the settings:

```ts
await remote.setWebInspectorPageSettings({
  pageSettings: {WebSecurityEnabled: false, ImagesEnabled: false},
  userPreferences: {PrefersColorScheme: 'Dark'},
  userAgent: 'MyTestBrowser/1.0',
});

// Keep only UA. Reset the earlier WebSecurityEnabled, ImagesEnabled and CSS preference overrides.
await remote.setWebInspectorPageSettings({userAgent: 'MyTestBrowser/2.0'});

// Reset all overrides managed by the retained policy.
await remote.setWebInspectorPageSettings({});
```

Each call replaces the **complete** policy. Omitted entries reset to browser/system
defaults; `{}` clears all overrides managed by this policy. The setter does not
merge objects. To change one key while retaining others, keep the complete policy
in your application and pass the updated object each time. Mutating an object
previously passed to the constructor or setter does not change the saved policy.

Calling the setter before the first connection saves the policy for later
attachment without sending commands. Likewise, a connected client with no tracked
page targets can save a policy without testing it on a device. A successful call
in either case confirms local validation and storage, not device support. Calls
on an existing disconnected RPC client can reject; reconnect before retrying.

## Supported inputs

| Group | Supported keys | Values |
| --- | --- | --- |
| `pageSettings` | `AuthorAndUserStylesEnabled`, `ImagesEnabled`, `ScriptEnabled`, `WebSecurityEnabled`, `MediaCaptureRequiresSecureConnection`, `ICECandidateFilteringEnabled` | Boolean |
| `userPreferences` | `PrefersReducedMotion` | `Reduce`, `NoPreference` |
| `userPreferences` | `PrefersContrast` | `More`, `NoPreference` |
| `userPreferences` | `PrefersColorScheme` | `Light`, `Dark` |
| `userAgent` | — | String |

Unknown keys, invalid object shapes, non-boolean page settings, and invalid
preference values are rejected with `TypeError` before any state change or RPC.
Names and values are case-sensitive. Optional entries set to `undefined` are
treated as omitted.

For example, `WebSecurityEnable` (missing the final `d`), the string `"false"`,
`PrefersColorScheme: 'dark'`, and `null` are invalid. Use `WebSecurityEnabled: false`,
`PrefersColorScheme: 'Dark'`, and omission or `{}` for resets. The exported
`PAGE_SETTING_NAMES`, `USER_PREFERENCE_VALUES`, and `WEB_INSPECTOR_SETTING_KEYS`
provide the accepted names and values for callers building their own input UI or
validation. They describe this package's API, not the capabilities of a specific
device. No capability-negotiation result is returned by the setter.

## When changes take effect

Reload or navigate after changing document/resource-dependent page settings.
CSS preferences update immediately. UA overrides affect subsequent requests;
reload to refresh an already-read `navigator.userAgent`. This API does not reload
pages automatically.

An override value of `true` or `false` explicitly forces that setting. Removing
the entry restores the browser's default, which need not equal `true`. Similarly,
`NoPreference` is an explicit CSS preference value; omit the preference to restore
the user's system setting.

## Choosing a User-Agent API

| API | Scope | Retained for new targets and reconnects |
| --- | --- | --- |
| `setWebInspectorPageSettings({userAgent: value, ...otherSettings})` | Currently tracked targets and the retained policy | Yes |
| `overrideUserAgent(value)` | Current selected page | No |

The legacy `overrideUserAgent` method keeps its existing page-scoped behavior.
Its values are not added to the retained policy, so `{}` does not reset a UA set
only through that method. When the retained policy does include UA, removing it
sends a UA reset to tracked targets.

Avoid mixing the APIs for UA: if the policy contains `A`, a legacy call sets `B`,
and the same policy containing `A` is submitted again, the setter sees no policy
change and does not overwrite `B` on that page. New targets still receive `A`.
Use the retained-policy API consistently when UA must survive navigation and
reconnection. Keep the legacy API for existing callers that need page-scoped
behavior.

## Errors and recovery

Local validation and device rejection are different. Invalid input always fails
before state changes. A valid API key can still be unavailable on a particular
OS version; Web Inspector decides whether it accepts that command.

| Operation | Unsupported method or parameter (`-32601` / `-32602`) |
| --- | --- |
| Applying the policy while attaching a new target | Warn, skip that override, and continue initialization |
| Applying a changed key in an explicit policy update | Reject the update and attempt rollback of changes already made |

This distinction keeps attachment usable on devices with partial support while
letting callers detect a rejected explicit update. For example, a constructor
policy containing an unavailable preference can still attach with a warning;
adding that same preference through a runtime update rejects the batch, including
otherwise supported changes. Restrict the runtime policy to keys supported by the
device when the whole update must succeed.

Unsupported initialization overrides are not queued as transient repairs.
Resubmitting an unchanged policy does not probe those overrides again. New
targets and later connections attempt the retained policy during initialization.

- Initialization is best-effort: unsupported methods or parameters produce a
  warning while the remaining overrides and normal page initialization continue.
  Other application failures are retained for retry during the next policy update.
- Runtime updates are transactional: a rejection, including an unsupported
  override, rejects the update, retains the previous policy, and attempts to roll
  back changes already made on other keys or targets. This differs intentionally
  from best-effort attachment; successful attachment alone does not confirm that
  every override was applied.
- Pending initialization or rollback repairs are reconciled with the requested
  policy. Repeating the policy retries unresolved keys; replacing or clearing a
  failed value sends the new value or reset directly. If rollback fails again,
  that unresolved state remains tracked for a later update.
- Each override response has a 10-second deadline. A target that times out is
  excluded from later policy updates until initialized again, for example after
  reconnecting, because its final override state is unknown. During attachment,
  remaining overrides for that target are skipped, but core domains and the
  `Inspector.initialized` handshake are still attempted. During a runtime update,
  timeout rejects the update and attempts rollback on responsive targets.
- Disconnects cancel pending override waits; missing applications and targets
  are removed from override tracking and their pending waits are canceled.
  A missing application cancels waits for all of its targets, allowing updates
  on healthy targets to complete without waiting for the missing app's deadline
  or rolling back solely because it disappeared. Disconnected or missing targets stop
  initialization rather than continuing commands on a dead target.
  Application-disconnect notifications and recognized missing-app/target errors
  trigger this removal. Unrecognized errors reject runtime updates rather than
  being assumed to mean that a target disappeared.
  Missing-app recognition accepts complete `app not found` or
  `Application PID:<digits> does not exist` responses (optionally ending in a
  period), including the RPC error prefix added by this client. A PID-bearing
  response must match the destination app. Messages merely containing similar
  words, or referring to another app's PID, do not remove tracked targets.
- Registration and policy updates share a lock to prevent stale policy application.
  Runtime updates run on up to four targets concurrently, with commands for each
  target kept in order. On failure, new target tasks stop being scheduled and all
  started tasks settle before rollback begins. Rollback also runs on up to four
  targets concurrently, restoring each target's completed changes in reverse order.
  The shared lock is held through rollback, so queued updates and override
  initialization cannot overlap the transaction. Override initialization itself
  remains serialized under this lock. Total latency can still grow with the number
  of targets and settings; the 10-second deadline is per request, not per batch.

Await each update before starting work that depends on it. A slow target can delay
other updates and target initialization; queuing more setters does not bypass
that wait. After a rejected update, the retained policy is still the previous
one, but rollback failures or timeouts mean individual pages may differ from it.
Retrying, replacing, or clearing the policy reconciles still-tracked targets.
Reconnect to reinitialize a target excluded after a timeout; an update on the
remaining targets does not confirm the excluded target's state.

## Verification scope

The supported settings were exercised on iPad mini (A17 Pro), iPadOS 27.2 Safari,
and the matching Simulator. Availability and effects can differ by OS version.
Media-related checks covered API exposure, not capture permission or operation.

The following protocol settings are not exposed because commands were accepted
without observable effects after reload in those checks:

- `InputTypeMonthEnabled` and `InputTypeWeekEnabled`: inputs remained enabled.
- `FullScreenEnabled`: `document.fullscreenEnabled` remained true; a physical-device
  HTTPS follow-up also allowed `requestFullscreen` with the override set to false.
- `PointerLockEnabled`, `NotificationsEnabled`, and `PushAPIEnabled`: enabling did
  not expose the APIs, including HTTPS on the physical device and localhost on
  Simulator. Installed web apps were not tested.

Other settings are not exposed because their effects were not verified:
`MockCaptureDevicesEnabled` (enumeration unchanged; capture not requested),
`FixedBackgroundsPaintRelativeToDocument`, `ShowDebugBorders`, `ShowRepaintCounter`,
`NeedsSiteSpecificQuirks`, `PrivateClickMeasurementDebugModeEnabled`, and
`ITPDebugModeEnabled`. Command acceptance alone does not establish functionality.
See WebKit's [Page protocol](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Page.json)
for the underlying commands.
