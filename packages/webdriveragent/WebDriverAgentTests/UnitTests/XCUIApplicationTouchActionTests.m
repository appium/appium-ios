/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBExceptions.h"
#import "FBW3CActionDoubles.h"
#import "XCSynthesizedEventRecord.h"
#import "XCUIApplication+FBTouchAction.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH

/** Application that was never launched: it only needs a bundle id for error messages. */
@interface FBTouchActionApplicationDouble : XCUIApplication
@end

@implementation FBTouchActionApplicationDouble

- (NSString *)bundleID
{
  return @"com.example.unit.test";
}

@end

@interface XCUIApplicationTouchActionTests : XCTestCase
@property (nonatomic) XCUIApplication *application;
@end

@implementation XCUIApplicationTouchActionTests

- (void)setUp
{
  [super setUp];
  // XCUIApplication cannot be initialized in a unit test host; the gesture never queries it
  self.application = [FBTouchActionApplicationDouble alloc];
}

// https://github.com/appium/WebDriverAgent/issues/1056
- (void)testPressAndDragFailsCleanlyForUnresolvableCoordinates
{
  XCUICoordinate *unresolvable = [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(INFINITY, INFINITY)];
  XCUICoordinate *valid = [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(100, 100)];
  for (NSArray<XCUICoordinate *> *pair in @[@[unresolvable, valid], @[valid, unresolvable]]) {
    NSError *error = nil;
    XCTAssertFalse([self.application fb_pressAtCoordinate:pair[0]
                                              forDuration:0.3
                                     thenDragToCoordinate:pair[1]
                                             withVelocity:XCUIGestureVelocityDefault
                                      thenHoldForDuration:0
                                                    error:&error]);
    XCTAssertTrue([error.localizedDescription containsString:@"Cannot resolve the on-screen position"]);
  }
}

- (void)testPressDragEventKeepsDisplayIDAndTiming
{
  XCSynthesizedEventRecord *event = [XCUIApplication fb_pressDragEventFromPoint:CGPointMake(100, 500)
                                                                    forDuration:0.3
                                                                        toPoint:CGPointMake(100, 100)
                                                                pointsPerSecond:500
                                                            thenHoldForDuration:0.1
                                                                      displayID:42
                                                           interfaceOrientation:UIInterfaceOrientationPortrait];
  XCTAssertEqual(event.displayID, 42ULL);
  XCTAssertEqual(event.eventPaths.count, 1U);
  // 0.3 s press + 400 pt / 500 pt per s drag + 0.1 s hold
  XCTAssertEqualWithAccuracy(event.maximumOffset, 1.2, 0.0001);
}

- (void)testPressAndDragRejectsInvalidVelocity
{
  XCUICoordinate *start = [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(100, 500)];
  XCUICoordinate *end = [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(100, 100)];
  XCTAssertThrowsSpecificNamed([self.application fb_pressAtCoordinate:start
                                                          forDuration:0
                                                 thenDragToCoordinate:end
                                                         withVelocity:0
                                                  thenHoldForDuration:0
                                                                error:nil],
                               NSException, FBInvalidArgumentException);
}

@end

#endif
