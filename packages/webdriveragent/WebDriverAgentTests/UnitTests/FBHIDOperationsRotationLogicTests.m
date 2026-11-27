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

#import "FBConfiguration.h"
#import "FBHIDOperations.h"
#import "FBHIDOperations+DuoRotation.h"
#import "XCUIDevice.h"
#import "XCUIScreen.h"

@interface FBHIDOperations (FBPanelResolutionUnitTesting)
+ (nullable NSNumber *)isInnerDuoDisplay:(XCUIScreen *)screen displays:(nullable NSArray *)displays;
@end

@interface FBUnitRotationDisplayDouble : NSObject
@property (nonatomic) unsigned int displayId;
@property (nonatomic, copy) NSString *deviceName;
@end
@implementation FBUnitRotationDisplayDouble
@end

@interface FBUnitRotationScreenDouble : NSObject
@property (nonatomic) long long displayID;
@property (nonatomic) BOOL isMainScreen;
@end
@implementation FBUnitRotationScreenDouble
@end

@interface FBHIDOperationsRotationLogicTests : XCTestCase
@end

@implementation FBHIDOperationsRotationLogicTests

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
  FBUnitRotationDisplayDouble *cover = [FBUnitRotationDisplayDouble new];
  cover.displayId = 42;
  cover.deviceName = @"primary";
  FBUnitRotationDisplayDouble *inner = [FBUnitRotationDisplayDouble new];
  inner.displayId = 73;
  inner.deviceName = @"primary-1";
  FBUnitRotationScreenDouble *screen = [FBUnitRotationScreenDouble new];
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
  FBUnitRotationScreenDouble *screen = [FBUnitRotationScreenDouble new];
  screen.displayID = 42;
  FBUnitRotationDisplayDouble *display = [FBUnitRotationDisplayDouble new];
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
