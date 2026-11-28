/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBConfiguration.h"
#import "FBExceptions.h"
#import "FBW3CActionDoubles.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIElement+FBScrolling.h"
#import "XCElementSnapshotDouble.h"

#if !TARGET_OS_TV

// Private directional scrolling of the snapshot wrapper, defined in XCUIElement+FBScrolling.m
@interface FBXCElementSnapshotWrapper (FBScrollingTestable)
- (BOOL)fb_scrollUpByNormalizedDistance:(CGFloat)distance anchorElement:(nullable XCUIElement *)anchorElement;
- (BOOL)fb_scrollDownByNormalizedDistance:(CGFloat)distance anchorElement:(nullable XCUIElement *)anchorElement;
- (BOOL)fb_scrollLeftByNormalizedDistance:(CGFloat)distance anchorElement:(nullable XCUIElement *)anchorElement;
- (BOOL)fb_scrollRightByNormalizedDistance:(CGFloat)distance anchorElement:(nullable XCUIElement *)anchorElement;
@end

@interface XCUIElementScrollingTests : XCTestCase
@property (nonatomic, nullable) NSNumber *previousDisplayId;
@end

@implementation XCUIElementScrollingTests

- (void)setUp
{
  [super setUp];
  self.previousDisplayId = FBConfiguration.sharedInstance.currentDisplayId;
  // Selects a display that never exists
  FBConfiguration.sharedInstance.currentDisplayId = @(-1);
}

- (void)tearDown
{
  FBConfiguration.sharedInstance.currentDisplayId = self.previousDisplayId;
  [super tearDown];
}

- (void)testDirectionalScrollRejectsUnavailableDisplay
{
  FBXCElementSnapshotWrapper *wrapper = [FBXCElementSnapshotWrapper ensureWrapped:(id)[XCElementSnapshotDouble new]];
  // The display is validated before any gesture coordinate is resolved
  XCTAssertThrowsSpecificNamed([wrapper fb_scrollDownByNormalizedDistance:0.5 anchorElement:nil], NSException, FBInvalidArgumentException);
  XCTAssertThrowsSpecificNamed([wrapper fb_scrollUpByNormalizedDistance:0.5 anchorElement:nil], NSException, FBInvalidArgumentException);
  XCTAssertThrowsSpecificNamed([wrapper fb_scrollLeftByNormalizedDistance:0.5 anchorElement:nil], NSException, FBInvalidArgumentException);
  XCTAssertThrowsSpecificNamed([wrapper fb_scrollRightByNormalizedDistance:0.5 anchorElement:nil], NSException, FBInvalidArgumentException);
}

- (void)testScrollToElementRejectsUnavailableDisplay
{
  // The display is checked before the element is snapshotted
  XCUIElement *element = [FBW3CElementDouble doubleWithType:XCUIElementTypeOther frame:CGRectZero];
  NSError *error = nil;
  XCTAssertFalse([element fb_scrollToVisibleWithError:&error]);
  XCTAssertNotNil(error);
  XCTAssertTrue([error.localizedDescription containsString:@"No display with id -1"]);
}

@end

#endif
