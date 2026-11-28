/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBElementUtils.h"
#import "FBSnapshotTreeDouble.h"
#import "FBXCElementSnapshotWrapper.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIElement+FBUID.h"
#import "XCUIElement+FBWebDriverAttributes.h"

// Mimics XCAccessibilityElement identity (pid + payload) so a UID can be derived
@interface FBFakeAXElementForAttributes : NSObject
@property (nonatomic, readonly) NSDictionary *payload;
@property (nonatomic, readonly) int processIdentifier;
@end

@implementation FBFakeAXElementForAttributes
- (NSDictionary *)payload
{
  return @{@"uid.elementID": @1234};
}

- (int)processIdentifier
{
  return 42;
}
@end

@interface FBAttributesSnapshotDouble : FBSnapshotTreeDouble
@property (nonatomic, strong, nullable) id accessibilityElement;
@end

@implementation FBAttributesSnapshotDouble
@synthesize accessibilityElement;
@end

@interface XCUIElementWebDriverAttributesTests : XCTestCase
@property (nonatomic, strong) FBAttributesSnapshotDouble *window;
@property (nonatomic, strong) FBAttributesSnapshotDouble *snapshot;
@property (nonatomic, strong) FBXCElementSnapshotWrapper *element;
@end

@implementation XCUIElementWebDriverAttributesTests

- (void)setUp
{
  [super setUp];
  FBAttributesSnapshotDouble *child = [FBAttributesSnapshotDouble type:XCUIElementTypeStaticText label:@"child" children:nil];
  child.additionalAttributes[FB_XCAXAIsElementAttribute] = @YES;
  FBAttributesSnapshotDouble *button = [FBAttributesSnapshotDouble type:XCUIElementTypeButton label:@"Alerts" children:@[child]];
  button.identifier = @"Alerts";
  button.value = nil;
  button.frame = CGRectMake(10, 20, 100, 50);
  button.accessibilityElement = [FBFakeAXElementForAttributes new];
  button.additionalAttributes[FB_XCAXAIsVisibleAttribute] = @YES;
  button.additionalAttributes[FB_XCAXAIsElementAttribute] = @YES;
  FBAttributesSnapshotDouble *window = [FBAttributesSnapshotDouble type:XCUIElementTypeWindow label:nil children:@[button]];
  window.additionalAttributes[FB_XCAXAIsElementAttribute] = @NO;
  // Parent links are weak, so the tree is retained by the test
  self.window = window;
  self.snapshot = button;
  self.element = [FBXCElementSnapshotWrapper ensureWrapped:(id<FBXCElementSnapshot>)button];
}

- (void)verifyGettingAttributeWithShortcut:(NSString *)shortcutName expectedValue:(id)expectedValue
{
  NSString *fullAttributeName = [NSString stringWithFormat:@"wd%@%@", [[shortcutName substringToIndex:1] uppercaseString], [shortcutName substringFromIndex:1]];
  id actualValue = [self.element fb_valueForWDAttributeName:fullAttributeName];
  id actualShortcutValue = [self.element fb_valueForWDAttributeName:shortcutName];
  XCTAssertEqualObjects(actualValue, expectedValue);
  XCTAssertEqualObjects(actualShortcutValue, expectedValue);
}

- (void)testGetNameAttribute
{
  [self verifyGettingAttributeWithShortcut:@"name" expectedValue:@"Alerts"];
  XCTAssertEqualObjects(self.element.wdName, @"Alerts");
}

- (void)testGetValueAttribute
{
  [self verifyGettingAttributeWithShortcut:@"value" expectedValue:nil];
  XCTAssertNil(self.element.wdValue);
}

- (void)testGetLabelAttribute
{
  [self verifyGettingAttributeWithShortcut:@"label" expectedValue:@"Alerts"];
  XCTAssertEqualObjects(self.element.wdLabel, @"Alerts");
}

- (void)testGetTypeAttribute
{
  [self verifyGettingAttributeWithShortcut:@"type" expectedValue:@"XCUIElementTypeButton"];
  XCTAssertEqualObjects(self.element.wdType, @"XCUIElementTypeButton");
}

- (void)testGetRectAttribute
{
  NSDictionary *expected = @{@"x": @10, @"y": @20, @"width": @100, @"height": @50};
  [self verifyGettingAttributeWithShortcut:@"rect" expectedValue:expected];
  XCTAssertEqualObjects(self.element.wdRect, expected);
}

- (void)testGetEnabledAttribute
{
  [self verifyGettingAttributeWithShortcut:@"enabled" expectedValue:@YES];
  self.snapshot.enabled = NO;
  [self verifyGettingAttributeWithShortcut:@"enabled" expectedValue:@NO];
}

- (void)testGetAccessibleAttribute
{
  [self verifyGettingAttributeWithShortcut:@"accessible" expectedValue:@YES];
  XCTAssertTrue(self.element.isWDAccessible);
}

- (void)testGetUidAttribute
{
  NSString *expected = [FBElementUtils uidWithAccessibilityElement:self.snapshot.accessibilityElement];
  XCTAssertNotNil(expected);
  [self verifyGettingAttributeWithShortcut:@"UID" expectedValue:expected];
  XCTAssertEqualObjects(self.element.wdUID, expected);
}

- (void)testGetVisibleAttribute
{
  [self verifyGettingAttributeWithShortcut:@"visible" expectedValue:@YES];
  self.snapshot.additionalAttributes[FB_XCAXAIsVisibleAttribute] = @NO;
  [self verifyGettingAttributeWithShortcut:@"visible" expectedValue:@NO];
}

- (void)testGetAccessibilityContainerAttribute
{
  [self verifyGettingAttributeWithShortcut:@"accessibilityContainer" expectedValue:@YES];
  XCTAssertTrue(self.element.isWDAccessibilityContainer);
  // Leaf elements are not containers
  [self.snapshot adoptChildren:@[]];
  [self verifyGettingAttributeWithShortcut:@"accessibilityContainer" expectedValue:@NO];
}

- (void)testGetInvalidAttribute
{
  XCTAssertThrowsSpecificNamed([FBElementUtils wdAttributeNameForAttributeName:@"invalid"], NSException, FBUnknownAttributeException);
  XCTAssertThrowsSpecificNamed([self.element fb_valueForWDAttributeName:@"invalid"], NSException, FBUnknownAttributeException);
}

@end
