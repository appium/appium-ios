#include "objc_runtime.h"

#import <dlfcn.h>
#import <objc/message.h>
#import <objc/runtime.h>

namespace coresim {

namespace {

constexpr auto kCoreSimulatorPath =
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/CoreSimulator";
constexpr auto kCoreSimulatorInfoPlist =
    "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/Info.plist";

}  // namespace

NativeSimUnavailableError::NativeSimUnavailableError(std::string kind, std::string name, std::string detail)
    : std::runtime_error("CoreSimulator " + kind + " unavailable: " + name + " (" + detail + ")"),
      kind(std::move(kind)),
      name(std::move(name)),
      detail(std::move(detail)) {}

const std::string& CoreSimulatorFrameworkVersion() {
  static const std::string version = [] {
    @autoreleasepool {
      NSDictionary* plist = [NSDictionary dictionaryWithContentsOfFile:@(kCoreSimulatorInfoPlist)];
      NSString* bundleVersion = plist[@"CFBundleVersion"];
      return bundleVersion ? std::string(bundleVersion.UTF8String) : std::string("unknown");
    }
  }();
  return version;
}

void EnsureCoreSimulatorLoaded() {
  static const bool loaded = [] {
    void* handle = dlopen(kCoreSimulatorPath, RTLD_NOW | RTLD_LOCAL);
    return handle != nullptr;
  }();
  if (!loaded) {
    throw NativeSimUnavailableError("framework", "CoreSimulator", dlerror() ?: "dlopen failed");
  }
}

Class RequireClass(const std::string& name) {
  EnsureCoreSimulatorLoaded();
  Class cls = NSClassFromString(@(name.c_str()));
  if (cls == nil) {
    throw NativeSimUnavailableError("class", name, CoreSimulatorFrameworkVersion());
  }
  return cls;
}

SEL SelectorNamed(const std::string& name) { return NSSelectorFromString(@(name.c_str())); }

void RequireSelector(id target, const std::string& selectorName) {
  if (target == nil) {
    // A nil deviceType/runtime/etc. is a legitimate CoreSimulator state (e.g. a device whose
    // runtime profile is no longer installed) — distinct from a genuinely missing selector, so
    // callers can tell the two apart instead of getting a misleading "selector unavailable".
    throw NativeSimUnavailableError("nil-target", selectorName, CoreSimulatorFrameworkVersion());
  }
  SEL selector = SelectorNamed(selectorName);
  if (![target respondsToSelector:selector]) {
    throw NativeSimUnavailableError("selector", selectorName, CoreSimulatorFrameworkVersion());
  }
}

void RequireClassSelector(Class cls, const std::string& selectorName) {
  SEL selector = SelectorNamed(selectorName);
  if (![cls respondsToSelector:selector]) {
    throw NativeSimUnavailableError("selector", selectorName, CoreSimulatorFrameworkVersion());
  }
}

}  // namespace coresim
