/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBIntegrationTestCase.h"

#import "FBElementCache.h"
#import "FBMathUtils.h"
#import "FBRunLoopSpinner.h"
#import "FBTestMacros.h"
#import "XCUIApplication+FBTouchAction.h"
#import "XCUICoordinate.h"
#import "XCUIDevice+FBRotation.h"
#import "XCUIElement+FBIsVisible.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@interface FBTapTest : FBIntegrationTestCase
@end

// It is recommnded to verify these tests with different iOS versions

@implementation FBTapTest

// One launch covers all orientations: re-launching per orientation only added ~10s each.
- (NSArray<NSNumber *> *)orientations
{
  NSMutableArray<NSNumber *> *result = [NSMutableArray arrayWithObjects:
                                        @(UIDeviceOrientationPortrait),
                                        @(UIDeviceOrientationLandscapeLeft),
                                        @(UIDeviceOrientationLandscapeRight), nil];
  // Upside-down is unsupported on iPad
  if (UIDevice.currentDevice.userInterfaceIdiom != UIUserInterfaceIdiomPad) {
    [result addObject:@(UIDeviceOrientationPortraitUpsideDown)];
  }
  return result;
}

- (void)verifyTapWithOrientation:(UIDeviceOrientation)orientation byCoordinates:(BOOL)byCoordinates
{
  [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation];
  // The app is not re-launched between orientations, so let it finish re-laying out first
  [self.testedApplication fb_waitUntilStable];
  XCUIElement *dstButton = self.testedApplication.buttons[FBShowAlertButtonName];
  FBAssertWaitTillBecomesTrue(dstButton.isHittable);
  if (byCoordinates) {
    [[dstButton coordinateWithNormalizedOffset:CGVectorMake(0.5, 0.5)] tap];
  } else {
    [dstButton tap];
  }
  BOOL alertShown = [[[FBRunLoopSpinner new] interval:1.0] spinUntilTrue:^BOOL{
    return self.testedApplication.alerts.count > 0;
  }];
  XCTAssertTrue(alertShown, @"No alert after tapping in orientation %ld (by coordinates: %d)",
                (long)orientation, byCoordinates);
  [self clearAlert];
}

- (void)setUp
{
  [super setUp];
  [self launchApplication];
  [self goToAlertsPage];
  [self clearAlert];
}

- (void)tearDown
{
  [self clearAlert];
  [self resetOrientation];
  [super tearDown];
}

- (void)testTapInAllOrientations
{
  for (NSNumber *orientation in self.orientations) {
    [self verifyTapWithOrientation:orientation.integerValue byCoordinates:NO];
  }
}

- (void)testTapCoordinatesInAllOrientations
{
  for (NSNumber *orientation in self.orientations) {
    [self verifyTapWithOrientation:orientation.integerValue byCoordinates:YES];
  }
}

// Element-less absolute offsets are never rescaled by XCTest's XCUICoordinate (verified by
// disassembling XCUIAutomation.framework), so this still fails under a window-size mismatch.
- (void)testTapAtElementRectCenterUnderWindowSizeMismatch
{
  [self skipUnlessWindowSizeMismatchesDevice];

  XCUIElement *dstButton = self.testedApplication.buttons[FBShowAlertButtonName];
  CGRect rect = dstButton.wdFrame;
  CGPoint center = CGPointMake(CGRectGetMidX(rect), CGRectGetMidY(rect));

  // Mirrors FBBaseActionsSynthesizer's hitpointWithElement:positionOffset:
  // for an absolute (x, y) offset, as used by touch/perform and W3C actions.
  XCUICoordinate *appOrigin = [self.testedApplication coordinateWithNormalizedOffset:CGVectorMake(0, 0)];
  XCUICoordinate *tapPoint = [appOrigin coordinateWithOffset:CGVectorMake(center.x, center.y)];
  [tapPoint tap];

  XCTExpectFailureInBlock(@"element-less absolute offsets are never rescaled by XCTest for a "
                           "compatibility-mode window (appium/appium#16185); starts failing "
                           "loudly here the moment XCTest fixes this itself", ^{
    FBAssertWaitTillBecomesTrue(self.testedApplication.alerts.count > 0);
  });
}

@end

// The Touch page's touchable view records each touch-down's location, in its own bounds
// coordinate space, as its accessibility value - a ground truth unaffected by any
// window-level scaling, letting these tests assert on exact landing position rather than
// just on whether a tap happened to land inside some (possibly large) target.
@interface FBElementOffsetTapTest : FBIntegrationTestCase
@end

@implementation FBElementOffsetTapTest

- (void)setUp
{
  [super setUp];
  [self launchApplication];
  [self goToTouchPage];
}

- (CGPoint)lastTouchLocationOf:(XCUIElement *)touchable
{
  NSString *value = touchable.value;
  NSArray<NSString *> *components = [value componentsSeparatedByString:@","];
  return CGPointMake(components.firstObject.doubleValue, components.lastObject.doubleValue);
}

// FBW3CActionsSynthesizer normalizes element-relative offsets against the element's own
// frame, so this keeps landing at the intended point under a window-size mismatch
// (appium/appium#16185), unlike an element-less absolute offset.
- (void)testTapWithElementOffsetUnderWindowSizeMismatch
{
  [self skipUnlessWindowSizeMismatchesDevice];

  XCUIElement *touchable = self.testedApplication.otherElements[@"touchableView"];
  CGSize size = touchable.wdFrame.size;
  CGVector offset = CGVectorMake(size.width / 4, -size.height / 4);
  CGPoint expectedLocation = CGPointMake(size.width / 2 + offset.dx, size.height / 2 + offset.dy);

  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"origin": touchable, @"x": @(offset.dx), @"y": @(offset.dy)},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @50},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  NSError *error;
  XCTAssertTrue([self.testedApplication fb_performW3CActions:gesture elementCache:nil error:&error]);

  FBAssertWaitTillBecomesTrue(FBPointFuzzyEqualToPoint([self lastTouchLocationOf:touchable], expectedLocation, 5.0));
}

@end
