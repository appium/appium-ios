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

@end
