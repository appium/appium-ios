# Duo portrait-window viewport regression test

From `packages/webdriveragent`, set `DUO_UDID` to a booted Duo simulator and run:

```sh
bash WebDriverAgentTests/Fixtures/DuoPortraitApp/install.sh "$DUO_UDID"
xcodebuild -project WebDriverAgent.xcodeproj -scheme IntegrationTests_3 \
  -destination "id=$DUO_UDID" -parallel-testing-enabled NO \
  -only-testing:IntegrationTests_3/FBDisplayGestureTests/testPortraitWindowViewportTapsInLandscape test
```

The fixture uses the current SDK and the scene lifecycle. It supports only portrait
and requires full screen, so Duo hosts its portrait window centered and scaled on
the unfolded landscape display. Three buttons at one-quarter, one-half and
three-quarters of the app height let the test check viewport coordinates without
using accessibility geometry to calculate the expected targets.

The test exercises W3C viewport actions and `/wda/tap` in both landscape directions
and checks the actual button counters (12 taps). It fails with the snapshot frame
used as the coordinate anchor: the first W3C tap misses its button. Using XCTest's
native window frame for normalization makes the same test pass. Existing hosted
compatibility-app tests cover the separate pre-scene lifecycle path.
