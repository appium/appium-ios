/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBW3CActionsSynthesizer.h"

#import "FBErrorBuilder.h"
#import "FBElementCache.h"
#import "FBConfiguration.h"
#import "FBLogger.h"
#import "FBMacros.h"
#import "FBMathUtils.h"
#import "FBProtocolHelpers.h"
#import "FBGestureCoordinateContext.h"
#import "FBW3CActionsHelpers.h"
#import "FBXCodeCompatibility.h"
#import "FBXCTestDaemonsProxy.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIDevice.h"
#import "XCUIElement+FBCaching.h"
#import "XCUIElement+FBIsVisible.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElement.h"
#import "XCSynthesizedEventRecord.h"
#import "XCPointerEventPath.h"
#import "XCPointerEvent.h"
#import "XCUIScreen.h"


static NSString *const FB_KEY_TYPE = @"type";
static NSString *const FB_ACTION_TYPE_POINTER = @"pointer";
static NSString *const FB_ACTION_TYPE_KEY = @"key";
static NSString *const FB_ACTION_TYPE_NONE = @"none";

static NSString *const FB_PARAMETERS_KEY_POINTER_TYPE = @"pointerType";
static NSString *const FB_POINTER_TYPE_MOUSE = @"mouse";
static NSString *const FB_POINTER_TYPE_PEN = @"pen";
static NSString *const FB_POINTER_TYPE_TOUCH = @"touch";

static NSString *const FB_ACTION_ITEM_KEY_ORIGIN = @"origin";
static NSString *const FB_ORIGIN_TYPE_VIEWPORT = @"viewport";
static NSString *const FB_ORIGIN_TYPE_POINTER = @"pointer";

static NSString *const FB_ACTION_ITEM_KEY_TYPE = @"type";
static NSString *const FB_ACTION_ITEM_TYPE_POINTER_MOVE = @"pointerMove";
static NSString *const FB_ACTION_ITEM_TYPE_POINTER_DOWN = @"pointerDown";
static NSString *const FB_ACTION_ITEM_TYPE_POINTER_UP = @"pointerUp";
static NSString *const FB_ACTION_ITEM_TYPE_POINTER_CANCEL = @"pointerCancel";
static NSString *const FB_ACTION_ITEM_TYPE_PAUSE = @"pause";
static NSString *const FB_ACTION_ITEM_TYPE_KEY_UP = @"keyUp";
static NSString *const FB_ACTION_ITEM_TYPE_KEY_DOWN = @"keyDown";

static NSString *const FB_ACTION_ITEM_KEY_X = @"x";
static NSString *const FB_ACTION_ITEM_KEY_Y = @"y";
static NSString *const FB_ACTION_ITEM_KEY_BUTTON = @"button";
static NSString *const FB_ACTION_ITEM_KEY_PRESSURE = @"pressure";

static NSString *const FB_KEY_ID = @"id";
static NSString *const FB_KEY_PARAMETERS = @"parameters";
static NSString *const FB_KEY_ACTIONS = @"actions";


#if !TARGET_OS_TV && !TARGET_OS_WATCH
@interface FBW3CGestureItem : FBBaseGestureItem

@property (nullable, readonly, nonatomic) FBW3CGestureItem *previousItem;
@property (readonly, nonatomic) CGPoint screenPoint;
@property (nonatomic) FBGestureCoordinateContext *coordinateContext;

@end

@interface FBPointerDownItem : FBW3CGestureItem
@property (nullable, readonly, nonatomic) NSNumber *pressure;
@end

@interface FBPointerMoveItem : FBW3CGestureItem

@end

@interface FBPointerUpItem : FBW3CGestureItem

@end

@interface FBPointerPauseItem : FBW3CGestureItem

@end


@interface FBW3CKeyItem : FBBaseActionItem

@property (nullable, readonly, nonatomic) FBW3CKeyItem *previousItem;

@end

@interface FBKeyUpItem : FBW3CKeyItem

@property (readonly, nonatomic) NSString *value;

@end

@interface FBKeyDownItem : FBW3CKeyItem

@property (readonly, nonatomic) NSString *value;

@end

@interface FBKeyPauseItem : FBW3CKeyItem

@property (readonly, nonatomic) double duration;

@end



@implementation FBW3CGestureItem

- (nullable instancetype)initWithActionItem:(NSDictionary<NSString *, id> *)actionItem
                                application:(XCUIApplication *)application
                               previousItem:(nullable FBW3CGestureItem *)previousItem
                          coordinateContext:(FBGestureCoordinateContext *)coordinateContext
                                     offset:(double)offset
                                      error:(NSError **)error
{
  self = [super init];
  if (self) {
    self.actionItem = actionItem;
    self.application = application;
    self.offset = offset;
    _previousItem = previousItem;
    _coordinateContext = coordinateContext;
    NSNumber *durationObj = FBOptDuration(actionItem, @0, error);
    if (nil == durationObj) {
      return nil;
    }
    self.duration = durationObj.doubleValue;
    XCUICoordinate *position = [self positionWithError:error];
    // A pause may legally have no position yet (nil position, no error set)
    if (nil == position && error && nil != *error) {
      return nil;
    }
    self.atPosition = position;
  }
  return self;
}

- (CGPoint)screenPoint
{
  return self.atPosition.screenPoint;
}

- (nullable XCUICoordinate *)positionWithError:(NSError **)error
{
  if (nil == self.previousItem || nil == self.previousItem.atPosition) {
    NSString *errorDescription = [NSString stringWithFormat:@"The '%@' action item must be preceded by %@ item", self.actionItem, FB_ACTION_ITEM_TYPE_POINTER_MOVE];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:errorDescription] build];
    }
    return nil;
  }
  return self.previousItem.atPosition;
}

- (nullable XCUICoordinate *)hitpointWithElement:(nullable XCUIElement *)element
                                  positionOffset:(nullable NSValue *)positionOffset
                                           error:(NSError **)error
{
  if (self.coordinateContext.usesWindowCoordinates) {
    CGPoint point = nil == positionOffset ? CGPointZero : positionOffset.CGPointValue;
    CGVector offset = CGVectorMake(point.x, point.y);
    if (nil == element) {
      return [self.coordinateContext coordinateWithApplication:self.application offset:offset error:error];
    }
    if (element.elementType == XCUIElementTypeApplication) {
      XCUIElement *application = element;
      return [self.coordinateContext coordinateWithApplicationOrigin:application offset:offset error:error];
    }
    // Resolve display affinity before combining element and viewport origins.
    (void)element.frame;
    if (element.screen.displayID != self.coordinateContext.screen.displayID) {
      [[[FBErrorBuilder builder] withDescriptionFormat:
        @"The element origin is not on the selected display %lld", self.coordinateContext.screen.displayID] buildError:error];
      return nil;
    }
  }
  // Single-display viewport and application origins retain the legacy path.
  if (nil == element || nil == positionOffset) {
    return [super hitpointWithElement:element positionOffset:positionOffset error:error];
  }

  // An offset relative to the element is defined.
  if (CGRectIsEmpty(element.frame)) {
    [FBLogger log:self.application.fb_descriptionRepresentation];
    NSString *description = [NSString stringWithFormat:@"The element '%@' is not visible on the screen and thus is not interactable",
                             element.description];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  // W3C standard requires that relative element coordinates start at the center of the element's rectangle
  // TODO: Shall we throw an exception if hitPoint is out of the element frame?
  CGVector offset = CGVectorMake(positionOffset.CGPointValue.x, positionOffset.CGPointValue.y);
  return FBCoordinateWithAnchorOffset((XCUIElement *)element, CGVectorMake(0.5, 0.5), offset, error);
}

@end

@implementation FBPointerDownItem

- (nullable instancetype)initWithActionItem:(NSDictionary<NSString *, id> *)actionItem
                                application:(XCUIApplication *)application
                               previousItem:(nullable FBW3CGestureItem *)previousItem
                          coordinateContext:(FBGestureCoordinateContext *)coordinateContext
                                     offset:(double)offset
                                      error:(NSError **)error
{
  self = [super initWithActionItem:actionItem application:application previousItem:previousItem coordinateContext:coordinateContext offset:offset error:error];
  if (self) {
    _pressure = [actionItem objectForKey:FB_ACTION_ITEM_KEY_PRESSURE];
  }
  return self;
}

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_POINTER_DOWN;
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  if (nil != eventPath && currentItemIndex >= 1) {
    FBW3CGestureItem *preceedingItem = [allItems objectAtIndex:currentItemIndex - 1];
    // Only skip creating a new touch if the preceding pointerMove is the one that
    // implicitly opened this touch, i.e. nothing but (possibly zero-duration) pauses
    // came before it. Pauses never create an event path themselves.
    BOOL isPreceedingMoveTheFirstRealItem = YES;
    for (NSInteger index = (NSInteger)currentItemIndex - 2; index >= 0; index--) {
      if (![[allItems objectAtIndex:index] isKindOfClass:FBPointerPauseItem.class]) {
        isPreceedingMoveTheFirstRealItem = NO;
        break;
      }
    }
    if ([preceedingItem isKindOfClass:FBPointerMoveItem.class] && isPreceedingMoveTheFirstRealItem) {
      return @[];
    }
  }
  if (nil == self.pressure) {
    XCPointerEventPath *result = [[XCPointerEventPath alloc] initForTouchAtPoint:self.screenPoint
                                                                          offset:FBMillisToSeconds(self.offset)];
    return @[result];
  }

  if (nil == eventPath) {
    NSString *description = [NSString stringWithFormat:@"'%@' action with pressure must be preceeded with at least one '%@' action without this option", self.class.actionName, self.class.actionName];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }
  if (![XCUIDevice sharedDevice].supportsPressureInteraction) {
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:@"This device does not support force press interactions"] build];
    }
    return nil;
  }
  [eventPath pressDownWithPressure:self.pressure.doubleValue
                          atOffset:FBMillisToSeconds(self.offset)];
  return @[];
}

@end

@implementation FBPointerMoveItem

- (nullable XCUICoordinate *)positionWithError:(NSError **)error
{
  static NSArray<NSString *> *supportedOriginTypes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    supportedOriginTypes = @[FB_ORIGIN_TYPE_POINTER, FB_ORIGIN_TYPE_VIEWPORT];
  });
  id origin = [self.actionItem objectForKey:FB_ACTION_ITEM_KEY_ORIGIN] ?: FB_ORIGIN_TYPE_VIEWPORT;
  BOOL isOriginAnElement = [origin isKindOfClass:XCUIElement.class] && [(XCUIElement *)origin exists];
  if (!isOriginAnElement && ![supportedOriginTypes containsObject:origin]) {
    NSString *description = [NSString stringWithFormat:@"Unsupported %@ type '%@' is set for '%@' action item. Supported origin types: %@ or an element instance", FB_ACTION_ITEM_KEY_ORIGIN, origin, self.actionItem, supportedOriginTypes];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }
  
  XCUIElement *element = isOriginAnElement ? (XCUIElement *)origin : nil;
  NSNumber *x = [self.actionItem objectForKey:FB_ACTION_ITEM_KEY_X];
  NSNumber *y = [self.actionItem objectForKey:FB_ACTION_ITEM_KEY_Y];
  if ((nil != x && nil == y) || (nil != y && nil == x) ||
      ([origin isKindOfClass:NSString.class] && [origin isEqualToString:FB_ORIGIN_TYPE_VIEWPORT] && (nil == x || nil == y))) {
    NSString *errorDescription = [NSString stringWithFormat:@"Both 'x' and 'y' options should be set for '%@' action item", self.actionItem];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:errorDescription] build];
    }
    return nil;
  }
  
  if (nil != element) {
    if (nil == x && nil == y) {
      return [self hitpointWithElement:element positionOffset:nil error:error];
    }
    return [self hitpointWithElement:element positionOffset:[NSValue valueWithCGPoint:CGPointMake(x.floatValue, y.floatValue)] error:error];
  }
  
  if ([origin isKindOfClass:NSString.class] && [origin isEqualToString:FB_ORIGIN_TYPE_VIEWPORT]) {
    return [self hitpointWithElement:nil positionOffset:[NSValue valueWithCGPoint:CGPointMake(x.floatValue, y.floatValue)] error:error];
  }
  
  // origin == FB_ORIGIN_TYPE_POINTER
  if (nil == self.previousItem || nil == self.previousItem.atPosition) {
    NSString *errorDescription = [NSString stringWithFormat:@"There is no previous item for '%@' action item, however %@ is set to '%@'", self.actionItem, FB_ACTION_ITEM_KEY_ORIGIN, FB_ORIGIN_TYPE_POINTER];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:errorDescription] build];
    }
    return nil;
  }
  XCUICoordinate *recentPosition = self.previousItem.atPosition;
  CGVector offsetRelativeToRecentPosition = (nil == x && nil == y) ? CGVectorMake(0, 0) : CGVectorMake(x.floatValue, y.floatValue);
  // Pointer-relative moves keep the coordinate space of their preceding position.
  return [recentPosition coordinateWithOffset:offsetRelativeToRecentPosition];
}

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_POINTER_MOVE;
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  if (nil == eventPath) {
    return @[[[XCPointerEventPath alloc] initForTouchAtPoint:self.screenPoint
                                                      offset:FBMillisToSeconds(self.offset + self.duration)]];
  }
  [eventPath moveToPoint:self.screenPoint
                atOffset:FBMillisToSeconds(self.offset + self.duration)];
  return @[];
}

@end

@implementation FBPointerPauseItem

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_PAUSE;
}

- (nullable XCUICoordinate *)positionWithError:(NSError **)error
{
  // A pause has no position of its own; proxy whatever real move preceded
  // it, or nil (not a fabricated point) if none has run yet
  return self.previousItem.atPosition;
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  return @[];
}

@end

@implementation FBPointerUpItem

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_POINTER_UP;
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  if (nil == eventPath) {
    NSString *description = [NSString stringWithFormat:@"Pointer Up must not be the first action in '%@'", self.actionItem];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  [eventPath liftUpAtOffset:FBMillisToSeconds(self.offset)];
  return @[];
}

@end

@implementation FBW3CKeyItem

- (nullable instancetype)initWithActionItem:(NSDictionary<NSString *, id> *)actionItem
                                application:(XCUIApplication *)application
                               previousItem:(nullable FBW3CKeyItem *)previousItem
                                     offset:(double)offset
                                      error:(NSError **)error
{
  self = [super init];
  if (self) {
    self.actionItem = actionItem;
    self.application = application;
    self.offset = offset;
    _previousItem = previousItem;
  }
  return self;
}

@end


// Zero-duration pauses do not separate keys into groups
static BOOL FBIsZeroPause(FBW3CKeyItem *item)
{
  return [item isKindOfClass:FBKeyPauseItem.class] && 0 == ((FBKeyPauseItem *)item).duration;
}

@implementation FBKeyUpItem : FBW3CKeyItem

- (nullable instancetype)initWithActionItem:(NSDictionary<NSString *, id> *)actionItem
                                application:(XCUIApplication *)application
                               previousItem:(nullable FBW3CKeyItem *)previousItem
                                     offset:(double)offset
                                      error:(NSError **)error
{
  self = [super initWithActionItem:actionItem
                       application:application
                      previousItem:previousItem
                            offset:offset
                             error:error];
  if (self) {
    NSString *value = FBRequireValue(actionItem, error);
    if (nil == value) {
      return nil;
    }
    _value = value;
  }
  return self;
}

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_KEY_UP;
}

- (BOOL)hasDownPairInItems:(NSArray *)allItems
          currentItemIndex:(NSUInteger)currentItemIndex
{
  NSInteger balance = 1;
  for (NSInteger index = currentItemIndex - 1; index >= 0; index--) {
    FBW3CKeyItem *item = [allItems objectAtIndex:index];
    BOOL isKeyDown = [item isKindOfClass:FBKeyDownItem.class];
    BOOL isKeyUp = !isKeyDown && [item isKindOfClass:FBKeyUpItem.class];
    if (!isKeyUp && !isKeyDown) {
      if (FBIsZeroPause(item)) {
        continue;
      }
      break;
    }

    NSString *value = [item performSelector:@selector(value)];
    if (isKeyDown && [value isEqualToString:self.value]) {
      balance--;
    }
    if (isKeyUp && [value isEqualToString:self.value]) {
      balance++;
    }
  }
  return 0 == balance;
}

- (NSString *)collectTextWithItems:(NSArray *)allItems
                  currentItemIndex:(NSUInteger)currentItemIndex
{
  NSMutableArray *result = [NSMutableArray array];
  for (NSInteger index = currentItemIndex; index >= 0; index--) {
    FBW3CKeyItem *item = [allItems objectAtIndex:index];
    BOOL isKeyDown = [item isKindOfClass:FBKeyDownItem.class];
    BOOL isKeyUp = !isKeyDown && [item isKindOfClass:FBKeyUpItem.class];
    if (!isKeyUp && !isKeyDown) {
      if (FBIsZeroPause(item)) {
        continue;
      }
      break;
    }

    NSString *value = [item performSelector:@selector(value)];
    if (isKeyUp) {
      [result addObject:FBMapIfSpecialCharacter(value)];
    }
  }
  return [result.reverseObjectEnumerator.allObjects componentsJoinedByString:@""];
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  if (![self hasDownPairInItems:allItems currentItemIndex:currentItemIndex]) {
    NSString *description = [NSString stringWithFormat:@"Key Up action '%@' is not balanced with a preceding Key Down one in '%@'", self.value, self.actionItem];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  // Zero-duration pauses are transparent, only a pause with a duration ends the group
  FBW3CKeyItem *nextItem = nil;
  for (NSUInteger index = currentItemIndex + 1; index < allItems.count; index++) {
    if (!FBIsZeroPause([allItems objectAtIndex:index])) {
      nextItem = [allItems objectAtIndex:index];
      break;
    }
  }
  BOOL isLastKeyUpInGroup = nil == nextItem || [nextItem isKindOfClass:FBKeyPauseItem.class];
  if (!isLastKeyUpInGroup) {
    return @[];
  }

  NSString *text = [self collectTextWithItems:allItems currentItemIndex:currentItemIndex];
  NSTimeInterval offset = FBMillisToSeconds(self.offset);
  XCPointerEventPath *resultPath = [[XCPointerEventPath alloc] initForTextInput];
  [resultPath typeText:text
              atOffset:offset
           typingSpeed:FBConfiguration.sharedInstance.maxTypingFrequency
          shouldRedact:YES];
  return @[resultPath];
}

@end

@implementation FBKeyDownItem : FBW3CKeyItem

- (nullable instancetype)initWithActionItem:(NSDictionary<NSString *, id> *)actionItem
                                application:(XCUIApplication *)application
                               previousItem:(nullable FBW3CKeyItem *)previousItem
                                     offset:(double)offset
                                      error:(NSError **)error
{
  self = [super initWithActionItem:actionItem
                       application:application
                      previousItem:previousItem
                            offset:offset
                             error:error];
  if (self) {
    NSString *value = FBRequireValue(actionItem, error);
    if (nil == value) {
      return nil;
    }
    _value = value;
  }
  return self;
}

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_KEY_DOWN;
}

- (BOOL)hasUpPairInItems:(NSArray *)allItems
        currentItemIndex:(NSUInteger)currentItemIndex
{
  NSInteger balance = 1;
  for (NSUInteger index = currentItemIndex + 1; index < allItems.count; index++) {
    FBW3CKeyItem *item = [allItems objectAtIndex:index];
    BOOL isKeyDown = [item isKindOfClass:FBKeyDownItem.class];
    BOOL isKeyUp = !isKeyDown && [item isKindOfClass:FBKeyUpItem.class];
    if (!isKeyUp && !isKeyDown) {
      if (FBIsZeroPause(item)) {
        continue;
      }
      break;
    }

    NSString *value = [item performSelector:@selector(value)];
    if (isKeyUp && [value isEqualToString:self.value]) {
      balance--;
    }
    if (isKeyDown && [value isEqualToString:self.value]) {
      balance++;
    }
  }
  return 0 == balance;
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  if (![self hasUpPairInItems:allItems currentItemIndex:currentItemIndex]) {
    NSString *description = [NSString stringWithFormat:@"Key Down action '%@' must have a closing Key Up successor in '%@'", self.value, self.actionItem];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  return @[];
}

@end

@implementation FBKeyPauseItem

- (nullable instancetype)initWithActionItem:(NSDictionary<NSString *, id> *)actionItem
                                application:(XCUIApplication *)application
                               previousItem:(nullable FBW3CKeyItem *)previousItem
                                     offset:(double)offset
                                      error:(NSError **)error
{
  self = [super initWithActionItem:actionItem
                       application:application
                      previousItem:previousItem
                            offset:offset
                             error:error];
  if (self) {
    NSNumber *duration = FBOptDuration(actionItem, @0, error);
    if (nil == duration) {
      return nil;
    }
    _duration = [duration doubleValue];
  }
  return self;
}

+ (NSString *)actionName
{
  return FB_ACTION_ITEM_TYPE_PAUSE;
}

- (NSArray<XCPointerEventPath *> *)addToEventPath:(XCPointerEventPath *)eventPath
                                         allItems:(NSArray *)allItems
                                 currentItemIndex:(NSUInteger)currentItemIndex
                                            error:(NSError **)error
{
  return @[];
}

@end


@interface FBW3CGestureItemsChain : FBBaseActionItemsChain

@end

@implementation FBW3CGestureItemsChain

- (void)addItem:(FBBaseActionItem *)item
{
  self.durationOffset += ((FBBaseGestureItem *)item).duration;
  [self.items addObject:item];
}

@end


@interface FBW3CKeyItemsChain : FBBaseActionItemsChain

@end

@implementation FBW3CKeyItemsChain

- (void)addItem:(FBBaseActionItem *)item
{
  if ([item isKindOfClass:FBKeyPauseItem.class]) {
    self.durationOffset += ((FBKeyPauseItem *)item).duration;
  }
  [self.items addObject:item];
}

@end


@implementation FBKeyAction

@end


@interface FBKeyActionStep : NSObject

/*! The record to perform. A delay is performed instead if the record is nil */
@property (nullable, nonatomic) XCSynthesizedEventRecord *record;
/*! The delay in seconds */
@property (nonatomic) NSTimeInterval delay;
@property (nonatomic) BOOL beginsPersistentState;
@property (nonatomic) BOOL endsPersistentState;

@end

@implementation FBKeyActionStep

@end


// The flags of the held modifier keys (the NULL key has no flags)
static NSUInteger FBHeldModifierFlags(NSCountedSet<NSString *> *heldKeys)
{
  NSUInteger result = 0;
  for (NSString *key in heldKeys) {
    result |= [FBToMetaModifier(key) unsignedIntegerValue];
  }
  return result;
}

#define MAX_KEY_ACTIONS_PAUSES_MS 300000

@implementation FBW3CActionsSynthesizer

- (NSArray<NSDictionary<NSString *, id> *> *)preprocessedActionItemsWith:(NSArray<NSDictionary<NSString *, id> *> *)actionItems
{
  NSMutableArray<NSDictionary<NSString *, id> *> *result = [NSMutableArray array];
  BOOL shouldCancelNextItem = NO;
  for (NSDictionary<NSString *, id> *actionItem in [actionItems reverseObjectEnumerator]) {
    if (shouldCancelNextItem) {
      shouldCancelNextItem = NO;
      continue;
    }
    NSString *actionItemType = [actionItem objectForKey:FB_ACTION_ITEM_KEY_TYPE];
    if (actionItemType != nil && [actionItemType isEqualToString:FB_ACTION_ITEM_TYPE_POINTER_CANCEL]) {
      shouldCancelNextItem = YES;
      continue;
    }
    
    if (nil == self.elementCache) {
      [result addObject:actionItem];
      continue;
    }
    id origin = [actionItem objectForKey:FB_ACTION_ITEM_KEY_ORIGIN];
    if (nil == origin || [@[FB_ORIGIN_TYPE_POINTER, FB_ORIGIN_TYPE_VIEWPORT] containsObject:origin]) {
      [result addObject:actionItem];
      continue;
    }
    // Selenium Python client passes 'origin' element in the following format:
    //
    // if isinstance(origin, WebElement):
    //    action["origin"] = {"element-6066-11e4-a52e-4f735466cecf": origin.id}
    if ([origin isKindOfClass:NSDictionary.class]) {
      id element = FBExtractElement(origin);
      if (nil != element) {
        origin = element;
      }
    }

    XCUIElement *instance;
    if ([origin isKindOfClass:XCUIElement.class]) {
      instance = origin;
    } else if ([origin isKindOfClass:NSString.class]) {
      instance = [self.elementCache elementForUUID:(NSString *)origin checkStaleness:YES];
    } else {
      [result addObject:actionItem];
      continue;
    }
    NSMutableDictionary<NSString *, id> *processedItem = actionItem.mutableCopy;
    [processedItem setObject:instance forKey:FB_ACTION_ITEM_KEY_ORIGIN];
    [result addObject:processedItem.copy];
  }
  return [[result reverseObjectEnumerator] allObjects];
}

- (nullable FBW3CKeyItemsChain *)keyItemsChainWithKeyAction:(NSDictionary<NSString *, id> *)actionDescription forActionId:(NSString *)actionId error:(NSError **)error
{
  static NSDictionary<NSString *, Class> *keyItemsMapping;
  static NSArray<NSString *> *supportedActionItemTypes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSMutableDictionary<NSString *, Class> *itemsMapping = [NSMutableDictionary dictionary];
    for (Class cls in @[FBKeyDownItem.class,
                        FBKeyPauseItem.class,
                        FBKeyUpItem.class]) {
      [itemsMapping setObject:cls forKey:[cls actionName]];
    }
    keyItemsMapping = itemsMapping.copy;
    supportedActionItemTypes = @[FB_ACTION_ITEM_TYPE_PAUSE,
                                 FB_ACTION_ITEM_TYPE_KEY_UP,
                                 FB_ACTION_ITEM_TYPE_KEY_DOWN];
  });

  NSArray<NSDictionary<NSString *, id> *> *actionItems = [actionDescription objectForKey:FB_KEY_ACTIONS];
  if (nil == actionItems || 0 == actionItems.count) {
   NSString *description = [NSString stringWithFormat:@"It is mandatory to have at least one item defined for each action. Action with id '%@' contains none", actionId];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  FBW3CKeyItemsChain *chain = [[FBW3CKeyItemsChain alloc] init];
  NSArray<NSDictionary<NSString *, id> *> *processedItems = [self preprocessedActionItemsWith:actionItems];
  for (NSDictionary<NSString *, id> *actionItem in processedItems) {
    id actionItemType = [actionItem objectForKey:FB_ACTION_ITEM_KEY_TYPE];
    if (![actionItemType isKindOfClass:NSString.class]) {
      NSString *description = [NSString stringWithFormat:@"The %@ property is mandatory to set for '%@' action item", FB_ACTION_ITEM_KEY_TYPE, actionItem];
      if (error) {
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }

    Class keyItemClass = [keyItemsMapping objectForKey:actionItemType];
    if (nil == keyItemClass) {
      NSString *description = [NSString stringWithFormat:@"'%@' action item type '%@' is not supported. Only the following action item types are supported: %@", actionId, actionItemType, supportedActionItemTypes];
      if (error) {
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }

    FBW3CKeyItem *keyItem = [[keyItemClass alloc] initWithActionItem:actionItem
                                                         application:self.application
                                                        previousItem:[chain.items lastObject]
                                                              offset:chain.durationOffset
                                                               error:error];
    if (nil == keyItem) {
      return nil;
    }

    [chain addItem:keyItem];
  }

  return [self verifyKeyItemsInChain:chain forActionId:actionId error:error] ? chain : nil;
}

- (nullable NSArray<XCPointerEventPath *> *)eventPathsWithKeyAction:(NSDictionary<NSString *, id> *)actionDescription forActionId:(NSString *)actionId error:(NSError **)error
{
  FBW3CKeyItemsChain *chain = [self keyItemsChainWithKeyAction:actionDescription forActionId:actionId error:error];
  return nil == chain ? nil : [chain asEventPathsWithError:error];
}

- (nullable NSArray<XCPointerEventPath *> *)eventPathsWithGestureAction:(NSDictionary<NSString *, id> *)actionDescription
                                                         forActionId:(NSString *)actionId
                                                   coordinateContext:(FBGestureCoordinateContext *)coordinateContext
                                                               error:(NSError **)error
{
  static NSDictionary<NSString *, Class> *gestureItemsMapping;
  static NSArray<NSString *> *supportedActionItemTypes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSMutableDictionary<NSString *, Class> *itemsMapping = [NSMutableDictionary dictionary];
    for (Class cls in @[FBPointerDownItem.class,
                        FBPointerMoveItem.class,
                        FBPointerPauseItem.class,
                        FBPointerUpItem.class]) {
      [itemsMapping setObject:cls forKey:[cls actionName]];
    }
    gestureItemsMapping = itemsMapping.copy;
    supportedActionItemTypes = @[FB_ACTION_ITEM_TYPE_PAUSE,
                                 FB_ACTION_ITEM_TYPE_POINTER_UP,
                                 FB_ACTION_ITEM_TYPE_POINTER_DOWN,
                                 FB_ACTION_ITEM_TYPE_POINTER_MOVE];
  });

  id parameters = [actionDescription objectForKey:FB_KEY_PARAMETERS];
  id pointerType = FB_POINTER_TYPE_MOUSE;
  if ([parameters isKindOfClass:NSDictionary.class]) {
    pointerType = [parameters objectForKey:FB_PARAMETERS_KEY_POINTER_TYPE] ?: FB_POINTER_TYPE_MOUSE;
  }
  if (![pointerType isKindOfClass:NSString.class] || ![pointerType isEqualToString:FB_POINTER_TYPE_TOUCH]) {
    NSString *description = [NSString stringWithFormat:@"Only pointer type '%@' is supported. '%@' is given instead for action with id '%@'", FB_POINTER_TYPE_TOUCH, pointerType, actionId];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  NSArray<NSDictionary<NSString *, id> *> *actionItems = [actionDescription objectForKey:FB_KEY_ACTIONS];
  if (nil == actionItems || 0 == actionItems.count) {
    NSString *description = [NSString stringWithFormat:@"It is mandatory to have at least one gesture item defined for each action. Action with id '%@' contains none", actionId];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  FBW3CGestureItemsChain *chain = [[FBW3CGestureItemsChain alloc] init];
  NSArray<NSDictionary<NSString *, id> *> *processedItems = [self preprocessedActionItemsWith:actionItems];
  for (NSDictionary<NSString *, id> *actionItem in processedItems) {
    id actionItemType = [actionItem objectForKey:FB_ACTION_ITEM_KEY_TYPE];
    if (![actionItemType isKindOfClass:NSString.class]) {
      NSString *description = [NSString stringWithFormat:@"The %@ property is mandatory to set for '%@' action item", FB_ACTION_ITEM_KEY_TYPE, actionItem];
      if (error) {
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }

    Class gestureItemClass = [gestureItemsMapping objectForKey:actionItemType];
    if (nil == gestureItemClass) {
      NSString *description = [NSString stringWithFormat:@"'%@' action item type '%@' is not supported. Only the following action item types are supported: %@", actionId, actionItemType, supportedActionItemTypes];
      if (error) {
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }

    FBW3CGestureItem *gestureItem = [[gestureItemClass alloc] initWithActionItem:actionItem application:self.application previousItem:[chain.items lastObject] coordinateContext:coordinateContext offset:chain.durationOffset error:error];
    if (nil == gestureItem) {
      return nil;
    }

    [chain addItem:gestureItem];
  }

  return [chain asEventPathsWithError:error];
}

- (nullable NSArray<XCPointerEventPath *> *)eventPathsWithActionDescription:(NSDictionary<NSString *, id> *)actionDescription
                                                             forActionId:(NSString *)actionId
                                                       coordinateContext:(FBGestureCoordinateContext *)coordinateContext
                                                                   error:(NSError **)error
{
  id actionType = [actionDescription objectForKey:FB_KEY_TYPE];
  if (![actionType isKindOfClass:NSString.class] ||
      !([actionType isEqualToString:FB_ACTION_TYPE_POINTER]
        || ([XCPointerEvent.class fb_areKeyEventsSupported] && [actionType isEqualToString:FB_ACTION_TYPE_KEY]))) {
    NSString *description = [NSString stringWithFormat:@"Only actions of '%@' types are supported. '%@' is given instead for action with id '%@'", @[FB_ACTION_TYPE_POINTER, FB_ACTION_TYPE_KEY], actionType, actionId];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }

  if ([actionType isEqualToString:FB_ACTION_TYPE_POINTER]) {
    return [self eventPathsWithGestureAction:actionDescription forActionId:actionId coordinateContext:coordinateContext error:error];
  }

  return [self eventPathsWithKeyAction:actionDescription forActionId:actionId error:error];
}

- (nullable NSDictionary<NSString *, id> *)singleKeyAction
{
  if (1 != self.actions.count) {
    return nil;
  }
  NSDictionary<NSString *, id> *action = self.actions.firstObject;
  id actionType = [action objectForKey:FB_KEY_TYPE];
  return [actionType isKindOfClass:NSString.class] && [actionType isEqualToString:FB_ACTION_TYPE_KEY]
    ? action
    : nil;
}

- (BOOL)requiresKeyRecords
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    return NO;
  }
  NSArray *items = [[self singleKeyAction] objectForKey:FB_KEY_ACTIONS];
  if (![items isKindOfClass:NSArray.class]) {
    return NO;
  }
  for (id item in items) {
    id value = [item isKindOfClass:NSDictionary.class] ? [item objectForKey:@"value"] : nil;
    if ([value isKindOfClass:NSString.class] && FBRequiresKeyRecord(value)) {
      return YES;
    }
  }
  return NO;
}

- (BOOL)verifyKeyItemsInChain:(FBW3CKeyItemsChain *)chain
                  forActionId:(NSString *)actionId
                        error:(NSError **)error
{
  NSMutableDictionary<NSString *, NSMutableArray<FBKeyDownItem *> *> *openItems = [NSMutableDictionary dictionary];
  double totalPausesMs = 0;
  for (FBW3CKeyItem *item in chain.items) {
    if ([item isKindOfClass:FBKeyPauseItem.class]) {
      totalPausesMs += ((FBKeyPauseItem *)item).duration;
      if (totalPausesMs > MAX_KEY_ACTIONS_PAUSES_MS) {
        NSString *description = [NSString stringWithFormat:@"The total duration of pauses in '%@' must not exceed %@ seconds",
                                 actionId, @(MAX_KEY_ACTIONS_PAUSES_MS / 1000)];
        return [[FBErrorBuilder.builder withDescription:description] buildError:error];
      }
    } else if ([item isKindOfClass:FBKeyDownItem.class]) {
      NSString *value = ((FBKeyDownItem *)item).value;
      NSMutableArray<FBKeyDownItem *> *stack = openItems[value] ?: [NSMutableArray array];
      [stack addObject:(FBKeyDownItem *)item];
      openItems[value] = stack;
    } else if ([item isKindOfClass:FBKeyUpItem.class]) {
      FBKeyUpItem *upItem = (FBKeyUpItem *)item;
      NSMutableArray *stack = openItems[upItem.value];
      if (0 == stack.count) {
        NSString *description = [NSString stringWithFormat:@"Key Up action '%@' is not balanced with a preceding Key Down one in '%@'", upItem.value, upItem.actionItem];
        return [[FBErrorBuilder.builder withDescription:description] buildError:error];
      }
      [stack removeLastObject];
    }
  }
  for (NSArray<FBKeyDownItem *> *stack in openItems.allValues) {
    if (stack.count > 0) {
      FBKeyDownItem *downItem = stack.firstObject;
      NSString *description = [NSString stringWithFormat:@"Key Down action '%@' must have a closing Key Up successor in '%@'", downItem.value, downItem.actionItem];
      return [[FBErrorBuilder.builder withDescription:description] buildError:error];
    }
  }
  return YES;
}

+ (XCPointerEventPath *)modifiersPathWithFlags:(NSUInteger)flags
{
  XCPointerEventPath *path = [[XCPointerEventPath alloc] initForTextInput];
  // Presses/releases the actual modifier keys
  [path setModifiers:flags mergeWithCurrentModifierFlags:NO atOffset:0];
  return path;
}

- (nullable XCSynthesizedEventRecord *)keyRecordWithPath:(XCPointerEventPath *)path
                                   beginsPersistentState:(BOOL)begins
                                     endsPersistentState:(BOOL)ends
                                                   error:(NSError **)error
{
  FBGestureCoordinateContext *context = [FBGestureCoordinateContext contextWithDisplayRequired:NO error:error];
  XCSynthesizedEventRecord *record = nil == context ? nil : [self eventRecordForContext:context error:error];
  if (nil == record) {
    return nil;
  }
  [record addPointerEventPath:path];
  record.beginsPersistentState = begins;
  record.endsPersistentState = ends;
  return record;
}

- (nullable FBKeyActionStep *)keyStepWithPath:(XCPointerEventPath *)path
                        beginsPersistentState:(BOOL)begins
                          endsPersistentState:(BOOL)ends
                                        error:(NSError **)error
{
  XCSynthesizedEventRecord *record = [self keyRecordWithPath:path
                                       beginsPersistentState:begins
                                         endsPersistentState:ends
                                                       error:error];
  if (nil == record) {
    return nil;
  }
  FBKeyActionStep *step = [FBKeyActionStep new];
  step.record = record;
  step.beginsPersistentState = begins;
  step.endsPersistentState = ends;
  return step;
}

// Plans the accumulated text (if any) as a single action
static void FBFlushText(NSMutableString *text, NSMutableArray<FBKeyAction *> *actions)
{
  if (0 == text.length) {
    return;
  }
  FBKeyAction *action = [FBKeyAction new];
  action.kind = FBKeyActionKindText;
  action.value = text.copy;
  [actions addObject:action];
  [text setString:@""];
}

- (nullable NSArray<FBKeyAction *> *)keyActionsWithError:(NSError **)error
{
  NSDictionary<NSString *, id> *action = [self singleKeyAction];
  NSString *actionId = [action objectForKey:FB_KEY_ID];
  if (![actionId isKindOfClass:NSString.class] || 0 == actionId.length) {
    NSString *description = [NSString stringWithFormat:@"The mandatory action %@ field is missing or empty for '%@'", FB_KEY_ID, action];
    [[FBErrorBuilder.builder withDescription:description] buildError:error];
    return nil;
  }
  FBW3CKeyItemsChain *chain = [self keyItemsChainWithKeyAction:action forActionId:actionId error:error];
  if (nil == chain) {
    return nil;
  }

  NSMutableArray<FBKeyAction *> *result = [NSMutableArray array];
  NSCountedSet<NSString *> *heldKeys = [NSCountedSet set];
  NSMutableString *pendingText = [NSMutableString string];
  for (FBW3CKeyItem *item in chain.items) {
    if ([item isKindOfClass:FBKeyPauseItem.class]) {
      double durationMs = ((FBKeyPauseItem *)item).duration;
      if (durationMs <= 0) {
        continue;
      }
      FBFlushText(pendingText, result);
      FBKeyAction *delay = [FBKeyAction new];
      delay.kind = FBKeyActionKindDelay;
      delay.delay = durationMs / 1000.0;
      [result addObject:delay];
      continue;
    }

    BOOL isKeyDown = [item isKindOfClass:FBKeyDownItem.class];
    NSString *value = isKeyDown ? ((FBKeyDownItem *)item).value : ((FBKeyUpItem *)item).value;
    NSNumber *modifier = FBToMetaModifier(value);
    if (nil != modifier) {
      NSUInteger oldFlags = FBHeldModifierFlags(heldKeys);
      if (0 == modifier.unsignedIntegerValue) {
        // The NULL key releases everything
        [heldKeys removeAllObjects];
      } else if (isKeyDown) {
        [heldKeys addObject:value];
      } else {
        [heldKeys removeObject:value];
      }
      NSUInteger newFlags = FBHeldModifierFlags(heldKeys);
      if (newFlags == oldFlags) {
        continue;
      }
      FBFlushText(pendingText, result);
      FBKeyAction *modifiers = [FBKeyAction new];
      modifiers.kind = FBKeyActionKindModifiers;
      modifiers.modifierFlags = newFlags;
      [result addObject:modifiers];
      continue;
    }
    if (isKeyDown) {
      // Regular keys are typed on key up
      continue;
    }

    NSUInteger flags = FBHeldModifierFlags(heldKeys);
    NSString *key = FBMapToXCUIKeyboardKey(value);
    NSString *text = FBMapIfSpecialCharacter(value);
    if (nil == key && 0 == text.length) {
      NSString *description = [NSString stringWithFormat:@"The key '%@' in '%@' is not supported", value, actionId];
      [[FBErrorBuilder.builder withDescription:description] buildError:error];
      return nil;
    }
    BOOL isDeletion = 0xE003 == [value characterAtIndex:0] || 0xE017 == [value characterAtIndex:0];
    if (nil == key && flags > 0 && isDeletion) {
      // Delete keys are only delivered as text, which cannot carry modifiers
      NSString *description = [NSString stringWithFormat:@"The key '%@' in '%@' is not supported while modifier keys are pressed", value, actionId];
      [[FBErrorBuilder.builder withDescription:description] buildError:error];
      return nil;
    }
    if (nil == key && 0 == flags) {
      [pendingText appendString:text];
      continue;
    }
    FBFlushText(pendingText, result);
    FBKeyAction *keyAction = [FBKeyAction new];
    keyAction.kind = FBKeyActionKindKey;
    keyAction.value = key ?: text;
    keyAction.modifierFlags = flags;
    [result addObject:keyAction];
  }
  FBFlushText(pendingText, result);
  return result.copy;
}

// XCTest calculates modifier key events for a whole record upfront, so keys typed under a modifier
// go to their own records. The modifiers survive between the records thanks to the persistent state.
- (nullable NSArray<FBKeyActionStep *> *)keyActionStepsWithError:(NSError **)error
{
  NSArray<FBKeyAction *> *actions = [self keyActionsWithError:error];
  if (nil == actions) {
    return nil;
  }

  NSMutableArray<FBKeyActionStep *> *result = [NSMutableArray array];
  NSUInteger heldFlags = 0;
  for (FBKeyAction *action in actions) {
    if (FBKeyActionKindDelay == action.kind) {
      FBKeyActionStep *step = [FBKeyActionStep new];
      step.delay = action.delay;
      [result addObject:step];
      continue;
    }

    XCPointerEventPath *path;
    BOOL begins = NO, ends = NO;
    switch (action.kind) {
      case FBKeyActionKindModifiers:
        path = [self.class modifiersPathWithFlags:action.modifierFlags];
        begins = 0 == heldFlags;
        ends = 0 == action.modifierFlags;
        heldFlags = action.modifierFlags;
        break;
      case FBKeyActionKindText:
        path = [[XCPointerEventPath alloc] initForTextInput];
        [path typeText:action.value
              atOffset:0
           typingSpeed:FBConfiguration.sharedInstance.maxTypingFrequency
          shouldRedact:YES];
        break;
      default:
        path = [[XCPointerEventPath alloc] initForTextInput];
        [path typeKey:action.value modifiers:action.modifierFlags atOffset:0];
        break;
    }
    FBKeyActionStep *step = [self keyStepWithPath:path beginsPersistentState:begins endsPersistentState:ends error:error];
    if (nil == step) {
      return nil;
    }
    [result addObject:step];
  }
  return result.copy;
}

- (BOOL)performKeyActionsWithError:(NSError **)error
{
  NSArray<FBKeyActionStep *> *steps = [self keyActionStepsWithError:error];
  if (nil == steps) {
    return NO;
  }

  BOOL areModifiersPressed = NO;
  @try {
    for (FBKeyActionStep *step in steps) {
      XCSynthesizedEventRecord *record = step.record;
      if (nil == record) {
        [NSThread sleepForTimeInterval:step.delay];
        continue;
      }
      areModifiersPressed |= step.beginsPersistentState;
      if (![FBXCTestDaemonsProxy synthesizeEventWithRecord:record error:error]) {
        return NO;
      }
      if (step.endsPersistentState) {
        areModifiersPressed = NO;
      }
    }
    return YES;
  } @finally {
    if (areModifiersPressed) {
      // Do not leave the modifiers pressed if something went wrong
      XCSynthesizedEventRecord *record = [self keyRecordWithPath:[self.class modifiersPathWithFlags:0]
                                           beginsPersistentState:NO
                                             endsPersistentState:YES
                                                           error:nil];
      if (nil != record) {
        [FBXCTestDaemonsProxy synthesizeEventWithRecord:record error:nil];
      }
    }
  }
}

- (nullable NSArray<NSDictionary<NSString *, id> *> *)validatedActionsWithError:(NSError **)error
{
  NSMutableDictionary<NSString *, NSDictionary<NSString *, id> *> *actionsMapping = [NSMutableDictionary new];
  NSMutableArray<NSDictionary<NSString *, id> *> *validatedActions = [NSMutableArray new];
  for (NSDictionary<NSString *, id> *action in self.actions) {
    id actionId = [action objectForKey:FB_KEY_ID];
    if (![actionId isKindOfClass:NSString.class] || 0 == [actionId length]) {
      if (error) {
        NSString *description = [NSString stringWithFormat:@"The mandatory action %@ field is missing or empty for '%@'", FB_KEY_ID, action];
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }
    if (nil != [actionsMapping objectForKey:actionId]) {
      if (error) {
        NSString *description = [NSString stringWithFormat:@"Action %@ '%@' is not unique for '%@'", FB_KEY_ID, actionId, action];
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }    
    NSArray<NSDictionary<NSString *, id> *> *actionItems = [action objectForKey:FB_KEY_ACTIONS];
    if (nil == actionItems) {
     NSString *description = [NSString stringWithFormat:@"It is mandatory to have at least one item defined for each action. Action with id '%@' contains none", actionId];
      if (error) {
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }
    if (0 == actionItems.count) {
      [FBLogger logFmt:@"Action items in the action id '%@' had an empty array. Skipping the action.", actionId];
      continue;
    }

    [validatedActions addObject:action];
    [actionsMapping setObject:action forKey:actionId];
  }
  return validatedActions.copy;
}

- (BOOL)actionsRequireDisplay:(NSArray<NSDictionary<NSString *, id> *> *)actions
{
  for (NSDictionary<NSString *, id> *action in actions) {
    if (![action[FB_KEY_TYPE] isEqual:FB_ACTION_TYPE_POINTER]) {
      continue;
    }
    for (NSDictionary *item in action[FB_KEY_ACTIONS]) {
      if (![item[FB_ACTION_ITEM_KEY_TYPE] isEqual:FB_ACTION_ITEM_TYPE_PAUSE]) {
        return YES;
      }
    }
  }
  return NO;
}

- (nullable XCSynthesizedEventRecord *)eventRecordForContext:(FBGestureCoordinateContext *)coordinateContext
                                                       error:(NSError **)error
{
  XCUIScreen *screen = coordinateContext.screen;
  if (coordinateContext.usesWindowCoordinates
      && [XCSynthesizedEventRecord instancesRespondToSelector:@selector(initWithName:displayID:interfaceOrientation:)]) {
    return [[XCSynthesizedEventRecord alloc] initWithName:@"W3C Touch Action"
                                               displayID:(unsigned long long)screen.displayID
                                    interfaceOrientation:self.application.interfaceOrientation];
  }
  if (screen.displayID != XCUIScreen.mainScreen.displayID) {
    if (error) {
      *error = [[FBErrorBuilder.builder
                 withDescription:@"Actions on a display other than the main one are not supported by this XCTest version"] build];
    }
    return nil;
  }
  return [[XCSynthesizedEventRecord alloc] initWithName:@"W3C Touch Action"
                                interfaceOrientation:self.application.interfaceOrientation];
}

- (nullable XCSynthesizedEventRecord *)synthesizeWithError:(NSError **)error
{
  NSArray<NSDictionary<NSString *, id> *> *actions = [self validatedActionsWithError:error];
  if (nil == actions) {
    return nil;
  }
  // A fresh context owns routing and anchors for every pointer source in this command.
  FBGestureCoordinateContext *coordinateContext = [FBGestureCoordinateContext
    contextWithDisplayRequired:[self actionsRequireDisplay:actions] error:error];
  if (nil == coordinateContext) {
    return nil;
  }
  XCSynthesizedEventRecord *eventRecord = [self eventRecordForContext:coordinateContext error:error];
  if (nil == eventRecord) {
    return nil;
  }
  for (NSDictionary<NSString *, id> *actionDescription in actions) {
    NSString *actionId = actionDescription[FB_KEY_ID];
    NSArray<XCPointerEventPath *> *eventPaths = [self eventPathsWithActionDescription:actionDescription forActionId:actionId coordinateContext:coordinateContext error:error];
    if (nil == eventPaths) {
      return nil;
    }
    for (XCPointerEventPath *eventPath in eventPaths) {
      [eventRecord addPointerEventPath:eventPath];
    }
  }
  return eventRecord;
}

@end
#endif
