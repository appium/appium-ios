/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBElementCommands.h"
#import "FBElementCommands-Private.h"

#import <stdatomic.h>

#import "FBConfiguration.h"
#import "FBScreen.h"
#import "XCUIScreen.h"
#import "FBLogger.h"
#import "FBRoute.h"
#import "FBRouteRequest.h"
#import "FBRunLoopSpinner.h"
#import "FBElementCache.h"
#import "FBErrorBuilder.h"
#import "FBSession.h"
#import "FBElementUtils.h"
#import "FBMacros.h"
#import "FBMathUtils.h"
#import "FBRuntimeUtils.h"
#import "FBXCTestDaemonsProxy.h"
#import "NSPredicate+FBFormat.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIApplication+FBTouchAction.h"

#import "XCUICoordinate.h"
#import "XCUIDevice.h"
#import "XCUIElement+FBIsVisible.h"
#import "XCUIElement+FBPickerWheel.h"
#import "XCUIElement+FBScrolling.h"
#import "XCUIElement+FBForceTouch.h"
#import "XCUIElement+FBSwiping.h"
#import "XCUIElement+FBTyping.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "XCUIElement+FBTVFocuse.h"
#import "XCUIElement+FBResolve.h"
#import "XCUIElement+FBUID.h"
#import "FBElementTypeTransformer.h"
#import "XCUIElement.h"
#import "XCUIElementQuery.h"
#import "FBXCodeCompatibility.h"

// Counters for the opt-in fast gesture queue. File scope so `/status` can read them; all
// updates use C11 atomics because enqueueing and synthesis run on different threads.
static atomic_int fbFastGesturesPending;
static atomic_int fbFastGesturesEnqueued;
static atomic_int fbFastGesturesFailed;
static atomic_int fbFastGesturesRejected;

// Bounded recent-result map for optional client-supplied `gestureId` values. The queue is
// asynchronous, so this is the only way a caller can learn that a specific event failed
// after its 200 was already sent.
static NSMutableDictionary<NSString *, NSMutableDictionary *> *fbFastGestureResults;
static NSMutableArray<NSString *> *fbFastGestureResultOrder;
static const NSUInteger FBMaxFastGestureResults = 32;

// Sixteen events is enough to absorb a burst from a caller that pipelines taps: at the
// measured 0.26-0.47 s per synthesis that is several seconds of backlog. Keeping the number
// small bounds both the event objects and the delay before a rejection is reported.
static const int32_t FBMaxPendingFastGestures = 16;

// One serial queue for fast gestures. Created lazily through fb_synthesisQueue so both the
// dispatcher and the drain barrier see the same queue.
static dispatch_queue_t fbSynthesisQueue;
static dispatch_once_t fbSynthesisQueueOnce;
// Marks the synthesis queue so a confirmed gesture invoked from inside it runs inline instead
// of deadlocking on a nested dispatch_sync.
static char FBGestureQueueKey;

@implementation FBElementCommands

#pragma mark - <FBCommandHandler>

+ (NSArray *)routes
{
  return
  @[
    [[FBRoute GET:@"/window/size"] respondWithTarget:self action:@selector(handleGetWindowSize:)],
    [[FBRoute GET:@"/window/rect"] respondWithTarget:self action:@selector(handleGetWindowRect:)],
    [[FBRoute GET:@"/window/size"].withoutSession respondWithTarget:self action:@selector(handleGetWindowSize:)],
    [[FBRoute GET:@"/element/:uuid/enabled"] respondWithTarget:self action:@selector(handleGetEnabled:)],
    [[FBRoute GET:@"/element/:uuid/rect"] respondWithTarget:self action:@selector(handleGetRect:)],
    [[FBRoute GET:@"/element/:uuid/attribute/:name"] respondWithTarget:self action:@selector(handleGetAttribute:)],
    [[FBRoute GET:@"/element/:uuid/text"] respondWithTarget:self action:@selector(handleGetText:)],
    [[FBRoute GET:@"/element/:uuid/displayed"] respondWithTarget:self action:@selector(handleGetDisplayed:)],
    [[FBRoute GET:@"/element/:uuid/selected"] respondWithTarget:self action:@selector(handleGetSelected:)],
    [[FBRoute GET:@"/element/:uuid/name"] respondWithTarget:self action:@selector(handleGetName:)],
    [[FBRoute POST:@"/element/:uuid/value"] respondWithTarget:self action:@selector(handleSetValue:)],
    [[FBRoute POST:@"/element/:uuid/click"] respondWithTarget:self action:@selector(handleClick:)],
    [[FBRoute POST:@"/element/:uuid/clear"] respondWithTarget:self action:@selector(handleClear:)],
    // W3C element screenshot
    [[FBRoute GET:@"/element/:uuid/screenshot"] respondWithTarget:self action:@selector(handleElementScreenshot:)],
    // JSONWP element screenshot
    [[FBRoute GET:@"/screenshot/:uuid"] respondWithTarget:self action:@selector(handleElementScreenshot:)],
    [[FBRoute GET:@"/wda/element/:uuid/accessible"] respondWithTarget:self action:@selector(handleGetAccessible:)],
    [[FBRoute GET:@"/wda/element/:uuid/accessibilityContainer"] respondWithTarget:self action:@selector(handleGetIsAccessibilityContainer:)],
#if TARGET_OS_TV
    [[FBRoute GET:@"/element/:uuid/attribute/focused"] respondWithTarget:self action:@selector(handleGetFocused:)],
    [[FBRoute POST:@"/wda/element/:uuid/focuse"] respondWithTarget:self action:@selector(handleFocuse:)],
#elif !TARGET_OS_WATCH
    // Gesture synthesis isn't supported on watchOS - only /element/:uuid/click is available.
    [[FBRoute POST:@"/wda/element/:uuid/swipe"] respondWithTarget:self action:@selector(handleSwipe:)],
    [[FBRoute POST:@"/wda/swipe"] respondWithTarget:self action:@selector(handleSwipe:)],

    [[FBRoute POST:@"/wda/element/:uuid/pinch"] respondWithTarget:self action:@selector(handlePinch:)],
    [[FBRoute POST:@"/wda/pinch"] respondWithTarget:self action:@selector(handlePinch:)],

    [[FBRoute POST:@"/wda/element/:uuid/rotate"] respondWithTarget:self action:@selector(handleRotate:)],
    [[FBRoute POST:@"/wda/rotate"] respondWithTarget:self action:@selector(handleRotate:)],

    [[FBRoute POST:@"/wda/element/:uuid/doubleTap"] respondWithTarget:self action:@selector(handleDoubleTap:)],
    [[FBRoute POST:@"/wda/doubleTap"] respondWithTarget:self action:@selector(handleDoubleTap:)],

    [[FBRoute POST:@"/wda/element/:uuid/twoFingerTap"] respondWithTarget:self action:@selector(handleTwoFingerTap:)],
    [[FBRoute POST:@"/wda/twoFingerTap"] respondWithTarget:self action:@selector(handleTwoFingerTap:)],

    [[FBRoute POST:@"/wda/element/:uuid/tapWithNumberOfTaps"] respondWithTarget:self
                                                                         action:@selector(handleTapWithNumberOfTaps:)],
    [[FBRoute POST:@"/wda/tapWithNumberOfTaps"] respondWithTarget:self
                                                           action:@selector(handleTapWithNumberOfTaps:)],

    [[FBRoute POST:@"/wda/element/:uuid/touchAndHold"] respondWithTarget:self action:@selector(handleTouchAndHold:)],
    [[FBRoute POST:@"/wda/touchAndHold"] respondWithTarget:self action:@selector(handleTouchAndHold:)],

    [[FBRoute POST:@"/wda/element/:uuid/scroll"] respondWithTarget:self action:@selector(handleScroll:)],
    [[FBRoute POST:@"/wda/scroll"] respondWithTarget:self action:@selector(handleScroll:)],

    [[FBRoute POST:@"/wda/element/:uuid/scrollTo"] respondWithTarget:self action:@selector(handleScrollTo:)],

    [[FBRoute POST:@"/wda/element/:uuid/dragfromtoforduration"] respondWithTarget:self action:@selector(handleDrag:)],
    [[FBRoute POST:@"/wda/dragfromtoforduration"] respondWithTarget:self action:@selector(handleDrag:)],

    [[FBRoute POST:@"/wda/element/:uuid/pressAndDragWithVelocity"] respondWithTarget:self action:@selector(handlePressAndDragWithVelocity:)],
    [[FBRoute POST:@"/wda/pressAndDragWithVelocity"] respondWithTarget:self action:@selector(handlePressAndDragCoordinateWithVelocity:)],

    [[FBRoute POST:@"/wda/element/:uuid/forceTouch"] respondWithTarget:self action:@selector(handleForceTouch:)],
    [[FBRoute POST:@"/wda/forceTouch"] respondWithTarget:self action:@selector(handleForceTouch:)],

    [[FBRoute POST:@"/wda/element/:uuid/tap"] respondWithTarget:self action:@selector(handleTap:)],
    [[FBRoute POST:@"/wda/tap"] respondWithTarget:self action:@selector(handleTap:)],

    [[FBRoute POST:@"/wda/pickerwheel/:uuid/select"] respondWithTarget:self action:@selector(handleWheelSelect:)],
#endif
    [[FBRoute POST:@"/wda/keys"] respondWithTarget:self action:@selector(handleKeys:)],
  ];
}


#pragma mark - Commands

+ (id<FBResponsePayload>)handleGetEnabled:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(@(element.isWDEnabled));
}

+ (id<FBResponsePayload>)handleGetRect:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(element.wdRect);
}

+ (id<FBResponsePayload>)handleGetAttribute:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  NSString *attributeName = request.parameters[@"name"];
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  id attributeValue = [element fb_valueForWDAttributeName:attributeName];
  return FBResponseWithObject(attributeValue ?: [NSNull null]);
}

+ (id<FBResponsePayload>)handleGetText:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  // https://github.com/appium/appium-xcuitest-driver/issues/2552
  id<FBXCElementSnapshot> snapshot = [element fb_customSnapshot];
  FBXCElementSnapshotWrapper *wrappedSnapshot = [FBXCElementSnapshotWrapper ensureWrapped:snapshot];
  id text = FBFirstNonEmptyValue(wrappedSnapshot.wdValue, wrappedSnapshot.wdLabel);
  return FBResponseWithObject(text ?: @"");
}

+ (id<FBResponsePayload>)handleGetDisplayed:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(@(element.isWDVisible));
}

+ (id<FBResponsePayload>)handleGetAccessible:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(@(element.isWDAccessible));
}

+ (id<FBResponsePayload>)handleGetIsAccessibilityContainer:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(@(element.isWDAccessibilityContainer));
}

+ (id<FBResponsePayload>)handleGetName:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(element.wdType);
}

+ (id<FBResponsePayload>)handleGetSelected:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  return FBResponseWithObject(@(element.wdSelected));
}

+ (id<FBResponsePayload>)handleSetValue:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]
                                       checkStaleness:YES];
  id value = request.arguments[@"value"] ?: request.arguments[@"text"];
  if (!value) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Neither 'value' nor 'text' parameter is provided" traceback:nil]);
  }
  NSString *textToType = [value isKindOfClass:NSArray.class]
    ? [value componentsJoinedByString:@""]
    : value;
  XCUIElementType elementType = [element elementType];
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  if (elementType == XCUIElementTypePickerWheel) {
    [element adjustToPickerWheelValue:textToType];
    return FBResponseWithOK();
  }
#endif
  if (elementType == XCUIElementTypeSlider) {
    CGFloat sliderValue = textToType.floatValue;
    if (sliderValue < 0.0 || sliderValue > 1.0 ) {
      return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Value of slider should be in 0..1 range" traceback:nil]);
    }
    [element adjustToNormalizedSliderPosition:sliderValue];
    return FBResponseWithOK();
  }
  NSUInteger frequency = (NSUInteger)[request.arguments[@"frequency"] longLongValue] ?: FBConfiguration.sharedInstance.maxTypingFrequency;
  NSError *error = nil;
  // checkStaleness:YES above already took a fresh, verified-live snapshot of
  // `element` and cached it as `lastSnapshot` - reuse it instead of paying
  // for another round trip.
  id<FBXCElementSnapshot> snapshot = element.lastSnapshot ?: element.fb_cachedSnapshot ?: [element fb_standardSnapshot];
  if (![element fb_typeText:textToType
                shouldClear:NO
                  frequency:frequency
                   snapshot:snapshot
                      error:&error]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleClick:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"] checkStaleness:YES];
#if TARGET_OS_IOS || TARGET_OS_WATCH
  [element tap];
#elif TARGET_OS_TV
  NSError *error = nil;
  if (![element fb_selectWithError:&error]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
#endif
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleClear:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  NSError *error;
  if (![element fb_clearTextWithError:&error]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  return FBResponseWithOK();
}

#if TARGET_OS_TV
+ (id<FBResponsePayload>)handleGetFocused:(FBRouteRequest *)request
{
  // `BOOL isFocused = [elementCache elementForUUID:request.parameters[@"uuid"]];`
  // returns wrong true/false after moving focus by key up/down, for example.
  // Thus, ensure the focus compares the status with `fb_focusedElement`.
  BOOL isFocused = NO;
  XCUIElement *focusedElement = request.session.activeApplication.fb_focusedElement;
  if (focusedElement != nil) {
    FBElementCache *elementCache = request.session.elementCache;
    BOOL useNativeCachingStrategy = request.session.useNativeCachingStrategy;
    NSString *focusedUUID = [elementCache storeElement:(useNativeCachingStrategy
                                                        ? focusedElement
                                                        : [focusedElement fb_stableInstanceWithUid:focusedElement.fb_uid])];
    focusedElement.lastSnapshot = nil;
    if (focusedUUID && [focusedUUID isEqualToString:(id)request.parameters[@"uuid"]]) {
      isFocused = YES;
    }
  }

  return FBResponseWithObject(@(isFocused));
}

+ (id<FBResponsePayload>)handleFocuse:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  NSError *error;
  if (![element fb_setFocusWithError:&error]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  return FBResponseWithStatus([FBCommandStatus okWithValue: FBDictionaryResponseWithElement(element, FBConfiguration.sharedInstance.shouldUseCompactResponses)]);
}
#else
+ (id<FBResponsePayload>)handleDoubleTap:(FBRouteRequest *)request
{
  NSError *error;
  id target = [self targetWithXyCoordinatesFromRequest:request error:&error];
  if (nil == target) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:error.localizedDescription
                                                                       traceback:nil]);
  }
  [target doubleTap];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleTwoFingerTap:(FBRouteRequest *)request
{
  XCUIElement *element = [self targetFromRequest:request];
  [element twoFingerTap];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleTapWithNumberOfTaps:(FBRouteRequest *)request
{
  if (nil == request.arguments[@"numberOfTaps"] || nil == request.arguments[@"numberOfTouches"]) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Both 'numberOfTaps' and 'numberOfTouches' arguments must be provided"
                                                                       traceback:nil]);
  }
  XCUIElement *element = [self targetFromRequest:request];
  [element tapWithNumberOfTaps:[request.arguments[@"numberOfTaps"] integerValue]
               numberOfTouches:[request.arguments[@"numberOfTouches"] integerValue]];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleTouchAndHold:(FBRouteRequest *)request
{
  NSError *error;
  id target = [self targetWithXyCoordinatesFromRequest:request error:&error];
  if (nil == target) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:error.localizedDescription
                                                                       traceback:nil]);
  }
  [target pressForDuration:[request.arguments[@"duration"] doubleValue]];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handlePressAndDragWithVelocity:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [self targetFromRequest:request];
  [element pressForDuration:[request.arguments[@"pressDuration"] doubleValue]
          thenDragToElement:[elementCache elementForUUID:(NSString *)request.arguments[@"toElement"] checkStaleness:YES]
               withVelocity:[request.arguments[@"velocity"] doubleValue]
        thenHoldForDuration:[request.arguments[@"holdDuration"] doubleValue]];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handlePressAndDragCoordinateWithVelocity:(FBRouteRequest *)request
{
  XCUIApplication *application = request.session.activeApplication;
  NSError *error;
  CGVector startOffset = CGVectorMake((CGFloat)[request.arguments[@"fromX"] doubleValue],
                                     (CGFloat)[request.arguments[@"fromY"] doubleValue]);
  XCUICoordinate *startCoordinate = [self.class gestureCoordinateWithOffset:startOffset
                                                                    element:application
                                                                      error:&error];
  if (nil == startCoordinate) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  CGVector endOffset = CGVectorMake((CGFloat)[request.arguments[@"toX"] doubleValue],
                                    (CGFloat)[request.arguments[@"toY"] doubleValue]);
  XCUICoordinate *endCoordinate = [self.class gestureCoordinateWithOffset:endOffset
                                                                  element:application
                                                                    error:&error];
  if (nil == endCoordinate) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  if (![application fb_pressAtCoordinate:startCoordinate
                             forDuration:[request.arguments[@"pressDuration"] doubleValue]
                    thenDragToCoordinate:endCoordinate
                            withVelocity:[request.arguments[@"velocity"] doubleValue]
                     thenHoldForDuration:[request.arguments[@"holdDuration"] doubleValue]
                                   error:&error]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleScroll:(FBRouteRequest *)request
{
  XCUIElement *element = [self targetFromRequest:request];
  // Using presence of arguments as a way to convey control flow seems like a pretty bad idea but it's
  // what ios-driver did and sadly, we must copy them.
  NSString *const name = request.arguments[@"name"];
  if (name) {
    XCUIElement *childElement = [[[[element.fb_query descendantsMatchingType:XCUIElementTypeAny]
                                   matchingIdentifier:name] allElementsBoundByIndex] lastObject];
    if (!childElement) {
      return FBResponseWithStatus([FBCommandStatus noSuchElementErrorWithMessage:[NSString stringWithFormat:@"'%@' identifier didn't match any elements", name]
                                                                       traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
    }
    return [self.class handleScrollElementToVisible:childElement withRequest:request];
  }

  NSString *const direction = request.arguments[@"direction"];
  if (direction) {
    NSString *const distanceString = request.arguments[@"distance"] ?: @"1.0";
    CGFloat distance = (CGFloat)distanceString.doubleValue;
    if ([direction isEqualToString:@"up"]) {
      [element fb_scrollUpByNormalizedDistance:distance];
    } else if ([direction isEqualToString:@"down"]) {
      [element fb_scrollDownByNormalizedDistance:distance];
    } else if ([direction isEqualToString:@"left"]) {
      [element fb_scrollLeftByNormalizedDistance:distance];
    } else if ([direction isEqualToString:@"right"]) {
      [element fb_scrollRightByNormalizedDistance:distance];
    }
    return FBResponseWithOK();
  }

  NSString *const predicateString = request.arguments[@"predicateString"];
  if (predicateString) {
    NSPredicate *formattedPredicate = [NSPredicate fb_snapshotBlockPredicateWithPredicate:[NSPredicate
                                                                                           predicateWithFormat:predicateString]];
    XCUIElement *childElement = [[[[element.fb_query descendantsMatchingType:XCUIElementTypeAny]
                                   matchingPredicate:formattedPredicate] allElementsBoundByIndex] lastObject];
    if (!childElement) {
      return FBResponseWithStatus([FBCommandStatus noSuchElementErrorWithMessage:[NSString stringWithFormat:@"'%@' predicate didn't match any elements", predicateString]
                                                                       traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
    }
    return [self.class handleScrollElementToVisible:childElement withRequest:request];
  }

  if (request.arguments[@"toVisible"]) {
    return [self.class handleScrollElementToVisible:element withRequest:request];
  }
  return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Unsupported scroll type" traceback:nil]);
}

+ (id<FBResponsePayload>)handleScrollTo:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]];
  NSError *error;
  return [element fb_nativeScrollToVisibleWithError:&error]
    ? FBResponseWithOK()
    : FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description
                                                                      traceback:nil]);
}

+ (id<FBResponsePayload>)handleDrag:(FBRouteRequest *)request
{
  XCUIElement *target = [self targetFromRequest:request];
  NSError *error;
  CGVector startOffset = CGVectorMake([request.arguments[@"fromX"] doubleValue],
                                      [request.arguments[@"fromY"] doubleValue]);
  XCUICoordinate *startCoordinate = [self.class gestureCoordinateWithOffset:startOffset element:target error:&error];
  if (nil == startCoordinate) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  CGVector endOffset = CGVectorMake([request.arguments[@"toX"] doubleValue],
                                    [request.arguments[@"toY"] doubleValue]);
  XCUICoordinate *endCoordinate = [self.class gestureCoordinateWithOffset:endOffset element:target error:&error];
  if (nil == endCoordinate) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
  }
  NSTimeInterval duration = [request.arguments[@"duration"] doubleValue];
#if TARGET_OS_WATCH
  XCUIApplication *application = [target isKindOfClass:XCUIApplication.class]
    ? (XCUIApplication *)target
    : target.application;
#else
  XCUIApplication *application = [XCUIApplication fb_applicationForElement:target];
#endif
  if ([request.arguments[@"fast"] boolValue]) {
#if TARGET_OS_TV || TARGET_OS_WATCH
    // Gesture synthesis is not available on tvOS or watchOS. The handlers are excluded from
    // tvOS at the compilation level and the category header hides these builders there, but
    // keeping the guard aligned with the header makes the contract explicit.
    return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Fast mode is not supported on tvOS or watchOS"
                                                                           traceback:nil]);
#else
    // The same event record the confirmed path builds, dispatched without waiting for the
    // daemon to confirm it. See handleTap: for the response contract.
    XCSynthesizedEventRecord *event = [application fb_pressDragEventFromCoordinate:startCoordinate
                                                                       forDuration:duration
                                                                      toCoordinate:endCoordinate
                                                                      withVelocity:XCUIGestureVelocityDefault
                                                               thenHoldForDuration:0
                                                                             error:&error];
    if (nil == event) {
      // The client-facing message is the readable one; error.description would print the
      // NSError dump (domain, code, userInfo) into the response.
      return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.localizedDescription
                                                                             traceback:nil]);
    }
    FBGestureEnqueueResult dragQueueResult = [self fb_dispatchEventInBackground:event
                                                                           name:@"drag"
                                                                      gestureId:request.arguments[@"gestureId"]];
    if (dragQueueResult != FBGestureEnqueueResultQueued) {
      NSString *message = dragQueueResult == FBGestureEnqueueResultDuplicateGestureId
        ? [NSString stringWithFormat:@"gestureId '%@' is already in use", request.arguments[@"gestureId"]]
        : @"Too many fast gestures are already queued. Wait for them to finish or retry without 'fast'";
      return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:message traceback:nil]);
    }
    return FBResponseWithOK();
#endif
  }
  __block BOOL dragSucceeded = NO;
  __block NSError *dragError = nil;
  [self fb_performGesture:^{
    dragSucceeded = [application fb_pressAtCoordinate:startCoordinate
                                          forDuration:duration
                                 thenDragToCoordinate:endCoordinate
                                         withVelocity:XCUIGestureVelocityDefault
                                  thenHoldForDuration:0
                                                error:&dragError];
  } wait:YES];
  if (!dragSucceeded) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:dragError.localizedDescription
                                                                           traceback:nil]);
  }
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleSwipe:(FBRouteRequest *)request
{
  NSString *const direction = request.arguments[@"direction"];
  if (!direction) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"Missing 'direction' parameter" traceback:nil]);
  }
  NSArray<NSString *> *supportedDirections = @[@"up", @"down", @"left", @"right"];
  if (![supportedDirections containsObject:direction.lowercaseString]) {
    NSString *message = [NSString stringWithFormat:@"Unsupported swipe direction '%@'. Only the following directions are supported: %@", direction, supportedDirections];
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:message
                                                                       traceback:nil]);
  }
  NSError *error;
  id target = [self targetWithXyCoordinatesFromRequest:request error:&error];
  if (nil == target) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:error.localizedDescription
                                                                       traceback:nil]);
  }
  [target fb_swipeWithDirection:direction velocity:request.arguments[@"velocity"]];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleTap:(FBRouteRequest *)request
{
  NSError *error;
  id target = [self targetWithXyCoordinatesFromRequest:request error:&error];
  if (nil == target) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:error.localizedDescription
                                                                       traceback:nil]);
  }
  if (![request.arguments[@"fast"] boolValue]) {
    [self fb_performGesture:^{
      [target tap];
    } wait:YES];
    return FBResponseWithOK();
  }

#if TARGET_OS_TV || TARGET_OS_WATCH
  // Gesture synthesis is not available on tvOS or watchOS. Handlers are excluded from tvOS at
  // the compilation level; this guard matches the category header on both platforms.
  return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"Fast mode is not supported on tvOS or watchOS"
                                                                         traceback:nil]);
#else
  // Opt-in fast mode: the event is queued and the reply is sent without waiting for XCTest
  // to confirm it, so the touch has not landed when the caller reads this response. Callers
  // that need proof of delivery have to observe the screen instead.
  XCUICoordinate *coordinate = [target isKindOfClass:XCUICoordinate.class]
    ? (XCUICoordinate *)target
    : [(XCUIElement *)target coordinateWithNormalizedOffset:CGVectorMake(0.5, 0.5)];
  CGPoint point = coordinate.screenPoint;
  if (!isfinite(point.x) || !isfinite(point.y)) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Cannot resolve the on-screen position of the tap target. Make sure it is visible and idle, then retry"
                                                                           traceback:nil]);
  }
  // `element` is not public on XCUICoordinate; referencedElement is.
  XCUIElement *anchor = coordinate.referencedElement ?: (XCUIElement *)target;
#if TARGET_OS_WATCH
  XCUIApplication *application = [anchor isKindOfClass:XCUIApplication.class]
    ? (XCUIApplication *)anchor
    : anchor.application;
#else
  XCUIApplication *application = [XCUIApplication fb_applicationForElement:anchor];
#endif
  if (nil == application) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:@"Cannot determine the application of the tap target"
                                                                           traceback:nil]);
  }
  // Element targets cannot be tapped in fast mode: the centre would be used without
  // XCTest's hittability and scroll-into-view resolution.
  if (![target isKindOfClass:XCUICoordinate.class]
      && ((XCUIElement *)target).elementType != XCUIElementTypeApplication) {
    return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:@"fast element taps are not supported; pass x/y or omit 'fast'"
                                                                           traceback:nil]);
  }
  // Like XCTest, send the event to the display the target belongs to.
  XCUIElement *referencedElement = coordinate.referencedElement;
  long long displayID = [referencedElement respondsToSelector:@selector(displayID)]
    ? referencedElement.displayID
    : 0;
  XCSynthesizedEventRecord *event = [XCUIApplication fb_tapEventFromPoint:point
                                                               displayID:displayID
                                                    interfaceOrientation:application.interfaceOrientation];
  FBGestureEnqueueResult tapQueueResult = [self fb_dispatchEventInBackground:event
                                                                         name:@"tap"
                                                                    gestureId:request.arguments[@"gestureId"]];
  if (tapQueueResult != FBGestureEnqueueResultQueued) {
    NSString *message = tapQueueResult == FBGestureEnqueueResultDuplicateGestureId
      ? [NSString stringWithFormat:@"gestureId '%@' is already in use", request.arguments[@"gestureId"]]
      : @"Too many fast gestures are already queued. Wait for them to finish or retry without 'fast'";
    return FBResponseWithStatus([FBCommandStatus unsupportedOperationErrorWithMessage:message traceback:nil]);
  }
  return FBResponseWithOK();
#endif
}

/**
 Dispatches an already built event record without waiting for the daemon to confirm it.
 The queue is serial, so consecutive fast gestures reach the daemon in the order they were
 requested. The pending count is bounded so a burst cannot grow the queue without limit; a
 caller that finds it full gets an error instead of a silent backlog. Failures are counted
 for `/status` and logged, because the reply has already been sent.
 Confirmed gestures that do not synthesize through this queue (notably -[XCUIElement tap])
 are still not ordered against a fast event; that limitation is deliberate until the
 confirmed tap path can share the queue.

 @param event The event record to synthesize
 @param name A short gesture name for the failure log message
 @return YES when the event was queued, NO when the pending limit is reached
 */
+ (FBGestureEnqueueResult)fb_dispatchEventInBackground:(XCSynthesizedEventRecord *)event
                                                  name:(NSString *)name
                                             gestureId:(NSString *)gestureId
{
  if (gestureId.length > 0) {
    @synchronized([FBElementCommands class]) {
      NSDictionary *existing = fbFastGestureResults[gestureId];
      if (nil != existing) {
        BOOL pending = [existing[@"state"] isEqualToString:@"pending"];
        NSTimeInterval age = [[NSDate date] timeIntervalSince1970] - [existing[@"updatedAt"] doubleValue];
        if (pending || age <= 60.0) {
          atomic_fetch_add_explicit(&fbFastGesturesRejected, 1, memory_order_relaxed);
          return FBGestureEnqueueResultDuplicateGestureId;
        }
        [fbFastGestureResultOrder removeObject:gestureId];
        [fbFastGestureResults removeObjectForKey:gestureId];
      }
    }
  }
  if (atomic_fetch_add_explicit(&fbFastGesturesPending, 1, memory_order_relaxed) >= FBMaxPendingFastGestures) {
    atomic_fetch_sub_explicit(&fbFastGesturesPending, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&fbFastGesturesRejected, 1, memory_order_relaxed);
    return FBGestureEnqueueResultQueueFull;
  }
  atomic_fetch_add_explicit(&fbFastGesturesEnqueued, 1, memory_order_relaxed);
  [self fb_recordFastGesture:gestureId name:name state:@"pending" error:nil];
  dispatch_async([self fb_synthesisQueue], ^{
    NSError *error = nil;
    BOOL succeeded = [FBXCTestDaemonsProxy synthesizeEventWithRecord:event error:&error];
    if (!succeeded) {
      atomic_fetch_add_explicit(&fbFastGesturesFailed, 1, memory_order_relaxed);
      [FBLogger logFmt:@"Failed to synthesize the %@ event without waiting for confirmation: %@",
       name, error.localizedDescription ?: @"unknown error"];
    }
    [self fb_recordFastGesture:gestureId
                          name:name
                         state:succeeded ? @"completed" : @"failed"
                         error:error];
    atomic_fetch_sub_explicit(&fbFastGesturesPending, 1, memory_order_relaxed);
  });
  return FBGestureEnqueueResultQueued;
}

+ (void)fb_recordFastGesture:(NSString *)gestureId
                        name:(NSString *)name
                       state:(NSString *)state
                       error:(NSError *)error
{
  if (gestureId.length == 0) {
    return;
  }
  @synchronized([FBElementCommands class]) {
    if (nil == fbFastGestureResults) {
      fbFastGestureResults = [NSMutableDictionary dictionary];
      fbFastGestureResultOrder = [NSMutableArray array];
    }
    NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
      @"name": name,
      @"state": state,
      @"updatedAt": @([[NSDate date] timeIntervalSince1970]),
    }];
    if (nil != error) {
      result[@"error"] = error.localizedDescription ?: @"unknown error";
    }
    if (![fbFastGestureResultOrder containsObject:gestureId]) {
      [fbFastGestureResultOrder addObject:gestureId];
    }
    fbFastGestureResults[gestureId] = result;
    while (fbFastGestureResultOrder.count > FBMaxFastGestureResults) {
      NSString *oldest = fbFastGestureResultOrder.firstObject;
      [fbFastGestureResultOrder removeObjectAtIndex:0];
      [fbFastGestureResults removeObjectForKey:oldest];
    }
  }
}

+ (dispatch_queue_t)fb_synthesisQueue
{
  dispatch_once(&fbSynthesisQueueOnce, ^{
    fbSynthesisQueue = dispatch_queue_create("com.facebook.WebDriverAgent.fast-gesture",
                                             DISPATCH_QUEUE_SERIAL);
    dispatch_set_target_queue(fbSynthesisQueue,
                              dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
    dispatch_queue_set_specific(fbSynthesisQueue, &FBGestureQueueKey, (void *)1, NULL);
  });
  return fbSynthesisQueue;
}

+ (void)fb_drainFastGestures
{
  // Wait for the blocks already queued, but do not let a stuck daemon block session
  // deletion forever. Five seconds covers the 16-event bound at normal synthesis times;
  // on timeout the events stay queued and are logged instead of holding the request.
  dispatch_semaphore_t drained = dispatch_semaphore_create(0);
  dispatch_async([self fb_synthesisQueue], ^{
    dispatch_semaphore_signal(drained);
  });
  if (dispatch_semaphore_wait(drained,
                              dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC))) != 0) {
    [FBLogger logFmt:@"Timed out waiting for the fast gesture queue to drain"];
  }
}

+ (void)fb_performGesture:(dispatch_block_t)block wait:(BOOL)wait
{
  if (dispatch_get_specific(&FBGestureQueueKey) != NULL) {
    block();
    return;
  }
  if (wait) {
    dispatch_sync([self fb_synthesisQueue], block);
  } else {
    dispatch_async([self fb_synthesisQueue], block);
  }
}

+ (NSDictionary *)fb_fastGestureStats
{
  NSDictionary *counters = @{
    @"pending": @(atomic_load(&fbFastGesturesPending)),
    @"enqueued": @(atomic_load(&fbFastGesturesEnqueued)),
    @"failed": @(atomic_load(&fbFastGesturesFailed)),
    @"rejected": @(atomic_load(&fbFastGesturesRejected)),
  };
  @synchronized([FBElementCommands class]) {
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    for (NSString *gestureId in [fbFastGestureResultOrder copy]) {
      NSDictionary *result = fbFastGestureResults[gestureId];
      BOOL pending = [result[@"state"] isEqualToString:@"pending"];
      if (!pending && now - [result[@"updatedAt"] doubleValue] > 60.0) {
        [fbFastGestureResultOrder removeObject:gestureId];
        [fbFastGestureResults removeObjectForKey:gestureId];
      }
    }
    NSMutableDictionary *stats = [counters mutableCopy];
    stats[@"recent"] = fbFastGestureResults.count > 0 ? [fbFastGestureResults copy] : @{};
    return [stats copy];
  }
}

+ (id<FBResponsePayload>)handlePinch:(FBRouteRequest *)request
{
  XCUIElement *element = [self targetFromRequest:request];
  CGFloat scale = (CGFloat)[request.arguments[@"scale"] doubleValue];
  CGFloat velocity = (CGFloat)[request.arguments[@"velocity"] doubleValue];
  [element pinchWithScale:scale velocity:velocity];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleRotate:(FBRouteRequest *)request
{
  XCUIElement *element = [self targetFromRequest:request];
  CGFloat rotation = (CGFloat)[request.arguments[@"rotation"] doubleValue];
  CGFloat velocity = (CGFloat)[request.arguments[@"velocity"] doubleValue];
  [element rotate:rotation withVelocity:velocity];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleForceTouch:(FBRouteRequest *)request
{
  XCUIElement *element = [self targetFromRequest:request];
  NSNumber *pressure = request.arguments[@"pressure"];
  NSNumber *duration = request.arguments[@"duration"];
  NSNumber *x = request.arguments[@"x"];
  NSNumber *y = request.arguments[@"y"];
  NSValue *hitPoint = (nil == x || nil == y)
    ? nil
    : [NSValue valueWithCGPoint:CGPointMake((CGFloat)[x doubleValue], (CGFloat)[y doubleValue])];
  NSError *error;
  BOOL didSucceed = [element fb_forceTouchCoordinate:hitPoint
                                            pressure:pressure
                                            duration:duration
                                               error:&error];
  return didSucceed
    ? FBResponseWithOK()
    : FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description
                                                                    traceback:nil]);
}
#endif

+ (id<FBResponsePayload>)handleKeys:(FBRouteRequest *)request
{
  NSString *textToType = [request.arguments[@"value"] componentsJoinedByString:@""];
  NSUInteger frequency = [request.arguments[@"frequency"] unsignedIntegerValue] ?: FBConfiguration.sharedInstance.maxTypingFrequency;
  NSError *error;
#if TARGET_OS_IOS
  NSTimeInterval keyboardWait = FBConfiguration.sharedInstance.keyboardWaitTimeout;
  if (keyboardWait > 0) {
    XCUIApplication *application = request.session.activeApplication ?: XCUIApplication.fb_activeApplication;
    FBWaitForHittableKey(application, keyboardWait);
  }
#endif
  if (!FBTypeText(textToType, frequency, &error)) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description
                                                                           traceback:nil]);
  }
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleGetWindowSize:(FBRouteRequest *)request
{
  XCUIApplication *app = request.session.activeApplication ?: XCUIApplication.fb_activeApplication;

  CGRect frame = app.wdFrame;
#if TARGET_OS_TV || TARGET_OS_WATCH
  CGSize screenSize = frame.size;
#else
  CGSize screenSize = FBAdjustDimensionsForApplication(frame.size, app.interfaceOrientation);
#endif
  return FBResponseWithObject(@{
    @"width": @(screenSize.width),
    @"height": @(screenSize.height),
  });
}


+ (id<FBResponsePayload>)handleGetWindowRect:(FBRouteRequest *)request
{
  XCUIApplication *app = request.session.activeApplication ?: XCUIApplication.fb_activeApplication;

  CGRect frame = app.wdFrame;
#if TARGET_OS_TV || TARGET_OS_WATCH
  CGSize screenSize = frame.size;
#else
  CGSize screenSize = FBAdjustDimensionsForApplication(frame.size, app.interfaceOrientation);
#endif
  return FBResponseWithObject(@{
    @"x": @(frame.origin.x),
    @"y": @(frame.origin.y),
    @"width": @(screenSize.width),
    @"height": @(screenSize.height),
  });
}

+ (id<FBResponsePayload>)handleElementScreenshot:(FBRouteRequest *)request
{
  @autoreleasepool {
    FBElementCache *elementCache = request.session.elementCache;
    XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]
                                        checkStaleness:YES];
    NSData *screenshotData = nil;
    @autoreleasepool {
      screenshotData = [element.screenshot PNGRepresentation];
      if (nil == screenshotData) {
        NSString *errMsg = [NSString stringWithFormat:@"Cannot take a screenshot of %@", element.description];
        return FBResponseWithStatus([FBCommandStatus unableToCaptureScreenErrorWithMessage:errMsg
                                                                                traceback:nil]);
      }
    }
    NSString *screenshot = [screenshotData base64EncodedStringWithOptions:(NSDataBase64EncodingOptions)0];
    screenshotData = nil;
    return FBResponseWithObject(screenshot);
  }
}


#if !TARGET_OS_TV
static const CGFloat DEFAULT_PICKER_OFFSET = (CGFloat)0.2;
static const NSInteger DEFAULT_MAX_PICKER_ATTEMPTS = 25;


+ (id<FBResponsePayload>)handleWheelSelect:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  XCUIElement *element = [elementCache elementForUUID:(NSString *)request.parameters[@"uuid"]
                                       checkStaleness:YES];
  if ([element elementType] != XCUIElementTypePickerWheel) {
    NSString *errMsg = [NSString stringWithFormat:@"The element is expected to be a valid Picker Wheel control. '%@' was given instead", element.wdType];
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:errMsg
                                                                       traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
  }
  NSString* order = [request.arguments[@"order"] lowercaseString];
  CGFloat offset = DEFAULT_PICKER_OFFSET;
  if (request.arguments[@"offset"]) {
    offset = (CGFloat)[request.arguments[@"offset"] doubleValue];
    if (offset <= 0.0 || offset > 0.5) {
      NSString *errMsg = [NSString stringWithFormat:@"'offset' value is expected to be in range (0.0, 0.5]. '%@' was given instead", request.arguments[@"offset"]];
      return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:errMsg
                                                                         traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
    }
  }
  NSNumber *maxAttempts = request.arguments[@"maxAttempts"] ?: @(DEFAULT_MAX_PICKER_ATTEMPTS);
  NSString *expectedValue = request.arguments[@"value"];
  NSInteger attempt = 0;
  while (attempt < [maxAttempts integerValue]) {
    BOOL isSuccessful = false;
    NSError *error;
    if ([order isEqualToString:@"next"]) {
      isSuccessful = [element fb_selectNextOptionWithOffset:offset error:&error];
    } else if ([order isEqualToString:@"previous"]) {
      isSuccessful = [element fb_selectPreviousOptionWithOffset:offset error:&error];
    } else {
      NSString *errMsg = [NSString stringWithFormat:@"Only 'previous' and 'next' order values are supported. '%@' was given instead", request.arguments[@"order"]];
      return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:errMsg
                                                                         traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
    }
    if (!isSuccessful) {
      return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description traceback:nil]);
    }
    if (nil == expectedValue || [element.wdValue isEqualToString:expectedValue]) {
      return FBResponseWithOK();
    }
    attempt++;
  }
  NSString *errMsg = [NSString stringWithFormat:@"Cannot select the expected picker wheel value '%@' after %ld attempts", expectedValue, attempt];
  return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:errMsg traceback:nil]);
}

#pragma mark - Helpers

+ (id<FBResponsePayload>)handleScrollElementToVisible:(XCUIElement *)element withRequest:(FBRouteRequest *)request
{
  NSError *error;
  if (!element.exists) {
    return FBResponseWithStatus([FBCommandStatus elementNotVisibleErrorWithMessage:@"Can't scroll to element that does not exist" traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
  }
  if (![element fb_scrollToVisibleWithError:&error]) {
    return FBResponseWithStatus([FBCommandStatus invalidElementStateErrorWithMessage:error.description
                                                                           traceback:[NSString stringWithFormat:@"%@", NSThread.callStackSymbols]]);
  }
  return FBResponseWithOK();
}

/**
 Returns gesture coordinate for the element based on absolute coordinate

 @param offset absolute screen offset for the given application
 @param element the element instance to perform the gesture on
 @param error Error instance if any
 @return translated gesture coordinates ready to be passed to XCUICoordinate methods, or
 nil if the element is not visible on the screen
 */
+ (nullable XCUICoordinate *)gestureCoordinateWithOffset:(CGVector)offset
                                                  element:(XCUIElement *)element
                                                    error:(NSError **)error
{
  if (element.elementType != XCUIElementTypeApplication) {
    return FBCoordinateWithAnchorOffset(element, CGVectorMake(0, 0), offset, error);
  }
  XCUIScreen *screen = [FBScreen currentScreenWithError:error];
  if (nil == screen) {
    return nil;
  }
  if (screen.displayID == XCUIScreen.mainScreen.displayID) {
    return FBCoordinateWithAnchorOffset(element, CGVectorMake(0, 0), offset, error);
  }
  // Application-root coordinates are rotated using the main display on Duo.
  // A window coordinate keeps XCTest's display affinity and rotation intact.
  // It is only a coordinate anchor, not a hit-test boundary. Preserve edge and
  // outside offsets just as on the main display; XCTest handles their delivery.
  CGPoint point = CGPointMake(offset.dx, offset.dy);
  for (XCUIElement *window in [element childrenMatchingType:XCUIElementTypeWindow].allElementsBoundByIndex) {
    // Resolve the window before reading its display affinity: an unresolved
    // element may report displayID == 0.
    (void)window.frame;
    CGRect frame = window.wdFrame;
    if (window.screen.displayID == screen.displayID && !CGRectIsEmpty(frame)) {
      return FBCoordinateWithAnchorOffset(window, CGVectorMake(0, 0),
        CGVectorMake(point.x - frame.origin.x, point.y - frame.origin.y), error);
    }
  }
  [[[FBErrorBuilder builder] withDescriptionFormat:@"No non-empty application window on display %lld is available as a coordinate anchor", screen.displayID]
    buildError:error];
  return nil;
}

/**
 Returns either coordinates or the target element for the given request that expects 'x' and 'y' coordannates

 @param request HTTP request object
 @param error Error instance if any
 @return Either XCUICoordinate or XCUIElement instance. nil if the input data is invalid
 */
+ (nullable id)targetWithXyCoordinatesFromRequest:(FBRouteRequest *)request error:(NSError **)error
{
  NSNumber *x = request.arguments[@"x"];
  NSNumber *y = request.arguments[@"y"];
  if (nil == x && nil == y) {
    return [self targetFromRequest:request];
  }
  if ((nil == x && nil != y) || (nil != x && nil == y)) {
    [[[FBErrorBuilder alloc]
      withDescription:@"Both x and y coordinates must be provided"]
     buildError:error];
    return nil;
  }
  return [self gestureCoordinateWithOffset:CGVectorMake(x.doubleValue, y.doubleValue)
                                   element:[self targetFromRequest:request]
                                     error:error];
}

/**
 Returns the target element for the given request

 @param request HTTP request object
 @return Matching XCUIElement instance
 */
+ (XCUIElement *)targetFromRequest:(FBRouteRequest *)request
{
  FBElementCache *elementCache = request.session.elementCache;
  NSString *elementUuid = (NSString *)request.parameters[@"uuid"];
  return nil == elementUuid
    ? request.session.activeApplication
    : [elementCache elementForUUID:elementUuid checkStaleness:YES];
}

#endif

@end
