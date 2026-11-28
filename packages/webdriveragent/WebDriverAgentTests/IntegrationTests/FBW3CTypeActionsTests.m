/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBIntegrationTestCase.h"
#import "XCUIElement.h"
#import "XCUIElement+FBTyping.h"
#import "XCUIApplication+FBTouchAction.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "FBRuntimeUtils.h"
#import "FBXCodeCompatibility.h"


@interface FBW3CTypeActionsTests : FBIntegrationTestCase
@end

@implementation FBW3CTypeActionsTests

- (void)setUp
{
  [super setUp];
  [self launchApplication];
  [self goToAttributesPage];
}

- (void)testTextTyping
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSArray<NSDictionary<NSString *, id> *> *typeAction =
    @[
      @{
      @"type": @"key",
      @"id": @"keyboard2",
      @"actions": @[
          @{@"type": @"pause", @"duration": @500},
          @{@"type": @"keyDown", @"value": @"🏀"},
          @{@"type": @"keyUp", @"value": @"🏀"},
          @{@"type": @"keyDown", @"value": @"N"},
          @{@"type": @"keyUp", @"value": @"N"},
          @{@"type": @"keyDown", @"value": @"B"},
          @{@"type": @"keyUp", @"value": @"B"},
          @{@"type": @"keyDown", @"value": @"A"},
          @{@"type": @"keyUp", @"value": @"A"},
          @{@"type": @"keyDown", @"value": @"a"},
          @{@"type": @"keyUp", @"value": @"a"},
          @{@"type": @"keyDown", @"value": [NSString stringWithFormat:@"%C", 0xE003]},
          @{@"type": @"keyUp", @"value": [NSString stringWithFormat:@"%C", 0xE003]},
          @{@"type": @"pause", @"duration": @500},
          ],
      },
    ];
  NSError *error;
  XCTAssertTrue([self.testedApplication fb_performW3CActions:typeAction
                                                elementCache:nil
                                                       error:&error]);
  XCTAssertNil(error);
  XCTAssertEqualObjects(textField.wdValue, @"🏀NBA");
}


static NSDictionary<NSString *, id> *FBKeyDown(NSString *value) { return @{@"type": @"keyDown", @"value": value}; }
static NSDictionary<NSString *, id> *FBKeyUp(NSString *value) { return @{@"type": @"keyUp", @"value": value}; }

- (void)performKeyActions:(NSArray<NSDictionary<NSString *, id> *> *)items
{
  NSArray *actions = @[@{@"type": @"key", @"id": @"keyboard", @"actions": items}];
  NSError *error;
  BOOL result = [self.testedApplication fb_performW3CActions:actions elementCache:nil error:&error];
  XCTAssertTrue(result, @"%@", error);
  XCTAssertNil(error);
}

- (void)testHeldShiftModifier
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSString *shift = [NSString stringWithFormat:@"%C", 0xE008];
  [self performKeyActions:@[
    FBKeyDown(shift),
    FBKeyDown(@"a"), FBKeyUp(@"a"),
    @{@"type": @"pause", @"duration": @100},
    FBKeyDown(@"b"), FBKeyUp(@"b"),
    FBKeyUp(shift),
    FBKeyDown(@"c"), FBKeyUp(@"c"),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"ABc");
}

- (void)testHeldCommandSelectAll
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSString *command = [NSString stringWithFormat:@"%C", 0xE03D];
  [self performKeyActions:@[
    FBKeyDown(@"a"), FBKeyUp(@"a"), FBKeyDown(@"b"), FBKeyUp(@"b"),
    FBKeyDown(command), FBKeyDown(@"a"), FBKeyUp(@"a"), FBKeyUp(command),
    FBKeyDown(@"x"), FBKeyUp(@"x"),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"x");
}

- (void)testHeldShiftWithArrowKey
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSString *shift = [NSString stringWithFormat:@"%C", 0xE008];
  NSString *left = [NSString stringWithFormat:@"%C", 0xE012];
  [self performKeyActions:@[
    FBKeyDown(@"a"), FBKeyUp(@"a"), FBKeyDown(@"b"), FBKeyUp(@"b"),
    FBKeyDown(shift), FBKeyDown(left), FBKeyUp(left), FBKeyUp(shift),
    FBKeyDown(@"x"), FBKeyUp(@"x"),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"ax");
}

- (void)testBackspaceAfterNavigationKey
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSString *left = [NSString stringWithFormat:@"%C", 0xE012];
  NSString *backspace = [NSString stringWithFormat:@"%C", 0xE003];
  [self performKeyActions:@[
    FBKeyDown(@"a"), FBKeyUp(@"a"), FBKeyDown(@"b"), FBKeyUp(@"b"), FBKeyDown(@"c"), FBKeyUp(@"c"),
    FBKeyDown(left), FBKeyUp(left),
    FBKeyDown(backspace), FBKeyUp(backspace),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"ac");
}

@end
