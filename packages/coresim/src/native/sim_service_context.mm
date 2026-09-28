#include "sim_service_context.h"

#import <objc/message.h>

#include "objc_runtime.h"
#include "safe_dispatch.h"

namespace coresim {

id SharedServiceContext(NSString* developerDir, NSError** error) {
  Class cls = RequireClass("SimServiceContext");
  static const std::string kSelectorName = "sharedServiceContextForDeveloperDir:error:";
  RequireClassSelector(cls, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = id (*)(Class, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(cls, selector, developerDir, error);
  });
}

id DefaultDeviceSet(id serviceContext, NSError** error) {
  static const std::string kSelectorName = "defaultDeviceSetWithError:";
  RequireSelector(serviceContext, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL, NSError**);
    return ((Fn)objc_msgSend)(serviceContext, selector, error);
  });
}

id DeviceSetWithPath(id serviceContext, NSString* path, NSError** error) {
  static const std::string kSelectorName = "deviceSetWithPath:error:";
  RequireSelector(serviceContext, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(serviceContext, selector, path, error);
  });
}

NSArray* SupportedDeviceTypes(id serviceContext) {
  static const std::string kSelectorName = "supportedDeviceTypes";
  RequireSelector(serviceContext, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSArray* (*)(id, SEL);
    return ((Fn)objc_msgSend)(serviceContext, selector);
  });
}

NSArray* SupportedRuntimes(id serviceContext) {
  static const std::string kSelectorName = "supportedRuntimes";
  RequireSelector(serviceContext, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSArray* (*)(id, SEL);
    return ((Fn)objc_msgSend)(serviceContext, selector);
  });
}

namespace {

// Shared shape for every zero-arg id-returning getter used below (identifier/name/versionString).
NSString* StringGetter(id target, const std::string& selectorName) {
  RequireSelector(target, selectorName);
  SEL selector = SelectorNamed(selectorName);
  return SafeInvoke([&] {
    using Fn = NSString* (*)(id, SEL);
    return ((Fn)objc_msgSend)(target, selector);
  });
}

}  // namespace

NSDictionary* SupportedDeviceTypesByIdentifier(id serviceContext) {
  static const std::string kSelectorName = "supportedDeviceTypesByIdentifier";
  RequireSelector(serviceContext, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSDictionary* (*)(id, SEL);
    return ((Fn)objc_msgSend)(serviceContext, selector);
  });
}

NSDictionary* SupportedRuntimesByIdentifier(id serviceContext) {
  static const std::string kSelectorName = "supportedRuntimesByIdentifier";
  RequireSelector(serviceContext, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = NSDictionary* (*)(id, SEL);
    return ((Fn)objc_msgSend)(serviceContext, selector);
  });
}

NSString* DeviceTypeIdentifier(id deviceType) { return StringGetter(deviceType, "identifier"); }
NSString* DeviceTypeName(id deviceType) { return StringGetter(deviceType, "name"); }
NSString* RuntimeIdentifier(id runtime) { return StringGetter(runtime, "identifier"); }
NSString* RuntimeName(id runtime) { return StringGetter(runtime, "name"); }
NSString* RuntimeVersionString(id runtime) { return StringGetter(runtime, "versionString"); }
NSString* RuntimeRootPath(id runtime) { return StringGetter(runtime, "root"); }

}  // namespace coresim
