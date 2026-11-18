/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBHIDOperations+DuoRotation.h"

#import "FBLogger.h"
#import "FBScreen.h"
#import "XCUIScreen.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH

// Private CADisplay device names observed on Duo simulators.
static NSString *const FBDuoCoverDisplayDeviceName = @"primary";
static NSString *const FBDuoInnerDisplayDeviceName = @"primary-1";

@protocol FBDuoPhysicalDisplay <NSObject>
@property (readonly) unsigned int displayId;
@property (readonly) NSString *deviceName;
@end

@protocol FBDuoDisplayProvider <NSObject>
+ (NSArray<id<FBDuoPhysicalDisplay>> *)displays;
@end

@interface FBHIDOperations (DuoRotationPrivate)
+ (nullable NSNumber *)isInnerDuoDisplay:(XCUIScreen *)screen
                               displays:(nullable NSArray<id<FBDuoPhysicalDisplay>> *)displays;
@end

@implementation FBHIDOperations (DuoRotation)

+ (nullable NSNumber *)isInnerDuoDisplay:(XCUIScreen *)screen
{
  // Physical panel identity survives changes to XCTest's main screen after folding.
  Class<FBDuoDisplayProvider> displayClass = (Class)NSClassFromString(@"CADisplay");
  NSArray<id<FBDuoPhysicalDisplay>> *displays = [displayClass respondsToSelector:@selector(displays)]
    ? [displayClass displays] : nil;
  return [self isInnerDuoDisplay:screen displays:displays];
}

+ (nullable NSNumber *)isInnerDuoDisplay:(XCUIScreen *)screen
                               displays:(nullable NSArray<id<FBDuoPhysicalDisplay>> *)displays
{
  for (id<FBDuoPhysicalDisplay> display in displays) {
    if (![display respondsToSelector:@selector(displayId)]
        || ![display respondsToSelector:@selector(deviceName)]
        || display.displayId != screen.displayID) {
      continue;
    }
    if ([display.deviceName isEqualToString:FBDuoInnerDisplayDeviceName]) {
      return @YES;
    }
    if ([display.deviceName isEqualToString:FBDuoCoverDisplayDeviceName]) {
      return @NO;
    }
  }
  return nil;
}

// Work around XCTest updating Duo device orientation without rotating the app.
// Reproduction details and checks required before removing this workaround:
// https://github.com/appium/appium-ios/pull/81
+ (nullable NSString *)duoOrientationValue:(UIDeviceOrientation)orientation
{
  NSError *error = nil;
  XCUIScreen *screen = [FBScreen currentScreenWithError:&error];
  if (nil == screen) {
    [FBLogger logFmt:@"Cannot resolve the display for Duo rotation: %@", error];
    return nil;
  }
  NSNumber *innerDisplay = [self isInnerDuoDisplay:screen];
  if (nil == innerDisplay) {
    [FBLogger logFmt:@"Cannot identify the physical Duo panel for display %lld; refusing to guess its rotation mapping",
     screen.displayID];
    return nil;
  }
  // The inner panel's native orientation is a quarter turn from the cover.
  // Values match DeviceKit's orientation-picker-control (Xcode 27.1).
  BOOL isInnerDisplay = innerDisplay.boolValue;
  NSString *value;
  switch (orientation) {
    case UIDeviceOrientationPortrait:
      value = !isInnerDisplay ? @"portrait" : @"landscape-left";
      break;
    case UIDeviceOrientationLandscapeLeft:
      value = !isInnerDisplay ? @"landscape-left" : @"pud";
      break;
    case UIDeviceOrientationLandscapeRight:
      value = !isInnerDisplay ? @"landscape-right" : @"portrait";
      break;
    case UIDeviceOrientationPortraitUpsideDown:
      value = !isInnerDisplay ? @"pud" : @"landscape-right";
      break;
    case UIDeviceOrientationUnknown:
    case UIDeviceOrientationFaceUp:
    case UIDeviceOrientationFaceDown:
    default:
      return nil;
  }

  return value;
}

@end
#endif
