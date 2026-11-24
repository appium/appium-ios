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

@interface FBScreen (FBLookupTesting)
+ (nullable NSNumber *)hasMultipleScreensForDevice:(id)device error:(NSError **)error;
+ (nullable XCUIScreen *)screenWithDisplayID:(long long)displayID device:(id)device error:(NSError **)error;
@end

@interface FBEmptyScreenDouble : NSObject
@property (nonatomic) CGRect bounds;
@end
@implementation FBEmptyScreenDouble
@end

@interface FBScreenDeviceDouble : NSObject
@property (nonatomic) BOOL nativeLookupAvailable;
@property (nonatomic) BOOL enumerationUnavailable;
@property (nonatomic) NSUInteger enumerationCount;
@property (nonatomic, strong) XCUIScreen *nativeScreen;
@property (nonatomic, strong) NSArray<XCUIScreen *> *screens;
@property (nonatomic, strong) NSError *lookupError;
@property (nonatomic, strong) NSError *enumerationError;
@end

@implementation FBScreenDeviceDouble
- (BOOL)respondsToSelector:(SEL)selector
{
  if (selector == NSSelectorFromString(@"screensOrError:") && self.enumerationUnavailable) {
    return NO;
  }
  return selector == @selector(screenWithDisplayID:orError:)
    ? self.nativeLookupAvailable : [super respondsToSelector:selector];
}
- (XCUIScreen *)screenWithDisplayID:(long long)displayID orError:(NSError **)error
{
  if (NULL != error) {
    *error = self.lookupError;
  }
  return self.nativeScreen;
}
- (NSArray<XCUIScreen *> *)screensOrError:(NSError **)error
{
  self.enumerationCount++;
  if (NULL != error) {
    *error = self.enumerationError;
  }
  return self.screens;
}
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
  XCTSkipIf([NSStringFromSelector(self.invocation.selector) isEqualToString:@"testScreenInfoAcrossFoldStates"]
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
  NSDictionary *rect = self.testedApplication.wdRect;
  NSDictionary *size = @{@"width": rect[@"width"], @"height": rect[@"height"]};
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
  }
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

- (void)testDisplayCountDoesNotTreatEnumerationFailureAsSingleDisplay
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.enumerationError = [NSError errorWithDomain:@"Enumeration" code:2 userInfo:nil];
  NSError *error = nil;
  XCTAssertNil([FBScreen hasMultipleScreensForDevice:device error:&error]);
  XCTAssertEqualObjects(error, device.enumerationError);

  device.enumerationError = nil;
  error = nil;
  XCTAssertNil([FBScreen hasMultipleScreensForDevice:device error:&error]);
  XCTAssertNotNil(error);
}

- (void)testDisplayCountDistinguishesSingleAndMultipleDisplays
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.screens = @[XCUIScreen.mainScreen];
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen hasMultipleScreensForDevice:device error:&error], @NO);
  XCTAssertNil(error);
  device.screens = @[XCUIScreen.mainScreen, XCUIScreen.mainScreen];
  XCTAssertEqualObjects([FBScreen hasMultipleScreensForDevice:device error:&error], @YES);
  XCTAssertNil(error);
}

- (void)testNativeScreenLookupDoesNotEnumerateOnSuccess
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.nativeScreen = XCUIScreen.mainScreen;
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen screenWithDisplayID:device.nativeScreen.displayID device:device error:&error],
                        device.nativeScreen);
  XCTAssertNil(error);
  XCTAssertEqual(device.enumerationCount, 0UL);
}

- (void)testNativeScreenPlaceholderMustBeAvailable
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.nativeScreen = (id)[FBEmptyScreenDouble new];
  device.screens = @[XCUIScreen.mainScreen];
  NSError *error = nil;
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertNotNil(error);
  XCTAssertEqual(device.enumerationCount, 1UL);
}

- (void)testNativeScreenLookupFailureIncludesAvailableIDs
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.screens = @[XCUIScreen.mainScreen];
  device.lookupError = [NSError errorWithDomain:@"NativeLookup" code:1 userInfo:nil];
  NSError *error = nil;
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertEqual(device.enumerationCount, 1UL);
  XCTAssertTrue([error.localizedDescription containsString:@"Available display ids"]);
  XCTAssertEqualObjects(error.userInfo[NSUnderlyingErrorKey], device.lookupError);
}

- (void)testNativeScreenLookupErrorSurvivesEnumerationFailure
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.lookupError = [NSError errorWithDomain:@"NativeLookup" code:1 userInfo:nil];
  device.enumerationError = [NSError errorWithDomain:@"Enumeration" code:2 userInfo:nil];
  NSError *error = nil;
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertEqualObjects(error, device.lookupError);
}

- (void)testScreenLookupWithoutNativeSelector
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.screens = @[XCUIScreen.mainScreen];
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen screenWithDisplayID:XCUIScreen.mainScreen.displayID device:device error:&error],
                        XCUIScreen.mainScreen);
  XCTAssertNil(error);
  XCTAssertEqual(device.enumerationCount, 1UL);
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertTrue([error.localizedDescription containsString:@"Available display ids"]);
  device.screens = nil;
  device.enumerationError = [NSError errorWithDomain:@"Enumeration" code:2 userInfo:nil];
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertEqualObjects(error, device.enumerationError);
}

- (void)testScreenLookupWithoutDeviceScreenSelectors
{
  FBScreenDeviceDouble *device = [FBScreenDeviceDouble new];
  device.enumerationUnavailable = YES;
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen screenWithDisplayID:XCUIScreen.mainScreen.displayID device:device error:&error],
                        XCUIScreen.mainScreen);
  XCTAssertNil(error);
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertNotNil(error);
  XCTAssertEqual(device.enumerationCount, 0UL);
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

- (void)testSessionResetClearsCurrentDisplay
{
  FBConfiguration.sharedInstance.currentDisplayId = @([FBScreen displayID]);
  [FBConfiguration.sharedInstance resetSessionSettings];
  XCTAssertNil(FBConfiguration.sharedInstance.currentDisplayId);
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
