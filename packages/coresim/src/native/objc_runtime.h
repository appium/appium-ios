#pragma once

#import <Foundation/Foundation.h>

#include <stdexcept>
#include <string>

namespace coresim {

// Thrown when a class/selector CoreSimulator.framework is expected to have doesn't exist on the
// currently loaded framework, or when @try/@catch around objc_msgSend caught an NSException.
// Distinct from ObjCDispatchError (an NSError-carrying operational failure): this means "not
// supported on this simulator runtime", not "the call ran and failed".
class NativeSimUnavailableError : public std::runtime_error {
 public:
  NativeSimUnavailableError(std::string kind, std::string name, std::string detail);

  // "class" | "selector" | "exception"
  std::string kind;
  // The missing class/selector name, or the NSException name.
  std::string name;
  // CFBundleVersion of the loaded CoreSimulator.framework, or the NSException reason.
  std::string detail;
};

// The loaded CoreSimulator.framework's CFBundleVersion (e.g. "1171.6"), or "unknown" if the
// framework/its Info.plist can't be found. Cached after first call.
const std::string& CoreSimulatorFrameworkVersion();

// dlopen()s CoreSimulator.framework by absolute path (never statically linked) exactly once.
// Idempotent; safe to call before every class lookup. Throws NativeSimUnavailableError if the
// framework can't be loaded at all.
void EnsureCoreSimulatorLoaded();

// NSClassFromString(name), throwing NativeSimUnavailableError if the class doesn't exist.
Class RequireClass(const std::string& name);

// Throws NativeSimUnavailableError unless `target` (instance or Class) responds to `selectorName`.
void RequireSelector(id target, const std::string& selectorName);
void RequireClassSelector(Class cls, const std::string& selectorName);

// SEL for a selector name; selectors are process-global so this never fails.
SEL SelectorNamed(const std::string& name);

}  // namespace coresim
