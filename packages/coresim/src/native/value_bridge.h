#pragma once

#import <Foundation/Foundation.h>

#include <napi.h>

namespace coresim {

// Converts a JS value (string/number/boolean/null/undefined/Array/plain Object/Buffer) into the
// corresponding Foundation object (NSString/NSNumber/NSNull/NSArray/NSDictionary/NSData).
// Used for option dictionaries (boot/install/uninstall options) and JSON payloads (push).
NSObject* JsValueToNSObject(Napi::Env env, Napi::Value value);

// Converts a Foundation object back into a JS value. Used for propertiesOfApplication/
// installedApps/getenv results. NSNull -> null; unrecognized types -> their -description string.
Napi::Value NSObjectToJsValue(Napi::Env env, id object);

}  // namespace coresim
