#pragma once

#import <Foundation/Foundation.h>

#include <stdexcept>
#include <string>
#include <utility>

namespace coresim {

// Thrown when @try/@catch around an objc_msgSend call caught an NSException (e.g.
// -doesNotRecognizeSelector:, an internal framework assertion, an argument-type mismatch).
// Distinct from NativeSimUnavailableError: the class/selector existed and responded, but the
// call itself raised.
class ObjCException : public std::runtime_error {
 public:
  ObjCException(std::string name, std::string reason)
      : std::runtime_error(name + ": " + reason), name(std::move(name)), reason(std::move(reason)) {}

  std::string name;
  std::string reason;
};

// Runs `fn` inside @try/@catch, converting any caught NSException into a C++ ObjCException.
// Every objc_msgSend call in this addon must be wrapped in SafeInvoke — no exceptions
// (pun intended) — so an uncaught NSException never reaches the caller and kills the process.
template <typename Fn>
auto SafeInvoke(Fn&& fn) -> decltype(fn()) {
  @try {
    return fn();
  } @catch (NSException* exception) {
    std::string name = exception.name ? exception.name.UTF8String : "NSException";
    std::string reason = exception.reason ? exception.reason.UTF8String : "";
    throw ObjCException(std::move(name), std::move(reason));
  }
}

}  // namespace coresim
