/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIDevice+FBHinge.h"

#import <dlfcn.h>
#import <math.h>
#import <mach/mach_time.h>

#import "FBErrorBuilder.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
static const NSTimeInterval FBHingeAngleReadingTimeout = 5.0;
// iOS 27.2 stops the first move of a hinge gesture ~5% short. A following event with
// a slightly different value lands exactly, so we verify and correct after settling.
static const NSTimeInterval FBHingeSettleDelay = 0.4;
static const NSTimeInterval FBHingeSettlePollInterval = 0.15;
static const NSTimeInterval FBHingeSettleTimeout = 2.0;
static const double FBHingeSettledEpsilon = 0.01;
static const double FBHingeAngleTolerance = 0.05;
static const double FBHingeCorrectionNudge = 0.001;
static const NSUInteger FBHingeMaxCorrections = 2;
static const double FBHingeClosedAngle = 0.0;
static const double FBHingeOpenAngle = 180.0;

static BOOL FBHingeAnglesEqual(double first, double second)
{
  return fabs(first - second) < FBHingeAngleTolerance;
}

typedef CFDataRef (*FBIOCFSerialize)(CFTypeRef object, CFOptionFlags options);
typedef CFTypeRef (*FBIOHIDEventCreateVendorDefinedEvent)(CFAllocatorRef allocator,
                                                       uint64_t timestamp,
                                                       uint32_t usagePage,
                                                       uint32_t usage,
                                                       uint32_t version,
                                                       uint8_t *data,
                                                       CFIndex length,
                                                       uint32_t options);
typedef CFTypeRef (*FBIOHIDEventSystemClientCreate)(CFAllocatorRef allocator);
typedef void (*FBIOHIDEventSystemClientDispatchEvent)(CFTypeRef client, CFTypeRef event);

@protocol FBAngle <NSObject>
- (BOOL)isAngleValid;
- (float)angleDegrees;
@end

@protocol FBAngleManager <NSObject>
+ (instancetype)new;
+ (BOOL)isAvailable;
+ (BOOL)instancesRespondToSelector:(SEL)selector;
- (void)startAngleUpdatesToQueue:(NSOperationQueue *)queue handler:(void (^)(id<FBAngle>))handler;
- (void)stopAngleUpdates;
@end

static Class<FBAngleManager> FBAngleManagerClass(void)
{
  static Class<FBAngleManager> angleManagerClass;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    // This path also loads on physical devices (verified on an iPad mini).
    // Framework/class presence does not imply that a hinge sensor is available.
    if (NULL != dlopen("/System/Library/Frameworks/CoreMotion.framework/CoreMotion", RTLD_LAZY)) {
      angleManagerClass = NSClassFromString(@"CMAngleManager");
    }
  });
  return angleManagerClass;
}

static BOOL FBHasAvailableHinge(void)
{
  Class<FBAngleManager> managerClass = FBAngleManagerClass();
  return [managerClass respondsToSelector:@selector(isAvailable)] && [managerClass isAvailable];
}

typedef struct {
  FBIOCFSerialize serialize;
  FBIOHIDEventCreateVendorDefinedEvent createEvent;
  FBIOHIDEventSystemClientCreate createClient;
  FBIOHIDEventSystemClientDispatchEvent dispatchEvent;
} FBHingeInjectionAPI;

// Loads and caches the injection APIs; NULL means at least one is unavailable.
// Resolving these functions does not dispatch an event or confirm its acceptance.
static const FBHingeInjectionAPI *FBHingeInjectionFunctions(void)
{
  static FBHingeInjectionAPI api;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    void *handle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
    if (NULL != handle) {
      api.serialize = (FBIOCFSerialize)dlsym(handle, "IOCFSerialize");
      api.createEvent = (FBIOHIDEventCreateVendorDefinedEvent)dlsym(handle, "IOHIDEventCreateVendorDefinedEvent");
      api.createClient = (FBIOHIDEventSystemClientCreate)dlsym(handle, "IOHIDEventSystemClientCreate");
      api.dispatchEvent = (FBIOHIDEventSystemClientDispatchEvent)dlsym(handle, "IOHIDEventSystemClientDispatchEvent");
    }
  });
  return NULL != api.serialize && NULL != api.createEvent
    && NULL != api.createClient && NULL != api.dispatchEvent ? &api : NULL;
}
#endif

@implementation XCUIDevice (FBHinge)

- (BOOL)fb_supportsHingeAngleReading
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  Class<FBAngleManager> managerClass = FBAngleManagerClass();
  return FBHasAvailableHinge()
    && [managerClass instancesRespondToSelector:@selector(startAngleUpdatesToQueue:handler:)]
    && [managerClass instancesRespondToSelector:@selector(stopAngleUpdates)];
#else
  return NO;
#endif
}

- (BOOL)fb_canAttemptSimulatedHingeAngleInjection
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  // Sensor presence and local APIs permit an attempt, not proof that the
  // device's receiver accepts the vendor event. Physical devices are unverified.
  return FBHasAvailableHinge() && NULL != FBHingeInjectionFunctions();
#else
  return NO;
#endif
}

- (nullable NSNumber *)fb_getSimulatedHingeAngle:(NSError **)error
{
  if (!self.fb_supportsHingeAngleReading) {
    [[FBErrorBuilder.builder withDescription:@"Hinge angle reading is unavailable on this device"] buildError:error];
    return nil;
  }
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  return [self fb_hingeAngleWithTimeout:FBHingeAngleReadingTimeout error:error];
#else
  return nil;
#endif
}

#if !TARGET_OS_TV && !TARGET_OS_WATCH

- (nullable NSNumber *)fb_hingeAngleWithTimeout:(NSTimeInterval)timeout error:(NSError **)error
{
  id<FBAngleManager> manager = [FBAngleManagerClass() new];
  NSOperationQueue *queue = [NSOperationQueue new];
  queue.maxConcurrentOperationCount = 1;
  NSCondition *condition = [NSCondition new];
  __block NSNumber *reading = nil;
  NSNumber *result;
  @try {
    [manager startAngleUpdatesToQueue:queue handler:^(id<FBAngle> angle) {
      if (![angle respondsToSelector:@selector(isAngleValid)]
          || ![angle respondsToSelector:@selector(angleDegrees)] || !angle.isAngleValid) {
        return;
      }
      float degrees = angle.angleDegrees;
      if (!isfinite(degrees)) {
        return;
      }
      [condition lock];
      if (nil == reading) {
        reading = @(degrees);
        [condition signal];
      }
      [condition unlock];
    }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
    [condition lock];
    while (nil == reading) {
      if (![condition waitUntilDate:deadline]) {
        break;
      }
    }
    result = reading;
    [condition unlock];
  } @finally {
    [manager stopAngleUpdates];
  }
  if (nil == result) {
    [[FBErrorBuilder.builder withDescriptionFormat:@"Timed out after %g seconds waiting for a valid hinge angle",
      timeout] buildError:error];
  }
  return result;
}

#endif

- (BOOL)fb_setSimulatedHingeAngle:(double)angle error:(NSError **)error
{
  if (!isfinite(angle) || angle < 0 || angle > 180) {
    return [[FBErrorBuilder.builder withDescription:@"Hinge angle must be a finite number between 0 and 180 degrees"] buildError:error];
  }
  if (!self.fb_canAttemptSimulatedHingeAngleInjection) {
    return [[FBErrorBuilder.builder withDescription:@"Hinge angle injection requires an available hinge and the IOKit HID APIs"] buildError:error];
  }
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  if (![self.class fb_dispatchHingeAngle:angle error:error]) {
    return NO;
  }
  if (self.fb_supportsHingeAngleReading) {
    [self fb_correctHingeAngleToward:angle];
  }
  return YES;
#else
  return NO;
#endif
}

#if !TARGET_OS_TV && !TARGET_OS_WATCH

+ (BOOL)fb_dispatchHingeAngle:(double)angle error:(NSError **)error
{
  // WDA's fb_performIOHIDEventWithPage:usage:duration:error: uses XCDeviceEvent
  // with page, usage, and duration only. The XCDeviceEvent interfaces checked
  // in Xcode 27.1 provide no way to attach the vendor payload containing the
  // hinge angle, so this command creates and dispatches an IOKit event directly.
  const FBHingeInjectionAPI *api = FBHingeInjectionFunctions();
  // Matches Device Hub's hinge-slider-control payload (Xcode 27.1). It is an
  // IOCF binary serialization, not an NSPropertyListSerialization binary plist.
  NSDictionary *payload = @{
    @"provider": @"com.apple.Virtualization.VirtualMachines",
    @"source": @"hinge-slider-control",
    @"type": @"range",
    @"value": @(angle),
  };
  CFDataRef data = api->serialize((__bridge CFTypeRef)payload, 1);
  if (NULL == data) {
    return [[FBErrorBuilder.builder withDescription:@"Cannot serialize the simulated hinge event"] buildError:error];
  }
  CFTypeRef event = api->createEvent(kCFAllocatorDefault, mach_absolute_time(), 0xff61, 0x5b, 0,
                                    (uint8_t *)CFDataGetBytePtr(data), CFDataGetLength(data), 0);
  CFRelease(data);
  CFTypeRef client = api->createClient(kCFAllocatorDefault);
  BOOL canDispatch = NULL != event && NULL != client;
  if (canDispatch) {
    api->dispatchEvent(client, event);
  }
  if (NULL != event) {
    CFRelease(event);
  }
  if (NULL != client) {
    CFRelease(client);
  }
  return canDispatch || [[FBErrorBuilder.builder withDescription:@"Cannot create the simulated hinge HID event or client"] buildError:error];
}

// Waits until two consecutive readings agree; nil if the angle never settles in time.
- (nullable NSNumber *)fb_settledHingeAngle
{
  [NSThread sleepForTimeInterval:FBHingeSettleDelay];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:FBHingeSettleTimeout];
  NSNumber *previous = nil;
  NSTimeInterval remaining;
  while ((remaining = [deadline timeIntervalSinceNow]) > 0) {
    NSNumber *current = [self fb_hingeAngleWithTimeout:MIN(remaining, FBHingeAngleReadingTimeout) error:nil];
    if (nil == current) {
      return nil;
    }
    if (nil != previous && fabs(current.doubleValue - previous.doubleValue) < FBHingeSettledEpsilon) {
      return current;
    }
    previous = current;
    [NSThread sleepForTimeInterval:FBHingeSettlePollInterval];
  }
  return nil;
}

// Best effort: a failed read or correction never fails the original request.
- (void)fb_correctHingeAngleToward:(double)angle
{
  // Identical consecutive values are ignored by the device, so each retry is nudged
  // inward; values near the ends are not nudged outward as >170 snaps to 180.
  double direction = angle <= 90 ? 1 : -1;
  for (NSUInteger attempt = 0; attempt <= FBHingeMaxCorrections; ++attempt) {
    NSNumber *reading = [self fb_settledHingeAngle];
    // 0 and 180 are the device's snap points, so a reading there is final
    if (nil == reading
        || FBHingeAnglesEqual(reading.doubleValue, FBHingeClosedAngle)
        || FBHingeAnglesEqual(reading.doubleValue, FBHingeOpenAngle)
        || FBHingeAnglesEqual(reading.doubleValue, angle)
        || attempt == FBHingeMaxCorrections) {
      return;
    }
    double nudged = angle + direction * FBHingeCorrectionNudge * (attempt + 1);
    if (![self.class fb_dispatchHingeAngle:nudged error:nil]) {
      return;
    }
  }
}

#endif

@end
