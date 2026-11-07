#include "sim_duo.h"
#import <dlfcn.h>
#include "nserror_bridge.h"
#include "objc_runtime.h"
#include "sim_device.h"
#include "sim_hid.h"
#include "sim_service_context.h"
namespace coresim {
namespace {
NSError* HIDError(NSString* message) {
  return [NSError errorWithDomain:@"io.appium.coresim.Duo" code:1 userInfo:@{NSLocalizedDescriptionKey : message}];
}
void SendVendorControl(id device, NSString* source, NSString* type, id value) {
  if (!IsDuoDevice(device)) {
    throw NativeSimUnavailableError("deviceType", "iPhone-Duo", "This control requires an iPhone Duo simulator");
  }
  // IOCF binary serialization (option 1), not a binary property list. Preserve
  // the payload verified by the former WDA implementation on Duo / iOS 27.1.
  static void* iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY | RTLD_GLOBAL);
  if (!iokit) throw NativeSimUnavailableError("framework", "IOKit", "Cannot load IOKit");
  auto serialize = reinterpret_cast<CFDataRef (*)(CFTypeRef, CFOptionFlags)>(dlsym(iokit, "IOCFSerialize"));
  if (!serialize) throw NativeSimUnavailableError("symbol", "IOCFSerialize", "Cannot serialize Duo HID control");
  NSDictionary* control = @{
    @"provider" : @"com.apple.Virtualization.VirtualMachines",
    @"source" : source,
    @"type" : type,
    @"value" : value
  };
  CFDataRef data = serialize((__bridge CFTypeRef)control, 1);
  if (!data) throw NSErrorException(HIDError(@"Cannot serialize simulator HID control"));
  SendVendorHIDEvent(device, 0xff61, 0x5b, 0, CFBridgingRelease(data));
}
}  // namespace

bool IsDuoDevice(id device) {
  id type = DeviceDeviceType(device);
  return type != nil &&
         [DeviceTypeIdentifier(type) isEqualToString:@"com.apple.CoreSimulator.SimDeviceType.iPhone-Duo"];
}
void SetSimulatedHingeAngle(id device, double angle) {
  SendVendorControl(device, @"hinge-slider-control", @"range", @(angle));
}
void SetHIDOrientation(id device, int32_t orientation, bool isMainDisplay) {
  NSString* value;
  switch (orientation) {
    case 1:
      value = isMainDisplay ? @"portrait" : @"landscape-left";
      break;
    case 2:
      value = isMainDisplay ? @"pud" : @"landscape-right";
      break;
    // CoreSimulator DeviceOrientation uses UIInterfaceOrientation numbering:
    // landscape-right is 3, landscape-left is 4 (the reverse of UIDeviceOrientation).
    case 3:
      value = isMainDisplay ? @"landscape-right" : @"portrait";
      break;
    case 4:
      value = isMainDisplay ? @"landscape-left" : @"pud";
      break;
    default:
      throw NSErrorException(HIDError(@"Unsupported interface orientation"));
  }
  SendVendorControl(device, @"orientation-picker-control", @"enum", value);
}
}  // namespace coresim
