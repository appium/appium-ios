/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import <objc/runtime.h>

#import "FBCapabilities.h"
#import "FBReflectionUtils.h"
#import "FBRouteRequest-Private.h"
#import "FBResponsePayload.h"
#import "FBSession.h"
#import "FBSessionCommands.h"
#import "RouteResponse.h"
#import "XCUIDevice+FBHelpers.h"

@interface FBSessionCommands (FBWDATestable)
+ (id<FBResponsePayload>)handleOpenURL:(FBRouteRequest *)request;
+ (id<FBResponsePayload>)handleCreateSession:(FBRouteRequest *)request;
+ (id<FBResponsePayload>)handleSessionAppLaunch:(FBRouteRequest *)request;
+ (id<FBResponsePayload>)handleSessionAppActivate:(FBRouteRequest *)request;
+ (id<FBResponsePayload>)handleSessionAppTerminate:(FBRouteRequest *)request;
+ (id<FBResponsePayload>)handleSessionAppState:(FBRouteRequest *)request;
+ (NSDictionary *)currentCapabilities;
@end

@implementation FBSessionCommands (FBSessionCommandsTests)

+ (NSDictionary *)fbtest_currentCapabilities
{
  return @{};
}

@end

// Stands in for the session of the /wda/apps handlers and records the bundle ids it gets
// (NSNull for nil), so nothing reaches XCTest.
@interface FBAppsSessionDouble : NSObject
@property (nonatomic, readonly) NSMutableArray *receivedBundleIds;
@end

@implementation FBAppsSessionDouble

- (instancetype)init
{
  if ((self = [super init])) {
    _receivedBundleIds = [NSMutableArray array];
  }
  return self;
}

- (XCUIApplication *)launchApplicationWithBundleId:(NSString *)bundleIdentifier
                           shouldWaitForQuiescence:(NSNumber *)shouldWaitForQuiescence
                                         arguments:(NSArray<NSString *> *)arguments
                                       environment:(NSDictionary <NSString *, NSString *> *)environment
                            asApplicationUnderTest:(BOOL)asApplicationUnderTest
{
  [self.receivedBundleIds addObject:bundleIdentifier ?: NSNull.null];
  return nil;
}

- (XCUIApplication *)activateApplicationWithBundleId:(NSString *)bundleIdentifier
{
  [self.receivedBundleIds addObject:bundleIdentifier ?: NSNull.null];
  return nil;
}

- (BOOL)terminateApplicationWithBundleId:(NSString *)bundleIdentifier
{
  [self.receivedBundleIds addObject:bundleIdentifier ?: NSNull.null];
  return NO;
}

- (NSUInteger)applicationStateWithBundleId:(NSString *)bundleIdentifier
{
  [self.receivedBundleIds addObject:bundleIdentifier ?: NSNull.null];
  return 0;
}

@end

// What the /url stubs below got: [url] or [url, bundleId]
static NSMutableArray<NSArray<NSString *> *> *FBOpenedUrls;

@implementation XCUIDevice (FBSessionCommandsTests)

- (BOOL)fbtest_openUrl:(NSString *)url error:(NSError **)error
{
  [FBOpenedUrls addObject:@[url]];
  return YES;
}

- (BOOL)fbtest_openUrl:(NSString *)url withApplication:(NSString *)bundleId error:(NSError **)error
{
  [FBOpenedUrls addObject:@[url, bundleId]];
  return YES;
}

@end

// -[NSNumber isEqual:] treats false and 0 as equal, so only the CF type tells a JSON boolean from a number
static BOOL FBIsBoolean(id value)
{
  return nil != value && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

@interface FBSessionCommandsTests : XCTestCase
@end

@implementation FBSessionCommandsTests

- (RouteResponse *)responseOf:(SEL)handler
                    arguments:(NSDictionary *)arguments
                      session:(nullable FBAppsSessionDouble *)session
{
  FBRouteRequest *request = [FBRouteRequest routeRequestWithURL:[NSURL URLWithString:@"http://localhost:8100/"]
                                                  parameters:@{}
                                                   arguments:arguments];
  request.session = (FBSession *)session;
  id<FBResponsePayload> (*invoke)(id, SEL, FBRouteRequest *) = (void *)[FBSessionCommands methodForSelector:handler];
  RouteResponse *response = [RouteResponse new];
  [invoke(FBSessionCommands.class, handler, request) dispatchWithResponse:response];
  return response;
}

- (nullable NSString *)errorOf:(RouteResponse *)response
{
  id value = [NSJSONSerialization JSONObjectWithData:response.responseData options:0 error:nil][@"value"];
  return [value isKindOfClass:NSDictionary.class] ? value[@"error"] : nil;
}

- (void)assertInvalidBundleIdResponse:(RouteResponse *)response message:(NSString *)message
{
  XCTAssertEqual(response.statusCode, 400, @"%@", message);
  XCTAssertEqualObjects([self errorOf:response], @"invalid argument", @"%@", message);
}

- (nullable id)valueOfSuccessfulResponse:(RouteResponse *)response message:(NSString *)message
{
  XCTAssertEqual(response.statusCode, 200, @"%@", message);
  NSError *error;
  NSDictionary *body = [NSJSONSerialization JSONObjectWithData:response.responseData options:0 error:&error];
  XCTAssertNil(error, @"%@", message);
  XCTAssertTrue([body isKindOfClass:NSDictionary.class], @"%@", message);
  return body[@"value"];
}

// Puts the stubs above in place of the XCUIDevice methods /url calls, until the test ends.
- (void)stubOpenUrl
{
  void (^swapMethods)(void) = ^{
    FBReplaceMethod(XCUIDevice.class, @selector(fb_openUrl:error:), @selector(fbtest_openUrl:error:));
    FBReplaceMethod(XCUIDevice.class,
                    @selector(fb_openUrl:withApplication:error:),
                    @selector(fbtest_openUrl:withApplication:error:));
  };
  swapMethods();
  [self addTeardownBlock:swapMethods];
  FBOpenedUrls = [NSMutableArray array];
}

// Maps each /wda/apps handler to its expected response value when using FBAppsSessionDouble
- (NSDictionary<NSString *, id> *)appHandlers
{
  return @{
    NSStringFromSelector(@selector(handleSessionAppLaunch:)): NSNull.null,
    NSStringFromSelector(@selector(handleSessionAppActivate:)): NSNull.null,
    NSStringFromSelector(@selector(handleSessionAppTerminate:)): @NO,
    NSStringFromSelector(@selector(handleSessionAppState:)): @0,
  };
}

// Values that are not bundle identifiers: not a string, empty, or with a character Apple does not allow
- (NSArray *)invalidBundleIds
{
  return @[NSNull.null, @42, @[@"com.apple.Preferences"], @"", @"com.example app", @"com.example_app", @"com.exämple.app"];
}

- (void)testAppCommandsRejectMissingOrInvalidBundleId
{
  NSMutableArray<NSDictionary *> *argumentsList = [NSMutableArray arrayWithObject:@{}];
  for (id bundleId in self.invalidBundleIds) {
    [argumentsList addObject:@{@"bundleId": bundleId}];
  }
  for (NSString *handler in self.appHandlers) {
    for (NSDictionary *arguments in argumentsList) {
      FBAppsSessionDouble *session = [FBAppsSessionDouble new];
      RouteResponse *response = [self responseOf:NSSelectorFromString(handler) arguments:arguments session:session];
      NSString *message = [NSString stringWithFormat:@"%@ with %@", handler, arguments];
      [self assertInvalidBundleIdResponse:response message:message];
      XCTAssertEqual(session.receivedBundleIds.count, 0, @"%@", message);
    }
  }
}

- (void)testAppCommandsPassValidBundleIdToSession
{
  NSDictionary<NSString *, id> *handlers = self.appHandlers;
  for (NSString *handler in handlers) {
    id expectedValue = handlers[handler];
    for (NSString *bundleId in @[@"com.apple.Preferences", @"io.appium.Test-App2"]) {
      FBAppsSessionDouble *session = [FBAppsSessionDouble new];
      RouteResponse *response = [self responseOf:NSSelectorFromString(handler)
                                       arguments:@{@"bundleId": bundleId}
                                         session:session];
      NSString *message = [NSString stringWithFormat:@"%@ with '%@'", handler, bundleId];
      id value = [self valueOfSuccessfulResponse:response message:message];
      XCTAssertEqualObjects(value, expectedValue, @"%@", message);
      XCTAssertEqual(FBIsBoolean(value), FBIsBoolean(expectedValue), @"%@", message);
      XCTAssertEqualObjects(session.receivedBundleIds, @[bundleId], @"%@", message);
    }
  }
}

- (void)testOpenURLRejectsInvalidBundleId
{
  [self stubOpenUrl];
  for (id bundleId in self.invalidBundleIds) {
    RouteResponse *response = [self responseOf:@selector(handleOpenURL:)
                                     arguments:@{@"url": @"https://appium.io", @"bundleId": bundleId}
                                       session:nil];
    [self assertInvalidBundleIdResponse:response message:[NSString stringWithFormat:@"/url with %@", bundleId]];
  }
  XCTAssertEqual(FBOpenedUrls.count, 0);
}

- (void)testOpenURLWithoutBundleIdUsesDefaultApplication
{
  [self stubOpenUrl];
  RouteResponse *response = [self responseOf:@selector(handleOpenURL:)
                                   arguments:@{@"url": @"https://appium.io"}
                                     session:nil];
  XCTAssertEqualObjects([self valueOfSuccessfulResponse:response message:@"/url without bundleId"], NSNull.null);
  XCTAssertEqualObjects(FBOpenedUrls, @[@[@"https://appium.io"]]);
}

- (void)testOpenURLWithBundleIdUsesThatApplication
{
  [self stubOpenUrl];
  RouteResponse *response = [self responseOf:@selector(handleOpenURL:)
                                   arguments:@{@"url": @"https://appium.io", @"bundleId": @"com.apple.Preferences"}
                                     session:nil];
  XCTAssertEqualObjects([self valueOfSuccessfulResponse:response message:@"/url with bundleId"], NSNull.null);
  XCTAssertEqualObjects(FBOpenedUrls, (@[@[@"https://appium.io", @"com.apple.Preferences"]]));
}

- (void)testCreateSessionWithoutBundleIdCapability
{
  // The session information reads UIDevice, which can wait tens of seconds on a simulator that has just booted
  Class metaClass = object_getClass(FBSessionCommands.class);
  FBReplaceMethod(metaClass, @selector(currentCapabilities), @selector(fbtest_currentCapabilities));
  [self addTeardownBlock:^{
    FBReplaceMethod(metaClass, @selector(currentCapabilities), @selector(fbtest_currentCapabilities));
    [FBSession.activeSession kill];
  }];
  // Skips the private keyboard API, which this test does not cover
  NSDictionary *capabilities = @{FB_CAP_FORCE_SIMULATOR_SOFTWARE_KEYBOARD_PRESENCE: @NO};
  RouteResponse *response = [self responseOf:@selector(handleCreateSession:)
                                   arguments:@{@"capabilities": @{@"alwaysMatch": capabilities}}
                                     session:nil];
  NSDictionary *value = [self valueOfSuccessfulResponse:response message:@"/session without bundleId"];
  XCTAssertNotNil(FBSession.activeSession.identifier);
  XCTAssertEqualObjects(value[@"sessionId"], FBSession.activeSession.identifier);
}

- (void)testCreateSessionRejectsInvalidBundleIdCapability
{
  for (id bundleId in self.invalidBundleIds) {
    RouteResponse *response = [self responseOf:@selector(handleCreateSession:)
                                     arguments:@{@"capabilities": @{@"alwaysMatch": @{@"bundleId": bundleId}}}
                                       session:nil];
    NSString *message = [NSString stringWithFormat:@"/session with %@", bundleId];
    // Like the other capability errors of this handler
    XCTAssertEqual(response.statusCode, 500, @"%@", message);
    XCTAssertEqualObjects([self errorOf:response], @"session not created", @"%@", message);
    XCTAssertNil(FBSession.activeSession, @"%@", message);
  }
}

@end
