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
#import "FBGestureCoordinateContext.h"
#import "FBMathUtils.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIDevice+FBHelpers.h"
#import "FBScreen.h"
#import "XCUIElement+FBFind.h"
#import "XCUIElement+FBUtilities.h"
#import "FBDisplayGeometry.h"
#import "FBRunLoopSpinner.h"
#import "XCUIDevice+FBRotation.h"
#import "XCUIDevice+FBHinge.h"
#import "XCUIApplication.h"
#import "XCUIElement.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "FBActiveAppDetectionPoint.h"
#import "FBExceptions.h"
#import "FBScreenRecordingRequest.h"
#import "FBScreenshot.h"
#import "XCUIScreen.h"
#import "FBCustomCommands.h"
#import "FBElementCommands.h"
#import "FBRouteRequest-Private.h"
#import "FBSession.h"
#import "FBResponsePayload.h"
#import "RouteResponse.h"

@interface FBCustomCommands (FBScreenInfoTesting)
+ (id<FBResponsePayload>)handleGetScreen:(FBRouteRequest *)request;
@end

@interface FBElementCommands (FBWindowGeometryTesting)
+ (id<FBResponsePayload>)handleGetWindowSize:(FBRouteRequest *)request;
+ (id<FBResponsePayload>)handleGetWindowRect:(FBRouteRequest *)request;
@end

// Synthetic source trees let us exercise display IDs that XCTest can omit.
@interface FBGeometrySnapshotDouble : NSObject
@property (nonatomic) CGRect frame;
@property (nonatomic) XCUIElementType elementType;
@property (nonatomic) long long displayID;
@property (nonatomic, weak) FBGeometrySnapshotDouble *parent;
@property (nonatomic) NSArray<FBGeometrySnapshotDouble *> *children;
@property (nonatomic) id accessibilityElement;
@property (nonatomic) NSString *identifier;
@property (nonatomic) NSString *label;
@end
@implementation FBGeometrySnapshotDouble
- (NSArray *)_allDescendants
{
  NSMutableArray *result = [NSMutableArray new];
  for (FBGeometrySnapshotDouble *child in self.children) {
    [result addObject:child];
    [result addObjectsFromArray:child._allDescendants];
  }
  return result;
}
@end

@interface FBGeometryScreenDouble : NSObject
@property (nonatomic) CGRect bounds;
@property (nonatomic) CGFloat scale;
@property (nonatomic) long long displayID;
@end
@implementation FBGeometryScreenDouble
@end

/** Shared helpers; does not launch the app. */
@interface FBScreenTestCase : FBIntegrationTestCase
@end

@implementation FBScreenTestCase

- (void)tearDown
{
  FBConfiguration.sharedInstance.currentDisplayId = nil;
  [super tearDown];
}

- (long long)unknownDisplayID
{
  long long maxID = 0;
  for (NSDictionary<NSString *, id> *screen in [FBScreen screensWithError:nil]) {
    maxID = MAX(maxID, [screen[@"displayId"] longLongValue]);
  }
  return maxID + 1;
}

- (NSDictionary *)screenInfoResponse
{
  FBRouteRequest *request = [FBRouteRequest routeRequestWithURL:[NSURL URLWithString:@"http://localhost:8100/wda/screen"]
                                                  parameters:@{}
                                                   arguments:@{}];
  RouteResponse *response = [RouteResponse new];
  [[FBCustomCommands handleGetScreen:request] dispatchWithResponse:response];
  return [NSJSONSerialization JSONObjectWithData:response.responseData options:0 error:nil][@"value"];
}

@end

/** Display lookup logic that does not need the app under test, so it skips the app launch. */
@interface FBScreenLookupTests : FBScreenTestCase
@end

/** Screen metadata that depends on the fixture app being in the foreground. */
@interface FBScreenTests : FBScreenTestCase
@end

@implementation FBScreenTests

// iPad status bar / landscape-native panel metadata
+ (NSArray<NSString *> *)iPadTests
{
  return @[@"*"];
}

- (void)skipIfUnsupported
{
  XCTSkipIf((self.invocation.selector == @selector(testScreenInfoAcrossFoldStates)
             || self.invocation.selector == @selector(testReadingControlCenterOnInnerDisplay)
             || self.invocation.selector == @selector(testReadingControlCenterOnCover))
            && !XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection, @"Requires a foldable simulator");
}

- (void)setUp
{
  [super setUp];
  [self launchApplication];
}

- (void)testScreenInfoAcrossPortraitAndLandscapeOrientations
{
  XCTSkipIf(XCUIDevice.sharedDevice.fb_canAttemptSimulatedHingeAngleInjection,
            @"Foldable orientations are covered by testScreenInfoAcrossFoldStates");
  XCUIElement *window = self.testedApplication.windows.firstMatch;
  (void)window.frame;
  XCTSkipIf(window.screen.displayID != XCUIScreen.mainScreen.displayID,
            @"Requires the fixture on the main display");
  [self addTeardownBlock:^{
    [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:UIDeviceOrientationPortrait];
  }];
  BOOL expectsVisibleBar = UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad;
  for (NSNumber *orientation in @[@(UIDeviceOrientationPortrait),
                                   @(UIDeviceOrientationLandscapeLeft),
                                   @(UIDeviceOrientationLandscapeRight),
                                   @(UIDeviceOrientationPortrait)]) {
    XCTAssertTrue([[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation.integerValue]);
    __block NSDictionary *info = nil;
    BOOL isPortrait = UIDeviceOrientationIsPortrait(orientation.integerValue);
    // Include portrait before and after rotation: landscape-native iPad panels
    // must swap their screen bounds back and retain the visible top status bar.
    // Wait for rotation rather than accepting a transient zero crop.
    XCTAssertTrue([[[FBRunLoopSpinner new] timeout:5] spinUntilTrue:^BOOL {
      info = [self screenInfoResponse];
      double width = [info[@"screenSize"][@"width"] doubleValue];
      double height = [info[@"screenSize"][@"height"] doubleValue];
      double barWidth = [info[@"statusBarSize"][@"width"] doubleValue];
      double barHeight = [info[@"statusBarSize"][@"height"] doubleValue];
      if (nil != info[@"error"] || width <= 0 || height <= 0
          || (isPortrait ? width >= height : width <= height)) {
        return NO;
      }
      if (barHeight == 0) {
        return !expectsVisibleBar && !isPortrait && barWidth == 0;
      }
      return barHeight > 0 && barHeight < height && fabs(barWidth - width) <= 1;
    }], @"Unexpected screen metadata at orientation %@: %@", orientation, info);
  }
}

- (void)testWindowGeometryWhenDisplayEnumerationFails
{
  FBRouteRequest *request = [FBRouteRequest routeRequestWithURL:[NSURL URLWithString:@"http://localhost:8100/"]
                                                     parameters:@{} arguments:@{}];
  request.session = [FBSession initWithApplication:self.testedApplication];
  request.session.defaultActiveApplication = self.testedApplication.bundleID;
  [self addTeardownBlock:^{ [request.session kill]; }];

  NSNumber *mainDisplay = @([FBScreen displayID]);
  CGRect frame = self.testedApplication.wdFrame;
  CGSize orientedSize = FBAdjustDimensionsForApplication(frame.size, self.testedApplication.interfaceOrientation);
  NSDictionary *size = @{@"width": @(orientedSize.width), @"height": @(orientedSize.height)};
  NSDictionary *rect = @{@"x": @(frame.origin.x), @"y": @(frame.origin.y),
                         @"width": size[@"width"], @"height": size[@"height"]};
  Method method = class_getClassMethod(FBScreen.class, @selector(hasMultipleScreensWithError:));
  IMP replacement = imp_implementationWithBlock(^NSNumber *(id receiver, NSError **error) {
    if (error != NULL) {
      *error = [NSError errorWithDomain:@"Test" code:1 userInfo:@{NSLocalizedDescriptionKey: @"No display list"}];
    }
    return nil;
  });
  IMP original = method_setImplementation(method, replacement);
  @try {
    for (NSNumber *explicit in @[@NO, @YES]) {
      FBConfiguration.sharedInstance.currentDisplayId = explicit.boolValue ? mainDisplay : nil;
      RouteResponse *sizeResponse = [RouteResponse new];
      [[FBElementCommands handleGetWindowSize:request] dispatchWithResponse:sizeResponse];
      RouteResponse *rectResponse = [RouteResponse new];
      [[FBElementCommands handleGetWindowRect:request] dispatchWithResponse:rectResponse];
      NSDictionary *actualSize = [NSJSONSerialization JSONObjectWithData:sizeResponse.responseData options:0 error:nil][@"value"];
      NSDictionary *actualRect = [NSJSONSerialization JSONObjectWithData:rectResponse.responseData options:0 error:nil][@"value"];
      if (explicit.boolValue) {
        XCTAssertEqualObjects(actualSize[@"error"], @"invalid argument");
        XCTAssertEqualObjects(actualRect[@"error"], @"invalid argument");
      } else {
        XCTAssertEqualObjects(actualSize, size);
        XCTAssertEqualObjects(actualRect, rect);
      }
    }
  } @finally {
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }
}

- (void)testScreenInfoAcrossFoldStates
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
  FBRouteRequest *request = [FBRouteRequest routeRequestWithURL:[NSURL URLWithString:@"http://localhost:8100/"]
                                                     parameters:@{} arguments:@{}];
  request.session = [FBSession initWithApplication:nil];
  request.session.defaultActiveApplication = @"com.apple.springboard";
  [self addTeardownBlock:^{ [request.session kill]; }];
  for (NSNumber *angle in @[@0, @90, @180, @0]) {
    [self.testedApplication terminate];
    XCTAssertTrue([device fb_setSimulatedHingeAngle:angle.doubleValue error:&error], @"%@", error);
    [self launchApplication];
    XCUIElement *window = self.testedApplication.windows.firstMatch;
    CGRect frame = window.frame;
    FBConfiguration.sharedInstance.currentDisplayId = @(window.screen.displayID);
    __block NSDictionary *info = nil;
    XCTAssertTrue([[[FBRunLoopSpinner new] timeout:5] spinUntilTrue:^BOOL {
      info = [self screenInfoResponse];
      double width = [info[@"screenSize"][@"width"] doubleValue];
      double height = [info[@"screenSize"][@"height"] doubleValue];
      double barHeight = [info[@"statusBarSize"][@"height"] doubleValue];
      return nil == info[@"error"] && fabs(width - frame.size.width) <= 1
        && fabs(height - frame.size.height) <= 1
        && barHeight >= 0 && barHeight < height
        && (barHeight == 0 || fabs([info[@"statusBarSize"][@"width"] doubleValue] - width) <= 1)
        && (angle.doubleValue == 0 || barHeight == 0);
    }], @"Unexpected screen metadata at hinge angle %@: %@", angle, info);

    // SpringBoard exposes windows on both panels even when its root retains the cover frame.
    RouteResponse *sizeResponse = [RouteResponse new];
    [[FBElementCommands handleGetWindowSize:request] dispatchWithResponse:sizeResponse];
    NSDictionary *size = [NSJSONSerialization JSONObjectWithData:sizeResponse.responseData options:0 error:nil][@"value"];
    XCTAssertEqualObjects(size, info[@"screenSize"]);
    RouteResponse *rectResponse = [RouteResponse new];
    [[FBElementCommands handleGetWindowRect:request] dispatchWithResponse:rectResponse];
    NSDictionary *rect = [NSJSONSerialization JSONObjectWithData:rectResponse.responseData options:0 error:nil][@"value"];
    NSDictionary *expectedRect = @{@"x": @0, @"y": @0, @"width": size[@"width"] ?: NSNull.null,
                                   @"height": size[@"height"] ?: NSNull.null};
    XCTAssertEqualObjects(rect, expectedRect);
    XCTAssertEqualObjects(request.session.activeApplication.wdRect, expectedRect,
                          @"Unexpected SpringBoard root rect at hinge angle %@", angle);

    FBConfiguration.sharedInstance.currentDisplayId = nil;
    RouteResponse *mainWindow = [RouteResponse new];
    [[FBElementCommands handleGetWindowRect:request] dispatchWithResponse:mainWindow];
    NSDictionary *mainRect = [NSJSONSerialization JSONObjectWithData:mainWindow.responseData options:0 error:nil][@"value"];
    XCTAssertEqualObjects(request.session.activeApplication.wdRect, mainRect,
                          @"SpringBoard root must follow the default window at hinge angle %@", angle);
  }
}

- (void)testReadingControlCenterOnInnerDisplay
{
  [self checkControlCenterAtHingeAngle:180];
}

- (void)testReadingControlCenterOnCover
{
  [self checkControlCenterAtHingeAngle:0];
}

- (void)checkControlCenterAtHingeAngle:(CGFloat)angle
{
  XCUIDevice *device = XCUIDevice.sharedDevice;
  NSNumber *originalAngle = [device fb_getSimulatedHingeAngle:nil];
  XCTAssertNotNil(originalAngle);
  [self addTeardownBlock:^{
    [device fb_goToHomescreenWithError:nil];
    if (originalAngle != nil) {
      [device fb_setSimulatedHingeAngle:originalAngle.doubleValue error:nil];
    }
  }];
  XCTAssertTrue([device fb_setSimulatedHingeAngle:angle error:nil]);
  [self.testedApplication terminate];
  [self launchApplication];
  XCUIElement *window = self.testedApplication.windows.firstMatch;
  (void)window.frame;
  FBConfiguration.sharedInstance.currentDisplayId = @(window.screen.displayID);
  XCTAssertTrue([device fb_goToHomescreenWithError:nil]);

  XCUIApplication *springboard = XCUIApplication.fb_systemApplication;
  FBGestureCoordinateContext *context = [FBGestureCoordinateContext contextWithDisplayRequired:YES error:nil];
  CGFloat x = [[self screenInfoResponse][@"screenSize"][@"width"] doubleValue] - 50;
  XCUICoordinate *start = [context coordinateWithApplication:springboard offset:CGVectorMake(x, 2) error:nil];
  XCUICoordinate *end = [context coordinateWithApplication:springboard offset:CGVectorMake(x, 240) error:nil];
  [start pressForDuration:0.08 thenDragToCoordinate:end];
  XCUIElement *addControls = springboard.buttons[@"Add Controls"].firstMatch;
  XCTAssertTrue([addControls waitForExistenceWithTimeout:5]);
  XCTAssertTrue(addControls.isWDVisible);
  id<FBXCElementSnapshot> app = [springboard fb_standardSnapshot];
  id<FBXCElementSnapshot> button = [app elementSnapshotMatchingAccessibilityElement:[addControls fb_standardSnapshot].accessibilityElement];
  FBDisplaySnapshotMap *source = FBDisplaySnapshotsForTree(app, YES);
  XCTAssertNotNil(button);
  id<FBXCElementSnapshot> sourceSnapshot = [source objectForKey:button];
  // Only the inner panel needs passive visibility for this button.
  BOOL expectsOverride = angle != 0;
  XCTAssertEqual(sourceSnapshot != nil, expectsOverride);
  id<FBXCElementSnapshot> scopedButton = [addControls fb_standardSnapshot];
  FBDisplaySnapshotMap *scoped = FBDisplaySnapshotsForTree(scopedButton, YES);
  XCTAssertEqual([scoped objectForKey:scopedButton] != nil, expectsOverride);
  XCTAssertEqual([addControls fb_descendantsMatchingXPathQuery:@"self::*[@visible='true']"
                                  shouldReturnAfterFirstMatch:YES].count, 1u);
  XCTAssertTrue(addControls.exists);
  FBXCElementSnapshotWrapper *sourceButton = [FBXCElementSnapshotWrapper ensureWrapped:sourceSnapshot ?: button];
  XCTAssertTrue(sourceButton.isWDVisible);
  XCTAssertNil([self screenInfoResponse][@"error"]);
  XCTAssertTrue(addControls.exists);
  XCTAssertNotNil(springboard.fb_tree);
  XCTAssertTrue(addControls.exists);
  XCTAssertNotNil(springboard.fb_xmlRepresentation);
  XCTAssertTrue(addControls.exists);
}

- (void)testScreenInfoIncludesTopStatusBarOnSingleDisplay
{
  XCTSkipIf([FBScreen screensWithError:nil].count != 1, @"Requires a single-display device");
  // The integration fixture uses the ordinary visible portrait status bar.
  // An unresolved XCUIElement has displayID == 0; it must not be filtered out.
  NSDictionary *info = [self screenInfoResponse];
  XCTAssertGreaterThan([info[@"statusBarSize"][@"height"] doubleValue], 0);
  XCTAssertEqualWithAccuracy([info[@"statusBarSize"][@"width"] doubleValue],
                            [info[@"screenSize"][@"width"] doubleValue], 1);
}

@end

@implementation FBScreenLookupTests

- (void)testLandscapeGeometryInheritsNearestDisplay
{
  FBConfiguration.sharedInstance.currentDisplayId = @3;
  FBGeometryScreenDouble *screen = [FBGeometryScreenDouble new];
  screen.bounds = CGRectMake(0, 0, 669, 951);
  screen.scale = 1;
  screen.displayID = 3;
  FBGeometrySnapshotDouble *window = [FBGeometrySnapshotDouble new];
  window.elementType = XCUIElementTypeWindow;
  window.displayID = 3;
  window.frame = screen.bounds;
  window.accessibilityElement = [XCUIApplication.fb_systemApplication fb_standardSnapshot].accessibilityElement;
  FBGeometrySnapshotDouble *(^node)(FBGeometrySnapshotDouble *, long long) = ^(FBGeometrySnapshotDouble *parent, long long display) {
    FBGeometrySnapshotDouble *result = [FBGeometrySnapshotDouble new];
    result.elementType = XCUIElementTypeOther;
    result.displayID = display;
    result.frame = CGRectMake(10, 20, 30, 40);
    result.parent = parent;
    result.accessibilityElement = window.accessibilityElement;
    parent.children = [(parent.children ?: @[]) arrayByAddingObject:result];
    return result;
  };
  FBGeometrySnapshotDouble *unknown = node(window, 0);
  FBGeometrySnapshotDouble *nestedUnknown = node(unknown, 0);
  // Child traversal still supplies ancestry when XCTest omits a parent link.
  nestedUnknown.parent = nil;
  FBGeometrySnapshotDouble *other = node(window, 1);
  FBGeometrySnapshotDouble *otherUnknown = node(other, 0);
  FBGeometrySnapshotDouble *selected = node(other, 3);
  FBGeometrySnapshotDouble *selectedUnknown = node(selected, 0);
  Method screenMethod = class_getClassMethod(FBScreen.class, @selector(currentScreenWithError:));
  IMP originalScreen = method_getImplementation(screenMethod);
  IMP replacementScreen = imp_implementationWithBlock(^id(id receiver, NSError **error) { return screen; });
  Method orientationMethod = class_getInstanceMethod(XCUIApplication.class, @selector(interfaceOrientation));
  IMP originalOrientation = method_getImplementation(orientationMethod);
  __block UIInterfaceOrientation orientation;
  IMP replacementOrientation = imp_implementationWithBlock(^UIInterfaceOrientation(id receiver) { return orientation; });
  method_setImplementation(screenMethod, replacementScreen);
  method_setImplementation(orientationMethod, replacementOrientation);
  @try {
    for (NSNumber *value in @[@(UIInterfaceOrientationLandscapeLeft), @(UIInterfaceOrientationLandscapeRight)]) {
      orientation = value.integerValue;
      CGRect expected = orientation == UIInterfaceOrientationLandscapeLeft
        ? CGRectMake(891, 10, 40, 30) : CGRectMake(20, 629, 40, 30);
      // Check a whole window and a scoped XPath subtree with unresolved IDs.
      for (FBGeometrySnapshotDouble *root in @[window, unknown, other]) {
        FBDisplaySnapshotMap *map = FBDisplaySnapshotsForTree((id)root, NO);
        XCTAssertNotNil(map);
        for (FBGeometrySnapshotDouble *item in [@[root] arrayByAddingObjectsFromArray:root._allDescendants]) {
          if (item == window) { continue; }
          id<FBXCElementSnapshot> resolved = [map objectForKey:(id)item] ?: (id)item;
          CGRect actual = [FBXCElementSnapshotWrapper ensureWrapped:resolved].wdFrame;
          BOOL shouldRotate = item != other && item != otherUnknown;
          XCTAssertTrue(CGRectEqualToRect(actual, shouldRotate ? expected : item.frame),
                        @"display %lld, orientation %@: %@", item.displayID, value, NSStringFromCGRect(actual));
          XCTAssertTrue(CGRectEqualToRect(item.frame, CGRectMake(10, 20, 30, 40)), @"Do not mutate XCTest snapshots");
        }
      }
      XCTAssertEqual(nestedUnknown.displayID, 0);
      XCTAssertEqual(selectedUnknown.displayID, 0);
    }
  } @finally {
    method_setImplementation(screenMethod, originalScreen);
    method_setImplementation(orientationMethod, originalOrientation);
    imp_removeBlock(replacementScreen);
    imp_removeBlock(replacementOrientation);
  }
}



- (void)testDisplayID
{
  XCTAssertGreaterThanOrEqual([FBScreen displayID], 0LL);
}

- (void)testScreens
{
  NSError *error = nil;
  NSArray<NSDictionary<NSString *, id> *> *screens = [FBScreen screensWithError:&error];

  XCTAssertNotNil(screens);
  XCTAssertNil(error);
  XCTAssertGreaterThan(screens.count, 0UL);

  NSDictionary<NSString *, id> *mainScreen = nil;
  for (NSDictionary<NSString *, id> *screen in screens) {
    if ([screen[@"isMain"] boolValue]) {
      mainScreen = screen;
      break;
    }
  }
  XCTAssertNotNil(mainScreen);
  XCTAssertEqualObjects(mainScreen[@"displayId"], @([FBScreen displayID]));
  XCTAssertNotNil(mainScreen[@"scale"]);
  XCTAssertNotNil(mainScreen[@"bounds"]);
  XCTAssertNotNil(mainScreen[@"traits"]);
}

- (void)testScreenWithDisplayID
{
  NSError *error = nil;
  for (NSDictionary<NSString *, id> *entry in [FBScreen screensWithError:&error]) {
    long long displayID = [entry[@"displayId"] longLongValue];
    XCUIScreen *screen = [FBScreen screenWithDisplayID:displayID error:&error];
    XCTAssertNotNil(screen);
    XCTAssertNil(error);
    XCTAssertEqual(screen.displayID, displayID);
  }

  XCTAssertNil([FBScreen screenWithDisplayID:[self unknownDisplayID] error:&error]);
  XCTAssertNotNil(error);
  NSMutableArray<NSNumber *> *availableIDs = [NSMutableArray array];
  for (NSDictionary<NSString *, id> *availableScreen in [FBScreen screensWithError:nil]) {
    [availableIDs addObject:availableScreen[@"displayId"]];
  }
  NSString *availableDisplays = [NSString stringWithFormat:@"Available display ids: [%@]",
                                [availableIDs componentsJoinedByString:@", "]];
  XCTAssertTrue([error.localizedDescription containsString:availableDisplays]);
}

- (void)testCurrentScreenDefaultsToMainScreen
{
  NSError *error = nil;
  XCTAssertTrue([FBScreen currentScreenWithError:&error].isMainScreen);
  XCTAssertNil(error);
}

- (void)testCurrentScreenFollowsSetting
{
  FBConfiguration.sharedInstance.currentDisplayId = @([FBScreen displayID]);
  NSError *error = nil;
  XCTAssertEqual([FBScreen currentScreenWithError:&error].displayID, [FBScreen displayID]);
  XCTAssertNil(error);
  XCTAssertNotNil([FBScreenshot takeInOriginalResolutionWithQuality:0 error:&error]);
  XCTAssertNil(error);

  FBConfiguration.sharedInstance.currentDisplayId = @([self unknownDisplayID]);
  XCTAssertNil([FBScreen currentScreenWithError:&error]);
  XCTAssertNotNil(error);
  error = nil;
  XCTAssertNil([FBScreenshot takeInOriginalResolutionWithQuality:0 error:&error]);
  XCTAssertNotNil(error);
}

- (void)testSecondaryDisplayDoesNotHitTestMainDisplay
{
  NSArray<NSDictionary<NSString *, id> *> *screens = [FBScreen screensWithError:nil];
  BOOL testedSecondaryDisplay = NO;
  for (NSDictionary<NSString *, id> *screen in screens) {
    if ([screen[@"isMain"] boolValue]) {
      continue;
    }
    testedSecondaryDisplay = YES;
    FBConfiguration.sharedInstance.currentDisplayId = screen[@"displayId"];
    XCTAssertNil(FBActiveAppDetectionPoint.sharedInstance.axElement);
  }
  XCTSkipIf(!testedSecondaryDisplay, @"Requires a secondary display");
}

- (void)testActiveAppDetectionRejectsUnavailableDisplay
{
  FBConfiguration.sharedInstance.currentDisplayId = @([self unknownDisplayID]);
  XCTAssertThrowsSpecificNamed(FBActiveAppDetectionPoint.sharedInstance.axElement,
                               NSException, FBInvalidArgumentException);
}

- (void)testRecordingUsesSelectedDisplay
{
  XCTSkipIf(nil == NSClassFromString(@"XCTScreenRecordingRequest"), @"Screen recording is unavailable");
  FBScreenRecordingRequest *request = [[FBScreenRecordingRequest alloc] initWithFps:10 codec:0];
  NSError *error = nil;
  id defaultRequest = [request toNativeRequestWithError:&error];
  XCTAssertNotNil(defaultRequest);
  XCTAssertNil(error);
  XCTAssertEqualObjects([defaultRequest valueForKey:@"screenID"], @([FBScreen displayID]));

  for (NSDictionary<NSString *, id> *screen in [FBScreen screensWithError:nil]) {
    FBConfiguration.sharedInstance.currentDisplayId = screen[@"displayId"];
    id nativeRequest = [request toNativeRequestWithError:&error];
    XCTAssertNotNil(nativeRequest);
    XCTAssertNil(error);
    XCTAssertEqualObjects([nativeRequest valueForKey:@"screenID"], screen[@"displayId"]);
  }

  FBConfiguration.sharedInstance.currentDisplayId = @([self unknownDisplayID]);
  XCTAssertNil([request toNativeRequestWithError:&error]);
  XCTAssertNotNil(error);
  XCTAssertTrue([error.localizedDescription containsString:@"Available display ids"]);
}


- (void)testScreenScale
{
  XCTAssertTrue([FBScreen scale] >= 2);
}


- (void)testScreenInfoFollowsDisplaySelection
{
  for (NSDictionary *screen in [FBScreen screensWithError:nil]) {
    FBConfiguration.sharedInstance.currentDisplayId = screen[@"displayId"];
    NSDictionary *info = [self screenInfoResponse];
    XCTAssertNil(info[@"error"]);
    XCTAssertEqualObjects(info[@"displayId"], screen[@"displayId"]);
    XCTAssertEqualObjects(info[@"scale"], screen[@"scale"]);
    double width = [info[@"screenSize"][@"width"] doubleValue];
    double height = [info[@"screenSize"][@"height"] doubleValue];
    double scale = [screen[@"scale"] doubleValue];
    double expectedWidth = [screen[@"bounds"][@"width"] doubleValue] / scale;
    double expectedHeight = [screen[@"bounds"][@"height"] doubleValue] / scale;
    XCTAssertEqualWithAccuracy(MIN(width, height), MIN(expectedWidth, expectedHeight), 0.01);
    XCTAssertEqualWithAccuracy(MAX(width, height), MAX(expectedWidth, expectedHeight), 0.01);
    double barHeight = [info[@"statusBarSize"][@"height"] doubleValue];
    XCTAssertGreaterThanOrEqual(barHeight, 0);
    XCTAssertLessThan(barHeight, height);
    if (barHeight > 0) {
      XCTAssertEqualWithAccuracy([info[@"statusBarSize"][@"width"] doubleValue], width, 1);
    }
  }
  // tearDown restores the default display even when an assertion fails.
}

- (void)testScreenInfoFollowsDisplayReset
{
  // Exercise reset independently of the display-selection assertions.
  FBConfiguration.sharedInstance.currentDisplayId = @([self unknownDisplayID]);
  FBConfiguration.sharedInstance.currentDisplayId = nil;
  XCTAssertEqualObjects([self screenInfoResponse][@"displayId"], @([FBScreen displayID]));
}

- (void)testScreenInfoRejectsUnavailableDisplay
{
  FBConfiguration.sharedInstance.currentDisplayId = @([self unknownDisplayID]);
  NSDictionary *info = [self screenInfoResponse];
  XCTAssertEqualObjects(info[@"error"], @"invalid argument");
  XCTAssertTrue([info[@"message"] containsString:@"Available display ids"]);
}

@end
