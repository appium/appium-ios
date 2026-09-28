#pragma once

#import <Foundation/Foundation.h>

namespace coresim {

// Own status codes GetTCCAccess reports through `outStatus` — deliberately not TCC's own raw wire
// values (which reuse 0 for "denied", not "no row"), so a missing row and an explicit denial are
// never confusable. `kTCCAuthLimited` ("selected photos" access) is only meaningful for
// kTCCServicePhotos — SetTCCAccess itself doesn't enforce that (see commands/permissions.ts).
enum TCCAuthStatus {
  kTCCAuthNotDetermined = 0,
  kTCCAuthDenied,
  kTCCAuthGranted,
  kTCCAuthLimited,
};

// Grants, revokes, or limits a privacy permission for `bundleId` in the simulator's own TCC
// (privacy) database, located under the device's data directory (see DeviceDataPath, sim_device.h)
// at `Library/TCC/TCC.db`. `service` is the raw TCC service identifier (e.g. "kTCCServiceCamera"),
// not a friendly name — callers map friendly names to these before calling in (see
// commands/permissions.ts). `desiredStatus` must be kTCCAuthGranted, kTCCAuthDenied, or
// kTCCAuthLimited — kTCCAuthNotDetermined isn't a writable state (see ResetTCCAccess). Fails with a
// descriptive NSError if the device has never been booted (TCC.db doesn't exist yet) or the
// database can't be written to.
BOOL SetTCCAccess(NSString* dataPath, NSString* service, NSString* bundleId, TCCAuthStatus desiredStatus,
                  NSError** error);

// Resets a previously granted/revoked permission back to its default (unprompted, "unset") state
// by deleting its row from TCC.db, if one exists.
BOOL ResetTCCAccess(NSString* dataPath, NSString* service, NSString* bundleId, NSError** error);

// Reads TCC.db for the current authorization status of (service, bundleId), translating either
// schema (see HasAuthValueColumn in the .mm) into the TCCAuthStatus values above. Fails with the
// same descriptive NSError as SetTCCAccess if the device has never been booted (no TCC.db yet).
BOOL GetTCCAccess(NSString* dataPath, NSString* service, NSString* bundleId, TCCAuthStatus* outStatus, NSError** error);

}  // namespace coresim
