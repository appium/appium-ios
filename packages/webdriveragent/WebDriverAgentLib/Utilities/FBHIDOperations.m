/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBHIDOperations.h"

#import <dlfcn.h>
#import <mach/mach_time.h>

#import "FBConfiguration.h"
#import "FBErrorBuilder.h"
#import "FBLogger.h"
#import "FBRunLoopSpinner.h"
#import "FBScreen.h"
#import "FBSession.h"
#import "XCUIScreen.h"
#import "XCUIDevice+FBHinge.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement+FBUtilities.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
// Workaround tracked in https://github.com/appium/appium/issues/22857.
// Reproduced on the iOS 27.1 Duo simulator with Xcode 27.1: XCTest's Home
// request returns without backgrounding the app. This direct HID path is also
// enabled on physical hinged devices, but Home behavior there is unverified.
// The affected Xcode/runtime version range has not been established. Remove
// the Home workaround when XCTest-only presses pass testHomeButtonBackgroundsApplication
// on supported Duo environments, including physical devices and both panels.
static BOOL FBPressDuoButton(uint32_t usage, NSError **error)
{
  static CFTypeRef (*createEvent)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, Boolean, uint32_t);
  static CFTypeRef (*createClient)(CFAllocatorRef);
  static void (*dispatchEvent)(CFTypeRef, CFTypeRef);
  static void (*setTimestamp)(CFTypeRef, uint64_t);
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    void *handle = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
    if (NULL != handle) {
      createEvent = dlsym(handle, "IOHIDEventCreateKeyboardEvent");
      createClient = dlsym(handle, "IOHIDEventSystemClientCreate");
      dispatchEvent = dlsym(handle, "IOHIDEventSystemClientDispatchEvent");
      setTimestamp = dlsym(handle, "IOHIDEventSetTimeStamp");
    }
  });
  if (NULL == createEvent || NULL == createClient || NULL == dispatchEvent || NULL == setTimestamp) {
    return [[FBErrorBuilder.builder withDescription:@"The button HID APIs are unavailable"] buildError:error];
  }
  CFTypeRef client = createClient(kCFAllocatorDefault);
  CFTypeRef down = createEvent(kCFAllocatorDefault, mach_absolute_time(), 0x0C, usage, YES, 0);
  CFTypeRef up = createEvent(kCFAllocatorDefault, mach_absolute_time(), 0x0C, usage, NO, 0);
  BOOL ready = NULL != client && NULL != down && NULL != up;
  if (ready) {
    // Dispatch a short paired press. Holding Power for 0.5s invokes Siri on Duo.
    dispatchEvent(client, down);
    [NSThread sleepForTimeInterval:0.03];
    setTimestamp(up, mach_absolute_time());
    dispatchEvent(client, up);
  }
  if (NULL != down) {
    CFRelease(down);
  }
  if (NULL != up) {
    CFRelease(up);
  }
  if (NULL != client) {
    CFRelease(client);
  }
  return ready || [[FBErrorBuilder.builder withDescription:@"Cannot create the button HID event or client"] buildError:error];
}

// Work around XCTest updating Duo device orientation without rotating the app.
// Reproduction details and checks required before removing this workaround:
// https://github.com/appium/appium-ios/pull/81
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

#endif

@implementation FBHIDOperations

+ (BOOL)appliesToDevice:(XCUIDevice *)device
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  return device.fb_supportsHingeAngleReading;
#else
  return NO;
#endif
}

+ (BOOL)usesSimulatedButtonsForDevice:(XCUIDevice *)device
{
#if TARGET_OS_SIMULATOR
  return [self appliesToDevice:device];
#else
  return NO;
#endif
}

#if !TARGET_OS_TV && !TARGET_OS_WATCH
+ (BOOL)pressHomeWithError:(NSError **)error
{
  return FBPressDuoButton(0x40, error);
}

+ (BOOL)pressLockWithError:(NSError **)error
{
  // XCTest locking times out on Duo / iOS 27.1 (Xcode 27.1). Remove this
  // workaround once XCTest alone passes testRepeatedLockUnlockAcrossHingePoses.
  return FBPressDuoButton(0x30, error);
}

+ (BOOL)rotateToOrientation:(UIDeviceOrientation)orientation
     interfaceOrientation:(UIInterfaceOrientation)interfaceOrientation
{
  XCUIApplication *application = XCUIApplication.fb_activeApplication;
  // Point-based detection can select the cover SpringBoard while the app
  // is on the inner panel. Prefer the session's active application.
  application = FBSession.activeSession.activeApplication ?: application;
  // Keep XCTest's reported device orientation in sync on the simulator too.
  [XCUIDevice sharedDevice].orientation = orientation;
#if !TARGET_OS_SIMULATOR
  [application fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.animationCoolOffTimeout];
  if (application.interfaceOrientation == interfaceOrientation) {
    return YES;
  }
  [FBLogger logFmt:@"XCTest did not rotate the app to device orientation %ld on a physical Duo device. "
    @"Falling back to the vendor HID orientation event; physical-device support is unverified.",
    (long)orientation];
#endif
  // On Duo simulators XCTest can update its value without rotating the app.
  // Dispatch directly instead of waiting for the XCTest path to fail.
  if (!FBDispatchDuoOrientation(orientation)) {
    return NO;
  }
  // Event dispatch is asynchronous. Check the app, not just XCTest's value.
  if (![[[FBRunLoopSpinner new] timeout:5.0] spinUntilTrue:^BOOL{
    return application.interfaceOrientation == interfaceOrientation;
  }]) {
    return NO;
  }
  [application fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.animationCoolOffTimeout];
  return application.interfaceOrientation == interfaceOrientation;
}
#endif

@end
