#include "sim_device.h"

#import <mach/mach.h>
#import <objc/message.h>

#include <cstring>

#include "objc_runtime.h"
#include "safe_dispatch.h"

namespace coresim {

namespace {

NSString* const kOrientationErrorDomain = @"io.appium.coresim.Orientation";

NSError* MakeOrientationError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kOrientationErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

// Shared shapes reused across the many identical-signature getters/setters below.
id IdGetter(id target, const std::string& selectorName) {
  RequireSelector(target, selectorName);
  SEL selector = SelectorNamed(selectorName);
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL);
    return ((Fn)objc_msgSend)(target, selector);
  });
}

BOOL BoolWithError(id target, const std::string& selectorName, NSError** error) {
  RequireSelector(target, selectorName);
  SEL selector = SelectorNamed(selectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSError**);
    return ((Fn)objc_msgSend)(target, selector, error);
  });
}

BOOL BoolGetter(id target, const std::string& selectorName) {
  RequireSelector(target, selectorName);
  SEL selector = SelectorNamed(selectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL);
    return ((Fn)objc_msgSend)(target, selector);
  });
}

unsigned int UIntGetter(id target, const std::string& selectorName) {
  RequireSelector(target, selectorName);
  SEL selector = SelectorNamed(selectorName);
  return SafeInvoke([&] {
    using Fn = unsigned int (*)(id, SEL);
    return ((Fn)objc_msgSend)(target, selector);
  });
}

}  // namespace

NSUUID* DeviceUDID(id device) { return IdGetter(device, "UDID"); }
NSString* DeviceName(id device) { return IdGetter(device, "name"); }
id DeviceDeviceType(id device) { return IdGetter(device, "deviceType"); }
id DeviceRuntime(id device) { return IdGetter(device, "runtime"); }
NSString* DeviceDataPath(id device) { return IdGetter(device, "dataPath"); }
NSDate* DeviceLastBootedAt(id device) { return IdGetter(device, "lastBootedAt"); }

unsigned long long DeviceState(id device) {
  static const std::string kSelectorName = "state";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = unsigned long long (*)(id, SEL);
    return ((Fn)objc_msgSend)(device, selector);
  });
}

BOOL Boot(id device, NSDictionary* options, NSError** error) {
  static const std::string kSelectorName = "bootWithOptions:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSDictionary*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, options, error);
  });
}

void BootAsync(id device, NSDictionary* options, dispatch_queue_t queue, void (^handler)(NSError*)) {
  static const std::string kSelectorName = "bootAsyncWithOptions:completionQueue:completionHandler:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  SafeInvoke([&] {
    using Fn = void (*)(id, SEL, NSDictionary*, dispatch_queue_t, void (^)(NSError*));
    ((Fn)objc_msgSend)(device, selector, options, queue, handler);
    return true;
  });
}

id DeviceBootStatus(id device) { return IdGetter(device, "bootStatus"); }

unsigned int BootInfoStatus(id bootInfo) { return UIntGetter(bootInfo, "status"); }

BOOL BootInfoIsTerminal(id bootInfo) { return BoolGetter(bootInfo, "isTerminalStatus"); }

BOOL Shutdown(id device, NSError** error) { return BoolWithError(device, "shutdownWithError:", error); }

BOOL Erase(id device, NSError** error) { return BoolWithError(device, "eraseContentsAndSettingsWithError:", error); }

BOOL Rename(id device, NSString* name, NSError** error) {
  static const std::string kSelectorName = "rename:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, name, error);
  });
}

NSString* Getenv(id device, NSString* name, NSError** error) {
  static const std::string kSelectorName = "getenv:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSString* (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, name, error);
  });
}

unsigned int LookupMachPort(id device, NSString* serviceName, NSError** error) {
  static const std::string kSelectorName = "lookup:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = unsigned int (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, serviceName, error);
  });
}

BOOL SetDeviceOrientation(id device, int32_t orientation, NSError** error) {
  NSError* lookupError = nil;
  unsigned int purplePort = LookupMachPort(device, @"PurpleWorkspacePort", &lookupError);
  // The port is the authoritative success signal, not the error (see LookupMachPort's own callers,
  // e.g. sim_pasteboard.mm).
  if (purplePort == 0) {
    *error = lookupError ?: MakeOrientationError(1, @"PurpleWorkspacePort is not available — is the device booted?");
    return NO;
  }

  // GSEvent wire format, undocumented (see CLAUDE.md): mach_msg_header_t + a fixed-layout event
  // record, in a 112-byte buffer (8-byte aligned, >= the 108-byte message mach_msg sends).
  constexpr uint32_t kGSEventTypeDeviceOrientationChanged = 50;
  constexpr uint32_t kGSEventHostFlag = 0x20000;
  constexpr mach_msg_id_t kGSEventMachMessageID = 0x7B;
  constexpr mach_msg_timeout_t kSendTimeoutMs = 2000;

  uint8_t buffer[112] = {0};
  auto* header = reinterpret_cast<mach_msg_header_t*>(buffer);
  header->msgh_bits = 0x13;  // MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0)
  header->msgh_size = 108;   // align4(4 + 0x6B) — matches Simulator.app's own sendPurpleEvent:
  header->msgh_remote_port = purplePort;
  header->msgh_local_port = MACH_PORT_NULL;
  header->msgh_id = kGSEventMachMessageID;

  uint32_t type = kGSEventTypeDeviceOrientationChanged | kGSEventHostFlag;
  std::memcpy(buffer + 0x18, &type, sizeof(type));
  uint32_t recordInfoSize = 4;
  std::memcpy(buffer + 0x48, &recordInfoSize, sizeof(recordInfoSize));
  uint32_t orientationValue = static_cast<uint32_t>(orientation);
  std::memcpy(buffer + 0x4C, &orientationValue, sizeof(orientationValue));

  kern_return_t kr = mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, header->msgh_size, 0, MACH_PORT_NULL,
                              kSendTimeoutMs, MACH_PORT_NULL);
  if (kr != KERN_SUCCESS) {
    *error = MakeOrientationError(
        2, [NSString stringWithFormat:@"Failed to send the orientation change (kern_return_t %d): %s", kr,
                                      mach_error_string(kr)]);
    return NO;
  }
  return YES;
}

BOOL InstallApp(id device, NSURL* appURL, NSDictionary* options, NSError** error) {
  static const std::string kSelectorName = "installApplication:withOptions:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSURL*, NSDictionary*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, appURL, options, error);
  });
}

BOOL UninstallApp(id device, NSString* bundleID, NSDictionary* options, NSError** error) {
  static const std::string kSelectorName = "uninstallApplication:withOptions:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSString*, NSDictionary*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, bundleID, options, error);
  });
}

int LaunchApp(id device, NSString* bundleID, NSDictionary* options, NSError** error) {
  static const std::string kSelectorName = "launchApplicationWithID:options:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = int (*)(id, SEL, NSString*, NSDictionary*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, bundleID, options, error);
  });
}

BOOL TerminateApp(id device, NSString* bundleID, NSError** error) {
  static const std::string kSelectorName = "terminateApplicationWithID:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, bundleID, error);
  });
}

NSDictionary* PropertiesOfApplication(id device, NSString* bundleID, NSError** error) {
  static const std::string kSelectorName = "propertiesOfApplication:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSDictionary* (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, bundleID, error);
  });
}

NSDictionary* InstalledApps(id device, NSError** error) {
  static const std::string kSelectorName = "installedAppsWithError:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSDictionary* (*)(id, SEL, NSError**);
    return ((Fn)objc_msgSend)(device, selector, error);
  });
}

BOOL OpenURL(id device, NSURL* url, NSError** error) {
  static const std::string kSelectorName = "openURL:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSURL*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, url, error);
  });
}

BOOL SetLocation(id device, double latitude, double longitude, NSError** error) {
  static const std::string kSelectorName = "setLocationWithLatitude:andLongitude:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, double, double, NSError**);
    return ((Fn)objc_msgSend)(device, selector, latitude, longitude, error);
  });
}

BOOL ClearLocation(id device, NSError** error) {
  return BoolWithError(device, "clearSimulatedLocationWithError:", error);
}

BOOL SendPushNotification(id device, NSString* bundleID, NSDictionary* payload, NSError** error) {
  static const std::string kSelectorName = "sendPushNotificationForBundleID:jsonPayload:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSString*, NSDictionary*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, bundleID, payload, error);
  });
}

BOOL AddCertificate(id device, NSURL* certURL, BOOL trustAsRoot, NSError** error) {
  static const std::string kSelectorName = "addCertificateAtURL:trustAsRoot:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSURL*, BOOL, NSError**);
    return ((Fn)objc_msgSend)(device, selector, certURL, trustAsRoot, error);
  });
}

BOOL ResetKeychain(id device, NSError** error) { return BoolWithError(device, "resetKeychainWithError:", error); }

long long CurrentUIInterfaceStyle(id device) {
  static const std::string kSelectorName = "currentUIInterfaceStyle";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = long long (*)(id, SEL);
    return ((Fn)objc_msgSend)(device, selector);
  });
}

BOOL SetUIInterfaceStyle(id device, long long style, NSError** error) {
  static const std::string kSelectorName = "setUIInterfaceStyle:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, long long, NSError**);
    return ((Fn)objc_msgSend)(device, selector, style, error);
  });
}

long long CurrentIncreaseContrastMode(id device) {
  static const std::string kSelectorName = "currentIncreaseContrastMode";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = long long (*)(id, SEL);
    return ((Fn)objc_msgSend)(device, selector);
  });
}

BOOL SetIncreaseContrastEnabled(id device, BOOL enabled, NSError** error) {
  static const std::string kSelectorName = "setIncreaseContrastEnabled:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, BOOL, NSError**);
    return ((Fn)objc_msgSend)(device, selector, enabled, error);
  });
}

long long CurrentContentSizeCategory(id device) {
  static const std::string kSelectorName = "currentContentSizeCategory";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = long long (*)(id, SEL);
    return ((Fn)objc_msgSend)(device, selector);
  });
}

BOOL SetContentSizeCategory(id device, long long category, NSError** error) {
  static const std::string kSelectorName = "setContentSizeCategory:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, long long, NSError**);
    return ((Fn)objc_msgSend)(device, selector, category, error);
  });
}

BOOL DarwinNotificationGetState(id device, unsigned long long* outState, NSString* name, NSError** error) {
  static const std::string kSelectorName = "darwinNotificationGetState:name:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, unsigned long long*, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, outState, name, error);
  });
}

BOOL DarwinNotificationSetState(id device, unsigned long long state, NSString* name, NSError** error) {
  static const std::string kSelectorName = "darwinNotificationSetState:name:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, unsigned long long, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, state, name, error);
  });
}

BOOL PostDarwinNotification(id device, NSString* name, NSError** error) {
  static const std::string kSelectorName = "postDarwinNotification:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, name, error);
  });
}

int Spawn(id device, NSString* path, NSDictionary* options, dispatch_queue_t terminationQueue,
          void (^terminationHandler)(int), NSError** error) {
  static const std::string kSelectorName = "spawnWithPath:options:terminationQueue:terminationHandler:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = int (*)(id, SEL, NSString*, NSDictionary*, dispatch_queue_t, void (^)(int), NSError**);
    return ((Fn)objc_msgSend)(device, selector, path, options, terminationQueue, terminationHandler, error);
  });
}

BOOL AddMedia(id device, NSArray<NSURL*>* fileURLs, NSError** error) {
  static const std::string kSelectorName = "addMedia:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSArray<NSURL*>*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, fileURLs, error);
  });
}

BOOL AddPhoto(id device, NSURL* fileURL, NSError** error) {
  static const std::string kSelectorName = "addPhoto:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSURL*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, fileURL, error);
  });
}

BOOL AddVideo(id device, NSURL* fileURL, NSError** error) {
  static const std::string kSelectorName = "addVideo:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSURL*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, fileURL, error);
  });
}

}  // namespace coresim
