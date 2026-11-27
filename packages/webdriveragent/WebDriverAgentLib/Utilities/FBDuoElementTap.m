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

@implementation FBDuoElementTap

+ (nullable NSNumber *)tapHostedElement:(XCUIElement *)element
                                 offset:(nullable NSValue *)offset
                                  error:(NSError **)error
{
  NSNumber *selectedDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  if (nil == selectedDisplay || !XCUIDevice.sharedDevice.fb_supportsHingeAngleReading) {
    return nil;
  }
  // Resolve affinity before testing it. Regular windows retain XCTest's native
  // scrolling, hit testing, and tap behavior.
  (void)element.frame;
  long long elementDisplayID = element.screen.displayID;
  if (elementDisplayID == selectedDisplay.longLongValue || elementDisplayID != XCUIScreen.mainScreen.displayID) {
    return nil;
  }
  XCUIApplication *application = element.application;
  CGRect windowFrame;
  if (nil != FBWindowOnDisplay(application, selectedDisplay.longLongValue, &windowFrame)) {
    return nil;
  }
  Class<FBHostedViewTransform> parametersClass = NSClassFromString(@"XCUITransformParameters");
  Class<FBHostedViewTransform> requestClass = NSClassFromString(@"XCUIPointTransformationRequest");
  if (![parametersClass respondsToSelector:@selector(transformParametersWithWindowID:displayID:)]
      || ![requestClass respondsToSelector:@selector(pointTransformationRequestWithPoint:parameters:)]) {
    return nil;
  }
  XCUIScreen *screen = [FBScreen screenWithDisplayID:selectedDisplay.longLongValue error:error];
  if (nil == screen) {
    return @NO;
  }
  // Require a system window on the destination before overriding the app
  // window's reported display. It also supplies the viewport coordinate anchor.
  XCUIElement *systemWindow = FBWindowOnDisplay(XCUIApplication.fb_systemApplication,
                                               screen.displayID, &windowFrame);
  if (nil == systemWindow) {
    [[[FBErrorBuilder builder] withDescription:@"No system window is available on the selected display"] buildError:error];
    return @NO;
  }
  CGPoint point;
  if (element.elementType == XCUIElementTypeApplication && nil != offset) {
    // These offsets are already viewport points. Normalize against XCTest's
    // native frame (not the app-space accessibility frame) so it applies only
    // the selected window's event-synthesis orientation transform.
    CGRect nativeFrame = systemWindow.frame;
    if (CGRectIsEmpty(nativeFrame)) {
      [[[FBErrorBuilder builder] withDescription:@"The selected system window has an empty frame"] buildError:error];
      return @NO;
    }
    point = FBCoordinateInWindow(systemWindow, nativeFrame, offset.CGPointValue).screenPoint;
  } else {
    NSValue *rawPoint = FBHostedElementPoint(element, offset, error);
    if (rawPoint == nil) {
      return @NO;
    }
    id<FBHostedViewTransform> snapshot = (id)element.fb_nativeSnapshot;
    if (![snapshot respondsToSelector:@selector(_transformParametersOrError:)]
        || ![snapshot respondsToSelector:@selector(_transformPointWithRequest:error:)]) {
      return nil;
    }
    id<FBHostedViewTransform> originalParameters = [snapshot _transformParametersOrError:error];
    if (nil == originalParameters) {
      return @NO;
    }
    id parameters = [parametersClass transformParametersWithWindowID:originalParameters.windowID
                                                                displayID:screen.displayID];
    id request = [requestClass pointTransformationRequestWithPoint:rawPoint.CGPointValue parameters:parameters];
    id<FBHostedViewTransform> transformed = [snapshot _transformPointWithRequest:request error:error];
    if (nil == transformed) {
      return @NO;
    }
    point = transformed.point;
  }
  if (!isfinite(point.x) || !isfinite(point.y)) {
    [[[FBErrorBuilder builder] withDescription:@"The hosted tap coordinate is not finite"] buildError:error];
    return @NO;
  }
  XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTouchAtPoint:point offset:0];
  [path liftUpAtOffset:0.05];
  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc] initWithName:@"Hosted window tap"
                                                                         displayID:screen.displayID
                                                              interfaceOrientation:application.interfaceOrientation];
  [event addPointerEventPath:path];
  if (![FBXCTestDaemonsProxy synthesizeEventWithRecord:event error:error]) {
    return @NO;
  }
  [application fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.animationCoolOffTimeout];
  return @YES;
}

@end
#endif
