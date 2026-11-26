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

- (void)testErroneousGestures
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  NSArray<NSArray<NSDictionary<NSString *, id> *> *> *invalidGestures =
  @[

    // missing balance 1
    @[@{
        @"type": @"key",
        @"id": @"keyboard",
        @"actions": @[
            @{@"type": @"keyDown", @"value": @"h"},
            @{@"type": @"keyUp", @"value": @"k"},
        ],
        },
      ],

    // missing balance 2
    @[@{
        @"type": @"key",
        @"id": @"keyboard",
        @"actions": @[
            @{@"type": @"keyDown", @"value": @"h"},
        ],
        },
      ],

    // missing balance 3
    @[@{
        @"type": @"key",
        @"id": @"keyboard",
        @"actions": @[
            @{@"type": @"keyUp", @"value": @"h"},
        ],
        },
      ],

    // missing key value
    @[@{
        @"type": @"key",
        @"id": @"keyboard",
        @"actions": @[
            @{@"type": @"keyUp"},
        ],
        },
      ],

    // wrong key value
    @[@{
        @"type": @"key",
        @"id": @"keyboard",
        @"actions": @[
            @{@"type": @"keyUp", @"value": @500},
        ],
        },
      ],

    // wrong duration value
    @[@{
        @"type": @"key",
        @"id": @"keyboard",
        @"actions": @[
            @{@"type": @"duration", @"duration": @"bla"},
        ],
        },
      ],

    ];

  for (NSArray<NSDictionary<NSString *, id> *> *invalidGesture in invalidGestures) {
    NSError *error;
    XCTAssertFalse([self.testedApplication fb_performW3CActions:invalidGesture elementCache:nil error:&error]);
    XCTAssertNotNil(error);
  }
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

- (void)testTextTypingWithEmptyActions
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSArray<NSDictionary<NSString *, id> *> *typeAction =
    @[
      @{
      @"type": @"pointer",
      @"id": @"touch",
      @"actions": @[],
      },
    ];
  NSError *error;
  XCTAssertTrue([self.testedApplication fb_performW3CActions:typeAction
                                                elementCache:nil
                                                       error:&error]);
  XCTAssertNil(error);
  XCTAssertEqualObjects(textField.value, @"");
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

- (void)testPauseWithoutDuration
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  [self performKeyActions:@[
    @{@"type": @"pause"},
    FBKeyDown(@"a"), FBKeyUp(@"a"),
    @{@"type": @"pause"},
    FBKeyDown(@"b"), FBKeyUp(@"b"),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"ab");
}

- (void)testTrailingPauseWithoutDuration
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  [self performKeyActions:@[FBKeyDown(@"a"), FBKeyUp(@"a"), @{@"type": @"pause"}]];
  XCTAssertEqualObjects(textField.wdValue, @"a");
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

- (void)testArrowKeysWithoutModifiers
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSString *left = [NSString stringWithFormat:@"%C", 0xE012];
  NSString *right = [NSString stringWithFormat:@"%C", 0xE014];
  [self performKeyActions:@[
    FBKeyDown(@"a"), FBKeyUp(@"a"), FBKeyDown(@"b"), FBKeyUp(@"b"), FBKeyDown(@"c"), FBKeyUp(@"c"),
    FBKeyDown(left), FBKeyUp(left), FBKeyDown(left), FBKeyUp(left),
    FBKeyDown(right), FBKeyUp(right),
    FBKeyDown(@"1"), FBKeyUp(@"1"),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"ab1c");
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

- (void)testBackspaceUnderModifierIsRejected
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  NSString *shift = [NSString stringWithFormat:@"%C", 0xE008];
  NSString *backspace = [NSString stringWithFormat:@"%C", 0xE003];
  NSArray *actions = @[@{@"type": @"key", @"id": @"keyboard", @"actions": @[FBKeyDown(shift), FBKeyDown(backspace), FBKeyUp(backspace), FBKeyUp(shift)]}];
  NSError *error;
  BOOL result = [self.testedApplication fb_performW3CActions:actions elementCache:nil error:&error];
  XCTAssertFalse(result);
  XCTAssertNotNil(error);
}

- (void)testUnsupportedKeyIsRejected
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  NSString *insert = [NSString stringWithFormat:@"%C", 0xE016];
  NSArray *actions = @[@{@"type": @"key", @"id": @"keyboard", @"actions": @[FBKeyDown(insert), FBKeyUp(insert)]}];
  NSError *error;
  BOOL result = [self.testedApplication fb_performW3CActions:actions elementCache:nil error:&error];
  XCTAssertFalse(result);
  XCTAssertNotNil(error);
}

- (void)testOverlappingLeftAndRightShift
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  XCUIElement *textField = self.testedApplication.textFields[@"aIdentifier"];
  [textField tap];
  NSString *leftShift = [NSString stringWithFormat:@"%C", 0xE008];
  NSString *rightShift = [NSString stringWithFormat:@"%C", 0xE050];
  [self performKeyActions:@[
    FBKeyDown(leftShift), FBKeyDown(rightShift), FBKeyUp(leftShift),
    FBKeyDown(@"a"), FBKeyUp(@"a"),
    FBKeyUp(rightShift),
    FBKeyDown(@"b"), FBKeyUp(@"b"),
  ]];
  XCTAssertEqualObjects(textField.wdValue, @"Ab");
}

- (void)testUnsupportedKeyUnderModifierIsRejected
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  NSString *control = [NSString stringWithFormat:@"%C", 0xE009];
  NSString *insert = [NSString stringWithFormat:@"%C", 0xE016];
  NSArray *actions = @[@{@"type": @"key", @"id": @"keyboard", @"actions": @[FBKeyDown(control), FBKeyDown(insert), FBKeyUp(insert), FBKeyUp(control)]}];
  NSError *error;
  BOOL result = [self.testedApplication fb_performW3CActions:actions elementCache:nil error:&error];
  XCTAssertFalse(result);
  XCTAssertNotNil(error);
}

- (void)testUnbalancedModifierIsRejected
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }

  NSString *control = [NSString stringWithFormat:@"%C", 0xE009];
  NSArray *actions = @[@{@"type": @"key", @"id": @"keyboard", @"actions": @[FBKeyDown(control), FBKeyDown(@"a"), FBKeyUp(@"a")]}];
  NSError *error;
  BOOL result = [self.testedApplication fb_performW3CActions:actions elementCache:nil error:&error];
  XCTAssertFalse(result);
  XCTAssertNotNil(error);
}

@end
