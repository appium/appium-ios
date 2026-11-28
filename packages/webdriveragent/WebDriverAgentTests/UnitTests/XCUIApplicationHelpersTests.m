/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBDisplayGeometry.h"
#import "FBSnapshotTreeDouble.h"
#import "FBXCElementSnapshotWrapper.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@interface XCUIApplication (FBHelpersUnitTests)
+ (NSDictionary *)dictionaryForElement:(id<FBXCElementSnapshot>)snapshot
                      displaySnapshots:(FBDisplaySnapshotMap *)displaySnapshots
                             recursive:(BOOL)recursive
                    excludedAttributes:(NSSet<NSString *> *)excludedAttributes;
@end

@interface XCUIApplicationHelpersTests : XCTestCase
@end

@implementation XCUIApplicationHelpersTests

// Seeds AX attributes so serialization never hits a live accessibility fetch
- (FBSnapshotTreeDouble *)snapshotWithType:(XCUIElementType)type
                                     label:(NSString *)label
                                     frame:(CGRect)frame
                                  children:(NSArray<FBSnapshotTreeDouble *> *)children
{
  FBSnapshotTreeDouble *snapshot = [FBSnapshotTreeDouble type:type label:label children:children];
  snapshot.identifier = label;
  snapshot.frame = frame;
  snapshot.additionalAttributes[FB_XCAXAIsElementAttribute] = @YES;
  snapshot.additionalAttributes[FB_XCAXAIsVisibleAttribute] = @YES;
  snapshot.additionalAttributes[FB_XCAXACustomActionsAttribute] = @"Custom Action 1,Custom Action 2";
  return snapshot;
}

- (FBSnapshotTreeDouble *)sampleTree
{
  FBSnapshotTreeDouble *button = [self snapshotWithType:XCUIElementTypeButton label:@"Button"
                                                  frame:CGRectMake(10, 20, 100, 40) children:nil];
  FBSnapshotTreeDouble *text = [self snapshotWithType:XCUIElementTypeStaticText label:@"Label"
                                                frame:CGRectMake(10, 80, 100, 20) children:nil];
  FBSnapshotTreeDouble *group = [self snapshotWithType:XCUIElementTypeOther label:@"Group"
                                                 frame:CGRectMake(0, 10, 200, 200) children:@[button, text]];
  return [self snapshotWithType:XCUIElementTypeWindow label:@"Root"
                          frame:CGRectMake(0, 0, 390, 844) children:@[group]];
}

- (void)visitNodes:(NSDictionary *)tree block:(void (^)(NSDictionary *node))block
{
  block(tree);
  for (NSDictionary *child in tree[@"children"]) {
    [self visitNodes:child block:block];
  }
}

- (NSDictionary *)findNodeNamed:(NSString *)name inTree:(NSDictionary *)tree
{
  __block NSDictionary *result = nil;
  [self visitNodes:tree block:^(NSDictionary *node) {
    if (nil == result && [node[@"name"] isEqual:name]) {
      result = node;
    }
  }];
  return result;
}

- (void)testJSONGeometryUsesDisplayCounterpart
{
  FBSnapshotTreeDouble *button = [self snapshotWithType:XCUIElementTypeButton label:@"Alerts"
                                                  frame:CGRectMake(10, 20, 100, 40) children:nil];
  FBSnapshotTreeDouble *window = [self snapshotWithType:XCUIElementTypeWindow label:@"Window"
                                                  frame:CGRectMake(0, 0, 390, 844) children:nil];
  FBDisplaySnapshotMap *matches = [NSMapTable strongToStrongObjectsMapTable];
  [matches setObject:window forKey:button];

  NSDictionary *node = [XCUIApplication dictionaryForElement:button displaySnapshots:matches recursive:NO excludedAttributes:nil];
  FBXCElementSnapshotWrapper *geometry = [FBXCElementSnapshotWrapper ensureWrapped:window];
  XCTAssertEqualObjects(node[@"rect"], geometry.wdRect);
  XCTAssertEqualObjects(node[@"rect"], (@{@"x": @0, @"y": @0, @"width": @390, @"height": @844}));
  XCTAssertEqualObjects(node[@"frame"], NSStringFromCGRect(geometry.wdFrame));
  XCTAssertEqualObjects(node[@"nativeFrame"], NSStringFromCGRect(CGRectMake(10, 20, 100, 40)));

  // Without a counterpart the node's own geometry is used
  NSDictionary *own = [XCUIApplication dictionaryForElement:button displaySnapshots:nil recursive:NO excludedAttributes:nil];
  XCTAssertEqualObjects(own[@"rect"], (@{@"x": @10, @"y": @20, @"width": @100, @"height": @40}));
  XCTAssertEqualObjects(own[@"frame"], NSStringFromCGRect(CGRectMake(10, 20, 100, 40)));
  XCTAssertEqualObjects(own[@"nativeFrame"], node[@"nativeFrame"]);
}

- (void)testApplicationTreeAttributesFiltering
{
  FBSnapshotTreeDouble *root = [self sampleTree];
  NSDictionary *full = [XCUIApplication dictionaryForElement:root displaySnapshots:nil recursive:YES excludedAttributes:nil];
  __block NSUInteger nodesCount = 0;
  [self visitNodes:full block:^(NSDictionary *node) {
    nodesCount++;
    XCTAssertNotNil(node[@"isVisible"], @"'isVisible' must be present without exclusions");
  }];
  XCTAssertEqual(nodesCount, 4u);

  NSDictionary *filtered = [XCUIApplication dictionaryForElement:root
                                                displaySnapshots:nil
                                                       recursive:YES
                                              excludedAttributes:[NSSet setWithObject:@"visible"]];
  nodesCount = 0;
  [self visitNodes:filtered block:^(NSDictionary *node) {
    nodesCount++;
    XCTAssertNil(node[@"isVisible"], @"'isVisible' must be excluded from every node");
    for (NSString *key in @[@"isEnabled", @"isAccessible", @"isNativeAccessibilityElement", @"isFocused",
                            @"traits", @"nativeFrame", @"customActions", @"frame", @"rect", @"type", @"name"]) {
      XCTAssertTrue([node.allKeys containsObject:key], @"'%@' must remain", key);
    }
  }];
  XCTAssertEqual(nodesCount, 4u);
}

- (void)testCustomActionsInJSONTree
{
  FBSnapshotTreeDouble *root = [self sampleTree];
  NSDictionary *tree = [XCUIApplication dictionaryForElement:root displaySnapshots:nil recursive:YES excludedAttributes:nil];
  __block NSUInteger nodesCount = 0;
  __block NSUInteger customActionsCount = 0;
  [self visitNodes:tree block:^(NSDictionary *node) {
    nodesCount++;
    if (nil != node[@"customActions"]) {
      customActionsCount++;
    }
  }];
  XCTAssertEqual(nodesCount, 4u);
  XCTAssertEqual(customActionsCount, nodesCount);
  XCTAssertEqualObjects([self findNodeNamed:@"Button" inTree:tree][@"customActions"], @"Custom Action 1,Custom Action 2");

  tree = [XCUIApplication dictionaryForElement:root
                              displaySnapshots:nil
                                     recursive:YES
                            excludedAttributes:[NSSet setWithObject:@"customActions"]];
  XCTAssertNotNil([self findNodeNamed:@"Button" inTree:tree]);
  nodesCount = 0;
  customActionsCount = 0;
  [self visitNodes:tree block:^(NSDictionary *node) {
    nodesCount++;
    if (nil != node[@"customActions"]) {
      customActionsCount++;
    }
  }];
  XCTAssertEqual(nodesCount, 4u);
  XCTAssertEqual(customActionsCount, 0u);
}

@end
