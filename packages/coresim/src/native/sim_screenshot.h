#pragma once

#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <functional>

namespace coresim {

// Enumerates the device's renderable display IO ports — the same information `simctl io <udid>
// enumerate` reports for its own `--display` selection. Each element contains:
// - "id": NSString port UUID — pass to CaptureScreenshot's displayId to target it.
// - "displayClass": NSNumber/unsigned short, the raw display class.
// - "isMain": NSNumber/BOOL, true when displayClass == 0. Multiple integrated displays can
//   have class 0 (e.g. both Duo displays); this does not identify a unique primary display.
// - "screenId": optional NSNumber/unsigned int guest screen ID from SimScreenProperties.screenID,
//   matching XCTest's displayID. Omitted when the required selectors are unavailable.
// Returns nil (and sets *error) if the device has no IO client at all (e.g. not booted); an empty
// (non-nil) array means the device has an IO client but no renderable display.
NSArray<NSDictionary*>* ListDisplays(id device, NSError** error);

// Resolves the display descriptor CaptureScreenshot itself reads from, without capturing a
// screenshot — same displayId/fallback semantics, exposed for callers that need the descriptor
// object itself (e.g. StartVideoRecording's `screen` argument).
id ResolveCaptureDisplay(id device, NSString* displayId, NSError** error);

// The device-wide "capture service" port (real protocol: SimScreenCaptureService — see CLAUDE.md),
// distinct from a display descriptor (see ResolveCaptureDisplay above). Found by scanning ioPorts
// since no header exists. Throws NativeSimUnavailableError (not NSError**) if absent.
id ResolveScreenCaptureService(id device, NSError** error);

// The descriptor's current framebuffer as an `IOSurfaceRef` (bridge-cast the returned `id`).
// Returns nil if not available yet (e.g. connection just dropped) — not an error, since that can
// legitimately happen from one call to the next on a live device.
id CurrentDisplaySurface(id descriptor);

// What one PolledDisplaySurface::Current() call found.
struct DisplaySurfaceLookup {
  enum class Status {
    kSurface,      // `surface` is the display's surface.
    kNoSurface,    // The display has no surface right now. Transient: try again on the next poll.
    kUnavailable,  // The display itself could not be resolved (e.g. the device is gone); see `error`.
  };
  Status status = Status::kNoSurface;
  // An `IOSurfaceRef` (bridge-cast it). Set for kSurface only.
  id surface = nil;
  // ResolveCaptureDisplay's error. Set for kUnavailable only.
  NSError* error = nil;
};

// One display's surface for a caller that polls it many times a second (the streaming sessions'
// timers). ResolveCaptureDisplay + CurrentDisplaySurface walk the device's IO ports over
// synchronous XPC, about 2 ms a call: done on every poll of a screen that never changed, that
// alone cost about 15% of a CPU core in this process and 20% in CoreSimulator's own services at
// 30 polls a second (M5 Pro, Xcode 27.2). So the surface is kept between polls and only looked up
// again once per kRefreshIntervalSeconds. That interval is therefore also how late a deleted or
// shut down device, a disconnected display or a replaced surface is noticed.
// Not thread-safe: every call must come from the same serial queue, or from one thread while that
// queue cannot be polling (before its timer starts, after it has drained).
class PolledDisplaySurface {
 public:
  static constexpr double kRefreshIntervalSeconds = 1.0;

  // One uncached lookup, and a monotonic clock in seconds. Both can be replaced so the caching
  // rules can be tested without a simulator.
  using Lookup = std::function<DisplaySurfaceLookup()>;
  using Clock = std::function<double()>;

  // `displayId` has ResolveCaptureDisplay's own semantics.
  PolledDisplaySurface(id device, NSString* displayId);
  PolledDisplaySurface(Lookup lookup, Clock clock);

  // The kept surface, or a fresh lookup if there is none or it is older than the interval. Only a
  // found surface is kept: after kNoSurface or kUnavailable the very next call looks up again.
  DisplaySurfaceLookup Current();

  // Drops the kept surface, so the next Current() looks it up again, and so a session that has
  // stopped does not pin it for as long as its own object happens to live.
  void Reset();

 private:
  Lookup lookup_;
  Clock clock_;
  id surface_ = nil;
  double refreshedAt_ = 0;
};

enum class ScreenshotFormat { kPNG, kJPEG };

// Encodes `cgImage` via ImageIO into `format` — the same CGImageDestination-based encode
// CaptureScreenshot uses for its own final step, exposed for a caller that already has a
// CGImageRef from its own CIContext (e.g. JpegStreamSession's persistent one — see
// sim_jpeg_stream.mm). `jpegQualityPercent` semantics match CaptureScreenshot's own parameter of
// the same name. Returns nil (and sets *error) on encode failure. Does not release `cgImage`.
NSData* EncodeImage(CGImageRef cgImage, ScreenshotFormat format, NSNumber* jpegQualityPercent, NSError** error);

// Captures a display as an image, reading the same in-process framebuffer surface `simctl io
// <udid> screenshot` itself reads (see sim_screenshot.mm) — no temp file, no subprocess.
// `displayId`, if non-nil, selects a specific port by its UUID (see ListDisplays); nil selects the
// first class-0 display, falling back to the first renderable display if none has class 0 (e.g.
// tvOS). Native selection does not reject multiple class-0 ports; callers that require a unique
// target must resolve a UUID first. `jpegQualityPercent` (0-100, nil for ImageIO's own default)
// only applies when `format` is kJPEG — ignored for kPNG, which is always lossless. Returns nil
// (and sets *error) if `displayId` doesn't match any port, the resolved display has no renderable
// surface yet (e.g. not booted), or rendering/encoding failed.
NSData* CaptureScreenshot(id device, NSString* displayId, ScreenshotFormat format, NSNumber* jpegQualityPercent,
                          NSError** error);

}  // namespace coresim
