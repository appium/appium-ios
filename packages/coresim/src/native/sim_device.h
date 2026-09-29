#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>

namespace coresim {

// -[SimDevice UDID] / -[SimDevice name] / -[SimDevice state] / -[SimDevice deviceType] /
// -[SimDevice runtime]. `state` is the raw SimDeviceState enum value (0=Creating, 1=Shutdown,
// 2=Booting, 3=Booted, 4=ShuttingDown).
NSUUID* DeviceUDID(id device);
NSString* DeviceName(id device);
unsigned long long DeviceState(id device);
id DeviceDeviceType(id device);
id DeviceRuntime(id device);

// -[SimDevice dataPath] -> the device's `data` directory
// (~/Library/Developer/CoreSimulator/Devices/<udid>/data), the root of everything the guest OS
// considers its own filesystem (app containers, Library, etc.) — used to locate TCC.db for
// privacy-permission access (see tcc_privacy.h).
NSString* DeviceDataPath(id device);

// -[SimDevice lastBootedAt] -> the current boot session's start time (nil if never booted). Used to
// tell a guest preference file that predates this boot from one already rewritten this boot (see
// sim_orientation.mm).
NSDate* DeviceLastBootedAt(id device);

// -[SimDevice bootWithOptions:error:]
BOOL Boot(id device, NSDictionary* options, NSError** error);

// -[SimDevice bootAsyncWithOptions:completionQueue:completionHandler:]. `handler` runs on `queue`
// exactly once with the resulting NSError (nil on success) — this is what replaces the CLI's
// bootstatus poll-until-timeout race.
void BootAsync(id device, NSDictionary* options, dispatch_queue_t queue, void (^handler)(NSError*));

// -[SimDevice bootStatus] -> SimDeviceBootInfo* describing the most recent boot attempt's
// progress, or nil if the device has never been booted. This is the same underlying mechanism
// `simctl bootstatus` itself uses — a separate, far more granular signal than SimDeviceState,
// tracking post-boot data migration and system-app readiness that `state` knows nothing about
// (see CLAUDE.md).
//
// Confirmed empirically NOT reset on shutdown: after `shutdownWithError:`, this still returns the
// *previous* boot session's terminal SimDeviceBootInfo rather than nil — callers must also check
// SimDevice.state to tell "genuinely mid-boot" from "shut down, remembering an old boot".
id DeviceBootStatus(id device);

// -[SimDeviceBootInfo status] -> raw status code. Confirmed values (see CLAUDE.md): 0 = Booting,
// 2 = WaitingOnDataMigration, 4 = WaitingOnSystemApp, 0xFFFFFFFF = Finished (the only terminal
// value observed). `simctl bootstatus`'s own output also names a WaitingOnBackboard phase whose
// numeric value wasn't observed in testing (not every boot passes through it) — treat any value other than
// the four confirmed above as "not yet terminal, keep waiting" rather than an error.
unsigned int BootInfoStatus(id bootInfo);

// -[SimDeviceBootInfo isTerminalStatus] -> whether this boot attempt has fully settled. Confirmed
// empirically to stay YES after shutdown, reflecting the previous session — see DeviceBootStatus.
BOOL BootInfoIsTerminal(id bootInfo);

// -[SimDevice shutdownWithError:]
BOOL Shutdown(id device, NSError** error);

// -[SimDevice eraseContentsAndSettingsWithError:]
BOOL Erase(id device, NSError** error);

// -[SimDevice getenv:error:]
NSString* Getenv(id device, NSString* name, NSError** error);

// -[SimDevice lookup:error:] -> a Mach port (0/MACH_PORT_NULL on failure), resolved within the
// device's own launchd_sim bootstrap namespace by name. Confirmed empirically (see CLAUDE.md) to
// need no special entitlement — used to reach the pasteboard sync service (sim_pasteboard.h),
// the same way Apple's own Simulator.app does.
unsigned int LookupMachPort(id device, NSString* serviceName, NSError** error);

// Rotates the device via a raw GSEvent mach message to SpringBoard's "PurpleWorkspacePort" (see
// CLAUDE.md). `orientation`: 1=portrait, 2=portraitUpsideDown, 3=landscapeRight, 4=landscapeLeft.
BOOL SetDeviceOrientation(id device, int32_t orientation, NSError** error);

// -[SimDevice installApplication:withOptions:error:]
BOOL InstallApp(id device, NSURL* appURL, NSDictionary* options, NSError** error);

// -[SimDevice uninstallApplication:withOptions:error:]
BOOL UninstallApp(id device, NSString* bundleID, NSDictionary* options, NSError** error);

// -[SimDevice launchApplicationWithID:options:error:]. Returns the launched pid.
int LaunchApp(id device, NSString* bundleID, NSDictionary* options, NSError** error);

// -[SimDevice terminateApplicationWithID:error:]
BOOL TerminateApp(id device, NSString* bundleID, NSError** error);

// -[SimDevice propertiesOfApplication:error:]
NSDictionary* PropertiesOfApplication(id device, NSString* bundleID, NSError** error);

// -[SimDevice installedAppsWithError:]
NSDictionary* InstalledApps(id device, NSError** error);

// -[SimDevice openURL:error:]
BOOL OpenURL(id device, NSURL* url, NSError** error);

// -[SimDevice(SimLocation) setLocationWithLatitude:andLongitude:error:]
BOOL SetLocation(id device, double latitude, double longitude, NSError** error);

// -[SimDevice(SimLocation) clearSimulatedLocationWithError:]
BOOL ClearLocation(id device, NSError** error);

// -[SimDevice(SimPushNotification) sendPushNotificationForBundleID:jsonPayload:error:] — despite
// the selector's "json" naming, the real parameter type is NSDictionary*, not NSData* (confirmed
// empirically: ObjC type encoding can't distinguish object *classes*, only that a parameter is
// some object pointer, so the original signature recovery guessed wrong; passing NSData crashes
// with "-[NSConcreteData objectForKeyedSubscript:]: unrecognized selector" regardless of whether
// the NSData holds JSON text or a serialized plist — see CLAUDE.md).
BOOL SendPushNotification(id device, NSString* bundleID, NSDictionary* payload, NSError** error);

// -[SimDevice(SimDeviceKeychain) addCertificateAtURL:trustAsRoot:error:]
BOOL AddCertificate(id device, NSURL* certURL, BOOL trustAsRoot, NSError** error);

// -[SimDevice(SimDeviceKeychain) resetKeychainWithError:]
BOOL ResetKeychain(id device, NSError** error);

// -[SimDevice(SimUIInterfaceStyle) currentUIInterfaceStyle] / setUIInterfaceStyle:error:
long long CurrentUIInterfaceStyle(id device);
BOOL SetUIInterfaceStyle(id device, long long style, NSError** error);

// -[SimDevice(Accessibility) currentIncreaseContrastMode] / setIncreaseContrastEnabled:error:
long long CurrentIncreaseContrastMode(id device);
BOOL SetIncreaseContrastEnabled(id device, BOOL enabled, NSError** error);

// -[SimDevice(Accessibility) currentContentSizeCategory] / setContentSizeCategory:error:
long long CurrentContentSizeCategory(id device);
BOOL SetContentSizeCategory(id device, long long category, NSError** error);

// -[SimDevice darwinNotificationGetState:name:error:]
BOOL DarwinNotificationGetState(id device, unsigned long long* outState, NSString* name, NSError** error);

// -[SimDevice darwinNotificationSetState:name:error:]
BOOL DarwinNotificationSetState(id device, unsigned long long state, NSString* name, NSError** error);

// -[SimDevice postDarwinNotification:error:]
BOOL PostDarwinNotification(id device, NSString* name, NSError** error);

// -[SimDevice spawnWithPath:options:terminationQueue:terminationHandler:error:]. Returns the
// spawned pid; `terminationHandler` runs on `terminationQueue` once with the exit status.
int Spawn(id device, NSString* path, NSDictionary* options, dispatch_queue_t terminationQueue,
          void (^terminationHandler)(int), NSError** error);

// -[SimDevice addMedia:error:] — takes an array of file URLs (photos/videos), auto-detected by
// type; this is what `simctl addmedia`'s multi-path form calls into.
BOOL AddMedia(id device, NSArray<NSURL*>* fileURLs, NSError** error);

// -[SimDevice addPhoto:error:] / -[SimDevice addVideo:error:] — single-file convenience variants
// alongside AddMedia, for a caller that already knows which kind it's adding.
BOOL AddPhoto(id device, NSURL* fileURL, NSError** error);
BOOL AddVideo(id device, NSURL* fileURL, NSError** error);

}  // namespace coresim
