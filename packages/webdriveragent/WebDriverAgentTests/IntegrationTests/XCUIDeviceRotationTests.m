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

- (void)testLandscapeRightOrientation
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:UIDeviceOrientationLandscapeRight];
  XCTAssertTrue(success, @"Device should support LandscapeRight");
  // Device rotation gives opposite interface rotation
  XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeLeft"].exists);
}

- (void)testLandscapeLeftOrientation
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:UIDeviceOrientationLandscapeLeft];
  XCTAssertTrue(success, @"Device should support LandscapeLeft");
  // Device rotation gives opposite interface rotation
  XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeRight"].exists);
}

- (void)testLandscapeRightRotation
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceRotation:@{
    @"x" : @(0),
    @"y" : @(0),
    @"z" : @(90)
  }];
  XCTAssertTrue(success, @"Device should support LandscapeRight");
  // Device rotation gives opposite interface rotation
  XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeLeft"].exists);
}

- (void)testLandscapeLeftRotation
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceRotation:@{
    @"x" : @(0),
    @"y" : @(0),
    @"z" : @(270)
  }];
  XCTAssertTrue(success, @"Device should support LandscapeLeft");
  // Device rotation gives opposite interface rotation
  XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeRight"].exists);
}

- (void)testGetDeviceOrientationInPortrait
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:UIDeviceOrientationPortrait];
  XCTAssertTrue(success, @"Device should support Portrait");
  XCTAssertEqualObjects([XCUIDevice sharedDevice].fb_deviceOrientation, @"UIDeviceOrientationPortrait");
}

- (void)testGetDeviceOrientationInLandscapeLeft
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:UIDeviceOrientationLandscapeLeft];
  XCTAssertTrue(success, @"Device should support LandscapeLeft");
  XCTAssertEqualObjects([XCUIDevice sharedDevice].fb_deviceOrientation, @"UIDeviceOrientationLandscapeLeft");
}

- (void)testGetDeviceOrientationInLandscapeRight
{
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:UIDeviceOrientationLandscapeRight];
  XCTAssertTrue(success, @"Device should support LandscapeRight");
  XCTAssertEqualObjects([XCUIDevice sharedDevice].fb_deviceOrientation, @"UIDeviceOrientationLandscapeRight");
}

- (void)testRotationTiltRotation
{
  UIDeviceOrientation currentRotation = [XCUIDevice sharedDevice].orientation;
  BOOL success = [[XCUIDevice sharedDevice] fb_setDeviceRotation:@{
    @"x" : @(15),
    @"y" : @(0),
    @"z" : @(0)}
  ];
  XCTAssertFalse(success, @"Device should not support tilt");
  XCTAssertEqual(currentRotation, [XCUIDevice sharedDevice].orientation, @"Device doesnt support tilt, should be at previous orientation");
}

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

- (void)testRotationOnSelectedDuoDisplay
{
#if TARGET_OS_SIMULATOR
  XCUIDevice *device = XCUIDevice.sharedDevice;
  XCTSkipIf(!device.fb_supportsHingeAngleReading || !device.fb_canAttemptSimulatedHingeAngleInjection,
            @"Requires hinge angle reading and injection support");
  NSNumber *originalDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  NSNumber *originalAngle = [device fb_getSimulatedHingeAngle:nil];
  XCTAssertNotNil(originalAngle);
  @try {
    for (NSNumber *angle in @[@0, @90, @180]) {
      XCTAssertTrue([device fb_setSimulatedHingeAngle:angle.doubleValue error:nil]);
      [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:3]];
      [self.testedApplication activate];
      XCUIElement *window = self.testedApplication.windows.firstMatch;
      (void)window.frame;
      FBConfiguration.sharedInstance.currentDisplayId = @(window.screen.displayID);
      NSArray *orientations = @[@(UIDeviceOrientationLandscapeLeft),
                                @(UIDeviceOrientationLandscapeRight),
                                @(UIDeviceOrientationPortrait)];
      NSArray *labels = @[@"LandscapeRight", @"LandscapeLeft", @"Portrait"];
      for (NSUInteger i = 0; i < orientations.count; i++) {
        UIDeviceOrientation orientation = [orientations[i] integerValue];
        XCTAssertTrue([device fb_setDeviceInterfaceOrientation:orientation]);
        XCTAssertTrue([self.testedApplication.staticTexts[labels[i]] waitForExistenceWithTimeout:5]);
        // The physical device and the inner panel have different native axes.
        // Verify the app's orientation; XCTest's raw device reading can differ.
        UIInterfaceOrientation expected = orientation == UIDeviceOrientationLandscapeLeft
          ? UIInterfaceOrientationLandscapeRight : orientation == UIDeviceOrientationLandscapeRight
          ? UIInterfaceOrientationLandscapeLeft : UIInterfaceOrientationPortrait;
        XCTAssertEqual(self.testedApplication.interfaceOrientation, expected);
      }
      BOOL rotated = [device fb_setDeviceRotation:@{@"x": @0, @"y": @0, @"z": @270}];
      XCTAssertTrue(rotated);
      XCTAssertTrue(self.testedApplication.staticTexts[@"LandscapeRight"].exists);
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
