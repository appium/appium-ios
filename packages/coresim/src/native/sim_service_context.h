#pragma once

#import <Foundation/Foundation.h>

namespace coresim {

// +[SimServiceContext sharedServiceContextForDeveloperDir:error:]. Returns nil (with *error set)
// on failure. `developerDir` is the "which Xcode" selector — the actual physical CoreSimulator
// binary loaded is always the one shared system-wide copy; this only picks which runtimes/device
// types/behaviors that shared framework resolves against.
id SharedServiceContext(NSString* developerDir, NSError** error);

// -[SimServiceContext defaultDeviceSetWithError:]
id DefaultDeviceSet(id serviceContext, NSError** error);

// -[SimServiceContext deviceSetWithPath:error:] — the same selector `simctl --set <path>` uses to
// address a non-default device set.
id DeviceSetWithPath(id serviceContext, NSString* path, NSError** error);

// -[SimServiceContext supportedDeviceTypes] -> NSArray<SimDeviceType*>
NSArray* SupportedDeviceTypes(id serviceContext);

// -[SimServiceContext supportedRuntimes] -> NSArray<SimRuntime*>
NSArray* SupportedRuntimes(id serviceContext);

// -[SimServiceContext supportedDeviceTypesByIdentifier] -> NSDictionary<NSString*, SimDeviceType*>
NSDictionary* SupportedDeviceTypesByIdentifier(id serviceContext);

// -[SimServiceContext supportedRuntimesByIdentifier] -> NSDictionary<NSString*, SimRuntime*>
NSDictionary* SupportedRuntimesByIdentifier(id serviceContext);

// -[SimDeviceType identifier] / -[SimDeviceType name]
NSString* DeviceTypeIdentifier(id deviceType);
NSString* DeviceTypeName(id deviceType);

// -[SimRuntime identifier] / -[SimRuntime name] / -[SimRuntime versionString]
NSString* RuntimeIdentifier(id runtime);
NSString* RuntimeName(id runtime);
NSString* RuntimeVersionString(id runtime);

// -[SimRuntime root] -> the runtime bundle's `RuntimeRoot` directory, same as a spawned process's
// own `$SIMULATOR_ROOT`. Used to resolve guest-OS-specific executables (e.g. `launchctl` — see
// CLAUDE.md) before spawning them, since SimDevice's spawn API takes a literal path, no PATH search.
NSString* RuntimeRootPath(id runtime);

}  // namespace coresim
