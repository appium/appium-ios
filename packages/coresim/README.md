# @appium/coresim

Fast, native control of the iOS/tvOS/watchOS/visionOS Simulator from Node.js — no `simctl`
subprocess, no CLI output to parse.

## Why

Most tools drive the Simulator by shelling out to `simctl` and parsing its text output.
`@appium/coresim` talks to the same underlying system directly, in-process. That means:

- **Faster** — no process spawn per call.
- **More reliable** — real errors instead of scraped stderr strings.
- **Async by design** — every call returns a `Promise` and never blocks your app.

## Install

```sh
npm install @appium/coresim
```

Works on any platform to install, but simulator control requires **macOS**. On other platforms
(or when the Simulator isn't available), calls reject with a clear `NativeSimUnavailableError`
instead of crashing.

## Usage

```ts
import {NativeSimctl} from '@appium/coresim';

const sim = new NativeSimctl();

const devices = await sim.getDevices();
console.log(devices.map((d) => `${d.name} (${d.state})`));

const device = await sim.createDevice(
  'My Test Device',
  'com.apple.CoreSimulator.SimDeviceType.iPhone-15',
  'com.apple.CoreSimulator.SimRuntime.iOS-17-4',
);

await sim.bootDevice(device.udid);
await sim.waitForBoot(device.udid); // waits until the simulator is fully ready, not just "booted"

await sim.installApp(device.udid, '/path/to/MyApp.app');
await sim.launchApp(device.udid, 'com.example.MyApp');

await sim.shutdownDevice(device.udid);
await sim.deleteDevice(device.udid);
```

## What it can do

- **Devices** — list, create, delete, boot, shut down, and erase simulators; check real boot
  readiness with `getBootStatus()`/`waitForBoot()`.
- **Apps** — install, remove, launch, terminate, and inspect apps.
- **Processes** — spawn a process on the simulator and stream its stdout/stderr live.
- **Screen capture** — screenshots, video recording to a file, a real-time encoded video stream,
  and a real-time JPEG frame stream (`startJpegStream` — configurable fps/quality, no video codec
  involved, meant for callers building their own MJPEG stream out of the frame sequence) —
  optionally with the device's own audio, muxed into the recording or interleaved into the video
  stream (`audio: true` on `startVideoRecording`/`startVideoStream`). Audio capture requires:
  - **macOS 14.2+** on the host (Core Audio process taps).
  - The host's **"System Audio Recording Only"** privacy permission (System Settings > Privacy &
    Security > Screen & System Audio Recording). This can't be granted programmatically, and a
    denial isn't a thrown error — it silently produces an audio-less/near-silent track.
  - A default audio output device on the host, and a booted simulator that has produced audio at
    least once (e.g. a foreground app that plays sound) — an empty guest process set throws.
  - Uses a host-side Core Audio API, not anything iOS-version-specific, so it's expected to work
    on any simulator runtime; only Xcode 26.x has actually been exercised so far.

  On some CI/headless hosts, starting an audio capture can block for a while before failing —
  see [`CLAUDE.md`](./CLAUDE.md) for the known root cause and current workaround.
- **Simulator settings** — appearance (light/dark), accessibility (increase contrast, content
  size), location, and permissions.
- **Extras** — keychain certificates, push notifications, and Darwin notifications.

## Status

Early stage: core device and app lifecycle is implemented and tested; broader coverage is in
progress.

See [`CLAUDE.md`](./CLAUDE.md) for architecture details.
