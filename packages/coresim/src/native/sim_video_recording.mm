#include "sim_video_recording.h"

#import <objc/message.h>

#include "objc_runtime.h"
#include "safe_dispatch.h"
#include "sim_screenshot.h"

namespace coresim {

BOOL StartVideoRecording(id device, NSString* displayId, VideoMaskPolicy mask, NSDictionary* assetWriterOutputSettings,
                         NSString* outputFile, dispatch_queue_t queue, void (^handler)(NSError*), NSError** error) {
  id captureService = ResolveScreenCaptureService(device, error);
  if (captureService == nil) {
    return NO;
  }
  id screen = ResolveCaptureDisplay(device, displayId, error);
  if (screen == nil) {
    return NO;
  }
  static const std::string kSelectorName =
      "startRecordingFromScreen:maskPolicy:assetWriterOutputSettings:outputFile:completionQueue:completionHandler:";
  SEL selector = NSSelectorFromString(@(kSelectorName.c_str()));
  return SafeInvoke([&] {
    using Fn = void (*)(id, SEL, id, long long, NSDictionary*, NSString*, dispatch_queue_t, void (^)(NSError*));
    ((Fn)objc_msgSend)(captureService, selector, screen, static_cast<long long>(mask), assetWriterOutputSettings,
                       outputFile, queue, handler);
    return YES;
  });
}

BOOL StopVideoRecording(id device, dispatch_queue_t queue, void (^handler)(NSError*), NSError** error) {
  id captureService = ResolveScreenCaptureService(device, error);
  if (captureService == nil) {
    return NO;
  }
  static const std::string kSelectorName = "stopRecordingWithCompletionQueue:completionHandler:";
  SEL selector = NSSelectorFromString(@(kSelectorName.c_str()));
  return SafeInvoke([&] {
    using Fn = void (*)(id, SEL, dispatch_queue_t, void (^)(NSError*));
    ((Fn)objc_msgSend)(captureService, selector, queue, handler);
    return YES;
  });
}

}  // namespace coresim
