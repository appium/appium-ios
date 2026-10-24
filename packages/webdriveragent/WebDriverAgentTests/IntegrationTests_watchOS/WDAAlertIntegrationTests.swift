/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import XCTest

/// Covers FBAlert's alert detection on watchOS directly, in-process.
///
/// Two watchOS behaviours shape this suite, both measured on watchOS 26.5:
///
///  * The *system* application always keeps a full-screen element typed
///    `XCUIElementTypeAlert` in its tree - `accessible = false`, no label and no children,
///    identical before, during and after a real alert. FBAlert's detection query matches that type
///    first, so without the empty-candidate guard in `fb_alertElementWithSnapshot:` every alert
///    command answered as though an alert were open (`text` returned "", `buttonLabels` returned
///    [], and `FBAlertsMonitor` fired on every tick).
///  * A watchOS alert is not typed `XCUIElementTypeAlert` at all. SwiftUI's `.alert` renders inside
///    the host application's own tree as a table of cells with a button each, so there is nothing
///    for FBAlert to detect and alert commands legitimately report "no such alert" there. Drive
///    such an alert by tapping its buttons as ordinary elements.
final class WDAAlertIntegrationTests: WDAWatchInProcessTestCase {
  override class var relaunchForEachTest: Bool { true }

  /// Presents the fixture alert.
  ///
  /// Skips rather than asserts that this runtime rendered it: how SwiftUI's `.alert` appears in the
  /// element tree is system-UI shape, measured only on watchOS 26.5/27.0, while
  /// `IntegrationTests_watchOS` also compiles into a watchOS 11.5 / Xcode 16.4 CI leg where a
  /// different rendering is not a product bug. Everything asserted after this call returns is about
  /// WDA's own code paths and stays strict.
  private func presentAlert() throws {
    let button = app.buttons["showAlertButton"]
    XCTAssertTrue(button.waitForExistence(timeout: 15), "expected the fixture's alert button")
    button.tap()
    guard app.staticTexts["Alert Title"].waitForExistence(timeout: 10) else {
      throw XCTSkip("this runtime renders the fixture alert differently than the measured "
        + "watchOS 26.5/27.0 shape, so there is no alert on screen to assert against")
    }
  }

  func testAlertTextWithNoAlertPresentReturnsNil() {
    XCTAssertNil(FBAlert(application: app).text())
  }

  func testAlertButtonsWithNoAlertPresentReturnsNil() {
    XCTAssertNil(FBAlert(application: app).buttonLabels())
  }

  func testPlaceholderAlertElementIsNotMistakenForAnAlertWhileAnAlertIsOpen() throws {
    // The placeholder pin: the *system* application keeps a childless, label-less
    // `XCUIElementTypeAlert` in its tree at all times, and before
    // `fb_alertElementWithSnapshot:` filtered empty candidates an open alert reported that
    // placeholder's contents - an empty string plus an empty button list - which is a wrong answer,
    // not merely an unhelpful one. So what this test forbids is FBAlert reporting an alert that
    // carries no contents of its own; it deliberately does not require `text`/`buttonLabels` to be
    // nil, because on a watchOS that one day types a SwiftUI alert as a childful
    // `XCUIElementTypeAlert` - an improvement - a bare nil check would read that as a failure. The
    // "alerts are ordinary elements" expectation is carried by
    // `testAlertButtonsStayTappableAsOrdinaryElements`, which needs no alert detection at all.
    try presentAlert()

    let alert = FBAlert(application: app)
    let text = alert.text()
    let labels = alert.buttonLabels()
    XCTAssert(
      (text == nil && labels == nil) || text?.isEmpty == false || labels?.isEmpty == false,
      "FBAlert reported an alert with no contents of its own (text: \(String(describing: text)), "
        + "buttons: \(String(describing: labels))) - that is the placeholder element, not an alert"
    )
  }

  func testAlertButtonsStayTappableAsOrdinaryElements() throws {
    // The way to drive a watchOS alert: its controls are normal elements in the app's tree.
    try presentAlert()

    let okButton = app.buttons["OK"]
    // Skipped, not asserted: the button's label and its being a plain `XCUIElementTypeButton` are
    // the same system-UI shape `presentAlert()` already refuses to pin across CI legs.
    guard okButton.waitForExistence(timeout: 5) else {
      throw XCTSkip("this runtime does not expose the fixture alert's controls as ordinary "
        + "elements, so there is nothing for this expectation to drive")
    }
    okButton.tap()
    XCTAssertEqual(app.staticTexts["resultLabel"].label, "Accepted")
  }
}
