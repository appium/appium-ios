/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import <objc/runtime.h>

#import "FBIntegrationTestCase.h"
#import "FBConfiguration.h"
#import "FBScreen.h"
#import "FBGestureCoordinateContext.h"
#import "FBRunLoopSpinner.h"
#import "FBExceptions.h"
#import "FBElementCommands.h"
#import "FBElementCache.h"
#import "FBBaseActionsSynthesizer.h"
#import "FBW3CActionsSynthesizer.h"
#import "FBMathUtils.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@interface FBElementCommands (CoordinateTests)
+ (nullable XCUICoordinate *)gestureCoordinateWithOffset:(CGVector)offset element:(XCUIElement *)element error:(NSError **)error;
+ (nullable NSArray<XCUICoordinate *> *)gestureCoordinatesWithOffsets:(NSArray<NSValue *> *)offsets element:(XCUIElement *)element error:(NSError **)error;
@end

@interface FBGestureCoordinateContext (CoordinateTests)
+ (nullable id)windowAnchorWithApplication:(XCUIElement *)application screen:(XCUIScreen *)screen error:(NSError **)error;
@end

#import "XCUIApplication+FBTouchAction.h"
#import "XCUIElement+FBScrolling.h"
#import "XCUIDevice+FBRotation.h"
#import "XCUIDevice+FBHinge.h"

// The private gesture item is exercised directly to isolate origin resolution.
@interface FBW3CGestureItem : FBBaseGestureItem
@property (nonatomic) FBGestureCoordinateContext *coordinateContext;
@end

@interface FBDisplayGestureTests : FBIntegrationTestCase
@property (nonatomic) NSNumber *previousDisplayId;
@property (nonatomic) XCUIElement *canvas;
@property (nonatomic) FBElementCache *actionElementCache;
@end

@implementation FBDisplayGestureTests

// Landscape-native iPad panels
+ (NSArray<NSString *> *)iPadTests
{
  return @[@"testNativeCoordinatesInLandscapeLeft", @"testNativeCoordinatesInLandscapeRight", @"testW3CApplicationOriginAcrossOrientations"];
}

// Skipped before the (slow) app launch
- (void)skipIfUnsupported
{
  NSString *name = NSStringFromSelector(self.invocation.selector);
  if ([name containsString:@"FoldStates"]) {
    XCTSkipIf(!XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection, @"Requires a foldable simulator");
  }
  NSArray<NSString *> *multiDisplayTests = @[
    @"testNativeCoordinatesRejectMismatchedWindowDisplay",
    @"testApplicationOriginUsesItsOwnAppInsteadOfTheSessionApp",
    @"testWindowAnchorCacheDoesNotHideAnotherApplicationsFailure",
    @"testMixedOriginsRejectAnElementOnAnotherDisplay",
  ];
  if ([multiDisplayTests containsObject:name]) {
    XCTSkipIf(![FBScreen hasMultipleScreensWithError:nil].boolValue, @"Requires multiple displays");
  }
}

- (void)setUp
{
  [super setUp];
  self.previousDisplayId = FBConfiguration.sharedInstance.currentDisplayId;
  self.actionElementCache = nil;
  if (!XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection) {
    [self resetOrientation];
  }
  [self launchApplication];
  [self.testedApplication.buttons[@"coordinate-probe"] tap];
  self.canvas = self.testedApplication.otherElements[@"coordinate-canvas"];

  [self selectFixtureDisplay];
}

- (void)selectFixtureDisplay
{
  // The fixture reports the screen it actually occupies. Do not assume the main
  // screen is active: Duo changes displays when its hinge changes position.
  NSArray<NSNumber *> *size = [self measurement][@"screenSize"];
  NSNumber *displayId = nil;
  for (NSDictionary *screen in [FBScreen screensWithError:nil]) {
    CGFloat width = [screen[@"bounds"][@"width"] doubleValue] / [screen[@"scale"] doubleValue];
    CGFloat height = [screen[@"bounds"][@"height"] doubleValue] / [screen[@"scale"] doubleValue];
    if (fabs(MAX(width, height) - MAX(size[0].doubleValue, size[1].doubleValue)) < 1
        && fabs(MIN(width, height) - MIN(size[0].doubleValue, size[1].doubleValue)) < 1) {
      displayId = screen[@"displayId"];
      break;
    }
  }
  XCTAssertNotNil(displayId, @"Cannot identify the fixture's display");
  FBConfiguration.sharedInstance.currentDisplayId = displayId;
}

- (void)tearDown
{
  FBConfiguration.sharedInstance.currentDisplayId = self.previousDisplayId;
  [super tearDown];
}

- (NSDictionary *)measurement
{
  NSString *value = self.testedApplication.staticTexts[@"probe-status"].label;
  NSError *error = nil;
  NSDictionary *result = [NSJSONSerialization JSONObjectWithData:[value dataUsingEncoding:NSUTF8StringEncoding]
                                                       options:0 error:&error];
  XCTAssertNil(error);
  return result;
}

- (void)performMoves:(NSArray<NSDictionary *> *)moves expectedEnd:(CGPoint)expected
{
  NSUInteger count = [[self measurement][@"count"] unsignedIntegerValue];
  NSMutableArray *items = [NSMutableArray arrayWithArray:@[
    moves.firstObject,
    @{@"type": @"pointerDown", @"button": @0},
    @{@"type": @"pause", @"duration": @100},
  ]];
  if (moves.count > 1) {
    [items addObjectsFromArray:[moves subarrayWithRange:NSMakeRange(1, moves.count - 1)]];
  }
  [items addObject:@{@"type": @"pointerUp", @"button": @0}];
  NSError *error = nil;
  NSArray *actions = @[@{
    @"type": @"pointer", @"id": @"finger", @"parameters": @{@"pointerType": @"touch"}, @"actions": items,
  }];
  XCTAssertTrue([self.testedApplication fb_performW3CActions:actions elementCache:self.actionElementCache error:&error], @"%@", error);
  NSDictionary *result = [self measurement];
  NSLog(@"W3C_DELIVERED expected=%@ actual=%@ count=%@ phase=%@", NSStringFromCGPoint(expected), result[@"last"], result[@"count"], result[@"phase"]);
  XCTAssertEqual([result[@"count"] unsignedIntegerValue], count + 1);
  XCTAssertEqualObjects(result[@"phase"], @"ended");
  NSArray<NSNumber *> *actual = result[@"last"];
  XCTAssertEqualWithAccuracy(actual[0].doubleValue, expected.x, 1);
  XCTAssertEqualWithAccuracy(actual[1].doubleValue, expected.y, 1);
}

- (NSDictionary *)moveFrom:(id)origin x:(CGFloat)x y:(CGFloat)y duration:(NSUInteger)duration
{
  if (nil != self.actionElementCache && [origin isKindOfClass:XCUIElement.class]) {
    NSString *uuid = [self.actionElementCache storeElement:origin];
    XCTAssertNotNil(uuid);
    origin = @{@"element-6066-11e4-a52e-4f735466cecf": uuid};
  }
  return @{@"type": @"pointerMove", @"origin": origin, @"x": @(x), @"y": @(y), @"duration": @(duration)};
}

- (void)verifyNativeApplicationCoordinates
{
  NSDictionary *geometry = [self measurement];
  NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
  NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
  for (NSNumber *x in @[@40, @(bounds[0].doubleValue - 40)]) {
    for (NSNumber *y in @[@40, @(bounds[1].doubleValue - 40)]) {
      NSUInteger count = [[self measurement][@"count"] unsignedIntegerValue];
      NSError *error = nil;
      XCUICoordinate *coordinate = [FBElementCommands gestureCoordinateWithOffset:
        CGVectorMake(frame[0].doubleValue + x.doubleValue, frame[1].doubleValue + y.doubleValue)
        element:self.testedApplication error:&error];
      XCTAssertNotNil(coordinate);
      XCTAssertNil(error);
      [coordinate tap];
      NSDictionary *result = [self measurement];
      XCTAssertEqual([result[@"count"] unsignedIntegerValue], count + 1);
      XCTAssertEqualWithAccuracy([result[@"last"][0] doubleValue], x.doubleValue, 1);
      XCTAssertEqualWithAccuracy([result[@"last"][1] doubleValue], y.doubleValue, 1);
    }
  }
}

- (void)verifyNativeEdgeCoordinates
{
  NSArray<NSNumber *> *size = [self measurement][@"windowSize"];
  CGFloat width = size[0].doubleValue;
  CGFloat height = size[1].doubleValue;
  NSError *error = nil;
  XCUICoordinate *center = [FBElementCommands gestureCoordinateWithOffset:CGVectorMake(width / 2, height / 2)
                                                               element:self.testedApplication error:&error];
  XCTAssertNotNil(center);
  XCTAssertNil(error);
  for (NSValue *value in @[
    [NSValue valueWithCGPoint:CGPointMake(width, height / 2)],
    [NSValue valueWithCGPoint:CGPointMake(width / 2, height)],
    [NSValue valueWithCGPoint:CGPointMake(width + 30, height / 2)],
    [NSValue valueWithCGPoint:CGPointMake(width / 2, height + 30)],
    [NSValue valueWithCGPoint:CGPointMake(-30, height / 2)],
    [NSValue valueWithCGPoint:CGPointMake(width / 2, -30)],
  ]) {
    CGPoint point = value.CGPointValue;
    error = nil;
    XCUICoordinate *coordinate = [FBElementCommands gestureCoordinateWithOffset:CGVectorMake(point.x, point.y)
                                                                     element:self.testedApplication error:&error];
    XCTAssertNotNil(coordinate, @"%@", error);
    XCTAssertNil(error);
    if (nil == coordinate) {
      continue;
    }
    // Check extrapolation, not just acceptance: boundary points must not clamp.
    CGPoint expected = [center coordinateWithOffset:CGVectorMake(point.x - width / 2, point.y - height / 2)].screenPoint;
    XCTAssertEqualWithAccuracy(coordinate.screenPoint.x, expected.x, 1);
    XCTAssertEqualWithAccuracy(coordinate.screenPoint.y, expected.y, 1);
  }
}

- (void)testNativeEdgeCoordinates
{
  [self verifyNativeEdgeCoordinates];
}

- (void)testNativeApplicationCoordinates
{
  [self verifyNativeApplicationCoordinates];
  [self verifyNativeEdgeCoordinates];
}

- (void)testNativeMainDisplayDefaultCoordinates
{
  XCTSkipIf(FBConfiguration.sharedInstance.currentDisplayId.longLongValue != [FBScreen displayID],
            @"Requires the fixture on the main display");
  FBConfiguration.sharedInstance.currentDisplayId = nil;
  [self verifyNativeApplicationCoordinates];
  FBConfiguration.sharedInstance.currentDisplayId = @([FBScreen displayID]);
  [self verifyNativeApplicationCoordinates];
  [self verifyNativeEdgeCoordinates];
}

- (void)verifyNativeCoordinatesInOrientation:(UIDeviceOrientation)orientation
{
  XCTSkipIf(XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection,
            @"Foldable orientations are covered by testNativeCoordinatesAcrossFoldStates");
  UIDeviceOrientation previousOrientation = XCUIDevice.sharedDevice.orientation;
  [self addTeardownBlock:^{
    [XCUIDevice.sharedDevice fb_setDeviceInterfaceOrientation:previousOrientation];
  }];
  XCTAssertTrue([XCUIDevice.sharedDevice fb_setDeviceInterfaceOrientation:orientation]);
  XCTAssertTrue([[[FBRunLoopSpinner new] timeout:5] spinUntilTrue:^BOOL {
    NSDictionary *geometry = [self measurement];
    NSArray<NSNumber *> *size = geometry[@"windowSize"];
    return size[0].doubleValue > size[1].doubleValue
      && ![geometry[@"rotationInProgress"] boolValue];
  }]);
  [self verifyNativeApplicationCoordinates];
  [self verifyNativeEdgeCoordinates];
}

- (void)testNativeCoordinatesInLandscapeLeft
{
  [self verifyNativeCoordinatesInOrientation:UIDeviceOrientationLandscapeLeft];
}

- (void)testNativeCoordinatesInLandscapeRight
{
  [self verifyNativeCoordinatesInOrientation:UIDeviceOrientationLandscapeRight];
}

- (void)testNativeCoordinatesRejectMismatchedWindowDisplay
{
  NSNumber *fixtureDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  NSArray<NSNumber *> *frame = [self measurement][@"canvasWindowRect"];
  BOOL checkedSecondaryDisplay = NO;
  for (NSDictionary *screen in [FBScreen screensWithError:nil]) {
    if ([screen[@"displayId"] isEqual:fixtureDisplay]) {
      continue;
    }
    checkedSecondaryDisplay = YES;
    FBConfiguration.sharedInstance.currentDisplayId = screen[@"displayId"];
    NSError *error = nil;
    XCUICoordinate *coordinate = [FBElementCommands gestureCoordinateWithOffset:
      CGVectorMake(frame[0].doubleValue + frame[2].doubleValue / 2,
                   frame[1].doubleValue + frame[3].doubleValue / 2)
      element:self.testedApplication error:&error];
    XCTAssertNil(coordinate, @"A window on display %@ must not satisfy a request for display %@",
                 fixtureDisplay, screen[@"displayId"]);
    XCTAssertNotNil(error);
  }
  XCTSkipIf(!checkedSecondaryDisplay, @"Requires an available secondary display without the fixture");
}

- (void)testApplicationOriginUsesItsOwnAppInsteadOfTheSessionApp
{
  XCTSkipIf(![FBScreen hasMultipleScreensWithError:nil].boolValue, @"Requires multiple displays");
  FBW3CGestureItem *item = [NSClassFromString(@"FBW3CGestureItem") new];
  // Accessing this app's windows would fail. Only the supplied origin should be used.
  item.application = [[XCUIApplication alloc] initWithBundleIdentifier:@"com.appium.nonexistent-session-app"];
  NSError *error = nil;
  item.coordinateContext = [FBGestureCoordinateContext contextWithDisplayRequired:YES error:&error];
  XCTAssertNotNil(item.coordinateContext);
  XCUICoordinate *coordinate = [item hitpointWithElement:self.testedApplication
                                       positionOffset:[NSValue valueWithCGPoint:CGPointZero] error:&error];
  XCTAssertNotNil(coordinate);
  XCTAssertNil(error);
  CGRect frame = self.testedApplication.wdFrame;
  XCUICoordinate *expected = [item.coordinateContext coordinateWithApplication:self.testedApplication
    offset:CGVectorMake(CGRectGetMidX(frame), CGRectGetMidY(frame)) error:&error];
  XCTAssertNotNil(expected);
  XCTAssertEqualWithAccuracy(coordinate.screenPoint.x, expected.screenPoint.x, 1);
  XCTAssertEqualWithAccuracy(coordinate.screenPoint.y, expected.screenPoint.y, 1);
}

- (void)testSingleDisplayW3COriginsRetainLegacyCoordinates
{
  XCTSkipIf([FBScreen hasMultipleScreensWithError:nil].boolValue, @"Requires a single display");
  FBW3CGestureItem *item = [NSClassFromString(@"FBW3CGestureItem") new];
  item.application = self.testedApplication;
  item.coordinateContext = [FBGestureCoordinateContext contextWithDisplayRequired:YES error:nil];
  XCTAssertNotNil(item.coordinateContext);
  FBBaseGestureItem *legacy = [FBBaseGestureItem new];
  legacy.application = self.testedApplication;
  for (NSNumber *orientation in @[@(UIDeviceOrientationPortrait), @(UIDeviceOrientationLandscapeLeft), @(UIDeviceOrientationLandscapeRight)]) {
    [XCUIDevice.sharedDevice fb_setDeviceInterfaceOrientation:orientation.integerValue];
    NSError *error = nil;
    NSValue *offset = [NSValue valueWithCGPoint:CGPointMake(30, 40)];
    XCUICoordinate *viewport = [item hitpointWithElement:nil positionOffset:offset error:&error];
    XCUICoordinate *expectedViewport = [legacy hitpointWithElement:nil positionOffset:offset error:&error];
    XCTAssertNotNil(viewport);
    XCTAssertTrue(CGPointEqualToPoint(viewport.screenPoint, expectedViewport.screenPoint));
    XCUICoordinate *app = [item hitpointWithElement:self.testedApplication positionOffset:nil error:&error];
    XCUICoordinate *expectedApp = [legacy hitpointWithElement:self.testedApplication positionOffset:nil error:&error];
    XCTAssertNotNil(app);
    XCTAssertTrue(CGPointEqualToPoint(app.screenPoint, expectedApp.screenPoint));
    XCUICoordinate *appOffset = [item hitpointWithElement:self.testedApplication positionOffset:offset error:&error];
    XCUICoordinate *expectedAppOffset = FBCoordinateWithAnchorOffset(self.testedApplication,
      CGVectorMake(0.5, 0.5), CGVectorMake(30, 40), &error);
    XCTAssertNotNil(appOffset);
    XCTAssertTrue(CGPointEqualToPoint(appOffset.screenPoint, expectedAppOffset.screenPoint));
    XCTAssertNil(error);
  }
}

- (void)testDisplayAndWindowResolutionRunsOncePerCommand
{
  BOOL hasMultipleScreens = [FBScreen hasMultipleScreensWithError:nil].boolValue;
  SEL selector = @selector(hasMultipleScreensWithError:);
  Method method = class_getClassMethod(FBScreen.class, selector);
  IMP original = method_getImplementation(method);
  __block NSUInteger calls = 0;
  IMP counting = imp_implementationWithBlock(^NSNumber *(id receiver, NSError **error) {
    calls++;
    return ((NSNumber *(*)(id, SEL, NSError **))original)(receiver, selector, error);
  });
  SEL anchorSelector = @selector(windowAnchorWithApplication:screen:error:);
  Method anchorMethod = class_getClassMethod(FBGestureCoordinateContext.class, anchorSelector);
  IMP originalAnchor = method_getImplementation(anchorMethod);
  __block NSUInteger anchorCalls = 0;
  IMP countingAnchors = imp_implementationWithBlock(^id(id receiver, XCUIElement *application, XCUIScreen *screen, NSError **error) {
    anchorCalls++;
    return ((id (*)(id, SEL, XCUIElement *, XCUIScreen *, NSError **))originalAnchor)(receiver, anchorSelector, application, screen, error);
  });
  method_setImplementation(method, counting);
  method_setImplementation(anchorMethod, countingAnchors);
  @try {
    // Exercise serialized origins and sharing between independent pointer sources.
    self.actionElementCache = [FBElementCache new];
    NSDictionary *finger = @{
      @"type": @"pointer", @"id": @"finger", @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
        [self moveFrom:@"viewport" x:100 y:100 duration:0],
        [self moveFrom:self.testedApplication x:0 y:0 duration:100],
        [self moveFrom:self.canvas x:0 y:0 duration:100],
        [self moveFrom:@"pointer" x:10 y:10 duration:100],
        [self moveFrom:@"viewport" x:120 y:120 duration:100],
      ],
    };
    NSMutableDictionary *secondFinger = finger.mutableCopy;
    secondFinger[@"id"] = @"secondFinger";
    NSError *error = nil;
    FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc]
      initWithActions:@[finger, secondFinger] forApplication:self.testedApplication elementCache:self.actionElementCache error:&error];
    // Even the same synthesizer must resolve a fresh anchor for each command.
    for (NSUInteger invocation = 1; invocation <= 2; invocation++) {
      XCTAssertNotNil([synthesizer synthesizeWithError:&error]);
      XCTAssertNil(error);
      XCTAssertEqual(calls, invocation);
      XCTAssertEqual(anchorCalls, hasMultipleScreens ? invocation : 0);
    }
    NSArray<NSValue *> *offsets = @[
      [NSValue valueWithCGVector:CGVectorMake(100, 100)],
      [NSValue valueWithCGVector:CGVectorMake(120, 120)],
    ];
    // A native drag shares one resolution between its endpoints, on iPhone too.
    for (NSUInteger invocation = 3; invocation <= 4; invocation++) {
      NSArray<XCUICoordinate *> *coordinates = [FBElementCommands gestureCoordinatesWithOffsets:offsets
        element:self.testedApplication error:&error];
      XCTAssertEqual(coordinates.count, 2);
      XCTAssertNil(error);
      XCTAssertEqual(calls, invocation);
      XCTAssertEqual(anchorCalls, hasMultipleScreens ? invocation : 0);
    }
    XCTAssertEqual([FBElementCommands gestureCoordinatesWithOffsets:offsets element:self.canvas error:&error].count, 2);
    XCTAssertNil(error);
    XCTAssertEqual(calls, 4); // Ordinary element gestures do not enumerate displays.
    XCTAssertEqual(anchorCalls, hasMultipleScreens ? 4 : 0);
  } @finally {
    method_setImplementation(method, original);
    method_setImplementation(anchorMethod, originalAnchor);
    imp_removeBlock(counting);
    imp_removeBlock(countingAnchors);
  }
}

- (void)testWindowAnchorCacheDoesNotHideAnotherApplicationsFailure
{
  XCTSkipIf(![FBScreen hasMultipleScreensWithError:nil].boolValue, @"Requires multiple displays");
  XCUIApplication *otherApplication = self.springboard;
  NSError *expectedError = [NSError errorWithDomain:@"WindowAnchorLookup" code:1 userInfo:nil];
  SEL selector = @selector(windowAnchorWithApplication:screen:error:);
  Method method = class_getClassMethod(FBGestureCoordinateContext.class, selector);
  IMP original = method_getImplementation(method);
  __block NSUInteger sessionAppCalls = 0;
  __block NSUInteger otherAppCalls = 0;
  IMP replacement = imp_implementationWithBlock(^id(id receiver, XCUIElement *application, XCUIScreen *screen, NSError **error) {
    if (application == otherApplication) {
      otherAppCalls++;
      if (NULL != error) {
        *error = expectedError;
      }
      return nil;
    }
    sessionAppCalls++;
    return ((id (*)(id, SEL, XCUIElement *, XCUIScreen *, NSError **))original)(receiver, selector, application, screen, error);
  });
  method_setImplementation(method, replacement);
  @try {
    NSArray *actions = @[@{
      @"type": @"pointer", @"id": @"finger", @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
        [self moveFrom:@"viewport" x:100 y:100 duration:0],
        [self moveFrom:self.testedApplication x:0 y:0 duration:100],
        [self moveFrom:otherApplication x:0 y:0 duration:100],
      ],
    }];
    NSError *error = nil;
    FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc]
      initWithActions:actions forApplication:self.testedApplication elementCache:nil error:&error];
    XCTAssertNil([synthesizer synthesizeWithError:&error]);
    XCTAssertEqualObjects(error, expectedError);
    XCTAssertEqual(sessionAppCalls, 1);
    XCTAssertEqual(otherAppCalls, 1);
  } @finally {
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }
}

- (void)testMixedOriginsRejectAnElementOnAnotherDisplay
{
  NSNumber *fixtureDisplay = FBConfiguration.sharedInstance.currentDisplayId;
  BOOL checkedOtherDisplay = NO;
  for (NSDictionary *screen in [FBScreen screensWithError:nil]) {
    if ([screen[@"displayId"] isEqual:fixtureDisplay]) {
      continue;
    }
    checkedOtherDisplay = YES;
    FBConfiguration.sharedInstance.currentDisplayId = screen[@"displayId"];
    NSArray *actions = @[@{
      @"type": @"pointer", @"id": @"finger", @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
        [self moveFrom:self.canvas x:0 y:0 duration:0],
        [self moveFrom:@"viewport" x:100 y:100 duration:0],
        [self moveFrom:@"pointer" x:10 y:10 duration:0],
      ],
    }];
    NSError *error = nil;
    FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc]
      initWithActions:actions forApplication:self.testedApplication elementCache:nil error:&error];
    XCTAssertNil([synthesizer synthesizeWithError:&error]);
    XCTAssertNotNil(error);
    XCTAssertTrue([error.localizedDescription containsString:@"element origin is not on the selected display"]);
  }
  XCTSkipIf(!checkedOtherDisplay, @"Requires another display without the fixture");
}

- (void)testDisplayEnumerationFailureStopsGestureResolution
{
  NSError *expectedError = [NSError errorWithDomain:@"DisplayEnumeration" code:1 userInfo:nil];
  SEL selector = @selector(hasMultipleScreensWithError:);
  Method method = class_getClassMethod(FBScreen.class, selector);
  IMP original = method_getImplementation(method);
  IMP replacement = imp_implementationWithBlock(^NSNumber *(id receiver, NSError **error) {
    if (NULL != error) {
      *error = expectedError;
    }
    return nil;
  });
  method_setImplementation(method, replacement);
  @try {
    NSError *error = nil;
    NSArray *offsets = @[[NSValue valueWithCGVector:CGVectorMake(100, 100)],
                        [NSValue valueWithCGVector:CGVectorMake(120, 120)]];
    XCTAssertNil([FBElementCommands gestureCoordinatesWithOffsets:offsets element:self.testedApplication error:&error]);
    XCTAssertEqualObjects(error, expectedError);
    error = nil;
    NSArray *actions = @[@{
      @"type": @"pointer", @"id": @"finger", @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[[self moveFrom:@"viewport" x:100 y:100 duration:0]],
    }];
    FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc]
      initWithActions:actions forApplication:self.testedApplication elementCache:nil error:&error];
    XCTAssertNil([synthesizer synthesizeWithError:&error]);
    XCTAssertEqualObjects(error, expectedError);
  } @finally {
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }
}

- (void)verifyNativeDragCoordinates
{
  NSDictionary *geometry = [self measurement];
  NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
  NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
  CGPoint end = CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2 - 40);
  CGVector endOffset = CGVectorMake(frame[0].doubleValue + end.x, frame[1].doubleValue + end.y);
  CGVector startOffset = CGVectorMake(endOffset.dx, endOffset.dy + 40);
  NSError *error = nil;
  NSArray<XCUICoordinate *> *coordinates = [FBElementCommands gestureCoordinatesWithOffsets:
    @[[NSValue valueWithCGVector:startOffset], [NSValue valueWithCGVector:endOffset]]
    element:self.testedApplication error:&error];
  XCTAssertEqual(coordinates.count, 2);
  XCTAssertNil(error);
  [coordinates[0] pressForDuration:0.1 thenDragToCoordinate:coordinates[1]];
  NSDictionary *result = [self measurement];
  XCTAssertEqual([result[@"count"] unsignedIntegerValue], [geometry[@"count"] unsignedIntegerValue] + 1);
  XCTAssertEqualObjects(result[@"phase"], @"ended");
  XCTAssertEqualWithAccuracy([result[@"last"][0] doubleValue], end.x, 1);
  XCTAssertEqualWithAccuracy([result[@"last"][1] doubleValue], end.y, 1);
}

- (void)testNativeDragCoordinates
{
  [self verifyNativeDragCoordinates];
}

- (void)testNativeCoordinatesAcrossFoldStates
{
  XCUIDevice *device = XCUIDevice.sharedDevice;
  XCTSkipIf(!device.fb_canAttemptSimulatedHingeAngleInjection, @"Requires a foldable simulator");
  NSError *error = nil;
  NSNumber *originalAngle = [device fb_getSimulatedHingeAngle:&error];
  XCTAssertNotNil(originalAngle, @"%@", error);
  [self addTeardownBlock:^{
    if (nil != originalAngle) {
      [device fb_setSimulatedHingeAngle:originalAngle.doubleValue error:nil];
    }
  }];
  for (NSNumber *angle in @[@0, @90, @180, @0]) {
    [self.testedApplication terminate];
    XCTAssertTrue([device fb_setSimulatedHingeAngle:angle.doubleValue error:&error], @"%@", error);
    [self launchApplication];
    [self.testedApplication.buttons[@"coordinate-probe"] tap];
    [self selectFixtureDisplay];
    [self verifyNativeApplicationCoordinates];
    [self verifyNativeEdgeCoordinates];
    [self verifyNativeDragCoordinates];
  }
}

- (void)verifyW3CApplicationOrigin
{
  // Resolve serialized element IDs through the same cache as the HTTP API.
  // Passing raw XCTest objects can hide application-root coordinate errors.
  self.actionElementCache = [FBElementCache new];
  NSDictionary *geometry = [self measurement];
  NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
  NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
  CGPoint local = CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2 - 20);
  CGPoint target = CGPointMake(frame[0].doubleValue + local.x, frame[1].doubleValue + local.y);
  // Use the same rect a client receives, not the window's differently oriented
  // frame. On Duo the app rect may still have transposed dimensions.
  CGRect appRect = self.testedApplication.wdFrame;
  NSDictionary *appMove = [self moveFrom:self.testedApplication
                                     x:target.x - CGRectGetMidX(appRect)
                                     y:target.y - CGRectGetMidY(appRect) duration:0];
  [self performMoves:@[[self moveFrom:@"viewport" x:target.x y:target.y duration:0]] expectedEnd:local];
  [self performMoves:@[[self moveFrom:self.canvas x:local.x - bounds[0].doubleValue / 2
                                   y:local.y - bounds[1].doubleValue / 2 duration:0]] expectedEnd:local];
  NSLog(@"W3C_APPLICATION_ORIGIN display=%@ app=%@ window=%@ target=%@", FBConfiguration.sharedInstance.currentDisplayId,
        NSStringFromCGRect(appRect), NSStringFromCGRect(self.testedApplication.windows.firstMatch.frame), NSStringFromCGPoint(target));
  [self performMoves:@[appMove] expectedEnd:local];
  [self performMoves:@[appMove, [self moveFrom:@"pointer" x:0 y:-20 duration:200]]
          expectedEnd:CGPointMake(local.x, local.y - 20)];
  NSMutableDictionary *appDrag = appMove.mutableCopy;
  appDrag[@"duration"] = @200;
  [self performMoves:@[[self moveFrom:self.canvas x:0 y:0 duration:0], appDrag,
                      [self moveFrom:@"pointer" x:0 y:-20 duration:200]]
          expectedEnd:CGPointMake(local.x, local.y - 20)];
  [self performMoves:@[appMove, [self moveFrom:self.canvas x:0 y:-40 duration:200],
                      [self moveFrom:@"pointer" x:0 y:-20 duration:200]]
          expectedEnd:CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2 - 60)];
}

- (void)testW3CApplicationOrigin
{
  [self verifyW3CApplicationOrigin];
}

- (void)testW3CApplicationOriginAcrossOrientations
{
  XCTSkipIf(XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection, @"Covered by fold states");
  __weak typeof(self) weakSelf = self;
  [self addTeardownBlock:^{ [weakSelf resetOrientation]; }];
  for (NSNumber *orientation in @[@(UIDeviceOrientationLandscapeLeft), @(UIDeviceOrientationLandscapeRight)]) {
    [self resetOrientation];
    XCTAssertTrue([[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation.integerValue]);
    [self verifyW3CApplicationOrigin];
  }
}

- (void)testW3CApplicationOriginAcrossFoldStates
{
  XCUIDevice *device = XCUIDevice.sharedDevice;
  XCTSkipIf(!device.fb_canAttemptSimulatedHingeAngleInjection, @"Requires a foldable simulator");
  NSError *error = nil;
  NSNumber *originalAngle = [device fb_getSimulatedHingeAngle:&error];
  XCTAssertNotNil(originalAngle);
  [self addTeardownBlock:^{ if (nil != originalAngle) { [device fb_setSimulatedHingeAngle:originalAngle.doubleValue error:nil]; } }];
  for (NSNumber *angle in @[@0, @180, @90, @0]) {
    [self.testedApplication terminate];
    XCTAssertTrue([device fb_setSimulatedHingeAngle:angle.doubleValue error:&error], @"%@", error);
    XCTAssertTrue([[[FBRunLoopSpinner new] timeout:5] spinUntilTrue:^BOOL {
      NSNumber *reading = [device fb_getSimulatedHingeAngle:nil];
      return nil != reading && fabs(reading.doubleValue - angle.doubleValue) < 1;
    }]);
    [self launchApplication];
    [self.testedApplication.buttons[@"coordinate-probe"] tap];
    self.canvas = self.testedApplication.otherElements[@"coordinate-canvas"];
    [self selectFixtureDisplay];
    [self verifyW3CApplicationOrigin];
  }
}

- (void)testViewportAndElementCorners
{
  NSDictionary *geometry = [self measurement];
  NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
  NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
  CGFloat width = bounds[0].doubleValue, height = bounds[1].doubleValue;
  for (NSNumber *x in @[@40, @(width - 40)]) {
    for (NSNumber *y in @[@40, @(height - 40)]) {
      CGPoint point = CGPointMake(x.doubleValue, y.doubleValue);
      [self performMoves:@[[self moveFrom:@"viewport"
                                       x:frame[0].doubleValue + point.x y:frame[1].doubleValue + point.y duration:0]]
              expectedEnd:point];
      [self performMoves:@[[self moveFrom:self.canvas x:point.x - width / 2 y:point.y - height / 2 duration:0]]
              expectedEnd:point];
    }
  }
}

- (void)testElementHitpoint
{
  NSArray<NSNumber *> *bounds = [self measurement][@"canvasBounds"];
  [self performMoves:@[@{@"type": @"pointerMove", @"origin": self.canvas, @"duration": @0}]
          expectedEnd:CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2)];
}

- (void)testPointerRelativeMovesPreserveOriginSpace
{
  NSDictionary *geometry = [self measurement];
  NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
  NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
  CGPoint center = CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2);
  for (NSDictionary *start in @[
    [self moveFrom:self.canvas x:0 y:0 duration:0],
    [self moveFrom:@"viewport" x:frame[0].doubleValue + center.x y:frame[1].doubleValue + center.y duration:0],
  ]) {
    [self performMoves:@[start,
                         [self moveFrom:@"pointer" x:0 y:-40 duration:200],
                         [self moveFrom:@"pointer" x:0 y:-40 duration:200]]
            expectedEnd:CGPointMake(center.x, center.y - 80)];
  }
}

- (void)testMixedOriginsWithinOneTouch
{
  NSDictionary *geometry = [self measurement];
  NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
  NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
  CGPoint center = CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2);
  for (NSNumber *startAtElement in @[@YES, @NO]) {
    NSDictionary *start = startAtElement.boolValue
      ? [self moveFrom:self.canvas x:0 y:0 duration:0]
      : [self moveFrom:@"viewport" x:frame[0].doubleValue + center.x y:frame[1].doubleValue + center.y duration:0];
    NSDictionary *next = startAtElement.boolValue
      ? [self moveFrom:@"viewport" x:frame[0].doubleValue + center.x y:frame[1].doubleValue + center.y - 40 duration:200]
      : [self moveFrom:self.canvas x:0 y:-40 duration:200];
    [self performMoves:@[start, next, [self moveFrom:@"pointer" x:0 y:-40 duration:200]]
            expectedEnd:CGPointMake(center.x, center.y - 80)];
  }
}

- (void)testScrollRemainsInForegroundAndMovesContent
{
  [self.testedApplication.buttons[@"Scroll"] tap];
  XCUIElement *table = self.testedApplication.tables[@"probe-table"];
  CGFloat before = [[self measurement][@"scrollY"] doubleValue];
  // Exceeds the per-drag limit, exercising multiple drags in one coordinate space.
  [table fb_scrollDownByNormalizedDistance:1.0];
  XCTAssertEqual(self.testedApplication.state, XCUIApplicationStateRunningForeground);
  CGFloat after = [[self measurement][@"scrollY"] doubleValue];
  XCTAssertGreaterThan(after, before + 10);
  [table fb_scrollUpByNormalizedDistance:0.5];
  XCTAssertLessThan([[self measurement][@"scrollY"] doubleValue], after - 10);
}

- (void)testDirectionalScrollRejectsUnavailableDisplay
{
  [self.testedApplication.buttons[@"Scroll"] tap];
  XCUIElement *table = self.testedApplication.tables[@"probe-table"];
  CGFloat before = [[self measurement][@"scrollY"] doubleValue];
  NSNumber *displayId = FBConfiguration.sharedInstance.currentDisplayId;
  @try {
    FBConfiguration.sharedInstance.currentDisplayId = @(-1);
    XCTAssertThrowsSpecificNamed([table fb_scrollDownByNormalizedDistance:0.5], NSException, FBInvalidArgumentException);
    XCTAssertThrowsSpecificNamed([table fb_scrollUpByNormalizedDistance:0.5], NSException, FBInvalidArgumentException);
    XCTAssertThrowsSpecificNamed([table fb_scrollLeftByNormalizedDistance:0.5], NSException, FBInvalidArgumentException);
    XCTAssertThrowsSpecificNamed([table fb_scrollRightByNormalizedDistance:0.5], NSException, FBInvalidArgumentException);
  } @finally {
    FBConfiguration.sharedInstance.currentDisplayId = displayId;
  }
  XCTAssertEqualWithAccuracy([[self measurement][@"scrollY"] doubleValue], before, 1);
}

- (void)testScrollToElementRejectsUnavailableDisplay
{
  [self.testedApplication.buttons[@"Scroll"] tap];
  XCUIElement *cell = self.testedApplication.cells[@"probe-row-13"];
  NSNumber *displayId = FBConfiguration.sharedInstance.currentDisplayId;
  @try {
    FBConfiguration.sharedInstance.currentDisplayId = @(-1);
    NSError *error = nil;
    XCTAssertFalse([cell fb_scrollToVisibleWithError:&error]);
    XCTAssertNotNil(error);
  } @finally {
    FBConfiguration.sharedInstance.currentDisplayId = displayId;
  }
}

- (void)testScrollToElementKeepsTheWholeCellVisible
{
  [self.testedApplication.buttons[@"Scroll"] tap];
  XCUIElement *cell = self.testedApplication.cells[@"probe-row-13"];
  NSError *error = nil;
  XCTAssertTrue([cell fb_scrollToVisibleWithError:&error], @"%@", error);
  XCTAssertEqual(self.testedApplication.state, XCUIApplicationStateRunningForeground);
  NSArray<NSNumber *> *frame = [self measurement][@"canvasWindowRect"];
  XCTAssertTrue(cell.hittable);
  XCTAssertGreaterThanOrEqual(CGRectGetMinY(cell.frame), frame[1].doubleValue - 1);
  XCTAssertLessThanOrEqual(CGRectGetMaxY(cell.frame), frame[1].doubleValue + frame[3].doubleValue + 1);
}

- (void)verifyLandscapeScrolling:(UIDeviceOrientation)orientation
{
  XCTSkipIf(XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection,
            @"Foldable simulator orientations are covered by testGesturesAcrossFoldStates");
  UIDeviceOrientation previousOrientation = XCUIDevice.sharedDevice.orientation;
  [self addTeardownBlock:^{
    [XCUIDevice.sharedDevice fb_setDeviceInterfaceOrientation:previousOrientation];
  }];
  XCTAssertTrue([[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation]);
  [self.testedApplication.buttons[@"Scroll"] tap];
  XCUIElement *table = self.testedApplication.tables[@"probe-table"];
  // Choose a nearby offscreen row: the phone's landscape table is intentionally
  // short, and this test checks coordinates rather than the 25-scroll limit.
  NSUInteger row = (NSUInteger)ceil(table.frame.size.height / 44) + 2;
  XCUIElement *cell = self.testedApplication.cells[[NSString stringWithFormat:@"probe-row-%lu", (unsigned long)row]];
  NSError *error = nil;
  XCTAssertTrue([cell fb_scrollToVisibleWithError:&error], @"%@", error);
  XCTAssertEqual(self.testedApplication.state, XCUIApplicationStateRunningForeground);
  XCTAssertGreaterThan([[self measurement][@"scrollY"] doubleValue], 10);
  XCTAssertTrue([[self measurement][@"fullyVisibleRows"] containsObject:@(row)]);
  XCTAssertTrue(cell.hittable);
  XCTAssertGreaterThanOrEqual(CGRectGetMinY(cell.frame), CGRectGetMinY(table.frame) - 1);
  XCTAssertLessThanOrEqual(CGRectGetMaxY(cell.frame), CGRectGetMaxY(table.frame) + 1);
}

- (void)testScrollToElementInLandscapeLeft
{
  [self verifyLandscapeScrolling:UIDeviceOrientationLandscapeLeft];
}

- (void)testScrollToElementInLandscapeRight
{
  [self verifyLandscapeScrolling:UIDeviceOrientationLandscapeRight];
}

- (void)testGesturesAcrossFoldStates
{
  XCUIDevice *device = XCUIDevice.sharedDevice;
  XCTSkipIf(!device.fb_canAttemptSimulatedHingeAngleInjection, @"Requires a foldable simulator");
  NSError *error = nil;
  NSNumber *originalAngle = [device fb_getSimulatedHingeAngle:&error];
  XCTAssertNotNil(originalAngle, @"%@", error);
  [self addTeardownBlock:^{
    if (nil != originalAngle) {
      [device fb_setSimulatedHingeAngle:originalAngle.doubleValue error:nil];
    }
  }];
  for (NSNumber *angle in @[@0, @90, @180, @0]) {
    [self.testedApplication terminate];
    XCTAssertTrue([device fb_setSimulatedHingeAngle:angle.doubleValue error:&error], @"%@", error);
    [self launchApplication];
    [self.testedApplication.buttons[@"coordinate-probe"] tap];
    self.canvas = self.testedApplication.otherElements[@"coordinate-canvas"];
    [self selectFixtureDisplay];
    NSDictionary *geometry = [self measurement];
    NSArray<NSNumber *> *bounds = geometry[@"canvasBounds"];
    NSArray<NSNumber *> *frame = geometry[@"canvasWindowRect"];
    CGPoint center = CGPointMake(bounds[0].doubleValue / 2, bounds[1].doubleValue / 2);
    [self performMoves:@[[self moveFrom:@"viewport" x:frame[0].doubleValue + center.x
                                      y:frame[1].doubleValue + center.y duration:0],
                         [self moveFrom:self.canvas x:0 y:-20 duration:200],
                         [self moveFrom:@"pointer" x:0 y:-20 duration:200]]
            expectedEnd:CGPointMake(center.x, center.y - 40)];
    [self.testedApplication.buttons[@"Scroll"] tap];
    XCUIElement *table = self.testedApplication.tables[@"probe-table"];
    [table fb_scrollDownByNormalizedDistance:1.0];
    XCTAssertGreaterThan([[self measurement][@"scrollY"] doubleValue], 10);
    XCTAssertEqual(self.testedApplication.state, XCUIApplicationStateRunningForeground);
  }
}

@end
