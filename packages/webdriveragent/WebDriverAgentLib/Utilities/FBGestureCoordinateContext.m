/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBGestureCoordinateContext.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
#import "FBConfiguration.h"
#import "FBErrorBuilder.h"
#import "FBMathUtils.h"
#import "FBScreen.h"
#import "XCUIElement.h"
#import "XCUIElement+FBWebDriverAttributes.h"
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

static XCUICoordinate *FBCoordinateInWindow(XCUIElement *window, CGRect frame, CGPoint point)
{
  return [window coordinateWithNormalizedOffset:CGVectorMake((point.x - frame.origin.x) / frame.size.width,
                                                            (point.y - frame.origin.y) / frame.size.height)];
}

@interface FBWindowCoordinateAnchor : NSObject
@property (nonatomic) XCUIElement *window;
@property (nonatomic) CGRect frame;
@end

@implementation FBWindowCoordinateAnchor
- (XCUICoordinate *)coordinateWithOffset:(CGVector)offset
{
  return FBCoordinateInWindow(self.window, self.frame, CGPointMake(offset.dx, offset.dy));
}
@end

@interface FBGestureCoordinateContext ()
@property (nonatomic) NSMapTable<XCUIElement *, FBWindowCoordinateAnchor *> *windowAnchors;
- (instancetype)initWithScreen:(XCUIScreen *)screen usesWindowCoordinates:(BOOL)usesWindowCoordinates;
@end

@implementation FBGestureCoordinateContext

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

+ (nullable instancetype)contextWithDisplayRequired:(BOOL)requiresDisplay error:(NSError **)error
{
  XCUIScreen *screen = requiresDisplay ? [FBScreen currentScreenWithError:error] : XCUIScreen.mainScreen;
  if (nil == screen) {
    return nil;
  }
  NSNumber *hasMultipleScreens = requiresDisplay ? [FBScreen hasMultipleScreensWithError:error] : @NO;
  if (nil == hasMultipleScreens) {
    return nil;
  }
  return [[self alloc] initWithScreen:screen usesWindowCoordinates:hasMultipleScreens.boolValue];
}

- (instancetype)initWithScreen:(XCUIScreen *)screen usesWindowCoordinates:(BOOL)usesWindowCoordinates
{
  self = [super init];
  if (self) {
    _screen = screen;
    _usesWindowCoordinates = usesWindowCoordinates;
    if (usesWindowCoordinates) {
      // Object identity avoids XCTest equality queries and keeps distinct app origins separate.
      _windowAnchors = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality
                                           valueOptions:NSPointerFunctionsStrongMemory];
    }
  }
  return self;
}

- (CGRect)windowFrameForApplication:(XCUIElement *)application error:(NSError **)error
{
  if (!self.usesWindowCoordinates) {
    return application.wdFrame;
  }
  NSError *lookupError = nil;
  FBWindowCoordinateAnchor *anchor = [self windowAnchorForApplication:application error:&lookupError];
  if (nil != anchor) {
    return anchor.frame;
  }
  // XCTest's main screen may still be the cover when the app is on the inner panel.
  if (nil == FBConfiguration.sharedInstance.currentDisplayId) {
    return application.wdFrame;
  }
  if (NULL != error) {
    *error = lookupError;
  }
  return CGRectNull;
}

- (nullable XCUICoordinate *)coordinateWithApplication:(XCUIElement *)application
                                              offset:(CGVector)offset
                                               error:(NSError **)error
{
  if (!self.usesWindowCoordinates) {
    return FBCoordinateWithAnchorOffset(application, CGVectorMake(0, 0), offset, error);
  }
  FBWindowCoordinateAnchor *anchor = [self windowAnchorForApplication:application error:error];
  return [anchor coordinateWithOffset:offset];
}

- (nullable XCUICoordinate *)coordinateWithApplicationOrigin:(XCUIElement *)application
                                                    offset:(CGVector)offset
                                                     error:(NSError **)error
{
  CGRect frame = application.wdFrame;
  if (CGRectIsEmpty(frame)) {
    [[[FBErrorBuilder builder] withDescription:@"The application origin has an empty frame"] buildError:error];
    return nil;
  }
  return [self coordinateWithApplication:application
                                 offset:CGVectorMake(CGRectGetMidX(frame) + offset.dx, CGRectGetMidY(frame) + offset.dy)
                                  error:error];
}

- (nullable FBWindowCoordinateAnchor *)windowAnchorForApplication:(XCUIElement *)application error:(NSError **)error
{
  FBWindowCoordinateAnchor *anchor = [self.windowAnchors objectForKey:application];
  if (nil == anchor) {
    anchor = [self.class windowAnchorWithApplication:application screen:self.screen error:error];
    if (nil != anchor) {
      [self.windowAnchors setObject:anchor forKey:application];
    }
  }
  return anchor;
}

+ (nullable FBWindowCoordinateAnchor *)windowAnchorWithApplication:(XCUIElement *)application
                                                           screen:(XCUIScreen *)screen
                                                            error:(NSError **)error
{
  // Application-root coordinates can retain cover-display geometry after main
  // switches to the inner panel. Resolve an anchor on the selected display.
  // A window coordinate keeps XCTest's display affinity and rotation intact.
  // It is only a coordinate anchor, not a hit-test boundary. Preserve edge and
  // outside offsets just as on the main display; XCTest handles their delivery.
  CGRect frame;
  XCUIElement *window = FBWindowOnDisplay(application, screen.displayID, &frame);
  if (window != nil) {
    FBWindowCoordinateAnchor *anchor = [FBWindowCoordinateAnchor new];
    anchor.window = window;
    anchor.frame = frame;
    return anchor;
  }
  [[[FBErrorBuilder builder] withDescriptionFormat:@"No non-empty application window on display %lld is available as a coordinate anchor", screen.displayID]
    buildError:error];
  return nil;
}

@end
#endif
