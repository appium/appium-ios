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
#import "FBDisplayGeometry.h"
#import "FBErrorBuilder.h"
#import "FBMathUtils.h"
#import "FBScreen.h"
#import "XCUIElement.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "XCUIScreen.h"

@interface FBWindowCoordinateAnchor : NSObject
@property (nonatomic) XCUIElement *window;
@property (nonatomic) CGRect frame;
@end

@implementation FBWindowCoordinateAnchor
- (XCUICoordinate *)coordinateWithOffset:(CGVector)offset
{
  // Use the captured frame; FBCoordinateWithAnchorOffset would query it again.
  return [self.window coordinateWithNormalizedOffset:CGVectorMake(
    (offset.dx - self.frame.origin.x) / self.frame.size.width,
    (offset.dy - self.frame.origin.y) / self.frame.size.height)];
}
@end

@interface FBGestureCoordinateContext ()
@property (nonatomic) NSMapTable<XCUIElement *, FBWindowCoordinateAnchor *> *windowAnchors;
- (instancetype)initWithScreen:(XCUIScreen *)screen usesWindowCoordinates:(BOOL)usesWindowCoordinates;
@end

@implementation FBGestureCoordinateContext

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
