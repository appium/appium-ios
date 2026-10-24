/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIDevice+FBRotation.h"

#import "FBConfiguration.h"
#import "FBRunLoopSpinner.h"
#import "FBSession.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement+FBUtilities.h"

# if !TARGET_OS_TV && !TARGET_OS_WATCH

static UIInterfaceOrientation FBInterfaceOrientationFromDeviceOrientation(UIDeviceOrientation orientation);

@implementation XCUIDevice (FBRotation)

- (BOOL)fb_setDeviceInterfaceOrientation:(UIDeviceOrientation)orientation
{
  [XCUIDevice sharedDevice].orientation = orientation;
  return [self fb_verifyDeviceInterfaceOrientation:orientation];
}

- (BOOL)fb_verifyDeviceInterfaceOrientation:(UIDeviceOrientation)orientation
{
  XCUIApplication *application = FBSession.activeSession.activeApplication ?: XCUIApplication.fb_activeApplication;
  return [self waitUntilInterfaceIsAtOrientation:orientation application:application];
}

- (BOOL)fb_setDeviceRotation:(NSDictionary *)rotationObj
{
  NSArray<NSNumber *> *keysForRotationObj = [self.fb_rotationMapping allKeysForObject:rotationObj];
  if (keysForRotationObj.count == 0) {
    return NO;
  }
  UIDeviceOrientation orientation = (UIDeviceOrientation)keysForRotationObj.firstObject.integerValue;
  return [self fb_setDeviceInterfaceOrientation:orientation];
}

static UIInterfaceOrientation FBInterfaceOrientationFromDeviceOrientation(UIDeviceOrientation orientation)
{
  switch (orientation) {
    case UIDeviceOrientationPortrait:
      return UIInterfaceOrientationPortrait;
    case UIDeviceOrientationPortraitUpsideDown:
      return UIInterfaceOrientationPortraitUpsideDown;
    case UIDeviceOrientationLandscapeLeft:
      return UIInterfaceOrientationLandscapeRight;
    case UIDeviceOrientationLandscapeRight:
      return UIInterfaceOrientationLandscapeLeft;
    case UIDeviceOrientationUnknown:
    case UIDeviceOrientationFaceUp:
    case UIDeviceOrientationFaceDown:
    default:
      return UIInterfaceOrientationUnknown;
  }
}

- (BOOL)waitUntilInterfaceIsAtOrientation:(UIDeviceOrientation)orientation application:(XCUIApplication *)application
{
  // Tapping elements immediately after rotation may fail due to way UIKit is handling touches.
  // We should wait till UI cools off, before continuing
  // Simulator HID is submitted by the host before this request. Wait for the
  // actual app scene as well as updating XCTest's device orientation above.
  UIInterfaceOrientation expected = FBInterfaceOrientationFromDeviceOrientation(orientation);
  if (![[[FBRunLoopSpinner new] timeout:5.0] spinUntilTrue:^BOOL{
    return application.interfaceOrientation == expected;
  }]) {
    return NO;
  }
  [application fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.animationCoolOffTimeout];
  return application.interfaceOrientation == expected;
}

- (NSString *)fb_deviceOrientation
{
  switch (self.orientation) {
    case UIDeviceOrientationPortrait:
      return @"UIDeviceOrientationPortrait";
    case UIDeviceOrientationPortraitUpsideDown:
      return @"UIDeviceOrientationPortraitUpsideDown";
    case UIDeviceOrientationLandscapeLeft:
      return @"UIDeviceOrientationLandscapeLeft";
    case UIDeviceOrientationLandscapeRight:
      return @"UIDeviceOrientationLandscapeRight";
    case UIDeviceOrientationFaceUp:
      return @"UIDeviceOrientationFaceUp";
    case UIDeviceOrientationFaceDown:
      return @"UIDeviceOrientationFaceDown";
    case UIDeviceOrientationUnknown:
    default:
      return @"UIDeviceOrientationUnknown";
  }
}

- (NSDictionary *)fb_rotationMapping
{
    static NSDictionary *rotationMap;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        rotationMap =
        @{
          @(UIDeviceOrientationUnknown) : @{@"x" : @(-1), @"y" : @(-1), @"z" : @(-1)},
          @(UIDeviceOrientationPortrait) : @{@"x" : @(0), @"y" : @(0), @"z" : @(0)},
          @(UIDeviceOrientationPortraitUpsideDown) : @{@"x" : @(0), @"y" : @(0), @"z" : @(180)},
          @(UIDeviceOrientationLandscapeLeft) : @{@"x" : @(0), @"y" : @(0), @"z" : @(270)},
          @(UIDeviceOrientationLandscapeRight) : @{@"x" : @(0), @"y" : @(0), @"z" : @(90)},
          @(UIDeviceOrientationFaceUp) : @{@"x" : @(90), @"y" : @(0), @"z" : @(0)},
          @(UIDeviceOrientationFaceDown) : @{@"x" : @(270), @"y" : @(0), @"z" : @(0)},
          };
    });
    return rotationMap;
}

@end
#endif
