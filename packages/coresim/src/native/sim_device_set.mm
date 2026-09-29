#include "sim_device_set.h"

#import <objc/message.h>

#include "objc_runtime.h"
#include "safe_dispatch.h"

namespace coresim {

NSArray* Devices(id deviceSet) {
  static const std::string kSelectorName = "devices";
  RequireSelector(deviceSet, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSArray* (*)(id, SEL);
    return ((Fn)objc_msgSend)(deviceSet, selector);
  });
}

id CreateDevice(id deviceSet, id deviceType, id runtime, NSString* name, NSError** error) {
  static const std::string kSelectorName = "createDeviceWithType:runtime:name:error:";
  RequireSelector(deviceSet, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL, id, id, NSString*, NSError**);
    return ((Fn)objc_msgSend)(deviceSet, selector, deviceType, runtime, name, error);
  });
}

BOOL DeleteDevice(id deviceSet, id device, NSError** error) {
  static const std::string kSelectorName = "deleteDevice:error:";
  RequireSelector(deviceSet, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, id, NSError**);
    return ((Fn)objc_msgSend)(deviceSet, selector, device, error);
  });
}

}  // namespace coresim
