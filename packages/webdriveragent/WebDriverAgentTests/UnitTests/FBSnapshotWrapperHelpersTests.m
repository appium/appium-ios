/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBSnapshotTreeDouble.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@interface FBSnapshotWrapperHelpersTests : XCTestCase
// Parent links are weak, so the tree root must be retained by the test
@property (nonatomic, strong) FBSnapshotTreeDouble *root;
@end

@implementation FBSnapshotWrapperHelpersTests

static FBSnapshotTreeDouble *node(XCUIElementType type, NSString *label, NSArray<FBSnapshotTreeDouble *> *children)
{
  return [FBSnapshotTreeDouble type:type label:label children:children];
}

static FBXCElementSnapshotWrapper *wrap(FBSnapshotTreeDouble *snapshot)
{
  return [FBXCElementSnapshotWrapper ensureWrapped:(id<FBXCElementSnapshot>)snapshot];
}

static FBSnapshotTreeDouble *visibleNode(XCUIElementType type, NSString *identifier, BOOL visible, NSArray<FBSnapshotTreeDouble *> *children)
{
  FBSnapshotTreeDouble *result = node(type, nil, children);
  result.identifier = identifier;
  result.additionalAttributes[FB_XCAXAIsVisibleAttribute] = @(visible);
  return result;
}

- (void)testDescendantsMatchingType
{
  NSArray<NSString *> *buttonLabels = @[@"Alerts", @"Attributes", @"Scroll"];
  FBSnapshotTreeDouble *nested = node(XCUIElementTypeOther, nil, @[
    node(XCUIElementTypeButton, buttonLabels[2], nil),
    node(XCUIElementTypeStaticText, @"text", nil),
  ]);
  self.root = node(XCUIElementTypeOther, @"MainView", @[
    node(XCUIElementTypeButton, buttonLabels[0], nil),
    node(XCUIElementTypeButton, buttonLabels[1], nil),
    nested,
    node(XCUIElementTypeSwitch, @"switch", nil),
  ]);
  NSArray<id<FBXCElementSnapshot>> *matching = [wrap(self.root) fb_descendantsMatchingType:XCUIElementTypeButton];
  XCTAssertEqual(matching.count, buttonLabels.count);
  XCTAssertEqualObjects([NSSet setWithArray:[matching valueForKeyPath:@"label"]], [NSSet setWithArray:buttonLabels]);
  NSArray<NSNumber *> *types = [matching valueForKeyPath:@"@distinctUnionOfObjects.elementType"];
  XCTAssertEqual(types.count, 1, @"matchingSnapshots should contain only one type");
  XCTAssertEqualObjects(types.lastObject, @(XCUIElementTypeButton));
}

- (void)testParentMatchingType
{
  FBSnapshotTreeDouble *button = node(XCUIElementTypeButton, @"Alerts", nil);
  FBSnapshotTreeDouble *window = node(XCUIElementTypeWindow, nil, @[
    node(XCUIElementTypeOther, @"MainView", @[button]),
  ]);
  self.root = node(XCUIElementTypeApplication, nil, @[window]);
  id<FBXCElementSnapshot> result = [wrap(button) fb_parentMatchingType:XCUIElementTypeWindow];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elementType, XCUIElementTypeWindow);
  XCTAssertTrue(result == (id)window);
}

- (void)testParentMatchingOneOfTypes
{
  FBSnapshotTreeDouble *wheel = node(XCUIElementTypePickerWheel, @"Today", nil);
  FBSnapshotTreeDouble *picker = node(XCUIElementTypeDatePicker, nil, @[
    node(XCUIElementTypePicker, nil, @[wheel]),
  ]);
  self.root = node(XCUIElementTypeWindow, nil, @[picker]);
  id<FBXCElementSnapshot> result = [wrap(wheel) fb_parentMatchingOneOfTypes:@[@(XCUIElementTypeDatePicker), @(XCUIElementTypeWindow)]];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elementType, XCUIElementTypeDatePicker);
}

- (void)testParentMatchingOneOfTypesWithXCUIElementTypeAny
{
  FBSnapshotTreeDouble *wheel = node(XCUIElementTypePickerWheel, @"Today", nil);
  self.root = node(XCUIElementTypeWindow, nil, @[
    node(XCUIElementTypeDatePicker, nil, @[wheel]),
  ]);
  XCTAssertNotNil([wrap(wheel) fb_parentMatchingOneOfTypes:@[@(XCUIElementTypeAny)]]);
}

- (void)testParentMatchingOneOfTypesWithAbsentParents
{
  FBSnapshotTreeDouble *wheel = node(XCUIElementTypePickerWheel, @"Today", nil);
  self.root = node(XCUIElementTypeWindow, nil, @[
    node(XCUIElementTypeDatePicker, nil, @[wheel]),
  ]);
  NSArray *absentTypes = @[@(XCUIElementTypeTab), @(XCUIElementTypeLink)];
  XCTAssertNil([wrap(wheel) fb_parentMatchingOneOfTypes:absentTypes]);
}

- (void)testParentMatchingOneOfTypesWithFilter
{
  FBSnapshotTreeDouble *text = node(XCUIElementTypeStaticText, @"3", nil);
  FBSnapshotTreeDouble *scrollView = visibleNode(XCUIElementTypeScrollView, @"scrollView", YES, @[
    // Accepted type, but filtered out by visibility
    visibleNode(XCUIElementTypeTable, @"hiddenTable", NO, @[text]),
  ]);
  self.root = node(XCUIElementTypeWindow, nil, @[scrollView]);
  NSArray *acceptedParents = @[@(XCUIElementTypeScrollView), @(XCUIElementTypeCollectionView), @(XCUIElementTypeTable)];
  id<FBXCElementSnapshot> result = [wrap(text) fb_parentMatchingOneOfTypes:acceptedParents
                                                                    filter:^BOOL(id<FBXCElementSnapshot> snapshot) {
    return [[FBXCElementSnapshotWrapper ensureWrapped:snapshot] isWDVisible];
  }];
  XCTAssertEqualObjects(result.identifier, @"scrollView");
}

- (void)testParentMatchingOneOfTypesWithFilterRetruningNo
{
  FBSnapshotTreeDouble *text = node(XCUIElementTypeStaticText, @"3", nil);
  self.root = node(XCUIElementTypeWindow, nil, @[
    visibleNode(XCUIElementTypeScrollView, @"scrollView", YES, @[text]),
  ]);
  NSArray *acceptedParents = @[@(XCUIElementTypeScrollView), @(XCUIElementTypeCollectionView), @(XCUIElementTypeTable)];
  id<FBXCElementSnapshot> result = [wrap(text) fb_parentMatchingOneOfTypes:acceptedParents
                                                                    filter:^BOOL(id<FBXCElementSnapshot> snapshot) {
    return NO;
  }];
  XCTAssertNil(result);
}

- (void)testDescendantsCellSnapshots
{
  NSMutableArray<FBSnapshotTreeDouble *> *cells = [NSMutableArray array];
  for (NSUInteger i = 0; i < 12; i++) {
    NSString *label = [NSString stringWithFormat:@"%lu", (unsigned long)i];
    [cells addObject:node(XCUIElementTypeCell, label, @[node(XCUIElementTypeStaticText, label, nil)])];
  }
  self.root = node(XCUIElementTypeScrollView, nil, cells);
  NSArray<id<FBXCElementSnapshot>> *result = [wrap(self.root) fb_descendantsCellSnapshots];
  XCTAssertEqual(result.count, cells.count);
  for (id<FBXCElementSnapshot> snapshot in result) {
    XCTAssertEqual(snapshot.elementType, XCUIElementTypeCell);
  }
  NSPredicate *predicate = [NSPredicate predicateWithFormat:@"label == %@", @"0"];
  XCTAssertNotNil([result filteredArrayUsingPredicate:predicate].firstObject, @"No element with label '0' was found.");
}

- (void)testDescendantsCellSnapshotsFallBackToIconsThenAllDescendants
{
  self.root = node(XCUIElementTypeOther, nil, @[
    node(XCUIElementTypeIcon, @"icon1", nil),
    node(XCUIElementTypeIcon, @"icon2", nil),
    node(XCUIElementTypeStaticText, @"text", nil),
  ]);
  XCTAssertEqual([wrap(self.root) fb_descendantsCellSnapshots].count, 2);

  self.root = node(XCUIElementTypeOther, nil, @[
    node(XCUIElementTypeButton, @"b", nil),
    node(XCUIElementTypeStaticText, @"text", nil),
  ]);
  XCTAssertEqual([wrap(self.root) fb_descendantsCellSnapshots].count, 2);
}

- (void)testParentCellSnapshot
{
  FBSnapshotTreeDouble *text = node(XCUIElementTypeStaticText, @"3", nil);
  FBSnapshotTreeDouble *cell = node(XCUIElementTypeCell, nil, @[
    node(XCUIElementTypeOther, nil, @[text]),
  ]);
  self.root = node(XCUIElementTypeScrollView, nil, @[cell]);
  id<FBXCElementSnapshot> result = [wrap(text) fb_parentCellSnapshot];
  XCTAssertEqual(result.elementType, XCUIElementTypeCell);
  XCTAssertTrue(result == (id)cell);
  // A cell is its own parent cell
  XCTAssertTrue([wrap(cell) fb_parentCellSnapshot] == (id)cell);
}

@end
