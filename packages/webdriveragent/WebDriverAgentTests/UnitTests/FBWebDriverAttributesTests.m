/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBAccessibilityTraits.h"
#import "FBSnapshotTreeDouble.h"
#import "FBXCElementSnapshotWrapper.h"
#import "XCUIElement+FBWebDriverAttributes.h"

// The base double hardcodes traits, so expose a settable one
@interface FBTraitsSnapshotDouble : FBSnapshotTreeDouble
@property (nonatomic, assign) UIAccessibilityTraits customTraits;
@end

@implementation FBTraitsSnapshotDouble
- (UIAccessibilityTraits)traits
{
  return self.customTraits;
}
@end

@interface FBWebDriverAttributesTests : XCTestCase
@end

@implementation FBWebDriverAttributesTests

- (FBSnapshotTreeDouble *)snapshotWithType:(XCUIElementType)type
                                identifier:(NSString *)identifier
                                     label:(NSString *)label
                                     value:(id)value
{
  FBSnapshotTreeDouble *snapshot = [FBSnapshotTreeDouble type:type label:label children:nil];
  snapshot.identifier = identifier;
  snapshot.value = value;
  return snapshot;
}

- (FBXCElementSnapshotWrapper *)wrap:(FBSnapshotTreeDouble *)snapshot
{
  return [FBXCElementSnapshotWrapper ensureWrapped:snapshot];
}

- (void)testAttributesPerElementType
{
  NSMutableString *longValue = [NSMutableString string];
  while (longValue.length < 500) {
    [longValue appendString:@"1234567890"];
  }
  NSNull *null = [NSNull null];
  NSArray<NSDictionary *> *cases = @[
    @{@"case": @"Label", @"type": @(XCUIElementTypeStaticText),
      @"id": @"Label", @"label": @"Label", @"value": @"Label",
      @"wdType": @"XCUIElementTypeStaticText", @"wdName": @"Label", @"wdLabel": @"Label", @"wdValue": @"Label"},
    @{@"case": @"Label without value falls back to label", @"type": @(XCUIElementTypeStaticText),
      @"id": @"Label", @"label": @"Label", @"value": null,
      @"wdType": @"XCUIElementTypeStaticText", @"wdName": @"Label", @"wdLabel": @"Label", @"wdValue": @"Label"},
    @{@"case": @"TextField", @"type": @(XCUIElementTypeTextField),
      @"id": null, @"label": @"", @"value": @"Value",
      @"wdType": @"XCUIElementTypeTextField", @"wdName": null, @"wdLabel": @"", @"wdValue": @"Value"},
    @{@"case": @"TextField with identifier", @"type": @(XCUIElementTypeTextField),
      @"id": @"aIdentifier", @"label": @"aLabel", @"value": @"Value2",
      @"wdType": @"XCUIElementTypeTextField", @"wdName": @"aIdentifier", @"wdLabel": @"aLabel", @"wdValue": @"Value2"},
    @{@"case": @"SegmentedControl", @"type": @(XCUIElementTypeSegmentedControl),
      @"id": null, @"label": null, @"value": null,
      @"wdType": @"XCUIElementTypeSegmentedControl", @"wdName": null, @"wdLabel": null, @"wdValue": null},
    @{@"case": @"ActivityIndicator", @"type": @(XCUIElementTypeActivityIndicator),
      @"id": @"Progress halted", @"label": @"Progress halted", @"value": @0,
      @"wdType": @"XCUIElementTypeActivityIndicator", @"wdName": @"Progress halted", @"wdLabel": @"Progress halted", @"wdValue": @"0"},
    @{@"case": @"PickerWheel", @"type": @(XCUIElementTypePickerWheel),
      @"id": null, @"label": null, @"value": @"Today",
      @"wdType": @"XCUIElementTypePickerWheel", @"wdName": null, @"wdLabel": null, @"wdValue": @"Today"},
    @{@"case": @"PageIndicator", @"type": @(XCUIElementTypePageIndicator),
      @"id": null, @"label": null, @"value": @"page 1 of 3",
      @"wdType": @"XCUIElementTypePageIndicator", @"wdName": null, @"wdLabel": null, @"wdValue": @"page 1 of 3"},
    @{@"case": @"TextView keeps long value", @"type": @(XCUIElementTypeTextView),
      @"id": null, @"label": null, @"value": longValue.copy,
      @"wdType": @"XCUIElementTypeTextView", @"wdName": null, @"wdLabel": null, @"wdValue": longValue.copy},
  ];
  id (^orNil)(id) = ^id(id raw) {
    return raw == null ? nil : raw;
  };
  for (NSDictionary *item in cases) {
    NSString *name = item[@"case"];
    FBSnapshotTreeDouble *snapshot = [self snapshotWithType:(XCUIElementType)[item[@"type"] unsignedIntegerValue]
                                                 identifier:orNil(item[@"id"])
                                                      label:orNil(item[@"label"])
                                                      value:orNil(item[@"value"])];
    FBXCElementSnapshotWrapper *wrapper = [self wrap:snapshot];
    XCTAssertEqualObjects(wrapper.wdType, orNil(item[@"wdType"]), @"%@: wdType", name);
    XCTAssertEqualObjects(wrapper.wdName, orNil(item[@"wdName"]), @"%@: wdName", name);
    XCTAssertEqualObjects(wrapper.wdLabel, orNil(item[@"wdLabel"]), @"%@: wdLabel", name);
    XCTAssertEqualObjects(wrapper.wdValue, orNil(item[@"wdValue"]), @"%@: wdValue", name);
  }
  XCTAssertEqual(longValue.length, 500u);
}

- (void)testNamePrefersIdentifierOverLabel
{
  FBSnapshotTreeDouble *snapshot = [self snapshotWithType:XCUIElementTypeButton identifier:@"id" label:@"lbl" value:nil];
  XCTAssertEqualObjects([self wrap:snapshot].wdName, @"id");
  snapshot.identifier = @"";
  XCTAssertEqualObjects([self wrap:snapshot].wdName, @"lbl");
  snapshot.identifier = nil;
  XCTAssertEqualObjects([self wrap:snapshot].wdName, @"lbl");
  snapshot.label = @"";
  XCTAssertNil([self wrap:snapshot].wdName);
}

- (void)testLabelEmptyStringHandling
{
  // Only text inputs keep an empty label; other types report nil
  XCTAssertEqualObjects([self wrap:[self snapshotWithType:XCUIElementTypeTextField identifier:nil label:@"" value:nil]].wdLabel, @"");
  XCTAssertEqualObjects([self wrap:[self snapshotWithType:XCUIElementTypeSecureTextField identifier:nil label:@"" value:nil]].wdLabel, @"");
  XCTAssertNil([self wrap:[self snapshotWithType:XCUIElementTypeButton identifier:nil label:@"" value:nil]].wdLabel);
}

- (void)testSwitchValueIsCoercedToBoolean
{
  NSNull *null = [NSNull null];
  NSArray<NSArray *> *cases = @[
    @[@1, @"1"], @[@0, @"0"], @[@"1", @"1"], @[@"0", @"0"], @[null, @"0"],
  ];
  for (NSArray *item in cases) {
    FBSnapshotTreeDouble *snapshot = [self snapshotWithType:XCUIElementTypeSwitch identifier:nil label:nil
                                                      value:item[0] == null ? nil : item[0]];
    FBXCElementSnapshotWrapper *wrapper = [self wrap:snapshot];
    XCTAssertEqualObjects(wrapper.wdType, @"XCUIElementTypeSwitch");
    XCTAssertNil(wrapper.wdName);
    XCTAssertNil(wrapper.wdLabel);
    XCTAssertNil(wrapper.wdPlaceholderValue);
    XCTAssertEqualObjects(wrapper.wdValue, item[1], @"raw value %@", item[0]);
    XCTAssertFalse(wrapper.isWDSelected);
  }
}

- (void)testIndexAttributes
{
  FBSnapshotTreeDouble *label = [FBSnapshotTreeDouble type:XCUIElementTypeStaticText label:@"Label" children:nil];
  FBSnapshotTreeDouble *field = [FBSnapshotTreeDouble type:XCUIElementTypeTextField label:@"Field" children:nil];
  FBSnapshotTreeDouble *button = [FBSnapshotTreeDouble type:XCUIElementTypeButton label:@"Button" children:nil];
  FBSnapshotTreeDouble *app = [FBSnapshotTreeDouble type:XCUIElementTypeApplication label:@"App"
                                                children:@[label, field, button]];
  XCTAssertEqual([self wrap:label].wdIndex, 0u);
  XCTAssertEqual([self wrap:field].wdIndex, 1u);
  XCTAssertEqual([self wrap:button].wdIndex, 2u);
  XCTAssertNil(app.parent);
  XCTAssertEqual([self wrap:app].wdIndex, 0u);
}

- (void)testAccessibilityTraitsToStrings
{
  XCTAssertEqualObjects(FBAccessibilityTraitsToStringsArray(UIAccessibilityTraitButton), @[@"Button"]);
  XCTAssertEqualObjects(FBAccessibilityTraitsToStringsArray(UIAccessibilityTraitAdjustable), @[@"Adjustable"]);
  XCTAssertEqual(FBAccessibilityTraitsToStringsArray(0).count, 0u);
  NSSet *combined = [NSSet setWithArray:FBAccessibilityTraitsToStringsArray(UIAccessibilityTraitLink | UIAccessibilityTraitSelected | UIAccessibilityTraitHeader)];
  XCTAssertEqualObjects(combined, ([NSSet setWithObjects:@"Link", @"Selected", @"Header", nil]));
}

- (void)testAccessibilityTraitsAttribute
{
  NSMutableArray<NSArray *> *cases = [NSMutableArray arrayWithArray:@[
    @[@"Button", @(UIAccessibilityTraitButton), @[@"Button"]],
    @[@"Slider", @(UIAccessibilityTraitAdjustable), @[@"Adjustable"]],
    @[@"PickerWheel", @(UIAccessibilityTraitAdjustable), @[@"Adjustable"]],
  ]];
#if __clang_major__ >= 16
  if (@available(iOS 17.0, *)) {
    [cases addObject:@[@"Toggle", @(UIAccessibilityTraitToggleButton | UIAccessibilityTraitButton), @[@"ToggleButton", @"Button"]]];
  }
#endif
  for (NSArray *item in cases) {
    FBTraitsSnapshotDouble *snapshot = [FBTraitsSnapshotDouble new];
    snapshot.customTraits = [item[1] unsignedLongLongValue];
    NSArray<NSString *> *actual = [[self wrap:snapshot].wdTraits componentsSeparatedByString:@", "];
    NSArray<NSString *> *expected = item[2];
    XCTAssertEqual(actual.count, expected.count, @"%@: traits count", item[0]);
    XCTAssertEqualObjects([NSSet setWithArray:actual], [NSSet setWithArray:expected], @"%@", item[0]);
  }
  FBTraitsSnapshotDouble *none = [FBTraitsSnapshotDouble new];
  none.customTraits = 0;
  XCTAssertEqualObjects([self wrap:none].wdTraits, @"");
}

@end
