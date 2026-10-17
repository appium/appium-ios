/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIDevice+FBRotation.h"

#import <dlfcn.h>
#import <mach/mach_time.h>

#import "FBConfiguration.h"
#import "FBLogger.h"
#import "FBRunLoopSpinner.h"
#import "FBScreen.h"
#import "FBSession.h"
#import "XCUIScreen.h"
#import "XCUIDevice+FBHinge.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement+FBUtilities.h"

# if !TARGET_OS_TV && !TARGET_OS_WATCH

static BOOL FBDispatchDuoOrientation(UIDeviceOrientation orientation)
{
  XCUIScreen *screen = [FBScreen currentScreenWithError:nil];
  if (nil == screen) {
    return NO;
  }
  // The inner panel's native orientation is a quarter turn from the cover.
  // Values match DeviceKit's orientation-picker-control (Xcode 27.1).
  NSString *value;
  switch (orientation) {
    case UIDeviceOrientationPortrait:
      value = screen.isMainScreen ? @"portrait" : @"landscape-left";
      break;
    case UIDeviceOrientationLandscapeLeft:
      value = screen.isMainScreen ? @"landscape-left" : @"pud";
      break;
    case UIDeviceOrientationLandscapeRight:
      value = screen.isMainScreen ? @"landscape-right" : @"portrait";
      break;
    case UIDeviceOrientationPortraitUpsideDown:
      value = screen.isMainScreen ? @"pud" : @"landscape-right";
      break;
    case UIDeviceOrientationUnknown:
    case UIDeviceOrientationFaceUp:
    case UIDeviceOrientationFaceDown:
    default:
      return NO;
  }

  static CFDataRef (*serialize)(CFTypeRef, CFOptionFlags);
  static CFTypeRef (*createEvent)(CFAllocatorRef, uint64_t, uint32_t, uint32_t,
                                  uint32_t, uint8_t *, CFIndex, uint32_t);
  static CFTypeRef (*createClient)(CFAllocatorRef);
  static void (*dispatchEvent)(CFTypeRef, CFTypeRef);
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    void *handle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
    if (NULL != handle) {
      serialize = (CFDataRef (*)(CFTypeRef, CFOptionFlags))dlsym(handle, "IOCFSerialize");
      createEvent = (CFTypeRef (*)(CFAllocatorRef, uint64_t, uint32_t, uint32_t,
                                  uint32_t, uint8_t *, CFIndex, uint32_t))dlsym(handle, "IOHIDEventCreateVendorDefinedEvent");
      createClient = (CFTypeRef (*)(CFAllocatorRef))dlsym(handle, "IOHIDEventSystemClientCreate");
      dispatchEvent = (void (*)(CFTypeRef, CFTypeRef))dlsym(handle, "IOHIDEventSystemClientDispatchEvent");
    }
  });
  if (NULL == serialize || NULL == createEvent || NULL == createClient || NULL == dispatchEvent) {
    return NO;
  }
  NSDictionary *payload = @{
    @"provider": @"com.apple.Virtualization.VirtualMachines",
    @"source": @"orientation-picker-control",
    @"type": @"enum",
    @"value": value,
  };
  // The receiver expects IOCF binary serialization, not a binary plist.
  CFDataRef data = serialize((__bridge CFTypeRef)payload, 1);
  if (NULL == data) {
    return NO;
  }
  CFTypeRef event = createEvent(kCFAllocatorDefault, mach_absolute_time(), 0xff61, 0x5b, 0,
                                (uint8_t *)CFDataGetBytePtr(data), CFDataGetLength(data), 0);
  CFRelease(data);
  CFTypeRef client = createClient(kCFAllocatorDefault);
  BOOL canDispatch = NULL != event && NULL != client;
  if (canDispatch) {
    dispatchEvent(client, event);
  }
  if (NULL != event) {
    CFRelease(event);
  }
  if (NULL != client) {
    CFRelease(client);
  }
  return canDispatch;
}

static UIInterfaceOrientation FBInterfaceOrientationFromDeviceOrientation(UIDeviceOrientation orientation);

@implementation XCUIDevice (FBRotation)

- (BOOL)fb_setDeviceInterfaceOrientation:(UIDeviceOrientation)orientation
{
  BOOL supportsHinge = self.fb_supportsHingeAngleReading;
  XCUIApplication *application = XCUIApplication.fb_activeApplication;
  if (supportsHinge) {
    // Point-based detection can select the cover SpringBoard while the app
    // is on the inner panel. Prefer the session's active application.
    application = FBSession.activeSession.activeApplication ?: application;
  }
  // Keep XCTest's reported device orientation in sync on the simulator too.
  [XCUIDevice sharedDevice].orientation = orientation;
#if TARGET_OS_SIMULATOR
  if (!supportsHinge) {
    return [self waitUntilInterfaceIsAtOrientation:orientation application:application];
  }
  // On Duo simulators XCTest can update its value without rotating the app.
  // Dispatch directly instead of waiting for the XCTest path to fail.
#else
  if ([self waitUntilInterfaceIsAtOrientation:orientation application:application]) {
    return YES;
  }
  if (!supportsHinge) {
    return NO;
  }
  [FBLogger logFmt:@"XCTest did not rotate the app to device orientation %ld on a physical Duo device. "
    @"Falling back to the vendor HID orientation event; physical-device support is unverified.",
    (long)orientation];
#endif
  if (!FBDispatchDuoOrientation(orientation)) {
    return NO;
  }
  // Event dispatch is asynchronous. Keep checking the app, not just XCTest's
  // device-orientation value, which can change without rotating the scene.
  BOOL reachedOrientation = [[[FBRunLoopSpinner new] timeout:5.0] spinUntilTrue:^BOOL{
    return application.interfaceOrientation == FBInterfaceOrientationFromDeviceOrientation(orientation);
  }];
  return reachedOrientation
    && [self waitUntilInterfaceIsAtOrientation:orientation application:application];
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
  [application fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.animationCoolOffTimeout];

  return application.interfaceOrientation == FBInterfaceOrientationFromDeviceOrientation(orientation);
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
