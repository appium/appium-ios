/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import <objc/runtime.h>

#import "FBConfiguration.h"
#import "FBW3CActionDoubles.h"
#import "FBScreen.h"
#import "FBW3CActionsSynthesizer.h"
#import "FBXCodeCompatibility.h"
#import "XCPointerEvent.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"
#import "XCUIElement.h"
#import "XCUIScreen.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH

static NSDictionary<NSString *, id> *FBTouchSequence(NSString *sequenceId, NSArray<NSDictionary<NSString *, id> *> *actions)
{
  return @{
    @"type": @"pointer",
    @"id": sequenceId,
    @"parameters": @{@"pointerType": @"touch"},
    @"actions": actions,
  };
}

static NSDictionary<NSString *, id> *FBKeySequence(NSArray<NSDictionary<NSString *, id> *> *actions)
{
  return @{@"type": @"key", @"id": @"keyboard", @"actions": actions};
}

static NSDictionary<NSString *, id> *FBMove(NSInteger x, NSInteger y)
{
  return @{@"type": @"pointerMove", @"duration": @0, @"x": @(x), @"y": @(y)};
}

@interface FBW3CActionsSynthesizerTests : XCTestCase
@property (nonatomic) FBW3CElementDouble *application;
@property (nonatomic, nullable) NSNumber *previousDisplayId;
@end

@implementation FBW3CActionsSynthesizerTests

- (void)setUp
{
  [super setUp];
  self.previousDisplayId = FBConfiguration.sharedInstance.currentDisplayId;
  FBConfiguration.sharedInstance.currentDisplayId = nil;
  self.application = [FBW3CElementDouble doubleWithType:XCUIElementTypeApplication
                                                  frame:CGRectMake(0, 0, 400, 800)];
}

- (void)tearDown
{
  FBConfiguration.sharedInstance.currentDisplayId = self.previousDisplayId;
  [super tearDown];
}

- (nullable XCSynthesizedEventRecord *)synthesizeActions:(NSArray *)actions error:(NSError **)error
{
  FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc] initWithActions:actions
                                                                           forApplication:(XCUIApplication *)self.application
                                                                             elementCache:nil
                                                                                    error:error];
  // Messaging a nil synthesizer keeps the initializer's error
  return [synthesizer synthesizeWithError:error];
}

- (void)stubClassMethod:(SEL)selector onClass:(Class)cls withBlock:(id)block
{
  Method method = class_getClassMethod(cls, selector);
  IMP original = method_getImplementation(method);
  IMP replacement = imp_implementationWithBlock(block);
  method_setImplementation(method, replacement);
  [self addTeardownBlock:^{
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }];
}

- (void)verifyRejectedGestures:(NSArray<NSDictionary<NSString *, id> *> *)cases
{
  for (NSDictionary<NSString *, id> *testCase in cases) {
    NSError *error = nil;
    XCSynthesizedEventRecord *record = [self synthesizeActions:testCase[@"gesture"] error:&error];
    XCTAssertNil(record, @"%@", testCase);
    XCTAssertNotNil(error, @"%@", testCase);
    XCTAssertTrue([error.localizedDescription containsString:testCase[@"error"]],
                  @"Expected '%@' in '%@' for %@", testCase[@"error"], error.localizedDescription, testCase);
  }
}

- (void)testErroneousPointerGesturesAreRejected
{
  NSArray<NSDictionary<NSString *, id> *> *down = @[@{@"type": @"pointerDown"},
                                                    @{@"type": @"pause", @"duration": @100},
                                                    @{@"type": @"pointerUp"}];
  NSDictionary *(^touchWith)(NSArray *) = ^NSDictionary *(NSArray *head) {
    return FBTouchSequence(@"finger1", [head arrayByAddingObjectsFromArray:down]);
  };
  [self verifyRejectedGestures:@[
    // Empty chain
    @{@"gesture": @[], @"error": @"Actions list cannot be empty"},
    // Chain element without 'actions' key
    @{@"gesture": @[@{@"type": @"pointer", @"id": @"finger1", @"parameters": @{@"pointerType": @"touch"}}],
      @"error": @"mandatory to have at least one item"},
    // Chain element without type
    @{@"gesture": @[@{@"id": @"finger1", @"parameters": @{@"pointerType": @"touch"}, @"actions": @[FBMove(100, 100)]}],
      @"error": @"Only actions of"},
    // Chain element without id
    @{@"gesture": @[@{@"type": @"pointer", @"parameters": @{@"pointerType": @"touch"}, @"actions": @[FBMove(100, 100)]}],
      @"error": @"field is missing or empty"},
    // Chain element with empty id
    @{@"gesture": @[@{@"type": @"pointer", @"id": @"", @"parameters": @{@"pointerType": @"touch"}, @"actions": @[FBMove(100, 100)]}],
      @"error": @"field is missing or empty"},
    // Chain element with unsupported type
    @{@"gesture": @[@{@"type": @"key", @"id": @"finger1", @"parameters": @{@"pointerType": @"touch"}, @"actions": @[FBMove(100, 100)]}],
      @"error": @"supported"},
    // Chain element with unsupported pointerType (default)
    @{@"gesture": @[@{@"type": @"pointer", @"id": @"finger1", @"actions": @[FBMove(100, 100)]}],
      @"error": @"Only pointer type 'touch' is supported"},
    // Chain element with unsupported pointerType (non-default)
    @{@"gesture": @[@{@"type": @"pointer", @"id": @"finger1", @"parameters": @{@"pointerType": @"pen"}, @"actions": @[FBMove(100, 100)]}],
      @"error": @"Only pointer type 'touch' is supported"},
    // Action item without type
    @{@"gesture": @[touchWith(@[@{@"duration": @0, @"x": @1, @"y": @1}])],
      @"error": @"property is mandatory to set"},
    // Single up action
    @{@"gesture": @[FBTouchSequence(@"finger1", @[@{@"type": @"pointerUp"}])],
      @"error": @"must be preceded by"},
    // Action item without y coordinate
    @{@"gesture": @[touchWith(@[@{@"type": @"pointerMove", @"duration": @0, @"x": @1}])],
      @"error": @"Both 'x' and 'y'"},
    // Action item with an unknown type
    @{@"gesture": @[touchWith(@[@{@"type": @"pointerMoved", @"duration": @0, @"x": @1, @"y": @1}])],
      @"error": @"is not supported"},
    // pointerMove without coordinates
    @{@"gesture": @[touchWith(@[@{@"type": @"pointerMove", @"duration": @0}])],
      @"error": @"Both 'x' and 'y'"},
    // pointerMove cannot use the coordinates of a previous item that does not exist
    @{@"gesture": @[touchWith(@[@{@"type": @"pointerMove", @"duration": @0, @"origin": @"pointer"}])],
      @"error": @"There is no previous item"},
    // Negative duration
    @{@"gesture": @[FBTouchSequence(@"finger1", @[FBMove(1, 1), @{@"type": @"pointerDown"},
                                                  @{@"type": @"pause", @"duration": @-100}, @{@"type": @"pointerUp"}])],
      @"error": @"Duration must be a valid positive number"},
    // A leading pause followed directly by pointerDown: no real pointerMove sets a position
    @{@"gesture": @[touchWith(@[@{@"type": @"pause", @"duration": @0}])],
      @"error": @"must be preceded by"},
    // A leading pause followed directly by a relative pointerMove: nothing to be relative to
    @{@"gesture": @[touchWith(@[@{@"type": @"pause", @"duration": @0},
                                @{@"type": @"pointerMove", @"duration": @0, @"origin": @"pointer"}])],
      @"error": @"There is no previous item"},
    // The canceled item is dropped, which leaves pointerDown without a preceding move
    @{@"gesture": @[FBTouchSequence(@"finger1", @[FBMove(1, 1), @{@"type": @"pointerCancel"}, @{@"type": @"pointerDown"},
                                                  @{@"type": @"pause", @"duration": @-100}, @{@"type": @"pointerUp"}])],
      @"error": @"must be preceded by"},
    // One of the chains has a duplicated id
    @{@"gesture": @[touchWith(@[FBMove(1, 1)]), touchWith(@[FBMove(1, 1)])],
      @"error": @"is not unique"},
  ]];
}

- (void)testErroneousKeyGesturesAreRejected
{
  if (![XCPointerEvent.class fb_areKeyEventsSupported]) {
    XCTSkip(@"Key events are not supported on this platform");
  }
  [self verifyRejectedGestures:@[
    // Missing balance 1
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"keyDown", @"value": @"h"}, @{@"type": @"keyUp", @"value": @"k"}])],
      @"error": @"must have a closing Key Up"},
    // Missing balance 2
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"keyDown", @"value": @"h"}])],
      @"error": @"must have a closing Key Up"},
    // Missing balance 3
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"keyUp", @"value": @"h"}])],
      @"error": @"is not balanced with a preceding Key Down"},
    // Missing key value
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"keyUp"}])],
      @"error": @"Key value must be present"},
    // Wrong key value
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"keyUp", @"value": @500}])],
      @"error": @"Key value must be present"},
    // Missing duration value
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"pause"}])],
      @"error": @"Duration must be present"},
    // Wrong action item type
    @{@"gesture": @[FBKeySequence(@[@{@"type": @"duration", @"duration": @"bla"}])],
      @"error": @"is not supported"},
  ]];
}

- (void)testActionsWithoutItemsDoNothingWithoutError
{
  // With and without explicit pointer parameters
  NSArray<NSDictionary<NSString *, id> *> *sequences = @[
    FBTouchSequence(@"finger1", @[]),
    @{@"type": @"pointer", @"id": @"touch", @"actions": @[]},
  ];
  for (NSDictionary<NSString *, id> *sequence in sequences) {
    NSError *error = nil;
    XCSynthesizedEventRecord *record = [self synthesizeActions:@[sequence] error:&error];
    XCTAssertNotNil(record, @"%@", error);
    XCTAssertEqual(record.eventPaths.count, (NSUInteger)0);
    XCTAssertNil(error);
  }
}

- (void)testUnavailableDisplaySettingIsRejected
{
  // A display id no device can have, independent of the simulator's real screens
  FBConfiguration.sharedInstance.currentDisplayId = @(LLONG_MAX);
  NSError *error = nil;
  XCTAssertNil([self synthesizeActions:@[FBTouchSequence(@"finger", @[FBMove(100, 100),
                                                                     @{@"type": @"pointerDown", @"button": @0},
                                                                     @{@"type": @"pointerUp", @"button": @0}])]
                                 error:&error]);
  XCTAssertNotNil(error);
}

- (void)testDisplayIndependentActionsAfterSelectedDisplayDisappears
{
  NSMutableArray<NSDictionary<NSString *, id> *> *sequences = [NSMutableArray arrayWithObject:
    FBTouchSequence(@"finger", @[@{@"type": @"pause", @"duration": @10}])];
  if ([XCPointerEvent.class fb_areKeyEventsSupported]) {
    [sequences addObject:@{@"id": @"keyboard", @"type": @"key",
                           @"actions": @[@{@"type": @"keyDown", @"value": @"a"}, @{@"type": @"keyUp", @"value": @"a"}]}];
  }
  for (NSDictionary<NSString *, id> *sequence in sequences) {
    for (NSNumber *display in @[@1, @987654]) {
      FBConfiguration.sharedInstance.currentDisplayId = display;
      NSError *error = nil;
      XCSynthesizedEventRecord *record = [self synthesizeActions:@[sequence] error:&error];
      XCTAssertNotNil(record, @"Display-independent %@ should succeed: %@", sequence[@"type"], error);
    }
  }
}

- (void)testLeadingZeroDurationPauseDoesNotAddExtraTouch
{
  // A leading pause must not defeat the down-after-move dedup in FBPointerDownItem,
  // which would synthesize a second touch-down for the same finger.
  NSDictionary<NSString *, id> *(^sequenceWithLeadingPause)(BOOL) = ^NSDictionary<NSString *, id> *(BOOL withLeadingPause) {
    NSMutableArray<NSDictionary<NSString *, id> *> *actions = [NSMutableArray array];
    if (withLeadingPause) {
      [actions addObject:@{@"type": @"pause", @"duration": @0}];
    }
    [actions addObjectsFromArray:@[
      FBMove(100, 200),
      @{@"type": @"pointerDown"},
      @{@"type": @"pause", @"duration": @100},
      @{@"type": @"pointerUp"},
    ]];
    return FBTouchSequence(@"finger1", actions.copy);
  };

  NSError *error = nil;
  XCSynthesizedEventRecord *baselineRecord = [self synthesizeActions:@[sequenceWithLeadingPause(NO)] error:&error];
  XCTAssertNotNil(baselineRecord, @"%@", error);
  XCSynthesizedEventRecord *pausedRecord = [self synthesizeActions:@[sequenceWithLeadingPause(YES)] error:&error];
  XCTAssertNotNil(pausedRecord, @"%@", error);

  XCTAssertEqual(baselineRecord.eventPaths.count, (NSUInteger)1);
  XCTAssertEqual(pausedRecord.eventPaths.count, baselineRecord.eventPaths.count);

  XCPointerEventPath *baselinePath = baselineRecord.eventPaths.firstObject;
  XCPointerEventPath *pausedPath = pausedRecord.eventPaths.firstObject;
  XCTAssertEqual(pausedPath.pointerEvents.count, baselinePath.pointerEvents.count);
  for (NSUInteger i = 0; i < baselinePath.pointerEvents.count; i++) {
    XCPointerEvent *baselineEvent = baselinePath.pointerEvents[i];
    XCPointerEvent *pausedEvent = pausedPath.pointerEvents[i];
    XCTAssertEqual(pausedEvent.eventType, baselineEvent.eventType);
    XCTAssertEqualWithAccuracy(pausedEvent.offset, baselineEvent.offset, 0.001);
    XCTAssertEqualWithAccuracy(pausedEvent.coordinate.x, baselineEvent.coordinate.x, 0.001);
    XCTAssertEqualWithAccuracy(pausedEvent.coordinate.y, baselineEvent.coordinate.y, 0.001);
  }
  XCTAssertTrue(CGPointEqualToPoint(((XCPointerEvent *)pausedPath.pointerEvents.firstObject).coordinate, CGPointMake(100, 200)));
}

- (void)testMixedOriginsRejectAnElementOnAnotherDisplay
{
  [self stubClassMethod:@selector(hasMultipleScreensWithError:)
                onClass:FBScreen.class
              withBlock:^NSNumber *(id receiver, NSError **error) { return @YES; }];
  FBW3CElementDouble *canvas = [FBW3CElementDouble doubleWithType:XCUIElementTypeOther
                                                            frame:CGRectMake(50, 100, 300, 300)];
  FBW3CScreenDouble *otherScreen = [FBW3CScreenDouble new];
  otherScreen.displayID = XCUIScreen.mainScreen.displayID + 1;
  canvas.stubScreen = otherScreen;
  NSDictionary<NSString *, id> *canvasMove = @{@"type": @"pointerMove", @"origin": canvas, @"x": @0, @"y": @0, @"duration": @0};
  NSError *error = nil;
  XCTAssertNil([self synthesizeActions:@[FBTouchSequence(@"finger", @[
    canvasMove,
    FBMove(100, 100),
    @{@"type": @"pointerMove", @"origin": @"pointer", @"x": @10, @"y": @10, @"duration": @0},
  ])] error:&error]);
  XCTAssertNotNil(error);
  XCTAssertTrue([error.localizedDescription containsString:@"element origin is not on the selected display"]);

  // The same element on the selected display resolves
  canvas.stubScreen = nil;
  error = nil;
  XCTAssertNotNil([self synthesizeActions:@[FBTouchSequence(@"finger", @[canvasMove])] error:&error], @"%@", error);
}

@end

#endif
