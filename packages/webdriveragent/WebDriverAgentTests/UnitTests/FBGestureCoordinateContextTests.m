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
#import "FBElementCommands.h"
#import "FBGestureCoordinateContext.h"
#import "FBW3CActionDoubles.h"
#import "FBScreen.h"
#import "FBW3CActionsSynthesizer.h"
#import "XCUIElement.h"
#import "XCUIScreen.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH

@interface FBElementCommands (GestureContextTestable)
+ (nullable NSArray<XCUICoordinate *> *)gestureCoordinatesWithOffsets:(NSArray<NSValue *> *)offsets
                                                              element:(XCUIElement *)element
                                                                error:(NSError **)error;
@end

@interface FBGestureCoordinateContext (GestureContextTestable)
+ (nullable id)windowAnchorWithApplication:(XCUIElement *)application screen:(XCUIScreen *)screen error:(NSError **)error;
@end

/** Stands in for the private window anchor: resolves offsets straight to screen points. */
@interface FBGestureContextAnchorDouble : NSObject
@property (nonatomic) CGRect frame;
- (XCUICoordinate *)coordinateWithOffset:(CGVector)offset;
@end

@implementation FBGestureContextAnchorDouble

- (XCUICoordinate *)coordinateWithOffset:(CGVector)offset
{
  return [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(offset.dx, offset.dy)];
}

@end

@interface FBGestureCoordinateContextTests : XCTestCase
@property (nonatomic, nullable) NSNumber *previousDisplayId;
@property (nonatomic) FBW3CElementDouble *application;
@end

@implementation FBGestureCoordinateContextTests

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

- (NSDictionary<NSString *, id> *)moveFrom:(id)origin x:(NSInteger)x y:(NSInteger)y duration:(NSUInteger)duration
{
  return @{@"type": @"pointerMove", @"origin": origin, @"x": @(x), @"y": @(y), @"duration": @(duration)};
}

- (FBW3CActionsSynthesizer *)synthesizerWithSequences:(NSArray<NSDictionary<NSString *, id> *> *)moveSequences
{
  NSMutableArray<NSDictionary<NSString *, id> *> *actions = [NSMutableArray array];
  for (NSUInteger index = 0; index < moveSequences.count; index++) {
    [actions addObject:@{
      @"type": @"pointer", @"id": [NSString stringWithFormat:@"finger%lu", (unsigned long)index],
      @"parameters": @{@"pointerType": @"touch"}, @"actions": moveSequences[index],
    }];
  }
  NSError *error = nil;
  FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc] initWithActions:actions
                                                                           forApplication:(XCUIApplication *)self.application
                                                                             elementCache:nil
                                                                                    error:&error];
  XCTAssertNotNil(synthesizer, @"%@", error);
  return synthesizer;
}

- (void)verifyResolutionCountsWithMultipleDisplays:(BOOL)multipleDisplays
{
  __block NSUInteger enumerations = 0;
  __block NSUInteger anchors = 0;
  [self stubClassMethod:@selector(hasMultipleScreensWithError:)
                onClass:FBScreen.class
              withBlock:^NSNumber *(id receiver, NSError **error) {
    enumerations++;
    return @(multipleDisplays);
  }];
  [self stubClassMethod:@selector(windowAnchorWithApplication:screen:error:)
                onClass:FBGestureCoordinateContext.class
              withBlock:^id(id receiver, XCUIElement *application, XCUIScreen *screen, NSError **error) {
    anchors++;
    return [FBGestureContextAnchorDouble new];
  }];
  FBW3CElementDouble *canvas = [FBW3CElementDouble doubleWithType:XCUIElementTypeOther
                                                            frame:CGRectMake(50, 100, 300, 300)];

  // Exercise the sharing between independent pointer sources
  NSArray<NSDictionary<NSString *, id> *> *finger = @[
    [self moveFrom:@"viewport" x:100 y:100 duration:0],
    [self moveFrom:self.application x:0 y:0 duration:100],
    [self moveFrom:canvas x:0 y:0 duration:100],
    [self moveFrom:@"pointer" x:10 y:10 duration:100],
    [self moveFrom:@"viewport" x:120 y:120 duration:100],
  ];
  FBW3CActionsSynthesizer *synthesizer = [self synthesizerWithSequences:@[finger, finger]];
  // Even the same synthesizer must resolve a fresh anchor for each command
  for (NSUInteger invocation = 1; invocation <= 2; invocation++) {
    NSError *error = nil;
    XCTAssertNotNil([synthesizer synthesizeWithError:&error], @"%@", error);
    XCTAssertNil(error);
    XCTAssertEqual(enumerations, invocation);
    XCTAssertEqual(anchors, multipleDisplays ? invocation : 0);
  }

  NSArray<NSValue *> *offsets = @[
    [NSValue valueWithCGVector:CGVectorMake(100, 100)],
    [NSValue valueWithCGVector:CGVectorMake(120, 120)],
  ];
  // A native drag shares one resolution between its endpoints
  for (NSUInteger invocation = 3; invocation <= 4; invocation++) {
    NSError *error = nil;
    NSArray<XCUICoordinate *> *coordinates = [FBElementCommands gestureCoordinatesWithOffsets:offsets
                                                                                      element:self.application
                                                                                        error:&error];
    XCTAssertEqual(coordinates.count, (NSUInteger)2);
    XCTAssertNil(error);
    XCTAssertEqual(enumerations, invocation);
    XCTAssertEqual(anchors, multipleDisplays ? invocation : 0);
  }
  NSError *error = nil;
  XCTAssertEqual([FBElementCommands gestureCoordinatesWithOffsets:offsets element:canvas error:&error].count, (NSUInteger)2);
  XCTAssertNil(error);
  // Ordinary element gestures do not enumerate displays
  XCTAssertEqual(enumerations, (NSUInteger)4);
  XCTAssertEqual(anchors, multipleDisplays ? 4 : 0);
}

- (void)testDisplayAndWindowResolutionRunsOncePerCommandOnMultipleDisplays
{
  [self verifyResolutionCountsWithMultipleDisplays:YES];
}

- (void)testDisplayResolutionRunsOncePerCommandOnSingleDisplay
{
  [self verifyResolutionCountsWithMultipleDisplays:NO];
}

- (void)testWindowAnchorCacheDoesNotHideAnotherApplicationsFailure
{
  FBW3CElementDouble *otherApplication = [FBW3CElementDouble doubleWithType:XCUIElementTypeApplication
                                                                      frame:CGRectMake(0, 0, 300, 600)];
  NSError *expectedError = [NSError errorWithDomain:@"WindowAnchorLookup" code:1 userInfo:nil];
  __block NSUInteger sessionAppCalls = 0;
  __block NSUInteger otherAppCalls = 0;
  [self stubClassMethod:@selector(hasMultipleScreensWithError:)
                onClass:FBScreen.class
              withBlock:^NSNumber *(id receiver, NSError **error) { return @YES; }];
  [self stubClassMethod:@selector(windowAnchorWithApplication:screen:error:)
                onClass:FBGestureCoordinateContext.class
              withBlock:^id(id receiver, XCUIElement *application, XCUIScreen *screen, NSError **error) {
    if (application == (XCUIElement *)otherApplication) {
      otherAppCalls++;
      if (NULL != error) {
        *error = expectedError;
      }
      return nil;
    }
    sessionAppCalls++;
    return [FBGestureContextAnchorDouble new];
  }];
  FBW3CActionsSynthesizer *synthesizer = [self synthesizerWithSequences:@[@[
    [self moveFrom:@"viewport" x:100 y:100 duration:0],
    [self moveFrom:self.application x:0 y:0 duration:100],
    [self moveFrom:otherApplication x:0 y:0 duration:100],
  ]]];
  NSError *error = nil;
  XCTAssertNil([synthesizer synthesizeWithError:&error]);
  XCTAssertEqualObjects(error, expectedError);
  XCTAssertEqual(sessionAppCalls, (NSUInteger)1);
  XCTAssertEqual(otherAppCalls, (NSUInteger)1);
}

- (void)testDisplayEnumerationFailureStopsGestureResolution
{
  NSError *expectedError = [NSError errorWithDomain:@"DisplayEnumeration" code:1 userInfo:nil];
  [self stubClassMethod:@selector(hasMultipleScreensWithError:)
                onClass:FBScreen.class
              withBlock:^NSNumber *(id receiver, NSError **error) {
    if (NULL != error) {
      *error = expectedError;
    }
    return nil;
  }];
  NSError *error = nil;
  NSArray<NSValue *> *offsets = @[[NSValue valueWithCGVector:CGVectorMake(100, 100)],
                                  [NSValue valueWithCGVector:CGVectorMake(120, 120)]];
  XCTAssertNil([FBElementCommands gestureCoordinatesWithOffsets:offsets element:self.application error:&error]);
  XCTAssertEqualObjects(error, expectedError);

  error = nil;
  FBW3CActionsSynthesizer *synthesizer = [self synthesizerWithSequences:@[@[[self moveFrom:@"viewport" x:100 y:100 duration:0]]]];
  XCTAssertNil([synthesizer synthesizeWithError:&error]);
  XCTAssertEqualObjects(error, expectedError);
}

@end

#endif
