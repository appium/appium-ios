/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBConfiguration.h"
#import "FBResponsePayload.h"
#import "FBSnapshotTreeDouble.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIElement+FBCaching.h"
#import "XCUIElement+FBUID.h"
#import "XCUIElement+FBUtilities.h"

static NSString *const W3C_KEY = @"element-6066-11e4-a52e-4f735466cecf";
static NSString *const JSONWP_KEY = @"ELEMENT";
static NSString *const ELEMENT_UID = @"test-uid";

// Minimal stand-in for the XCUIElement members read by FBDictionaryResponseWithElement
@interface FBResponseElementDouble : NSObject
@property (nonatomic, strong, nullable) id fb_boundAccessibilityElement;
@property (nonatomic, copy, nullable) NSString *fb_cacheId;
@property (nonatomic, strong, nullable) id lastSnapshot;
@property (nonatomic, strong, nullable) id fb_cachedSnapshot;
@property (nonatomic, strong, nullable) id customSnapshot;
@end

@implementation FBResponseElementDouble
- (id)fb_customSnapshot
{
  return self.customSnapshot;
}
@end

@interface FBResponsePayloadTests : XCTestCase
@property (nonatomic, copy) NSString *originalResponseAttributes;
@property (nonatomic, strong) FBSnapshotTreeDouble *snapshot;
@property (nonatomic, strong) FBResponseElementDouble *element;
@end

@implementation FBResponsePayloadTests

- (void)setUp
{
  [super setUp];
  self.originalResponseAttributes = FBConfiguration.sharedInstance.elementResponseAttributes;
  FBConfiguration.sharedInstance.elementResponseAttributes = @"type,label";

  FBSnapshotTreeDouble *snapshot = [FBSnapshotTreeDouble type:XCUIElementTypeButton label:@"Alerts" children:nil];
  snapshot.identifier = @"Alerts";
  snapshot.value = nil;
  snapshot.enabled = YES;
  snapshot.selected = NO;
  snapshot.frame = CGRectMake(10, 20, 100, 50);
  snapshot.additionalAttributes[FB_XCAXAIsVisibleAttribute] = @YES;
  self.snapshot = snapshot;

  FBResponseElementDouble *element = [FBResponseElementDouble new];
  element.fb_boundAccessibilityElement = [NSObject new];
  element.fb_cacheId = ELEMENT_UID;
  element.lastSnapshot = snapshot;
  self.element = element;
}

- (void)tearDown
{
  FBConfiguration.sharedInstance.elementResponseAttributes = self.originalResponseAttributes;
  [super tearDown];
}

- (NSDictionary *)responseWithCompact:(BOOL)compact
{
  return FBDictionaryResponseWithElement((XCUIElement *)self.element, compact);
}

- (void)assertElementKeysIn:(NSDictionary *)fields
{
  XCTAssertEqualObjects(fields[JSONWP_KEY], ELEMENT_UID);
  XCTAssertEqualObjects(fields[W3C_KEY], ELEMENT_UID);
}

- (void)testCompactResponseYes
{
  NSDictionary *fields = [self responseWithCompact:YES];
  [self assertElementKeysIn:fields];
  XCTAssertEqual(fields.count, 2);
}

- (void)testCompactResponseNo
{
  NSDictionary *fields = [self responseWithCompact:NO];
  [self assertElementKeysIn:fields];
  XCTAssertEqualObjects(fields[@"type"], @"XCUIElementTypeButton");
  XCTAssertEqualObjects(fields[@"label"], @"Alerts");
  XCTAssertEqual(fields.count, 4);
}

- (void)testCompactResponseYesWithResponseAttributesSet
{
  FBConfiguration.sharedInstance.elementResponseAttributes = @"name,text,enabled";
  NSDictionary *fields = [self responseWithCompact:YES];
  [self assertElementKeysIn:fields];
  XCTAssertEqual(fields.count, 2);
}

- (void)testCompactResponseNoWithResponseAttributesSet
{
  FBConfiguration.sharedInstance.elementResponseAttributes = @"name,text,enabled";
  NSDictionary *fields = [self responseWithCompact:NO];
  [self assertElementKeysIn:fields];
  XCTAssertEqualObjects(fields[@"name"], @"XCUIElementTypeButton");
  XCTAssertEqualObjects(fields[@"text"], @"Alerts");
  XCTAssertEqualObjects(fields[@"enabled"], @(YES));
  XCTAssertEqual(fields.count, 5);
}

- (void)testInvalidAttribute
{
  FBConfiguration.sharedInstance.elementResponseAttributes = @"invalid_field,name";
  NSDictionary *fields = [self responseWithCompact:NO];
  [self assertElementKeysIn:fields];
  XCTAssertEqualObjects(fields[@"name"], @"XCUIElementTypeButton");
  XCTAssertEqual(fields.count, 3);
}

- (void)testKnownAttributes
{
  FBConfiguration.sharedInstance.elementResponseAttributes = @"name,type,label,text,rect,enabled,displayed,selected";
  NSDictionary *fields = [self responseWithCompact:NO];
  [self assertElementKeysIn:fields];
  XCTAssertEqualObjects(fields[@"name"], @"XCUIElementTypeButton");
  XCTAssertEqualObjects(fields[@"type"], @"XCUIElementTypeButton");
  XCTAssertEqualObjects(fields[@"label"], @"Alerts");
  XCTAssertEqualObjects(fields[@"text"], @"Alerts");
  NSDictionary *expectedRect = @{@"x": @10, @"y": @20, @"width": @100, @"height": @50};
  XCTAssertEqualObjects(fields[@"rect"], expectedRect);
  XCTAssertEqualObjects(fields[@"enabled"], @(YES));
  XCTAssertEqualObjects(fields[@"displayed"], @(YES));
  XCTAssertEqualObjects(fields[@"selected"], @(NO));
  XCTAssertEqual(fields.count, 10);
}

- (void)testArbitraryAttributes
{
  FBConfiguration.sharedInstance.elementResponseAttributes = @"attribute/name,attribute/value";
  NSDictionary *fields = [self responseWithCompact:NO];
  [self assertElementKeysIn:fields];
  XCTAssertEqualObjects(fields[@"attribute/name"], @"Alerts");
  XCTAssertEqualObjects(fields[@"attribute/value"], [NSNull null]);
  XCTAssertEqual(fields.count, 4);
}

- (void)testSnapshotSourcePrecedence
{
  FBSnapshotTreeDouble *cached = [FBSnapshotTreeDouble type:XCUIElementTypeSwitch label:@"cached" children:nil];
  FBSnapshotTreeDouble *custom = [FBSnapshotTreeDouble type:XCUIElementTypeLink label:@"custom" children:nil];
  self.element.fb_cachedSnapshot = cached;
  self.element.customSnapshot = custom;
  XCTAssertEqualObjects([self responseWithCompact:NO][@"label"], @"Alerts", @"lastSnapshot wins");

  self.element.lastSnapshot = nil;
  XCTAssertEqualObjects([self responseWithCompact:NO][@"label"], @"cached", @"cached snapshot is next");

  self.element.fb_cachedSnapshot = nil;
  XCTAssertEqualObjects([self responseWithCompact:NO][@"label"], @"custom", @"custom snapshot is the last resort");
}

@end
