#include "value_bridge.h"

#include <string>

namespace coresim {

namespace {

// A plain `.c_str()`/`UTF8String` round trip truncates at the first embedded NUL byte, since both
// treat the buffer as a null-terminated C string — but a JS string (and an NSString) can validly
// contain U+0000 mid-string. Converting via the actual byte length on both sides preserves it.
NSString* ToNSString(const std::string& utf8) {
  return [[NSString alloc] initWithBytes:utf8.data() length:utf8.size() encoding:NSUTF8StringEncoding];
}

std::string ToStdString(NSString* str) {
  return std::string(str.UTF8String, [str lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
}

}  // namespace

NSObject* JsValueToNSObject(Napi::Env env, Napi::Value value) {
  if (value.IsNull() || value.IsUndefined()) {
    return [NSNull null];
  }
  if (value.IsBoolean()) {
    return @(value.As<Napi::Boolean>().Value());
  }
  if (value.IsNumber()) {
    return @(value.As<Napi::Number>().DoubleValue());
  }
  if (value.IsString()) {
    return ToNSString(value.As<Napi::String>().Utf8Value());
  }
  if (value.IsBuffer()) {
    auto buffer = value.As<Napi::Buffer<uint8_t>>();
    return [NSData dataWithBytes:buffer.Data() length:buffer.Length()];
  }
  if (value.IsArray()) {
    auto array = value.As<Napi::Array>();
    NSMutableArray* result = [NSMutableArray arrayWithCapacity:array.Length()];
    for (uint32_t i = 0; i < array.Length(); i++) {
      [result addObject:JsValueToNSObject(env, array.Get(i))];
    }
    return result;
  }
  if (value.IsObject()) {
    auto object = value.As<Napi::Object>();
    Napi::Array keys = object.GetPropertyNames();
    NSMutableDictionary* result = [NSMutableDictionary dictionaryWithCapacity:keys.Length()];
    for (uint32_t i = 0; i < keys.Length(); i++) {
      Napi::Value key = keys.Get(i);
      Napi::Value propertyValue = object.Get(key);
      // Matches JSON.stringify's own undefined-property handling: an object option consumers built
      // conditionally (`{...(x && {x})}`-style) can easily end up with an explicit `undefined`
      // value instead of the key being absent — converting that to NSNull rather than dropping it
      // has crashed the whole process before (some CoreSimulator option dictionaries, e.g.
      // spawnWithPath:'s "environment", assume a present key is a real NSDictionary and don't
      // tolerate NSNull; see CLAUDE.md's note on exceptions raised outside SafeInvoke's guard).
      if (propertyValue.IsUndefined()) {
        continue;
      }
      NSString* nsKey = ToNSString(key.As<Napi::String>().Utf8Value());
      result[nsKey] = JsValueToNSObject(env, propertyValue);
    }
    return result;
  }
  return [NSNull null];
}

Napi::Value NSObjectToJsValue(Napi::Env env, id object) {
  if (object == nil || object == [NSNull null]) {
    return env.Null();
  }
  if ([object isKindOfClass:[NSString class]]) {
    return Napi::String::New(env, ToStdString((NSString*)object));
  }
  if ([object isKindOfClass:[NSNumber class]]) {
    NSNumber* number = (NSNumber*)object;
    if (strcmp(number.objCType, @encode(BOOL)) == 0 || strcmp(number.objCType, @encode(char)) == 0) {
      return Napi::Boolean::New(env, number.boolValue);
    }
    return Napi::Number::New(env, number.doubleValue);
  }
  if ([object isKindOfClass:[NSArray class]]) {
    NSArray* array = (NSArray*)object;
    Napi::Array result = Napi::Array::New(env, array.count);
    for (NSUInteger i = 0; i < array.count; i++) {
      result[static_cast<uint32_t>(i)] = NSObjectToJsValue(env, array[i]);
    }
    return result;
  }
  if ([object isKindOfClass:[NSDictionary class]]) {
    NSDictionary* dict = (NSDictionary*)object;
    Napi::Object result = Napi::Object::New(env);
    for (NSString* key in dict) {
      // Napi::Object::Set's named-property overloads forward to napi_set_named_property, which
      // (per the underlying N-API C function's own signature) only ever accepts a null-terminated
      // C string for the key — there's no byte-length variant, so an embedded-NUL key can't go
      // through that path no matter what we do here. Building the key as a proper Napi::String
      // first and setting it via the napi_value-keyed overload (napi_set_property) sidesteps that
      // limitation entirely.
      Napi::String jsKey = Napi::String::New(env, ToStdString(key));
      result.Set(jsKey, NSObjectToJsValue(env, dict[key]));
    }
    return result;
  }
  if ([object isKindOfClass:[NSURL class]]) {
    return Napi::String::New(env, ToStdString([(NSURL*)object absoluteString]));
  }
  if ([object isKindOfClass:[NSUUID class]]) {
    return Napi::String::New(env, ToStdString([(NSUUID*)object UUIDString]));
  }
  if ([object isKindOfClass:[NSData class]]) {
    NSData* data = (NSData*)object;
    return Napi::Buffer<uint8_t>::Copy(env, static_cast<const uint8_t*>(data.bytes), data.length);
  }
  return Napi::String::New(env, ToStdString([object description]));
}

}  // namespace coresim
