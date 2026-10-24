# Hinge angle

`GET /session/:sessionId/wda/device/hingeAngle` reads the current hinge angle in
degrees using CoreMotion, on supported simulators and physical devices. It returns
a numeric value, for example `{"value": 90.5}`, including changes made outside WDA.
It waits up to five seconds for a valid reading and returns an error if none arrives.
Devices without a hinge or the CoreMotion subscription APIs, tvOS, and watchOS
return `unsupported operation`. A reading during a fold may be an intermediate angle.

`GET /wda/device/hingeAngle` is also available without a session.

Simulated hinge injection is implemented on the Mac in `@appium/coresim` and used
by the XCUITest driver's `mobile: setSimulatedHingeAngle` command. It is simulator-only.
The legacy WDA POST endpoint returns `unsupported operation`; WDA no longer directly
injects HID events. Select `currentDisplayId` separately after folding, and wait for
the expected application layout before resolving coordinates.
