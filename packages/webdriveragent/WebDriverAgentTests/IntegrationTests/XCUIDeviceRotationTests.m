/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <limits.h>
#import "FBHIDOperations.h"
#import "FBHIDOperations+DuoRotation.h"
#import "FBIntegrationTestCase.h"
#import "XCUIDevice+FBRotation.h"
#import "XCUIDevice+FBHinge.h"
#import "FBConfiguration.h"
#import "FBScreen.h"
#import "XCUIElement.h"
#import "XCUIScreen.h"
#import "FBSession.h"

@interface FBHIDOperations (FBPanelResolutionTesting)
+ (nullable NSNumber *)isInnerDuoDisplay:(XCUIScreen *)screen displays:(nullable NSArray *)displays;
@end

@interface FBRotationDisplayDouble : NSObject
@property (nonatomic) unsigned int displayId;
@property (nonatomic, copy) NSString *deviceName;
@end
@implementation FBRotationDisplayDouble
@end

@interface FBRotationScreenDouble : NSObject
@property (nonatomic) long long displayID;
@property (nonatomic) BOOL isMainScreen;
@end
@implementation FBRotationScreenDouble
@end

/** Rotation resolution logic on doubles; does not need the app, so it skips the app launch. */
@interface XCUIDeviceRotationLogicTests : FBIntegrationTestCase
@end

@implementation XCUIDeviceRotationLogicTests

- (void)assertRotationRejectedWithoutOrientationChange
{
  Method method = class_getInstanceMethod(XCUIDevice.class, @selector(setOrientation:));
  IMP original = method_getImplementation(method);
  __block NSUInteger orientationChanges = 0;
  IMP replacement = imp_implementationWithBlock(^(id receiver, UIDeviceOrientation orientation) {
    orientationChanges++;
  });
  method_setImplementation(method, replacement);
  @try {
    XCTAssertFalse([FBHIDOperations rotateToOrientation:UIDeviceOrientationLandscapeLeft
                                 interfaceOrientation:UIInterfaceOrientationLandscapeRight]);
    XCTAssertEqual(orientationChanges, 0UL, @"Unresolved display identity must fail before changing device orientation");
  } @finally {
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }
}

- (void)testInvalidDisplayDoesNotChangeDeviceOrientation
{
  NSNumber *originalDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  @try {
    FBConfiguration.sharedInstance.currentDisplayId = @(LLONG_MAX);
    [self assertRotationRejectedWithoutOrientationChange];
  } @finally {
    FBConfiguration.sharedInstance.currentDisplayId = originalDisplay;
  }
}

- (void)testUnknownPanelDoesNotChangeDeviceOrientation
{
  Method method = class_getClassMethod(FBHIDOperations.class, @selector(isInnerDuoDisplay:displays:));
  IMP original = method_getImplementation(method);
  __block NSUInteger resolutions = 0;
  IMP replacement = imp_implementationWithBlock(^NSNumber *(id receiver, XCUIScreen *screen, NSArray *displays) {
    resolutions++;
    return nil;
  });
  method_setImplementation(method, replacement);
  @try {
    [self assertRotationRejectedWithoutOrientationChange];
    XCTAssertEqual(resolutions, 1UL);
  } @finally {
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }
}

- (void)testPhysicalPanelIdentityDoesNotFollowMainScreen
{
  FBRotationDisplayDouble *cover = [FBRotationDisplayDouble new];
  cover.displayId = 42;
  cover.deviceName = @"primary";
  FBRotationDisplayDouble *inner = [FBRotationDisplayDouble new];
  inner.displayId = 73;
  inner.deviceName = @"primary-1";
  FBRotationScreenDouble *screen = [FBRotationScreenDouble new];
  for (NSNumber *isMain in @[@YES, @NO]) {
    screen.isMainScreen = isMain.boolValue;
    screen.displayID = cover.displayId;
    XCTAssertEqualObjects(([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[inner, cover]]), @NO);
    screen.displayID = inner.displayId;
    XCTAssertEqualObjects(([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[cover, inner]]), @YES);
  }
}

- (void)testUnrecognizedPhysicalPanelIsNotGuessed
{
  FBRotationScreenDouble *screen = [FBRotationScreenDouble new];
  screen.displayID = 42;
  FBRotationDisplayDouble *display = [FBRotationDisplayDouble new];
  display.displayId = 73;
  display.deviceName = @"primary";
  for (NSNumber *isMain in @[@YES, @NO]) {
    screen.isMainScreen = isMain.boolValue;
    XCTAssertNil([FBHIDOperations isInnerDuoDisplay:(id)screen displays:nil]);
    XCTAssertNil([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[]]);
    XCTAssertNil([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[[NSObject new]]]);
    display.displayId = 73;
    display.deviceName = @"primary";
    XCTAssertNil([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[display]]);
    display.displayId = 42;
    display.deviceName = @"unrecognized-panel";
    XCTAssertNil([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[display]]);
  }
  // Do not truncate XCTest's wider ID to a Core Animation display ID.
  screen.displayID = (1LL << 32) + 42;
  display.deviceName = @"primary";
  XCTAssertNil([FBHIDOperations isInnerDuoDisplay:(id)screen displays:@[display]]);
}

@end

@interface XCUIDeviceRotationTests : FBIntegrationTestCase
@property (nonatomic, strong) FBSession *session;

@end

@implementation XCUIDeviceRotationTests

- (void)setUp
{
  [super setUp];
  [self launchApplication];
  self.session = [FBSession initWithApplication:self.testedApplication];
}

- (void)tearDown
{
  [self resetOrientation];
  [self.session kill];
  [super tearDown];
}

- (void)testInterfaceOrientation
{
  // Device rotation gives opposite interface rotation
  NSArray<NSDictionary *> *cases = @[
    @{@"orientation": @(UIDeviceOrientationLandscapeRight), @"label": @"LandscapeLeft",
      @"name": @"UIDeviceOrientationLandscapeRight"},
    @{@"orientation": @(UIDeviceOrientationLandscapeLeft), @"label": @"LandscapeRight",
      @"name": @"UIDeviceOrientationLandscapeLeft"},
    @{@"orientation": @(UIDeviceOrientationPortrait), @"name": @"UIDeviceOrientationPortrait"},
  ];
  for (NSDictionary *testCase in cases) {
    UIDeviceOrientation orientation = [testCase[@"orientation"] integerValue];
    XCTAssertTrue([[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation],
                  @"Device should support %@", testCase[@"name"]);
    if (nil != testCase[@"label"]) {
      XCTAssertTrue(self.testedApplication.staticTexts[testCase[@"label"]].exists);
    }
    XCTAssertEqualObjects([XCUIDevice sharedDevice].fb_deviceOrientation, testCase[@"name"]);
  }
}

- (void)testDeviceRotation
{
  XCUIDevice *device = [XCUIDevice sharedDevice];
  // Device rotation gives opposite interface rotation
  BOOL success = [device fb_setDeviceRotation:@{@"x": @(0), @"y": @(0), @"z": @(90)}];
  XCTAssertTrue(success, @"Device should support LandscapeRight");
  XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeLeft"].exists);
  success = [device fb_setDeviceRotation:@{@"x": @(0), @"y": @(0), @"z": @(270)}];
  XCTAssertTrue(success, @"Device should support LandscapeLeft");
  XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeRight"].exists);

  UIDeviceOrientation currentRotation = device.orientation;
  success = [device fb_setDeviceRotation:@{@"x": @(15), @"y": @(0), @"z": @(0)}];
  XCTAssertFalse(success, @"Device should not support tilt");
  XCTAssertEqual(currentRotation, device.orientation, @"Device doesnt support tilt, should be at previous orientation");
}

@end

/** Needs a foldable simulator: skips before launching the app elsewhere. */
@interface XCUIDeviceDuoRotationTests : FBIntegrationTestCase
@property (nonatomic, strong, nullable) FBSession *session;
@end

@implementation XCUIDeviceDuoRotationTests

- (void)tearDown
{
  [self resetOrientation];
  [self.session kill];
  [super tearDown];
}

- (void)assertDevice:(XCUIDevice *)device hasOrientation:(UIDeviceOrientation)orientation name:(NSString *)name
{
  XCTAssertEqual(device.orientation, orientation);
  XCTAssertEqualObjects(device.fb_deviceOrientation, name);
}

- (void)testRotationOnSelectedDuoDisplay
{
#if TARGET_OS_SIMULATOR
  XCUIDevice *device = XCUIDevice.sharedDevice;
  XCTSkipIf(!device.fb_supportsHingeAngleReading || !device.fb_canAttemptSimulatedHingeAngleInjection,
            @"Requires hinge angle reading and injection support");
  // Launched after the skip check above so non-foldable devices don't pay for it
  [self launchApplication];
  self.session = [FBSession initWithApplication:self.testedApplication];
  NSNumber *originalDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  NSNumber *originalAngle = [device fb_getSimulatedHingeAngle:nil];
  XCTAssertNotNil(originalAngle);
  @try {
    for (NSNumber *angle in @[@0, @90, @180]) {
      XCTAssertTrue([device fb_setSimulatedHingeAngle:angle.doubleValue error:nil]);
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:3]];
      [self.testedApplication activate];
      XCUIElement *window = self.testedApplication.windows.firstMatch;
      XCTAssertTrue([window waitForExistenceWithTimeout:5], @"The app must have a window after the hinge change");
      (void)window.frame;
      XCUIScreen *screen = window.screen;
      XCTAssertNotNil(screen, @"The resolved window must expose its display");
      NSError *screenError = nil;
      NSArray<NSDictionary *> *screens = [FBScreen screensWithError:&screenError];
      XCTAssertNotNil(screens);
      XCTAssertNil(screenError);
      NSNumber *displayID = @(screen.displayID);
      XCTAssertTrue([[screens valueForKey:@"displayId"] containsObject:displayID],
                    @"The app window must belong to an available display");
      NSNumber *isInnerDisplay = [FBHIDOperations isInnerDuoDisplay:screen];
      XCTAssertNotNil(isInnerDisplay);
      XCTAssertEqual(isInnerDisplay.boolValue, angle.doubleValue > 0,
                     @"The fixture must use the cover when closed and the inner panel when open");
      FBConfiguration.sharedInstance.currentDisplayId = displayID;
      // 27.1/27.2 keep XCTest's assigned value; 27.3 reports the HID-adjusted value on the inner panel.
      BOOL reportsHIDOrientation = isInnerDisplay.boolValue
        && [NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:(NSOperatingSystemVersion){27, 3, 0}];
      // Independent expectations for the app's interface and XCTest's raw device reading.
      NSArray<NSDictionary *> *cases = @[
        @{@"device": @(UIDeviceOrientationLandscapeLeft), @"interface": @(UIInterfaceOrientationLandscapeRight),
          @"innerDevice": @(UIDeviceOrientationPortraitUpsideDown), @"label": @"LandscapeRight"},
        @{@"device": @(UIDeviceOrientationLandscapeRight), @"interface": @(UIInterfaceOrientationLandscapeLeft),
          @"innerDevice": @(UIDeviceOrientationPortrait), @"label": @"LandscapeLeft"},
        @{@"device": @(UIDeviceOrientationPortrait), @"interface": @(UIInterfaceOrientationPortrait),
          @"innerDevice": @(UIDeviceOrientationLandscapeLeft), @"label": @"Portrait"},
      ];
      NSDictionary<NSNumber *, NSString *> *deviceNames = @{
        @(UIDeviceOrientationPortrait): @"UIDeviceOrientationPortrait",
        @(UIDeviceOrientationPortraitUpsideDown): @"UIDeviceOrientationPortraitUpsideDown",
        @(UIDeviceOrientationLandscapeLeft): @"UIDeviceOrientationLandscapeLeft",
        @(UIDeviceOrientationLandscapeRight): @"UIDeviceOrientationLandscapeRight",
      };
      for (NSDictionary *testCase in cases) {
        UIDeviceOrientation orientation = [testCase[@"device"] integerValue];
        XCTAssertTrue([device fb_setDeviceInterfaceOrientation:orientation]);
        XCTAssertTrue([self.testedApplication.staticTexts[testCase[@"label"]] waitForExistenceWithTimeout:5]);
        XCTAssertEqual(self.testedApplication.interfaceOrientation, [testCase[@"interface"] integerValue]);
        UIDeviceOrientation rawOrientation = [testCase[reportsHIDOrientation ? @"innerDevice" : @"device"] integerValue];
        [self assertDevice:device hasOrientation:rawOrientation name:deviceNames[@(rawOrientation)]];
        (void)window.frame;
        XCTAssertNotNil(window.screen);
        XCTAssertEqual(window.screen.displayID, displayID.longLongValue, @"Rotation must keep the app on the selected panel");
      }
      BOOL rotated = [device fb_setDeviceRotation:@{@"x": @0, @"y": @0, @"z": @270}];
      XCTAssertTrue(rotated);
      XCTAssertTrue([self.testedApplication.staticTexts[@"LandscapeRight"] waitForExistenceWithTimeout:5]);
      XCTAssertEqual(self.testedApplication.interfaceOrientation, UIInterfaceOrientationLandscapeRight);
      UIDeviceOrientation rawOrientation = reportsHIDOrientation
        ? UIDeviceOrientationPortraitUpsideDown : UIDeviceOrientationLandscapeLeft;
      [self assertDevice:device hasOrientation:rawOrientation name:deviceNames[@(rawOrientation)]];
    }
  } @finally {
    [device fb_setSimulatedHingeAngle:0 error:nil];
    [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:3]];
    FBConfiguration.sharedInstance.currentDisplayId = nil;
    [device fb_setDeviceInterfaceOrientation:UIDeviceOrientationPortrait];
    if (nil != originalAngle) {
      [device fb_setSimulatedHingeAngle:originalAngle.doubleValue error:nil];
    }
    FBConfiguration.sharedInstance.currentDisplayId = originalDisplay;
  }
#endif
}

@end
