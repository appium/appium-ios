# Web Inspector page settings

Pass `webInspectorSettings` to the constructor, or call
`setWebInspectorPageSettings(settings)` to replace the retained override policy.
The policy applies to inspected pages, new and provisional page targets, and
subsequent debugger connections.

```ts
const remote = new RemoteDebugger({
  webInspectorSettings: {pageSettings: {WebSecurityEnabled: false}},
});

await remote.setWebInspectorPageSettings({
  pageSettings: {WebSecurityEnabled: false, ImagesEnabled: false},
  userPreferences: {PrefersColorScheme: 'Dark'},
  userAgent: 'MyTestBrowser/1.0',
});
await remote.setWebInspectorPageSettings({});
```

Each call replaces the **complete** policy. Omitted entries reset to browser/system
defaults; `{}` clears all overrides managed by this policy. The existing
`overrideUserAgent(value)` method remains page-scoped and does not update the
retained policy. A reset only clears its UA value if the policy itself manages UA;
avoid mixing the two APIs for the same setting.

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

Reload or navigate after changing document/resource-dependent page settings.
CSS preferences update immediately. UA overrides affect subsequent requests;
reload to refresh an already-read `navigator.userAgent`. This API does not reload
pages automatically.

## Errors and recovery

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
  are removed from override tracking. Disconnected or missing targets stop
  initialization rather than continuing commands on a dead target.
- Registration and policy updates share a lock to prevent stale policy application.
  Override requests are sequential, so total latency can grow with the number of
  targets and settings. The 10-second deadline applies per request, not per batch.

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
