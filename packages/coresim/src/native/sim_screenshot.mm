#include "sim_screenshot.h"

#import <CoreImage/CoreImage.h>
#import <IOSurface/IOSurface.h>
#import <ImageIO/ImageIO.h>
#import <objc/message.h>

#include "objc_runtime.h"
#include "safe_dispatch.h"

namespace coresim {

namespace {

NSString* const kScreenshotErrorDomain = @"io.appium.coresim.Screenshot";

NSError* MakeError(NSInteger code, NSString* message) {
  return [NSError errorWithDomain:kScreenshotErrorDomain code:code userInfo:@{NSLocalizedDescriptionKey : message}];
}

id IdGetter(id target, const std::string& selectorName) {
  RequireSelector(target, selectorName);
  SEL selector = SelectorNamed(selectorName);
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL);
    return ((Fn)objc_msgSend)(target, selector);
  });
}

// -[<SimDisplayDescriptorState> displayClass] — iOS's main display is class 0; tvOS renders only
// on the (non-zero) TVOut class.
unsigned short DisplayClass(id descriptorState) {
  static const std::string kSelectorName = "displayClass";
  RequireSelector(descriptorState, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);
  return SafeInvoke([&] {
    using Fn = unsigned short (*)(id, SEL);
    return ((Fn)objc_msgSend)(descriptorState, selector);
  });
}

// One renderable display IO port found among -[SimDeviceIOClient ioPorts]. Keeps "descriptor"
// alongside the JS-facing "id"/"displayClass" fields so CaptureScreenshot can resolve a requested
// displayId against the same list ListDisplays reports, without walking ioPorts twice.
NSString* const kCandidateUUIDKey = @"id";
NSString* const kCandidateDisplayClassKey = @"displayClass";
NSString* const kCandidateDescriptorKey = @"descriptor";

// Every IO port that actually renders a screen, in -[SimDeviceIOClient ioPorts]'s own order. Only
// a port conforming to the (private, headerless) SimDisplayIOSurfaceRenderable/SimDisplayRenderable
// protocols carries a "displayClass" or either surface accessor — other ports (audio, the
// screenshot mach service itself) don't, so the respondsToSelector: checks below are the actual
// filter, not defensive leftovers. Returns nil (and sets *error) only if the device has no IO
// client at all (e.g. not booted); no renderable port is an empty array, not an error — the caller
// decides whether that's fatal.
NSArray<NSDictionary*>* RenderableDisplayCandidates(id device, NSError** error) {
  id ioClient = IdGetter(device, "io");
  if (ioClient == nil) {
    *error = MakeError(1, @"Device has no IO client available — is it booted?");
    return nil;
  }

  NSArray* ports = IdGetter(ioClient, "ioPorts");
  NSMutableArray<NSDictionary*>* candidates = [NSMutableArray array];
  for (id port in ports) {
    id descriptor = IdGetter(port, "descriptor");
    if (descriptor == nil) continue;
    if (![descriptor respondsToSelector:NSSelectorFromString(@"framebufferSurface")] &&
        ![descriptor respondsToSelector:NSSelectorFromString(@"ioSurface")]) {
      continue;
    }
    if (![descriptor respondsToSelector:NSSelectorFromString(@"state")]) {
      continue;
    }
    id state = IdGetter(descriptor, "state");
    if (state == nil || ![state respondsToSelector:NSSelectorFromString(@"displayClass")]) {
      continue;
    }
    NSUUID* uuid = IdGetter(port, "uuid");
    [candidates addObject:@{
      kCandidateUUIDKey : uuid ? uuid.UUIDString : @"",
      kCandidateDisplayClassKey : @(DisplayClass(state)),
      kCandidateDescriptorKey : descriptor,
    }];
  }
  return candidates;
}

// Picks which candidate CaptureScreenshot should read from: the one matching `displayId` if given
// (an error if none match), else the primary display (displayClass 0), falling back to the first
// renderable display found so a target with no class-0 display (e.g. tvOS) still gets a
// screenshot instead of an outright failure.
id ResolveDisplayDescriptor(NSArray<NSDictionary*>* candidates, NSString* displayId, NSError** error) {
  if (displayId != nil) {
    for (NSDictionary* candidate in candidates) {
      if ([candidate[kCandidateUUIDKey] isEqualToString:displayId]) {
        return candidate[kCandidateDescriptorKey];
      }
    }
    *error = MakeError(2, [NSString stringWithFormat:@"No display with id '%@' was found on this device", displayId]);
    return nil;
  }
  id fallback = nil;
  for (NSDictionary* candidate in candidates) {
    if ([candidate[kCandidateDisplayClassKey] unsignedShortValue] == 0) {
      return candidate[kCandidateDescriptorKey];
    }
    if (fallback == nil) {
      fallback = candidate[kCandidateDescriptorKey];
    }
  }
  if (fallback == nil) {
    *error = MakeError(3, @"No renderable display port was found on this device");
  }
  return fallback;
}

// Unlike IdGetter, doesn't RequireSelector: a display proxy that has lost its connection (e.g. the
// device just shut down) can legitimately stop responding to a selector it answered a moment ago —
// that's "no surface right now", not "unsupported on this CoreSimulator", so it must not raise
// NativeSimUnavailableError the way a genuinely missing selector should.
id OptionalIdGetter(id target, NSString* selectorName) {
  SEL selector = NSSelectorFromString(selectorName);
  if (![target respondsToSelector:selector]) {
    return nil;
  }
  return SafeInvoke([&] {
    using Fn = id (*)(id, SEL);
    return ((Fn)objc_msgSend)(target, selector);
  });
}

// `framebufferSurface` is the primary surface since Xcode 13.2 split what used to be a single
// `ioSurface`; both are real (non-optional) members of the descriptor's protocol once it's passed
// RenderableDisplayCandidates' filter above, but the underlying remote proxy can still legitimately
// vend nil for either — or stop responding entirely if the connection just dropped — so both are
// tried before giving up.
id RenderableSurface(id descriptor) {
  return OptionalIdGetter(descriptor, @"framebufferSurface") ?: OptionalIdGetter(descriptor, @"ioSurface");
}

NSString* const kPNGUTI = @"public.png";
NSString* const kJPEGUTI = @"public.jpeg";

}  // namespace

id ResolveCaptureDisplay(id device, NSString* displayId, NSError** error) {
  NSArray<NSDictionary*>* candidates = RenderableDisplayCandidates(device, error);
  if (candidates == nil) {
    return nil;
  }
  return ResolveDisplayDescriptor(candidates, displayId, error);
}

// The real protocol is SimScreenCaptureService (see CLAUDE.md) — found by scanning ioPorts for
// whichever descriptor responds to startRecordingFromScreen:..., since no header exists for it.
id ResolveScreenCaptureService(id device, NSError** error) {
  static const std::string kStartRecordingSelector =
      "startRecordingFromScreen:maskPolicy:assetWriterOutputSettings:outputFile:completionQueue:completionHandler:";
  id ioClient = IdGetter(device, "io");
  if (ioClient == nil) {
    *error = MakeError(11, @"Device has no IO client available — is it booted?");
    return nil;
  }
  NSArray* ports = IdGetter(ioClient, "ioPorts");
  SEL selector = NSSelectorFromString(@(kStartRecordingSelector.c_str()));
  for (id port in ports) {
    id descriptor = IdGetter(port, "descriptor");
    if (descriptor != nil && [descriptor respondsToSelector:selector]) {
      return descriptor;
    }
  }
  throw NativeSimUnavailableError("selector", kStartRecordingSelector, CoreSimulatorFrameworkVersion());
}

id CurrentDisplaySurface(id descriptor) { return RenderableSurface(descriptor); }

NSArray<NSDictionary*>* ListDisplays(id device, NSError** error) {
  NSArray<NSDictionary*>* candidates = RenderableDisplayCandidates(device, error);
  if (candidates == nil) {
    return nil;
  }
  NSMutableArray<NSDictionary*>* result = [NSMutableArray arrayWithCapacity:candidates.count];
  for (NSDictionary* candidate in candidates) {
    unsigned short displayClass = [candidate[kCandidateDisplayClassKey] unsignedShortValue];
    [result addObject:@{
      @"id" : candidate[kCandidateUUIDKey],
      @"displayClass" : candidate[kCandidateDisplayClassKey],
      @"isMain" : @(displayClass == 0),
    }];
  }
  return result;
}

NSData* EncodeImage(CGImageRef cgImage, ScreenshotFormat format, NSNumber* jpegQualityPercent, NSError** error) {
  NSString* uti = format == ScreenshotFormat::kJPEG ? kJPEGUTI : kPNGUTI;
  NSMutableData* imageData = [NSMutableData data];
  CGImageDestinationRef destination =
      CGImageDestinationCreateWithData((__bridge CFMutableDataRef)imageData, (__bridge CFStringRef)uti, 1, NULL);
  if (destination == nullptr) {
    *error = MakeError(7, @"Failed to create an image encoder");
    return nil;
  }
  // kCGImageDestinationLossyCompressionQuality is meaningless for PNG (always lossless) — ImageIO
  // silently ignores properties a format doesn't use, so this is only gated on jpegQualityPercent
  // being present, not on `format` too.
  NSDictionary* properties =
      jpegQualityPercent != nil
          ? @{(NSString*)kCGImageDestinationLossyCompressionQuality : @(jpegQualityPercent.doubleValue / 100.0)}
          : nil;
  CGImageDestinationAddImage(destination, cgImage, (__bridge CFDictionaryRef)properties);
  BOOL ok = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  if (!ok) {
    *error = MakeError(8, @"Failed to encode the image");
    return nil;
  }
  return imageData;
}

NSData* CaptureScreenshot(id device, NSString* displayId, ScreenshotFormat format, NSNumber* jpegQualityPercent,
                          NSError** error) {
  id descriptor = ResolveCaptureDisplay(device, displayId, error);
  if (descriptor == nil) {
    return nil;
  }

  id surfaceObj = RenderableSurface(descriptor);
  if (surfaceObj == nil) {
    *error = MakeError(4, @"The device's display surface is not available yet");
    return nil;
  }

  IOSurfaceRef surfaceRef = (__bridge IOSurfaceRef)surfaceObj;
  CIImage* ciImage = [CIImage imageWithIOSurface:surfaceRef];
  if (ciImage == nil) {
    *error = MakeError(5, @"Failed to wrap the device's display surface as an image");
    return nil;
  }

  // A fresh CIContext per call, matching this operation's one-shot semantics (mirrors
  // simctl's own screenshot command) rather than the persistent, reused context a
  // continuous video/streaming path would want (JpegStreamSession — see sim_jpeg_stream.mm).
  CIContext* context = [CIContext contextWithOptions:nil];
  CGImageRef cgImage = [context createCGImage:ciImage fromRect:ciImage.extent];
  if (cgImage == nil) {
    *error = MakeError(6, @"Failed to render the device's display surface");
    return nil;
  }

  NSData* imageData = EncodeImage(cgImage, format, jpegQualityPercent, error);
  CGImageRelease(cgImage);
  return imageData;
}

}  // namespace coresim
