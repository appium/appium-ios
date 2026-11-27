/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBW3CActionsHelpers.h"
#import "FBW3CActionsSynthesizer.h"
#import "FBXCodeCompatibility.h"
#import "XCPointerEvent.h"
#import "XCPointerEventPath.h"

@interface FBW3CActionsSynthesizer (FBW3CKeyActionsTests)

- (nullable NSArray<XCPointerEventPath *> *)eventPathsWithKeyAction:(NSDictionary<NSString *, id> *)actionDescription
                                                        forActionId:(NSString *)actionId
                                                              error:(NSError **)error;

@end

static NSString *K(unichar code)
{
  return [NSString stringWithFormat:@"%C", code];
}

static NSDictionary<NSString *, id> *Down(NSString *value)
{
  return @{@"type": @"keyDown", @"value": value};
}

static NSDictionary<NSString *, id> *Up(NSString *value)
{
  return @{@"type": @"keyUp", @"value": value};
}

static NSDictionary<NSString *, id> *Pause(id duration)
{
  return nil == duration ? @{@"type": @"pause"} : @{@"type": @"pause", @"duration": duration};
}

// A key press, which consists of the paired down and up items
static NSArray<NSDictionary<NSString *, id> *> *Press(NSString *value)
{
  return @[Down(value), Up(value)];
}

static NSArray<NSDictionary<NSString *, id> *> *Flat(NSArray<id> *parts)
{
  NSMutableArray *result = [NSMutableArray array];
  for (id part in parts) {
    if ([part isKindOfClass:NSArray.class]) {
      [result addObjectsFromArray:part];
    } else {
      [result addObject:part];
    }
  }
  return result.copy;
}

static NSArray<NSDictionary<NSString *, id> *> *KeyActions(NSArray<NSDictionary<NSString *, id> *> *items)
{
  return @[@{@"type": @"key", @"id": @"keyboard", @"actions": items}];
}

@interface FBW3CKeyActionsTests : XCTestCase
@end

@implementation FBW3CKeyActionsTests

- (FBW3CActionsSynthesizer *)synthesizerWithActions:(NSArray *)actions
{
  NSError *error;
  FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc] initWithActions:actions
                                                                           forApplication:(id)nil
                                                                             elementCache:nil
                                                                                    error:&error];
  XCTAssertNotNil(synthesizer, @"%@", error);
  return synthesizer;
}

// Compact representation of the planned actions
- (nullable NSArray<NSString *> *)plan:(NSArray *)parts error:(NSError **)error
{
  NSArray<FBKeyAction *> *actions = [[self synthesizerWithActions:KeyActions(Flat(parts))] keyActionsWithError:error];
  if (nil == actions) {
    return nil;
  }
  NSMutableArray<NSString *> *result = [NSMutableArray array];
  for (FBKeyAction *action in actions) {
    switch (action.kind) {
      case FBKeyActionKindDelay:
        [result addObject:[NSString stringWithFormat:@"delay:%@", @(action.delay)]];
        break;
      case FBKeyActionKindModifiers:
        [result addObject:[NSString stringWithFormat:@"mod:%@", @(action.modifierFlags)]];
        break;
      case FBKeyActionKindText:
        [result addObject:[NSString stringWithFormat:@"text:%@", action.value]];
        break;
      case FBKeyActionKindKey:
        [result addObject:[NSString stringWithFormat:@"key:%@@%@", action.value, @(action.modifierFlags)]];
        break;
    }
  }
  return result.copy;
}

- (void)assertPlan:(NSArray *)parts equals:(NSArray<NSString *> *)expected
{
  NSError *error;
  XCTAssertEqualObjects([self plan:parts error:&error], expected, @"%@", error);
}

- (void)assertPlanFails:(NSArray *)parts
{
  NSError *error;
  XCTAssertNil([self plan:parts error:&error]);
  XCTAssertNotNil(error);
}

#pragma mark - Helpers

- (void)testModifierMapping
{
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE008)), @2);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE050)), @2);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE009)), @4);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE051)), @4);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE00A)), @8);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE052)), @8);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE03D)), @16);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE053)), @16);
  XCTAssertEqualObjects(FBToMetaModifier(K(0xE000)), @0);
  XCTAssertNil(FBToMetaModifier(@"a"));
  XCTAssertNil(FBToMetaModifier(@""));
  XCTAssertNil(FBToMetaModifier(@"ab"));
}

- (void)testKeyboardKeyMapping
{
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE012)), K(0x2190));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE013)), K(0x2191));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE014)), K(0x2192));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE015)), K(0x2193));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE011)), K(0xF729));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE010)), K(0xF72B));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE00E)), K(0xF72C));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE00F)), K(0xF72D));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE031)), K(0xF704));
  XCTAssertEqualObjects(FBMapToXCUIKeyboardKey(K(0xE03C)), K(0xF70F));
  XCTAssertNil(FBMapToXCUIKeyboardKey(@"a"));
  XCTAssertNil(FBMapToXCUIKeyboardKey(K(0xE003)));
}

- (void)testRequiresKeyRecordPredicate
{
  // No text representation
  XCTAssertTrue(FBRequiresKeyRecord(K(0xE008)));
  XCTAssertTrue(FBRequiresKeyRecord(K(0xE012)));
  XCTAssertTrue(FBRequiresKeyRecord(K(0xE031)));
  XCTAssertTrue(FBRequiresKeyRecord(K(0xE016)));
  // Can be typed as text
  XCTAssertFalse(FBRequiresKeyRecord(@"a"));
  XCTAssertFalse(FBRequiresKeyRecord(K(0xE003)));
  XCTAssertFalse(FBRequiresKeyRecord(K(0xE006)));
  XCTAssertFalse(FBRequiresKeyRecord(K(0xE00D)));
  // The NULL key is a no-op for plain text
  XCTAssertFalse(FBRequiresKeyRecord(K(0xE000)));
  XCTAssertFalse(FBRequiresKeyRecord(@""));
}

#pragma mark - Routing

- (void)testRequiresKeyRecords
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCTAssertFalse([self synthesizerWithActions:KeyActions(Flat(@[Press(@"a"), Press(K(0xE003))]))].requiresKeyRecords);
  XCTAssertFalse([self synthesizerWithActions:KeyActions(Flat(@[Press(K(0xE000))]))].requiresKeyRecords);
  XCTAssertTrue([self synthesizerWithActions:KeyActions(Flat(@[Down(K(0xE009)), Press(@"a"), Up(K(0xE009))]))].requiresKeyRecords);
  XCTAssertTrue([self synthesizerWithActions:KeyActions(Flat(@[Press(K(0xE012))]))].requiresKeyRecords);

  NSArray *pointer = @[@{@"type": @"pointer", @"id": @"mouse", @"actions": @[]}];
  XCTAssertFalse([self synthesizerWithActions:pointer].requiresKeyRecords);
  NSDictionary *activePointer = @{@"type": @"pointer", @"id": @"mouse", @"actions": @[@{@"type": @"pause", @"duration": @0}]};
  NSArray *mixed = @[KeyActions(Flat(@[Press(K(0xE012))])).firstObject, activePointer];
  XCTAssertFalse([self synthesizerWithActions:mixed].requiresKeyRecords);
}

- (void)testEmptySourcesDoNotAffectRouting
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  NSDictionary *keyboard = KeyActions(Flat(@[Down(K(0xE008)), Press(@"a"), Up(K(0xE008))])).firstObject;
  NSDictionary *emptyKeyboard = @{@"type": @"key", @"id": @"keyboard2", @"actions": @[]};
  NSDictionary *emptyPointer = @{@"type": @"pointer", @"id": @"mouse", @"actions": @[]};
  NSArray *withEmptyKeyboard = @[keyboard, emptyKeyboard];
  NSArray *withEmptySources = @[emptyPointer, keyboard, emptyKeyboard];
  XCTAssertTrue([self synthesizerWithActions:withEmptyKeyboard].requiresKeyRecords);
  XCTAssertTrue([self synthesizerWithActions:withEmptySources].requiresKeyRecords);

  NSError *error;
  NSArray<FBKeyAction *> *plan = [[self synthesizerWithActions:withEmptyKeyboard] keyActionsWithError:&error];
  XCTAssertNotNil(plan, @"%@", error);
  XCTAssertEqual(plan.count, 3u);
  XCTAssertEqualObjects(plan[1].value, @"A");
}

#pragma mark - Planning

- (void)testPlainKeysAreBatchedIntoSingleText
{
  [self assertPlan:@[Press(@"a"), Press(@"b"), Press(@"c")] equals:@[@"text:abc"]];
}

- (void)testPauseSplitsText
{
  [self assertPlan:@[Press(@"a"), Pause(@100), Press(@"b")]
            equals:@[@"text:a", @"delay:0.1", @"text:b"]];
}

- (void)testPausesWithoutPositiveDurationAreIgnored
{
  [self assertPlan:@[Press(@"a"), Pause(nil), Press(@"b")] equals:@[@"text:ab"]];
  [self assertPlan:@[Press(@"a"), Pause(@0), Press(@"b")] equals:@[@"text:ab"]];
  [self assertPlan:@[Pause(nil), Press(@"a"), Pause(nil)] equals:@[@"text:a"]];
}

- (void)testHeldModifierAcrossPause
{
  NSString *shift = K(0xE008);
  [self assertPlan:@[Down(shift), Press(@"a"), Pause(@100), Press(@"b"), Up(shift), Press(@"c")]
            equals:@[@"mod:2", @"text:A", @"delay:0.1", @"text:B", @"mod:0", @"text:c"]];
}

- (void)testModifierCombination
{
  NSString *command = K(0xE03D);
  [self assertPlan:@[Press(@"a"), Press(@"b"), Down(command), Press(@"a"), Up(command), Press(@"x")]
            equals:@[@"text:ab", @"mod:16", @"key:a@16", @"mod:0", @"text:x"]];
}

- (void)testSeveralModifiersAreCombined
{
  [self assertPlan:@[Down(K(0xE009)), Down(K(0xE008)), Press(@"a"), Up(K(0xE008)), Press(@"b"), Up(K(0xE009))]
            equals:@[@"mod:4", @"mod:6", @"key:a@6", @"mod:4", @"key:b@4", @"mod:0"]];
}

- (void)testLeftAndRightVariantsAreCountedSeparately
{
  NSString *left = K(0xE008);
  NSString *right = K(0xE050);
  [self assertPlan:@[Down(left), Down(right), Up(left), Press(@"a"), Up(right), Press(@"b")]
            equals:@[@"mod:2", @"text:A", @"mod:0", @"text:b"]];
}

- (void)testRepeatedModifierPressIsARepeat
{
  NSString *shift = K(0xE008);
  [self assertPlan:@[Down(shift), Down(shift), Up(shift), Press(@"a")]
            equals:@[@"mod:2", @"mod:0", @"text:a"]];
}

- (void)testKeyIsTypedWithModifiersPressedAtKeyDown
{
  NSString *command = K(0xE03D);
  NSArray *expected = @[@"mod:16", @"key:a@16", @"mod:0"];
  // The order of the releases must not matter
  [self assertPlan:@[Down(command), Down(@"a"), Up(command), Up(@"a")] equals:expected];
  [self assertPlan:@[Down(command), Down(@"a"), Up(@"a"), Up(command)] equals:expected];
  // The modifier pressed after the key does not apply to it
  [self assertPlan:@[Down(@"a"), Down(command), Up(@"a"), Up(command)]
            equals:@[@"text:a", @"mod:16", @"mod:0"]];
}

- (void)testShiftedLettersAreTypedAsText
{
  NSString *shift = K(0xE008);
  [self assertPlan:@[Down(shift), Press(@"a"), Press(@"1"), Up(shift)]
            equals:@[@"mod:2", @"text:A", @"key:1@2", @"mod:0"]];
  // Other modifiers keep the letter as a key
  [self assertPlan:@[Down(K(0xE009)), Down(shift), Press(@"a"), Up(shift), Up(K(0xE009))]
            equals:@[@"mod:4", @"mod:6", @"key:a@6", @"mod:4", @"mod:0"]];
}

- (void)testNullKeyReleasesAllModifiers
{
  NSString *control = K(0xE009);
  NSString *shift = K(0xE008);
  [self assertPlan:@[Down(control), Down(shift), Press(K(0xE000)), Press(@"a"), Up(shift), Up(control)]
            equals:@[@"mod:4", @"mod:6", @"mod:0", @"text:a"]];
}

- (void)testNullKeyReleasesModifiersWithoutKeyUp
{
  NSString *shift = K(0xE008);
  NSArray *expected = @[@"mod:2", @"mod:0", @"text:a"];
  [self assertPlan:@[Down(shift), Down(K(0xE000)), Up(K(0xE000)), Down(@"a"), Up(@"a")] equals:expected];
  // The key up of the released modifier is still accepted
  [self assertPlan:@[Down(shift), Down(K(0xE000)), Up(K(0xE000)), Down(@"a"), Up(@"a"), Up(shift)] equals:expected];
}

- (void)testNavigationKeysSeparateText
{
  [self assertPlan:@[Press(@"a"), Press(@"b"), Press(K(0xE012)), Press(K(0xE003))]
            equals:@[@"text:ab", [NSString stringWithFormat:@"key:%@@0", K(0x2190)], @"text:\b"]];
}

- (void)testArrowKeyUnderModifier
{
  NSString *shift = K(0xE008);
  [self assertPlan:@[Down(shift), Press(K(0xE012)), Up(shift)]
            equals:@[@"mod:2", [NSString stringWithFormat:@"key:%@@2", K(0x2190)], @"mod:0"]];
}

- (void)testSpecialCharacterIsTypedAsKeyUnderModifier
{
  NSString *control = K(0xE009);
  [self assertPlan:@[Down(control), Press(K(0xE006)), Up(control)]
            equals:@[@"mod:4", @"key:\r@4", @"mod:0"]];
}

#pragma mark - Validation

- (void)testUnbalancedKeysAreRejected
{
  [self assertPlanFails:@[Up(@"a")]];
  [self assertPlanFails:@[Down(@"a")]];
  [self assertPlanFails:@[Down(K(0xE009)), Press(@"a")]];
  [self assertPlanFails:@[Down(@"a"), Up(@"b")]];
}

- (void)testBalancedKeysAcrossPauseAreAccepted
{
  NSString *control = K(0xE009);
  [self assertPlan:@[Down(control), Pause(@100), Up(control)] equals:@[@"mod:4", @"delay:0.1", @"mod:0"]];
}

- (void)testUnsupportedKeysAreRejected
{
  NSString *insert = K(0xE016);
  [self assertPlanFails:@[Press(insert)]];
  [self assertPlanFails:@[Down(K(0xE009)), Press(insert), Up(K(0xE009))]];
}

- (void)testDeleteKeysUnderModifierAreRejected
{
  NSString *shift = K(0xE008);
  [self assertPlanFails:@[Down(shift), Press(K(0xE003)), Up(shift)]];
  [self assertPlanFails:@[Down(shift), Press(K(0xE017)), Up(shift)]];
}

- (void)testInvalidPausesAreRejected
{
  [self assertPlanFails:@[Press(@"a"), Pause(@-1)]];
  // The total pause duration is limited
  [self assertPlanFails:@[Pause(@200000), Press(@"a"), Pause(@200000)]];
  [self assertPlan:@[Pause(@300000)] equals:@[@"delay:300"]];
}

- (void)testKeyActionRequiresId
{
  NSArray *actions = @[@{@"type": @"key", @"actions": Press(@"a")}];
  NSError *error;
  XCTAssertNil([[self synthesizerWithActions:actions] keyActionsWithError:&error]);
  XCTAssertNotNil(error);
}

#pragma mark - Text typing path

- (NSArray<NSString *> *)typedTextsOf:(NSArray *)parts
{
  NSError *error;
  NSArray<XCPointerEventPath *> *paths = [[self synthesizerWithActions:KeyActions(Flat(parts))]
                                          eventPathsWithKeyAction:KeyActions(Flat(parts)).firstObject
                                          forActionId:@"keyboard"
                                          error:&error];
  XCTAssertNotNil(paths, @"%@", error);
  NSMutableArray<NSString *> *result = [NSMutableArray array];
  for (XCPointerEventPath *path in paths) {
    for (XCPointerEvent *event in path.pointerEvents) {
      [result addObject:event.string ?: @""];
    }
  }
  return result.copy;
}

- (void)assertTyped:(NSArray *)parts equals:(NSArray<NSString *> *)expected
{
  XCTAssertEqualObjects([self typedTextsOf:parts], expected);
}

- (void)testPauseWithDurationSplitsTypedText
{
  [self assertTyped:@[Press(@"a"), Pause(@100), Press(@"b")] equals:@[@"a", @"b"]];
}

- (void)testPauseWithoutDurationDoesNotSplitTypedText
{
  [self assertTyped:@[Press(@"a"), Pause(nil), Press(@"b")] equals:@[@"ab"]];
  [self assertTyped:@[Press(@"a"), Pause(@0), Press(@"b")] equals:@[@"ab"]];
}

- (void)testTrailingPauseWithoutDurationKeepsTypedText
{
  [self assertTyped:@[Press(@"a"), Pause(nil)] equals:@[@"a"]];
}

@end
