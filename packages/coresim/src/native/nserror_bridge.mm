#include "nserror_bridge.h"

#include "screenshot_errors.h"

namespace coresim {

std::string DescribeNSError(NSError* error) {
  constexpr NSUInteger kMaxErrorDepth = 10;
  NSMutableArray<NSString*>* parts = [NSMutableArray array];
  NSError* current = error;
  for (NSUInteger depth = 0; current != nil && depth < kMaxErrorDepth; ++depth) {
    for (NSString* text in @[ current.localizedDescription ?: @"", current.localizedFailureReason ?: @"" ]) {
      NSString* trimmed = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      NSUInteger known = [parts indexOfObjectPassingTest:^BOOL(NSString* part, NSUInteger, BOOL*) {
        return [part containsString:trimmed];
      }];
      if (trimmed.length == 0 || known != NSNotFound) {
        continue;
      }
      NSIndexSet* covered = [parts indexesOfObjectsPassingTest:^BOOL(NSString* part, NSUInteger, BOOL*) {
        return [trimmed containsString:part];
      }];
      [parts removeObjectsAtIndexes:covered];
      [parts addObject:trimmed];
    }
    id underlying = current.userInfo[NSUnderlyingErrorKey];
    current = [underlying isKindOfClass:NSError.class] ? underlying : nil;
  }
  NSMutableArray<NSString*>* sentences = [NSMutableArray arrayWithCapacity:parts.count];
  for (NSString* part in parts) {
    BOOL terminated = [part hasSuffix:@"."] || [part hasSuffix:@"!"] || [part hasSuffix:@"?"];
    [sentences addObject:terminated ? part : [part stringByAppendingString:@"."]];
  }
  return sentences.count > 0 ? [sentences componentsJoinedByString:@" "].UTF8String : "Operation failed";
}

Napi::Error NSErrorExceptionToJsError(Napi::Env env, const NSErrorException& error) {
  Napi::Error jsError = Napi::Error::New(env, error.what());
  const bool isDisplayResolutionError =
      error.domain == kScreenshotErrorDomain &&
      (error.code == kScreenshotDisplayNotFound || error.code == kScreenshotNoRenderableDisplay);
  jsError.Set("name", isDisplayResolutionError ? "NativeSimDisplayResolutionError" : "NativeSimOperationError");
  jsError.Set("domain", error.domain);
  jsError.Set("code", static_cast<double>(error.code));
  return jsError;
}

Napi::Error UnavailableToJsError(Napi::Env env, const NativeSimUnavailableError& error) {
  Napi::Error jsError = Napi::Error::New(env, error.what());
  jsError.Set("name", "NativeSimUnavailableError");
  jsError.Set("kind", error.kind);
  jsError.Set("missing", error.name);
  jsError.Set("frameworkVersion", error.detail);
  return jsError;
}

Napi::Error ObjCExceptionToJsError(Napi::Env env, const ObjCException& error) {
  Napi::Error jsError = Napi::Error::New(env, error.what());
  jsError.Set("name", "NativeSimDispatchError");
  jsError.Set("exceptionName", error.name);
  jsError.Set("reason", error.reason);
  return jsError;
}

}  // namespace coresim
