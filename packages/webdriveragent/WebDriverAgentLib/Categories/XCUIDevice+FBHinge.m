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

#import "FBErrorBuilder.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
static const NSTimeInterval FBHingeAngleReadingTimeout = 5.0;

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
  // Simulated HID controls are owned by the host-side @appium/coresim package.
  return NO;
}

- (nullable NSNumber *)fb_getSimulatedHingeAngle:(NSError **)error
{
  if (!self.fb_supportsHingeAngleReading) {
    [[FBErrorBuilder.builder withDescription:@"Hinge angle reading is unavailable on this device"] buildError:error];
    return nil;
  }
#if !TARGET_OS_TV && !TARGET_OS_WATCH
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
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:FBHingeAngleReadingTimeout];
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
      FBHingeAngleReadingTimeout] buildError:error];
  }
  return result;
#else
  return nil;
#endif
}

- (BOOL)fb_setSimulatedHingeAngle:(double)angle error:(NSError **)error
{
  return [[FBErrorBuilder.builder withDescription:
    @"Set simulated hinge angles through the host-side @appium/coresim API"] buildError:error];
}

@end
