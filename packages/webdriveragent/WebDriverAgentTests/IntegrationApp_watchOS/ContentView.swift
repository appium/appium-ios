/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import SwiftUI

struct ContentView: View {
  @State private var resultText = "Idle"
  @State private var typedText = ""
  @State private var showAlert = false

  var body: some View {
    // ScrollView keeps content reachable - WDA's test-launch path shifts the scene down
    // vs. a plain launch, which can push a plain VStack off-screen.
    ScrollView {
      VStack(spacing: 8) {
        Text(resultText)
          .accessibilityIdentifier("resultLabel")
        Button("Tap Me") {
          resultText = "Tapped"
        }
        .accessibilityIdentifier("tapMeButton")
        Button("Show Alert") {
          showAlert = true
        }
        .accessibilityIdentifier("showAlertButton")
        TextField("Type here", text: $typedText)
          .accessibilityIdentifier("typingField")
      }
    }
    .alert("Alert Title", isPresented: $showAlert) {
      Button("OK") { resultText = "Accepted" }
      Button("Cancel", role: .cancel) { resultText = "Cancelled" }
    } message: {
      Text("Alert message body")
    }
  }
}
