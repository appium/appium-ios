/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBDuoElementTap.h"

#if TARGET_OS_IOS
#import "FBConfiguration.h"
#import "FBErrorBuilder.h"
#import "FBHIDOperations+DuoRotation.h"
#import "FBMathUtils.h"
#import "FBScreen.h"
#import "XCUIElement.h"
#import "XCUIScreen.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "FBXCTestDaemonsProxy.h"
#import "XCUICoordinate.h"
#import "XCUIDevice+FBHinge.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElement+FBScrolling.h"
#import "XCUIHitPointResult.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"

@protocol FBDisplayHitTestApplication <NSObject>
+ (instancetype)uiApplicationAtCoordinate:(CGPoint)point displayId:(unsigned int)displayID;
@property (nonatomic, readonly) pid_t pid;
@end

// The hosted-view transform API is optional on older XCTest versions. Keep the
// original window context and substitute only the selected display, without
// changing XCTest's shared snapshots.
@protocol FBHostedViewTransform <NSObject>
@property (nonatomic, readonly) unsigned long long windowID;
@property (nonatomic, readonly) CGPoint point;
+ (id)transformParametersWithWindowID:(unsigned long long)windowID displayID:(unsigned long long)displayID;
+ (id)pointTransformationRequestWithPoint:(CGPoint)point parameters:(id)parameters;
- (id)_transformParametersOrError:(NSError **)error;
- (id)_transformPointWithRequest:(id)request error:(NSError **)error;
@end

// Element offsets use the accessibility frame. A tap without an offset uses
// XCTest's hit point, which may require scrolling the element into view first.
static NSValue *FBHostedElementPoint(XCUIElement *element, NSValue *offset, NSError **error)
{
  id<FBXCElementSnapshot> snapshot = element.fb_standardSnapshot;
  if (offset != nil) {
    CGRect frame = snapshot.frame;
    if (CGRectIsEmpty(frame)) {
      [[[FBErrorBuilder builder] withDescription:@"The hosted element has an empty frame"] buildError:error];
      return nil;
    }
    return [NSValue valueWithCGPoint:CGPointMake(frame.origin.x + offset.CGPointValue.x,
                                                 frame.origin.y + offset.CGPointValue.y)];
  }
  XCUIHitPointResult *hitPoint = [snapshot hitPoint:error];
  if (!hitPoint.isHittable) {
    if (![element fb_scrollToVisibleWithError:error]) {
      return nil;
    }
    hitPoint = [element.fb_standardSnapshot hitPoint:error];
  }
  if (!hitPoint.isHittable) {
    [[[FBErrorBuilder builder] withDescription:@"The hosted element has no hittable point"] buildError:error];
    return nil;
  }
  return [NSValue valueWithCGPoint:hitPoint.hitPoint];
}

static XCUIElement *FBSelectedSystemWindow(XCUIScreen *screen, NSError **error)
{
  CGRect windowFrame;
  // Require a system window on the destination before overriding the app
  // window's reported display. It also supplies the viewport coordinate anchor.
  XCUIElement *systemWindow = FBWindowOnDisplay(XCUIApplication.fb_systemApplication,
                                               screen.displayID, &windowFrame);
  if (nil == systemWindow) {
    [[[FBErrorBuilder builder] withDescription:@"No system window is available on the selected display"] buildError:error];
  }
  return systemWindow;
}

static NSValue *FBViewportTapPoint(XCUIElement *systemWindow, CGPoint offset, NSError **error)
{
  // These offsets are already viewport points. Normalize against XCTest's
  // native frame (not the app-space accessibility frame) so it applies only
  // the selected window's event-synthesis orientation transform.
  CGRect nativeFrame = systemWindow.frame;
  if (CGRectIsEmpty(nativeFrame)) {
    [[[FBErrorBuilder builder] withDescription:@"The selected system window has an empty frame"] buildError:error];
    return nil;
  }
  return [NSValue valueWithCGPoint:FBCoordinateInWindow(systemWindow, nativeFrame, offset).screenPoint];
}

static NSValue *FBTransformedElementTapPoint(XCUIElement *element, NSValue *offset, long long displayID, NSError **error)
{
  Class<FBHostedViewTransform> parametersClass = NSClassFromString(@"XCUITransformParameters");
  Class<FBHostedViewTransform> requestClass = NSClassFromString(@"XCUIPointTransformationRequest");
  if (![parametersClass respondsToSelector:@selector(transformParametersWithWindowID:displayID:)]
      || ![requestClass respondsToSelector:@selector(pointTransformationRequestWithPoint:parameters:)]) {
    [[[FBErrorBuilder builder] withDescription:@"XCTest cannot transform the tap to the selected display"] buildError:error];
    return nil;
  }
  NSValue *rawPoint = FBHostedElementPoint(element, offset, error);
  if (rawPoint == nil) {
    return nil;
  }
  id<FBHostedViewTransform> snapshot = (id)element.fb_nativeSnapshot;
  if (![snapshot respondsToSelector:@selector(_transformParametersOrError:)]
      || ![snapshot respondsToSelector:@selector(_transformPointWithRequest:error:)]) {
    [[[FBErrorBuilder builder] withDescription:@"XCTest cannot transform the tap to the selected display"] buildError:error];
    return nil;
  }
  id<FBHostedViewTransform> originalParameters = [snapshot _transformParametersOrError:error];
  if (nil == originalParameters) {
    return nil;
  }
  id parameters = [parametersClass transformParametersWithWindowID:originalParameters.windowID
                                                              displayID:displayID];
  id request = [requestClass pointTransformationRequestWithPoint:rawPoint.CGPointValue parameters:parameters];
  id<FBHostedViewTransform> transformed = [snapshot _transformPointWithRequest:request error:error];
  if (nil == transformed) {
    return nil;
  }
  return [NSValue valueWithCGPoint:transformed.point];
}

static BOOL FBApplicationOwnsPoint(XCUIApplication *application, CGPoint point, long long displayID)
{
  // SpringBoard can have a window even on the inactive panel. Before sending a
  // hosted tap, verify that the app owns the hit point on the destination display.
  Class<FBDisplayHitTestApplication> axClass = NSClassFromString(@"AXUIElement");
  id<FBDisplayHitTestApplication> hit = [axClass respondsToSelector:@selector(uiApplicationAtCoordinate:displayId:)]
    ? [axClass uiApplicationAtCoordinate:point displayId:(unsigned int)displayID] : nil;
  return [hit respondsToSelector:@selector(pid)] && hit.pid > 0 && hit.pid == application.processID;
}

@implementation FBDuoElementTap

+ (FBHostedTapResult)tapHostedElement:(XCUIElement *)element
                               offset:(nullable NSValue *)offset
                                error:(NSError **)error
{
  NSNumber *selectedDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  if (nil == selectedDisplay || !XCUIDevice.sharedDevice.fb_supportsHingeAngleReading) {
    return FBHostedTapUseNative;
  }
  long long displayID = selectedDisplay.longLongValue;
  if ([FBHIDOperations isInactiveDuoCover:displayID]) {
    [[[FBErrorBuilder builder] withDescription:@"The selected Duo cover display is inactive"] buildError:error];
    return FBHostedTapFailed;
  }
  // Resolve affinity before testing it. Regular windows retain XCTest's native
  // scrolling, hit testing, and tap behavior.
  (void)element.frame;
  long long elementDisplayID = element.screen.displayID;
  if (elementDisplayID == displayID) {
    return FBHostedTapUseNative;
  }
  XCUIApplication *application = element.application;
  CGRect windowFrame;
  BOOL isViewportTap = element.elementType == XCUIElementTypeApplication && nil != offset;
  if (elementDisplayID != XCUIScreen.mainScreen.displayID
      || nil != FBWindowOnDisplay(application, displayID, &windowFrame)) {
    if (isViewportTap) {
      return FBHostedTapUseNative; // The viewport path resolves the app's window on the selected display.
    }
    // A native element tap would follow XCTest onto the wrong panel.
    [[[FBErrorBuilder builder] withDescription:@"The element belongs to a different display"] buildError:error];
    return FBHostedTapFailed;
  }
  XCUIScreen *screen = [FBScreen screenWithDisplayID:displayID error:error];
  if (screen == nil) {
    return FBHostedTapFailed;
  }
  XCUIElement *systemWindow = FBSelectedSystemWindow(screen, error);
  if (systemWindow == nil) {
    return FBHostedTapFailed;
  }
  NSValue *tapPoint = isViewportTap
    ? FBViewportTapPoint(systemWindow, offset.CGPointValue, error)
    : FBTransformedElementTapPoint(element, offset, screen.displayID, error);
  if (tapPoint == nil) {
    return FBHostedTapFailed;
  }
  CGPoint point = tapPoint.CGPointValue;
  if (!isfinite(point.x) || !isfinite(point.y)) {
    [[[FBErrorBuilder builder] withDescription:@"The hosted tap coordinate is not finite"] buildError:error];
    return FBHostedTapFailed;
  }
  if (!FBApplicationOwnsPoint(application, point, displayID)) {
    if (isViewportTap) {
      return FBHostedTapUseNative; // Let the normal viewport path report the missing application window.
    }
    [[[FBErrorBuilder builder] withDescription:@"Cannot verify the target application at the tap point on the selected display"]
      buildError:error];
    return FBHostedTapFailed;
  }
  XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTouchAtPoint:point offset:0];
  [path liftUpAtOffset:0.05];
  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc] initWithName:@"Hosted window tap"
                                                                         displayID:displayID
                                                              interfaceOrientation:application.interfaceOrientation];
  [event addPointerEventPath:path];
  if (![FBXCTestDaemonsProxy synthesizeEventWithRecord:event error:error]) {
    return FBHostedTapFailed;
  }
  [application fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.animationCoolOffTimeout];
  return FBHostedTapDelivered;
}

@end
#endif
