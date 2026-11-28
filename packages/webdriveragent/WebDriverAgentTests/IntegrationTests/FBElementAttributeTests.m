/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBIntegrationTestCase.h"
#import "FBFindElementCommands.h"
#import "FBTestMacros.h"
#import "FBXCodeCompatibility.h"
#import "XCUIElement+FBAccessibility.h"
#import "XCUIElement+FBCustomActions.h"
#import "XCUIElement+FBIsVisible.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@interface FBElementAttributeTests : FBIntegrationTestCase
@end

@implementation FBElementAttributeTests

- (void)setUp
{
  [super setUp];
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    [self launchApplication];
    [self goToAttributesPage];
  });
}

- (void)testElementAccessibilityAttributes
{
  // "Button" is accessibility element, and therefore isn't accessibility container
  XCUIElement *buttonElement = self.testedApplication.buttons[@"Button"];
  XCTAssertTrue(buttonElement.exists);
  XCTAssertTrue(buttonElement.fb_isAccessibilityElement);
  XCTAssertFalse(buttonElement.isWDAccessibilityContainer);
}

- (void)testButtonAttributes
{
  XCUIElement *element = self.testedApplication.buttons[@"Button"];
  XCTAssertTrue(element.exists);
  XCTAssertEqualObjects(element.wdType, @"XCUIElementTypeButton");
  XCTAssertEqualObjects(element.wdName, @"Button");
  XCTAssertEqualObjects(element.wdLabel, @"Button");
  XCTAssertNil(element.wdValue);
  XCTAssertFalse(element.wdSelected);
  XCTAssertTrue(element.fb_isVisible);
  [element tap];
  XCTAssertTrue(element.wdValue.boolValue);
  XCTAssertTrue(element.wdSelected);
}

- (void)testSliderAttributes
{
  XCUIElement *element = self.testedApplication.sliders.element;
  XCTAssertTrue(element.exists);
  XCTAssertEqualObjects(element.wdType, @"XCUIElementTypeSlider");
  XCTAssertNil(element.wdName);
  XCTAssertNil(element.wdLabel);
  XCTAssertTrue([element.wdValue containsString:@"50"]);

  NSNumber *minValue = element.wdMinValue;
  NSNumber *maxValue = element.wdMaxValue;

  XCTAssertNotNil(minValue, @"Slider minValue should not be nil");
  XCTAssertNotNil(maxValue, @"Slider maxValue should not be nil");

  XCTAssertEqualObjects(minValue, @0);
  XCTAssertEqualObjects(maxValue, @1);
}


- (void)testSwitchAttributes
{
  XCUIElement *element = self.testedApplication.switches.element;
  XCTAssertTrue(element.exists);
  XCTAssertEqualObjects(element.wdType, @"XCUIElementTypeSwitch");
  XCTAssertNil(element.wdName);
  XCTAssertNil(element.wdLabel);
  XCTAssertNil(element.wdPlaceholderValue);
  XCTAssertEqualObjects(element.wdValue, @"1");
  XCTAssertFalse(element.wdSelected);
  XCTAssertEqual(element.wdHittable, element.hittable);
  [element tap];
  XCTAssertEqualObjects(element.wdValue, @"0");
  XCTAssertFalse(element.wdSelected);
}

- (void)testCustomActionsAttributes
{
  XCUIElement *buttonElement = self.testedApplication.buttons[@"Button"];
  XCTAssertTrue(buttonElement.exists);
  NSString *customActions = buttonElement.wdCustomActions;
  XCTAssertNotNil(customActions, @"Button should have custom actions");
  XCTAssertEqualObjects(customActions, @"Custom Action 1,Custom Action 2");
}

@end
