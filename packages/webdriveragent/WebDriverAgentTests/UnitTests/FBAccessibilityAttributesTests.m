/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBSnapshotTreeDouble.h"
#import "FBXCElementSnapshotWrapper.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIElement+FBAccessibility.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@interface FBAccessibilityAttributesTests : XCTestCase
@end

@implementation FBAccessibilityAttributesTests

// Pre-seeds the AX flag so no live accessibility fetch happens
- (FBSnapshotTreeDouble *)snapshotWithType:(XCUIElementType)type
                       accessibilityElement:(BOOL)isElement
                                   children:(NSArray<FBSnapshotTreeDouble *> *)children
{
  FBSnapshotTreeDouble *snapshot = [FBSnapshotTreeDouble type:type label:nil children:children];
  snapshot.additionalAttributes[FB_XCAXAIsElementAttribute] = @(isElement);
  return snapshot;
}

- (FBXCElementSnapshotWrapper *)wrap:(FBSnapshotTreeDouble *)snapshot
{
  return [FBXCElementSnapshotWrapper ensureWrapped:snapshot];
}

- (void)testNativeAccessibilityElementAttribute
{
  // The raw native flag, without the custom wdAccessible computation
  for (NSNumber *flag in @[@YES, @NO]) {
    FBXCElementSnapshotWrapper *wrapper = [self wrap:[self snapshotWithType:XCUIElementTypeButton
                                                        accessibilityElement:flag.boolValue
                                                                    children:nil]];
    XCTAssertEqual(wrapper.isWDNativeAccessibilityElement, flag.boolValue);
    XCTAssertEqual(wrapper.isWDNativeAccessibilityElement, wrapper.fb_isAccessibilityElement);
  }
}

- (void)testElementIsNotAccessibilityContainer
{
  FBSnapshotTreeDouble *button = [self snapshotWithType:XCUIElementTypeButton accessibilityElement:YES children:nil];
  FBXCElementSnapshotWrapper *wrapper = [self wrap:button];
  XCTAssertTrue(wrapper.fb_isAccessibilityElement);
  XCTAssertFalse(wrapper.isWDAccessibilityContainer);
}

// The integration test asserts NO for a real "not_accessible" button (Xcode 11 FIXME), but the
// lib logic reports a container once a descendant is an accessibility element.
- (void)testContainerAccessibilityAttributes
{
  FBSnapshotTreeDouble *leaf = [self snapshotWithType:XCUIElementTypeButton accessibilityElement:YES children:nil];
  FBSnapshotTreeDouble *container = [self snapshotWithType:XCUIElementTypeButton accessibilityElement:NO
                                                  children:@[leaf]];
  FBXCElementSnapshotWrapper *wrapper = [self wrap:container];
  XCTAssertFalse(wrapper.fb_isAccessibilityElement);
  XCTAssertTrue(wrapper.isWDAccessibilityContainer);

  // The check recurses through inaccessible intermediate children
  FBSnapshotTreeDouble *deepLeaf = [self snapshotWithType:XCUIElementTypeButton accessibilityElement:YES children:nil];
  FBSnapshotTreeDouble *middle = [self snapshotWithType:XCUIElementTypeOther accessibilityElement:NO children:@[deepLeaf]];
  FBSnapshotTreeDouble *top = [self snapshotWithType:XCUIElementTypeOther accessibilityElement:NO children:@[middle]];
  XCTAssertTrue([self wrap:top].isWDAccessibilityContainer);
  XCTAssertTrue([self wrap:middle].isWDAccessibilityContainer);
}

- (void)testIgnoredAccessibilityAttributes
{
  // Images are neither accessibility elements nor contain them
  FBSnapshotTreeDouble *image = [self snapshotWithType:XCUIElementTypeImage accessibilityElement:NO children:nil];
  FBXCElementSnapshotWrapper *wrapper = [self wrap:image];
  XCTAssertFalse(wrapper.fb_isAccessibilityElement);
  XCTAssertFalse(wrapper.isWDAccessibilityContainer);

  // Same for a branch of inaccessible nodes only
  FBSnapshotTreeDouble *leaf = [self snapshotWithType:XCUIElementTypeImage accessibilityElement:NO children:nil];
  FBSnapshotTreeDouble *branch = [self snapshotWithType:XCUIElementTypeOther accessibilityElement:NO children:@[leaf]];
  XCTAssertFalse([self wrap:branch].fb_isAccessibilityElement);
  XCTAssertFalse([self wrap:branch].isWDAccessibilityContainer);
}

@end
