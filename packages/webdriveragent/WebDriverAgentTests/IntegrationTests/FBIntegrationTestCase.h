/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

extern NSString *const FBShowAlertButtonName;
extern NSString *const FBShowSheetAlertButtonName;
extern NSString *const FBShowAlertForceTouchButtonName;
extern NSString *const FBTouchesCountLabelIdentifier;
extern NSString *const FBTapsCountLabelIdentifier;

/**
 Labels of the buttons on the integration app's main page, in their on-screen
 (top to bottom) order. Update this in one place - WebDriverAgentTests/IntegrationApp/Resources/Base.lproj/Main.storyboard -
 and here, rather than duplicating the list/count across individual tests.
 */
extern NSArray<NSString *> *const FBMainViewButtonLabels;

/**
 XCTestCase helper class used for integration tests
 */
@interface FBIntegrationTestCase : XCTestCase
@property (nonatomic, strong, readonly) XCUIApplication *testedApplication;
@property (nonatomic, strong, readonly) XCUIApplication *springboard;

/**
 Whether tests are running under CI, as forwarded into the test process by the
 scheme's CI environment variable (see Fastlane/Fastfile). Use to XCTSkip tests
 that are known to be too slow/flaky/unsupported for CI.
 */
+ (BOOL)isRunningInCI;

/**
 Names of this class's tests that depend on the iPad form factor and so also run in the dedicated
 iPad CI job (@[@"*"] for all of them). The iPhone jobs run every test. This is only metadata:
 Scripts/ci/check-integration-test-plan.mjs reads the literal `return @[...]` of overrides to
 build the iPad job's test list.
 */
+ (NSArray<NSString *> *)iPadTests;

/**
 Override to XCTSkip the running test (see self.invocation.selector) when it is unsupported
 on this device/OS/CI. Called from setUp before the app is launched, so skipped tests stay cheap.
 */
- (void)skipIfUnsupported;

/**
 Launches application and resets side effects of testing like orientation etc.
 */
- (void)launchApplication;

/**
 Navigates integration app to attributes page
 */
- (void)goToAttributesPage;

/**
 Navigates integration app to alerts page
 */
- (void)goToAlertsPage;

/**
 Navigates integration app to touch page
 */
- (void)goToTouchPage;

/**
 Navigates to SpringBoard first page
 */
- (void)goToSpringBoardFirstPage;

/**
 Navigates to SpringBoard's dashboard
 */
- (void)goToSpringBoardDashboard;

/**
 Navigates integration app to scrolling page
 @param showCells whether should navigate to view with cell or plain scrollview
 */
- (void)goToScrollPageWithCells:(BOOL)showCells;

/**
 Navigates integration app to a page containing a 70-level-deep chain of
 nested elements (otherElements[@"view_0"]...otherElements[@"view_69"]),
 each nested directly inside the previous one. Intended as a fixture for
 performance testing of element lookups (e.g. class chain locators) against
 a deep accessibility tree.
 */
- (void)goToDeepHierarchyPage;

/**
 Verifies no alerts are present on the page.
 If an alert exists then it is going to be dismissed.
 */
- (void)clearAlert;

/**
 Resets device orientation to portrait mode
 */
- (void)resetOrientation;

/**
 appium/appium#16185: skips the current test unless the app's window size actually
 differs from SpringBoard's, e.g. an iPhone-only app on iPad (built with
 TARGETED_DEVICE_FAMILY=1).
 */
- (void)skipUnlessWindowSizeMismatchesDevice;

@end
