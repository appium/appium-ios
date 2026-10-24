/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import "FBLogger.h"
#import "FBXCAccessibilityElement.h"
#import "FBXCAXClientProxy.h"
#import "FBXCElementSnapshot.h"
#import "FBXCodeCompatibility.h"
#import "FBElementTypeTransformer.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement.h"
#import "XCUIElement+FBUtilities.h"

// Which process owns the watchOS keyboard, and which one owns the accessory bar that carries its
// `Done`/`Cancel`.
//
// `fb_dismissKeyboardWithKeyNames:` (XCUIApplication+FBHelpers.m) has a watchOS-only fallback: when
// the keyboard subtree holds nothing named by the client's `keyNames`, it searches the whole
// application tree and accepts a match whose process differs from the application under test's. That
// process check is the only thing between the fallback and a control belonging to some unrelated
// process, so how wide it is deserves a measurement rather than a comment:
//
//  - if the accessory bar shares the keyboard element's process, the predicate can become "same
//    process as the keyboard element", which is strictly narrower than "not the application under
//    test" and removes every foreign-process control from the reachable set;
//  - if it does not - e.g. the keyboard element resolves to the application's own process while the
//    bar belongs to the text-input service - then "not the application under test" is already the
//    narrowest scope that keeps the feature working.
//
// The `PIDSPIKE[...]` lines are the product of this file: the process id of the element the
// production code calls `self.keyboard`, of the accessory bar's `Cancel`/`Done`, of the application
// under test, and the bundle each of those pids belongs to, asked the way `fb_activeAppsInfo` asks
// (the runner-to-daemon messaging channel, over the very accessibility elements the controls came
// from).
//
// The candidate table comes out of the guard's own predicate, run over the guard's own query: block
// predicates are evaluated in the runner, so the test can watch production's decision per snapshot
// instead of re-finding elements by index, which goes stale against the sheet's animation.
//
// Assertions are kept to the relationships the fallback itself depends on, so a layout change turns
// this red instead of leaving the guard's comment stale - evidence CI cannot turn red is not evidence.
// Objective-C rather than Swift: pids come from element snapshots and accessibility elements, which
// the Swift side cannot reach, and `-fb_standardSnapshot` throws on a missing element where
// @try/@catch can trap it. `continueAfterFailure` is on (see `setUp`) so a failed relationship costs
// one assertion, not the numbers.
//
// Only the layout measured on watchOS 26.5 and 27.0 is asserted here. CI also compiles this suite into
// a watchOS 11.5 / Xcode 16.4 leg, where a different keyboard rendering is a platform difference and
// not a product bug, so below watchOS 26 the test skips.

@interface WDAKeyboardAccessoryBarProcessSpikeTests : XCTestCase
@property (nonatomic, strong) XCUIApplication *app;
@end

static BOOL WDAKeyboardProcessRuntimeIsMeasured(void)
{
  if (@available(watchOS 26, *)) {
    return YES;
  }
  return NO;
}

/// The process identifier of an element's snapshot accessibility element - the read the production
/// guard performs. `nil` if no snapshot could be taken (the element is absent or went stale).
static id<FBXCAccessibilityElement> _Nullable WDAAccessibilityElementOfElement(XCUIElement *_Nullable element)
{
  if (nil == element) {
    return nil;
  }
  @try {
    return [element fb_standardSnapshot].accessibilityElement;
  } @catch (NSException *event) {
    [FBLogger logFmt:@"could not snapshot an element: %@", event.reason];
    return nil;
  }
}

/// The application's own accessibility element; the private XCTest category exposes it as an untyped
/// `id`, and production reads the same property.
static id<FBXCAccessibilityElement> _Nullable WDAAccessibilityElementOfApplication(XCUIApplication *app)
{
  return (id<FBXCAccessibilityElement>)app.accessibilityElement;
}

static pid_t WDAPidOfAccessibilityElement(id<FBXCAccessibilityElement> _Nullable axElement)
{
  return nil == axElement ? -1 : (pid_t)[axElement processIdentifier];
}

/// One `PIDSPIKE[element]` line per control: how it is named and which process it lives in.
static void WDALogElement(NSString *role, XCUIElement *_Nullable element)
{
  id<FBXCElementSnapshot> snapshot = nil;
  @try {
    snapshot = [element fb_standardSnapshot];
  } @catch (NSException *event) {
    [FBLogger logFmt:@"PIDSPIKE[element] role=%@ unreadable: %@", role, event.reason];
    return;
  }
  NSLog(@"PIDSPIKE[element] role=%@ identifier=%@ label=%@ type=%@ pid=%d",
        role, snapshot.identifier, snapshot.label,
        [FBElementTypeTransformer shortStringWithElementType:snapshot.elementType],
        WDAPidOfAccessibilityElement(snapshot.accessibilityElement));
}

/// Whether a snapshot's matched name is the one the fallback has to reach. The guard accepts either
/// `done` (the iOS key name the driver asks for by default) or `Done` (what UIKit names the button).
static BOOL WDANameIsDone(NSString *_Nullable name)
{
  return [@"Done" isEqualToString:name] || [@"done" isEqualToString:name];
}

@implementation WDAKeyboardAccessoryBarProcessSpikeTests

- (void)setUp
{
  [super setUp];
  // The numbers are the deliverable: keep going after a failed relationship so the log still holds
  // them.
  self.continueAfterFailure = YES;
  self.app = [XCUIApplication new];
  [self.app launch];
  XCTAssertTrue([self.app.buttons[@"tapMeButton"] waitForExistenceWithTimeout:20]);
}

- (void)testKeyboardAccessoryBarProcessIdentity
{
  XCTSkipUnless(WDAKeyboardProcessRuntimeIsMeasured(),
                @"the accessory-bar process layout was only measured on watchOS 26 and 27; this is %@",
                NSProcessInfo.processInfo.operatingSystemVersionString);

  // The names `WDATypingIntegrationTests.testDismissingTheKeyboardTapsTheAccessoryBarDoneButton`
  // hands the helper. The fixture's own button is labelled `Done` on purpose, so these names already
  // pull in an application-process control and the search below is as ambiguous as production's.
  NSArray<NSString *> *keyNames = @[@"done", @"Done"];

  XCUIElement *typingField = [[self.app.fb_query descendantsMatchingType:XCUIElementTypeAny]
                              matchingIdentifier:@"typingField"].fb_firstMatch;
  XCTAssertTrue(nil != typingField, @"the fixture's typing field must exist");
  [typingField tap];

  id<FBXCAccessibilityElement> autAxElement = WDAAccessibilityElementOfApplication(self.app);
  pid_t autPid = WDAPidOfAccessibilityElement(autAxElement);

  // Whether the bar showed up at all is what the typing tests skip on for unmeasured renderings; the
  // same skip applies before anything below is meaningful. The sheet needs seconds to appear.
  XCUIElement *barCancel = self.app.buttons[@"Cancel"];
  if (![barCancel waitForExistenceWithTimeout:15]) {
    NSLog(@"PIDSPIKE[skip] no accessory bar appeared; aut=%d", autPid);
    XCTSkip(@"the keyboard never surfaced an accessory bar, so there is no process identity to measure");
    return;
  }

  // ---- what the production guard sees, and what it lets through ---------
  // The guard's predicate over the guard's query, with the verdict recorded per snapshot before it is
  // returned. Nothing is tapped here: tapping would dismiss the sheet being measured. XCTest evaluates
  // a block predicate more than once per element, so records are keyed by name+process to keep the
  // reported candidate count the number of controls rather than the number of evaluations.
  NSMutableDictionary<NSString *, NSDictionary<NSString *, id> *> *candidates = [NSMutableDictionary dictionary];
  NSPredicate *foreignProcessPredicate = [NSPredicate predicateWithBlock:^BOOL(id<FBXCElementSnapshot> snapshot, NSDictionary *bindings) {
    if (snapshot.elementType != XCUIElementTypeKey && snapshot.elementType != XCUIElementTypeButton) {
      return NO;
    }
    NSString *identifier = snapshot.identifier;
    NSString *label = snapshot.label;
    if (!(nil != identifier && [keyNames containsObject:identifier])
        && !(nil != label && [keyNames containsObject:label])) {
      return NO;
    }
    id<FBXCAccessibilityElement> axElement = snapshot.accessibilityElement;
    pid_t pid = WDAPidOfAccessibilityElement(axElement);
    // The process owning the node above this one. This is what shows the bar is not a foreign child
    // hung under an application-process container: its parent is in the same process as it is.
    pid_t parentPid = WDAPidOfAccessibilityElement(snapshot.parentAccessibilityElement);
    BOOL kept = autPid > 0 && pid > 0 && pid != autPid;
    @synchronized (candidates) {
      candidates[[NSString stringWithFormat:@"%@/%d", 0 < [label length] ? label : (identifier ?: @""), pid]] =
        @{
          @"name": 0 < [label length] ? label : (identifier ?: @""),
          @"identifier": identifier ?: @"",
          @"label": label ?: @"",
          @"type": [FBElementTypeTransformer shortStringWithElementType:snapshot.elementType],
          @"pid": @(pid),
          @"parentPid": @(parentPid),
          // The query root: on watchOS both `Done` controls are reached through the *application's*
          // own element, which is why "not the application under test" cannot be read off the tree
          // shape and has to be read off each element's process.
          @"path": snapshot.pathDescription ?: @"",
          @"kept": @(kept),
          @"axElement": axElement ?: [NSNull null],
        };
    }
    return kept;
  }];
  NSArray<XCUIElement *> *guardReachable =
    [[self.app.fb_query descendantsMatchingType:XCUIElementTypeAny]
     matchingPredicate:foreignProcessPredicate].allElementsBoundByIndex;

  pid_t barDonePid = -1;
  pid_t appDonePid = -1;
  id<FBXCAccessibilityElement> barDoneAxElement = nil;
  // `Cancel` is how the sheet is detected, not a name the dismissal helper is ever given, so its pid
  // is read from the element the typing tests use rather than from the guard's candidate table.
  id<FBXCAccessibilityElement> barCancelAxElement = WDAAccessibilityElementOfElement(barCancel);
  pid_t barCancelPid = WDAPidOfAccessibilityElement(barCancelAxElement);
  for (NSDictionary<NSString *, id> *candidate in candidates.allValues) {
    NSString *name = candidate[@"name"];
    pid_t pid = [candidate[@"pid"] intValue];
    NSLog(@"PIDSPIKE[candidate] name=%@ identifier=%@ type=%@ pid=%d parentPid=%d keptByGuard=%@ path=%@",
          name, candidate[@"identifier"], candidate[@"type"], pid, [candidate[@"parentPid"] intValue],
          [candidate[@"kept"] boolValue] ? @"yes" : @"no", candidate[@"path"]);
    if (!WDANameIsDone(name)) {
      continue;
    }
    if (pid == autPid) {
      if (-1 == appDonePid) {
        appDonePid = pid;
      }
    } else if (pid > 0 && -1 == barDonePid) {
      barDonePid = pid;
      barDoneAxElement = [candidate[@"axElement"] isKindOfClass:[NSNull class]] ? nil : candidate[@"axElement"];
    }
  }
  NSLog(@"PIDSPIKE[guard] candidates=%lu reachable=%lu",
        (unsigned long)candidates.count, (unsigned long)guardReachable.count);
  // Tree order, which is the order the fallback taps in.
  for (NSUInteger index = 0; index < guardReachable.count; ++index) {
    WDALogElement([NSString stringWithFormat:@"reachable[%lu]", (unsigned long)index], guardReachable[index]);
  }

  // ---- the keyboard side -------------------------------------------------
  // The element the production fallback is written against (`self.keyboard`) and the query-shaped
  // variant FBKeyboard uses (`app.keyboards`). If those two ever disagree, the narrowing decision has
  // to name which one a guard would compare against.
  id<FBXCAccessibilityElement> keyboardAxElement = WDAAccessibilityElementOfElement(self.app.keyboard);
  id<FBXCAccessibilityElement> keyboardsQueryAxElement =
    WDAAccessibilityElementOfElement(self.app.keyboards.fb_firstMatch);
  WDALogElement(@"aut", self.app);
  WDALogElement(@"keyboard", self.app.keyboard);
  WDALogElement(@"keyboardsQuery", self.app.keyboards.fb_firstMatch);
  WDALogElement(@"barCancel", barCancel);
  WDALogElement(@"fixtureDone", self.app.buttons[@"appDoneButton"]);
  pid_t keyboardPid = WDAPidOfAccessibilityElement(keyboardAxElement);
  pid_t keyboardsQueryPid = WDAPidOfAccessibilityElement(keyboardsQueryAxElement);

  // ---- bundle ownership -------------------------------------------------
  // Asked the way `fb_activeAppsInfo` asks: the runner-to-daemon messaging channel, over the very
  // accessibility elements these controls came from.
  NSMutableArray<id<FBXCAccessibilityElement>> *axElements = [NSMutableArray array];
  // A C array, not a literal: any of these can be nil when the element it came from is absent, and a
  // literal would stop at the first one.
  id<FBXCAccessibilityElement> probedElements[] = {barCancelAxElement, barDoneAxElement,
                                                   keyboardAxElement, keyboardsQueryAxElement,
                                                   autAxElement};
  for (size_t i = 0; i < sizeof(probedElements) / sizeof(probedElements[0]); ++i) {
    id<FBXCAccessibilityElement> axElement = probedElements[i];
    if (nil != axElement && NO == [axElements containsObject:axElement]) {
      [axElements addObject:axElement];
    }
  }
  NSArray<NSDictionary<NSString *, id> *> *appsInfo =
    [XCUIApplication fb_appsInfoWithAxElements:axElements];
  NSMutableArray<NSString *> *ownerTable = [NSMutableArray array];
  for (NSDictionary<NSString *, id> *appInfo in appsInfo) {
    [ownerTable addObject:[NSString stringWithFormat:@"%@=%@", appInfo[@"pid"], appInfo[@"bundleId"]]];
  }
  NSLog(@"PIDSPIKE[ownership] %@", [ownerTable componentsJoinedByString:@", "]);

  NSMutableArray<NSString *> *activeApps = [NSMutableArray array];
  for (NSDictionary<NSString *, id> *appInfo in XCUIApplication.fb_activeAppsInfo) {
    [activeApps addObject:[NSString stringWithFormat:@"%@=%@", appInfo[@"pid"], appInfo[@"bundleId"]]];
  }
  NSLog(@"PIDSPIKE[activeApps] %@", [activeApps componentsJoinedByString:@", "]);

  NSString *bundleOfAutPid = nil;
  NSString *bundleOfKeyboardPid = nil;
  NSString *bundleOfBarDonePid = nil;
  for (NSDictionary<NSString *, id> *appInfo in appsInfo) {
    pid_t pid = [appInfo[@"pid"] intValue];
    if (pid == autPid) {
      bundleOfAutPid = appInfo[@"bundleId"];
    }
    if (pid == keyboardPid) {
      bundleOfKeyboardPid = appInfo[@"bundleId"];
    }
    if (pid == barDonePid) {
      bundleOfBarDonePid = appInfo[@"bundleId"];
    }
  }

  NSLog(@"PIDSPIKE[summary] runtime=%@ candidates=%lu reachableByGuard=%lu aut=%d(%@) keyboard=%d(%@) "
        @"keyboardsQuery=%d barDone=%d(%@) barCancel=%d appDone=%d monitoredApp(barDone)=%@",
        NSProcessInfo.processInfo.operatingSystemVersionString,
        (unsigned long)candidates.count, (unsigned long)guardReachable.count,
        autPid, bundleOfAutPid, keyboardPid, bundleOfKeyboardPid, keyboardsQueryPid,
        barDonePid, bundleOfBarDonePid, barCancelPid, appDonePid,
        nil == barDoneAxElement ? @"<no element>" :
        [FBXCAXClientProxy.sharedClient
         monitoredApplicationWithProcessIdentifier:WDAPidOfAccessibilityElement(barDoneAxElement)].bundleID);

  // What the fallback is written against; if any of these stops holding, dismissal stops working.
  XCTAssertGreaterThan(autPid, 0, @"the application under test must have a process id");
  XCTAssertGreaterThan(barCancelPid, 0, @"the accessory bar's Cancel must resolve to a process");
  XCTAssertGreaterThan(barDonePid, 0,
                       @"the accessory bar's Done must resolve to a process outside the application "
                        "under test (aut=%d); that difference is the only thing the dismissal "
                        "fallback searches on", autPid);
  XCTAssertEqual(barCancelPid, barDonePid,
                 @"Cancel and Done are one bar and must be reported as one process (%d vs %d)",
                 barCancelPid, barDonePid);
  XCTAssertGreaterThan(keyboardPid, 0,
                       @"the element the fallback searches relative to (`self.keyboard`) must resolve "
                        "to a process");
  XCTAssertEqual(keyboardPid, keyboardsQueryPid,
                 @"`self.keyboard` and `app.keyboards` must name one process (%d vs %d); a guard can "
                  "only compare against a single keyboard pid if they agree",
                 keyboardPid, keyboardsQueryPid);
  XCTAssertFalse(nil == barDoneAxElement || nil == keyboardAxElement,
                 @"the bar and the keyboard must both have accessibility elements to compare at all");
  // Measured on watchOS 26.5 (Xcode 26.6) and 27.0 (Xcode 27.1): the accessory bar is owned by the
  // same process as the keyboard element, `com.apple.QuickboardViewService` - not merely "not the
  // application". While this holds, the guard can be narrowed to "same process as the keyboard
  // element", which is strictly tighter than "not the application under test" because it drops every
  // other foreign-process control from the set the fallback can tap.
  XCTAssertEqual(barDonePid, keyboardPid,
                 @"the accessory bar must be reported as the keyboard element's process (bar=%d "
                  "keyboard=%d); if they ever split, \"not the application under test\" is again the "
                  "narrowest scope that can reach Done", barDonePid, keyboardPid);

  // The tripwire premise: the fixture's own `Done` has to be an application-process control, or the
  // guard's exclusion of the application's process is not exercised here at all.
  XCTAssertEqual(appDonePid, autPid,
                 @"the fixture's own Done must live in the application's process (got %d, aut %d) so "
                  "the fallback's process check has something to reject", appDonePid, autPid);
  // The guard has to see the candidates it is deciding about, and let exactly the bar's Done through:
  // a predicate that never ran would pass the whole named set, which is the failure the process check
  // exists to prevent.
  XCTAssertEqual(1, (unsigned long)guardReachable.count,
                 @"only the accessory bar's Done should survive the process check; the guard reached "
                  "%lu of %lu candidates", (unsigned long)guardReachable.count,
                 (unsigned long)candidates.count);

  [self.app.buttons[@"Cancel"] tap];
}

@end
