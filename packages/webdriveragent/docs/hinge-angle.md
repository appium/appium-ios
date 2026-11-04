# Hinge angle

These endpoints use runtime capability checks on both simulators and physical
devices, rather than restricting access to a particular device model or to
Simulator builds. Reading an angle and injecting a simulated angle have separate
requirements.

`POST /session/:sessionId/wda/device/hingeAngle` with `{"angle": 90}` sends an
event requesting a simulated hinge angle of 90 degrees. The angle
must be a finite number from `0` (closed) to `180` (fully open); fractional values
are supported. POST checks for a hinge and the required IOKit serialization,
event creation, and dispatch APIs. This permits an injection attempt; it does not
establish that the device accepts this vendor payload. Physical devices may attempt
injection when those prerequisites exist, but event acceptance and the resulting
angle/layout changes on a physical Duo remain unverified. Devices without these
prerequisites, tvOS, and watchOS return `unsupported operation`.

On iOS 27.2 the simulator stops the first move of an intermediate angle about 5%
short of the target (for example 85.4° instead of 90°). After dispatching, POST therefore
waits for the angle to settle and, if the reading differs from the target by more than
0.05°, re-sends the angle nudged by up to 0.002° (at most twice). Intermediate angles
take about one second to return; the final reading is within that nudge of the target.
Values above 170° snap to 180° on the simulator. The correction is best effort and
never fails the request.

The response confirms event dispatch, not that the device applied the angle.
Wait for the expected app layout before continuing, since folding completes
asynchronously. The command does not rotate the device or update
`currentDisplayId`; select the desired display separately.

`GET /session/:sessionId/wda/device/hingeAngle` reads the current angle in degrees
and returns a numeric value, for example `{"value": 90.5}`. It reads CoreMotion
rather than remembering the last angle sent by WDA, so changes made outside WDA
are reflected too. The request waits up to five seconds for a valid reading and
returns an error if none arrives. GET separately checks for a hinge and the
CoreMotion subscription APIs; it does not depend on the IOKit injection APIs.
Devices without these reading prerequisites return `unsupported operation`.
A reading during a fold may reflect an intermediate angle; it does not wait for
the transition to finish.

Both hinge angle endpoints are also available without a session:
`GET /wda/device/hingeAngle` and `POST /wda/device/hingeAngle`. They operate on
the device and do not require creating an Appium session first.

## Validation and feedback

Hinge operations have been tested on the iPhone Duo simulator with Xcode 27.1.
We have not had access to a physical Duo for testing,
so hinge readings, acceptance of the private HID events, and the resulting
display/layout behavior on that hardware remain unverified. Loading CoreMotion
and finding `CMAngleManager` were verified on a physical iPad mini, which reported
no available hinge. On the same iPad mini running iPadOS 27.0.1, IOKit loading,
resolution of all four injection functions, payload serialization, vendor-event
creation, and HID client creation also succeeded. Event dispatch was not called.
These checks do not validate hinge readings or event acceptance on physical
hardware with a hinge.

If you have access to a physical device with a hinge, we would appreciate your
help testing these endpoints and [reporting the observed behavior](https://github.com/appium/WebDriverAgent/issues).
Please include the device model, iOS and Xcode versions, WDA version, requests and
responses, and any observed angle or display/layout changes. Reports of unsupported
operations or successful responses with no observable change are useful too.
