/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

// Availability probe for the public XCUIElement/XCUICoordinate gesture primitives on watchOS.
//
// `FBElementCommands.m` guards every synthesized-gesture route behind `#elif !TARGET_OS_WATCH`
// with the comment "Gesture synthesis isn't supported on watchOS", yet the XCUIAutomation headers
// shipped with WatchSimulator.platform are byte-identical to the iPhone ones. That claim is
// therefore about the watchOS *runtime*, not the SDK surface - and it had never been measured.
//
// Each probe reports OK or the thrown error instead of asserting, so one run yields the complete
// matrix. Objective-C (rather than Swift) is deliberate: unavailable selectors raise
// NSInvalidArgumentException, which @try/@catch can trap; a Swift trap would tear down the runner
// and cost the rest of the matrix.
//
// Whether a gesture also *takes effect* is a separate question covered by the driver-level
// functional suite once the routes exist; this only settles "does the call return".
//
// Only primitives measured to return on watchOS 26.5 are invoked here. The velocity-carrying swipes
// are deliberately NOT: `swipeUpWithVelocity:` stalls inside `Synthesize event` for over a minute and
// then takes the runner down with it ("Restarting after unexpected exit, crash, or test timeout"),
// which would cost the rest of the matrix and break CI. They are reported by selector presence
// only, below, together with pinch and rotate, which are known not to be usable on the platform.
//
// `FBElementCommands` also exposes `-pressForDuration:thenDragToElement:withVelocity:thenHoldForDuration:`
// on watchOS, for `mobile: dragFromToWithVelocity` with `fromElementId`. It belongs to the same
// velocity-carrying family as the swipes above, so it is invoked by itself in
// `testSpikeElementVelocityDrag`, where a runner kill would cost one test instead of the matrix.
// Measured on watchOS 26.5: the selector is present (the watch SDK guards it with
// `API_UNAVAILABLE(tvos)` only) and the call returns in ~1 s with the runner still alive, so that
// route stays enabled in the watch build.

@interface WDAWatchGestureSpikeTests : XCTestCase
@property (nonatomic, strong) XCUIApplication *app;
@end

@implementation WDAWatchGestureSpikeTests

- (void)setUp
{
  [super setUp];
  self.continueAfterFailure = YES;
  self.app = [XCUIApplication new];
  [self.app launch];
  XCTAssertTrue([self.app.buttons[@"tapMeButton"] waitForExistenceWithTimeout:20]);
}

- (void)probe:(NSString *)name body:(void (^)(void))body
{
  CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
  NSString *outcome;
  @try {
    body();
    outcome = [NSString stringWithFormat:@"OK (%.2fs)", CFAbsoluteTimeGetCurrent() - started];
  } @catch (NSException *exception) {
    outcome = [NSString stringWithFormat:@"THREW %@: %@",
               exception.name, exception.reason ?: @"(no reason)"];
  }
  NSLog(@"SPIKE[%@] %@", name, outcome);
}

- (void)testSpikeGesturePrimitives
{
  XCUIElement *button = self.app.buttons[@"tapMeButton"];
  XCUIElement *scroll = self.app.scrollViews.firstMatch;
  XCUICoordinate *buttonCenter = [button coordinateWithNormalizedOffset:CGVectorMake(.5, .5)];
  XCUICoordinate *lowerHalf = [self.app coordinateWithNormalizedOffset:CGVectorMake(.5, .9)];

  [self probe:@"element.tap" body:^{ [button tap]; }];
  [self probe:@"element.doubleTap" body:^{ [button doubleTap]; }];
  [self probe:@"element.twoFingerTap" body:^{ [button twoFingerTap]; }];
  [self probe:@"element.tapWithNumberOfTaps:numberOfTouches:" body:^{
    [button tapWithNumberOfTaps:2 numberOfTouches:1];
  }];
  [self probe:@"element.pressForDuration:" body:^{ [button pressForDuration:.5]; }];
  [self probe:@"element.adjustToNormalizedSliderPosition:" body:^{
    [button adjustToNormalizedSliderPosition:.5];
  }];
  [self probe:@"element.pressForDuration:thenDragToElement:" body:^{
    [button pressForDuration:.3 thenDragToElement:button];
  }];

  [self probe:@"scroll.swipeUp" body:^{ [scroll swipeUp]; }];
  [self probe:@"scroll.swipeDown" body:^{ [scroll swipeDown]; }];
  [self probe:@"scroll.swipeLeft" body:^{ [scroll swipeLeft]; }];
  [self probe:@"scroll.swipeRight" body:^{ [scroll swipeRight]; }];

  [self probe:@"coordinate.pressForDuration:thenDragToCoordinate:" body:^{
    [buttonCenter pressForDuration:.3 thenDragToCoordinate:lowerHalf];
  }];
  [self probe:@"coordinate.pressForDuration:thenDragToCoordinate:withVelocity:thenHoldForDuration:"
         body:^{
    [buttonCenter pressForDuration:.3
                thenDragToCoordinate:lowerHalf
                        withVelocity:XCUIGestureVelocityFast
                 thenHoldForDuration:.2];
  }];

  // Selector presence is reported separately from invocation: a missing selector means the SDK
  // really does not implement it, while a present selector that throws is a runtime/synthesis gap.
  NSArray<NSString *> *selectors = @[
    @"tap", @"doubleTap", @"twoFingerTap", @"tapWithNumberOfTaps:numberOfTouches:",
    @"pressForDuration:", @"pressForDuration:thenDragToElement:",
    @"pressForDuration:thenDragToElement:withVelocity:thenHoldForDuration:",
    @"swipeUp", @"swipeDown", @"swipeLeft", @"swipeRight",
    @"swipeUpWithVelocity:", @"swipeDownWithVelocity:",
    @"pinchWithScale:velocity:", @"rotate:withVelocity:",
    @"adjustToNormalizedSliderPosition:", @"normalizedSliderPosition",
  ];
  for (NSString *selectorName in selectors) {
    SEL selector = NSSelectorFromString(selectorName);
    NSLog(@"SPIKE[responds %@ on XCUIElement] %@", selectorName,
          [button respondsToSelector:selector] ? @"YES" : @"NO");
  }
  for (NSString *selectorName in @[
         @"pressForDuration:thenDragToCoordinate:",
         @"pressForDuration:thenDragToCoordinate:withVelocity:thenHoldForDuration:",
       ]) {
    NSLog(@"SPIKE[responds %@ on XCUICoordinate] %@", selectorName,
          [buttonCenter respondsToSelector:NSSelectorFromString(selectorName)] ? @"YES" : @"NO");
  }
}

/// Isolated on purpose: this selector takes a velocity on an `XCUIElement`, the same family whose
/// swipes are known to stall synthesis and kill the runner on watchOS 26.5. If that happens here,
/// only this test is lost, and the answer is what `FBElementCommands` needs to know before it keeps
/// the `pressAndDragWithVelocity` element route in the watch build.
- (void)testSpikeElementVelocityDrag
{
  XCUIElement *button = self.app.buttons[@"tapMeButton"];
  XCTAssertTrue([button waitForExistenceWithTimeout:20]);
  SEL selector =
      NSSelectorFromString(@"pressForDuration:thenDragToElement:withVelocity:thenHoldForDuration:");
  NSLog(@"SPIKE[responds %@ on XCUIElement] %@",
        NSStringFromSelector(selector),
        [button respondsToSelector:selector] ? @"YES" : @"NO");
  if (![button respondsToSelector:selector]) {
    return;
  }
  // The same call `handlePressAndDragWithVelocity:` makes, with the same shape of arguments.
  [self probe:@"element.pressForDuration:thenDragToElement:withVelocity:thenHoldForDuration:"
         body:^{
           [button pressForDuration:.3
                  thenDragToElement:button
                       withVelocity:1000.0
                thenHoldForDuration:.2];
         }];
}

@end
