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

  private func presentAlert() {
    let button = app.buttons["showAlertButton"]
    XCTAssertTrue(button.waitForExistence(timeout: 15), "expected the fixture's alert button")
    button.tap()
    XCTAssertTrue(
      app.staticTexts["Alert Title"].waitForExistence(timeout: 10),
      "expected the alert to be presented"
    )
  }

  func testAlertTextWithNoAlertPresentReturnsNil() {
    XCTAssertNil(FBAlert(application: app).text())
  }

  func testAlertButtonsWithNoAlertPresentReturnsNil() {
    XCTAssertNil(FBAlert(application: app).buttonLabels())
  }

  func testPlaceholderAlertElementIsNotMistakenForAnAlertWhileAnAlertIsOpen() {
    // The regression this pins: with the placeholder unfiltered, an open alert still reported the
    // placeholder's empty contents - an empty string and an empty button list - which is a wrong
    // answer, not merely an unhelpful one.
    presentAlert()

    let alert = FBAlert(application: app)
    XCTAssertNil(alert.text(), "expected no FBAlert-detectable alert on watchOS")
    XCTAssertNil(alert.buttonLabels(), "expected no FBAlert-detectable alert on watchOS")
  }

  func testAlertButtonsStayTappableAsOrdinaryElements() {
    // The way to drive a watchOS alert: its controls are normal elements in the app's tree.
    presentAlert()

    let okButton = app.buttons["OK"]
    XCTAssertTrue(okButton.exists, "expected the alert's OK button as an ordinary element")
    okButton.tap()
    XCTAssertEqual(app.staticTexts["resultLabel"].label, "Accepted")
  }
}
