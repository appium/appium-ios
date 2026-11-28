# Duo hosted tap test

From `packages/webdriveragent`, set `DUO_UDID` to the UDID of a booted Duo simulator, then run

```sh
bash WebDriverAgentTests/Fixtures/DuoHostedApp/install.sh "$DUO_UDID"
xcodebuild -project WebDriverAgent.xcodeproj -scheme IntegrationTests_3 \
  -destination "id=$DUO_UDID" -parallel-testing-enabled NO \
  -only-testing:IntegrationTests_3/FBDisplayGestureTests/testHostedCompatibilityTapsAcrossFoldStates test
```

The fixture uses the pre-scene app lifecycle. The installer builds it with the
current SDK and marks the simulator binary as linked against SDK 26 so the runtime
uses its compatibility layout. The test checks XCTest's reported display affinity
and counts touches delivered to the button on each panel.
