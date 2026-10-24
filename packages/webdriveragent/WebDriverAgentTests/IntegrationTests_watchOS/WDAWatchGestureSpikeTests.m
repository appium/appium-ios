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
// Every probe logs `OK (<n.n>s)`, `REJECTED (dispatched)` or the error it threw, and a probe that
// throws fails the run: this file's `OK` lines are the evidence that keeps the gesture routes
// registered in the watch build of `FBElementCommands.m`, and evidence CI cannot turn red is not
// evidence. Objective-C (rather than Swift) is deliberate: unavailable selectors raise
// NSInvalidArgumentException, which @try/@catch can trap; a Swift trap would tear down the runner
// and cost the rest of the matrix. `continueAfterFailure` is on (see `setUp`) so a failed probe
// costs that one capability, not the matrix.
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
//
// Both tests stand on measurements taken on watchOS 26 and 27. CI also runs this suite through the
// `watch_int_test_Min_Xcode` leg on `MIN_WATCH_PLATFORM_VERSION` (11.5), where the newer primitives
// may be absent and where a velocity-carrying call could stall and take that runner down; below
// watchOS 26 the tests skip rather than assert - or crash - an unmeasured configuration.

@interface WDAWatchGestureSpikeTests : XCTestCase
@property (nonatomic, strong) XCUIApplication *app;
@end

static BOOL WDAWatchGestureRuntimeIsMeasured(void)
{
  if (@available(watchOS 26, *)) {
    return YES;
  }
  return NO;
}

@implementation WDAWatchGestureSpikeTests

- (void)setUp
{
  [super setUp];
  self.continueAfterFailure = YES;
  self.app = [XCUIApplication new];
  [self.app launch];
  XCTAssertTrue([self.app.buttons[@"tapMeButton"] waitForExistenceWithTimeout:20]);
}

/// Invokes a primitive and asserts it does not throw. A throw means the runtime stopped dispatching
/// something the watch build's routes rely on, so it fails the run; `OK (<n.n>s)` stays the artifact
/// the plan cites.
- (void)probe:(NSString *)name body:(void (^)(void))body
{
  CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
  NSString *outcome;
  NSException *thrown = nil;
  @try {
    body();
    outcome = [NSString stringWithFormat:@"OK (%.2fs)", CFAbsoluteTimeGetCurrent() - started];
  } @catch (NSException *exception) {
    thrown = exception;
    outcome = [NSString stringWithFormat:@"THREW %@: %@",
               exception.name, exception.reason ?: @"(no reason)"];
  }
  NSLog(@"SPIKE[%@] %@", name, outcome);
  if (nil != thrown) {
    XCTFail(@"'%@' raised %@: %@ - the watch build of FBElementCommands.m dispatches the "
            @"primitives measured here, so a throw is a lost capability, not a note",
            name, thrown.name, thrown.reason ?: @"(no reason)");
  }
}

/// Logs and asserts: the watch build of `FBElementCommands.m` dispatches this selector, so a
/// runtime that stopped answering it must turn CI red instead of only printing a line.
- (void)assertRequiredSelector:(NSString *)selectorName onTarget:(id)target
{
  SEL selector = NSSelectorFromString(selectorName);
  BOOL responds = [target respondsToSelector:selector];
  NSLog(@"SPIKE[responds %@ on %@] %@", selectorName, NSStringFromClass([target class]),
        responds ? @"YES" : @"NO");
  XCTAssertTrue(responds, @"%@ no longer responds to '%@'", NSStringFromClass([target class]),
                selectorName);
}

/// Logs only: the watch build never dispatches this selector - pinch, rotate and the
/// velocity-carrying swipes stay out of it on purpose, each reason recorded at its own guard - so
/// its presence is context for the matrix, not a contract with the runtime. Asserting it would
/// turn an excluded capability into a required one.
- (void)reportOptionalSelector:(NSString *)selectorName onTarget:(id)target
{
  SEL selector = NSSelectorFromString(selectorName);
  NSLog(@"SPIKE[responds %@ on %@] %@", selectorName, NSStringFromClass([target class]),
        [target respondsToSelector:selector] ? @"YES" : @"NO");
}

/// Asserts the *weaker* contract: the selector must be dispatched, and a rejection naming the
/// element type counts as dispatch. `handleSetValue:` reaches `adjustToNormalizedSliderPosition:`
/// for a slider element, but the fixture has no slider to give it - SwiftUI exposes no `Slider` on
/// watchOS - so the honest result of probing it against a button is a domain rejection. Presence
/// still has to be pinned, because a selector the runtime stopped answering raises the same
/// NSInvalidArgumentException with an "unrecognized selector" reason, and that difference is exactly
/// what this separates: a domain rejection means the code ran, an unrecognized selector means the
/// watch build lost the capability the route depends on.
- (void)probeDispatchedOrRejected:(NSString *)name
                          keyword:(NSString *)keyword
                             body:(void (^)(void))body
{
  CFAbsoluteTime started = CFAbsoluteTimeGetCurrent();
  NSString *outcome;
  BOOL dispatched = NO;
  @try {
    body();
    dispatched = YES;
    outcome = [NSString stringWithFormat:@"OK (%.2fs)", CFAbsoluteTimeGetCurrent() - started];
  } @catch (NSException *exception) {
    NSString *reason = exception.reason ?: @"";
    BOOL unrecognized =
        NSNotFound != [reason rangeOfString:@"unrecognized selector"
                                    options:NSCaseInsensitiveSearch].location;
    BOOL domainRejection =
        [exception.name isEqualToString:NSInvalidArgumentException] &&
        NSNotFound != [reason rangeOfString:keyword options:NSCaseInsensitiveSearch].location;
    dispatched = !unrecognized && domainRejection;
    outcome = [NSString stringWithFormat:@"%@%@: %@",
               dispatched ? @"REJECTED (dispatched) " : @"THREW ", exception.name,
               exception.reason ?: @"(no reason)"];
  }
  NSLog(@"SPIKE[%@] %@", name, outcome);
  XCTAssertTrue(dispatched, @"'%@' was not dispatched (%@) - the watch build of FBElementCommands.m "
                            @"dispatches this selector for a %@ element, so an unrecognized selector "
                            @"here is a lost capability, and any other throw is a runtime gap",
                name, outcome, keyword);
}

- (void)testSpikeGesturePrimitives
{
  XCTSkipUnless(WDAWatchGestureRuntimeIsMeasured(),
                @"this runtime predates the watchOS 26 measurement these expectations are pinned "
                @"to; the newer XCUIElement primitives are not asserted here");

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
  // A button is the wrong element type for this one on purpose; see the helper's note on why a
  // domain rejection is the passing result.
  [self probeDispatchedOrRejected:@"element.adjustToNormalizedSliderPosition:"
                          keyword:@"slider"
                             body:^{
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
  // The required set is every selector this file probes or invokes: each one is a claim the watch
  // build of `FBElementCommands.m` relies on (`swipeUp`/`swipeDown`/`swipeLeft`/`swipeRight` are
  // exactly the names `swipeWithDirection:` builds from a direction string, and
  // `handleSetValue:` dispatches `adjustToNormalizedSliderPosition:` for a slider), so presence is
  // asserted and a runtime that stops answering one turns CI red.
  for (NSString *selectorName in @[
         @"tap", @"doubleTap", @"twoFingerTap", @"tapWithNumberOfTaps:numberOfTouches:",
         @"pressForDuration:", @"pressForDuration:thenDragToElement:",
         @"pressForDuration:thenDragToElement:withVelocity:thenHoldForDuration:",
         @"swipeUp", @"swipeDown", @"swipeLeft", @"swipeRight",
         @"adjustToNormalizedSliderPosition:",
       ]) {
    [self assertRequiredSelector:selectorName onTarget:button];
  }
  for (NSString *selectorName in @[
         @"pressForDuration:thenDragToCoordinate:",
         @"pressForDuration:thenDragToCoordinate:withVelocity:thenHoldForDuration:",
       ]) {
    [self assertRequiredSelector:selectorName onTarget:buttonCenter];
  }
  for (NSString *selectorName in @[
         @"swipeUpWithVelocity:", @"swipeDownWithVelocity:",
         @"pinchWithScale:velocity:", @"rotate:withVelocity:",
         @"normalizedSliderPosition",
       ]) {
    [self reportOptionalSelector:selectorName onTarget:button];
  }
}

/// Isolated on purpose: this selector takes a velocity on an `XCUIElement`, the same family whose
/// swipes are known to stall synthesis and kill the runner on watchOS 26.5. If that happens here,
/// only this test is lost, and the answer is what `FBElementCommands` needs to know before it keeps
/// the `pressAndDragWithVelocity` element route in the watch build.
- (void)testSpikeElementVelocityDrag
{
  XCTSkipUnless(WDAWatchGestureRuntimeIsMeasured(),
                @"this runtime predates the watchOS 26 measurement this route's evidence is pinned "
                @"to; a velocity-carrying call is not attempted here");

  XCUIElement *button = self.app.buttons[@"tapMeButton"];
  XCTAssertTrue([button waitForExistenceWithTimeout:20]);
  SEL selector =
      NSSelectorFromString(@"pressForDuration:thenDragToElement:withVelocity:thenHoldForDuration:");
  // Asserted, not just logged: the plan cites this test's `OK (1.00s)` line as the reason the
  // `pressAndDragWithVelocity` element route stays in the watch build, so a runtime that stopped
  // answering the selector has to fail here rather than let the route ride on stale evidence.
  [self assertRequiredSelector:NSStringFromSelector(selector) onTarget:button];
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
