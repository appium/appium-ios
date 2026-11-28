/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBSession.h"
#import "FBSession-Private.h"
#import "FBExceptions.h"
#import "FBAlert.h"
#import "FBConfiguration.h"
#import "FBScreenRecordingContainer.h"
#import "FBScreenRecordingPromise.h"
#import "XCUIApplicationDouble.h"

@interface FBSession (SystemApplicationTests)
- (BOOL)fb_isApplicationSameAsSystemApp:(XCUIApplication *)application timeout:(NSTimeInterval)timeout;
@end

@interface FBSession (AlertTests)
- (void)didDetectAlert:(FBAlert *)alert;
@end

static id (^FBSystemApplicationLookup)(void);

// Run teardown at the exact point where launch has started but the AUT has
// not yet been published. No wall-clock sleeps or simulator launch timing.
@interface FBAUTLaunchApplicationDouble : XCUIApplicationDouble
@property (nonatomic, copy) void (^duringLaunch)(void);
@property (nonatomic, copy) NSArray *launchArguments;
@property (nonatomic, copy) NSDictionary *launchEnvironment;
@property (nonatomic) BOOL didLaunch;
@end

@implementation FBAUTLaunchApplicationDouble
+ (id)fb_systemApplication
{
  return FBSystemApplicationLookup ? FBSystemApplicationLookup() : nil;
}
- (void)launch
{
  self.didLaunch = YES;
  if (self.duringLaunch) {
    self.duringLaunch();
  }
}
- (BOOL)fb_isSameAppAs:(id)application
{
  return self == application;
}
@end

@interface FBAUTTerminationFailureApplicationDouble : FBAUTLaunchApplicationDouble
@property (nonatomic) BOOL didAttemptTermination;
@end

@implementation FBAUTTerminationFailureApplicationDouble
- (void)terminate
{
  self.didAttemptTermination = YES;
  @throw [NSException exceptionWithName:@"TerminationFailure" reason:nil userInfo:nil];
}
@end

@interface FBAUTLaunchSession : FBSession
@property (nonatomic, strong) FBAUTLaunchApplicationDouble *launchApplication;
@end

@implementation FBAUTLaunchSession
- (XCUIApplication *)makeApplicationWithBundleId:(NSString *)bundleIdentifier
{
  return (id)self.launchApplication;
}
@end

// Records the alert actions instead of touching a real alert.
@interface FBRecordingAlertDouble : FBAlert
@property (nonatomic) NSUInteger acceptCalls;
@property (nonatomic) NSUInteger dismissCalls;
@property (nonatomic) NSMutableArray<NSString *> *classChains;
@property (nonatomic) BOOL shouldThrow;
@end

@implementation FBRecordingAlertDouble
- (NSMutableArray<NSString *> *)classChains
{
  if (nil == _classChains) {
    _classChains = [NSMutableArray array];
  }
  return _classChains;
}
- (void)accept
{
  self.acceptCalls++;
  if (self.shouldThrow) {
    @throw [NSException exceptionWithName:@"AlertFailure" reason:nil userInfo:nil];
  }
}
- (void)dismiss
{
  self.dismissCalls++;
  if (self.shouldThrow) {
    @throw [NSException exceptionWithName:@"AlertFailure" reason:nil userInfo:nil];
  }
}
- (void)clickElementMatchingClassChain:(NSString *)classChain
{
  [self.classChains addObject:classChain];
  if (self.shouldThrow) {
    @throw [NSException exceptionWithName:@"AlertFailure" reason:nil userInfo:nil];
  }
}
@end

@interface FBTestScreenRecordingPromise : FBScreenRecordingPromise
@property (nonatomic, strong) NSUUID *testIdentifier;
@property (nonatomic, copy, nullable) id (^onNativePromiseAccess)(void);
- (instancetype)initWithUUID:(NSUUID *)uuid
       onNativePromiseAccess:(nullable id (^)(void))onNativePromiseAccess;
@end

@implementation FBTestScreenRecordingPromise
- (instancetype)initWithUUID:(NSUUID *)uuid
       onNativePromiseAccess:(nullable id (^)(void))onNativePromiseAccess
{
  XCTAttachment *attachment = [XCTAttachment attachmentWithString:@"video"];
  if ((self = [super initWithNativePromise:attachment])) {
    _testIdentifier = uuid;
    _onNativePromiseAccess = [onNativePromiseAccess copy];
  }
  return self;
}

- (NSUUID *)identifier
{
  return self.testIdentifier;
}

- (id)nativePromise
{
  if (self.onNativePromiseAccess) {
    return self.onNativePromiseAccess();
  }
  return [super nativePromise];
}
@end

@interface FBSessionTests : XCTestCase
@property (nonatomic, strong) FBSession *session;
@property (nonatomic, strong) XCUIApplication *testedApplication;
@property (nonatomic) BOOL shouldTerminateAppValue;
@property (nonatomic) BOOL shouldRespectSystemAlertsValue;
@property (nonatomic, copy) NSString *autoClickAlertSelectorValue;
@end

@implementation FBSessionTests

- (void)setUp
{
  [super setUp];
  self.testedApplication = (id)XCUIApplicationDouble.new;
  self.shouldTerminateAppValue = FBConfiguration.sharedInstance.shouldTerminateApp;
  FBConfiguration.sharedInstance.shouldTerminateApp = NO;
  self.shouldRespectSystemAlertsValue = FBConfiguration.sharedInstance.shouldRespectSystemAlerts;
  self.autoClickAlertSelectorValue = FBConfiguration.sharedInstance.autoClickAlertSelector;
  // Keeps -activeApplication from querying the real system application
  FBConfiguration.sharedInstance.shouldRespectSystemAlerts = NO;
  FBConfiguration.sharedInstance.autoClickAlertSelector = nil;
  self.session = [FBSession initWithApplication:self.testedApplication];
}

- (void)tearDown
{
  if ([self.session isKindOfClass:FBAUTLaunchSession.class]) {
    ((FBAUTLaunchSession *)self.session).launchApplication.duringLaunch = nil;
  }
  FBSystemApplicationLookup = nil;
  [FBScreenRecordingContainer.sharedInstance reset];
  [self.session kill];
  FBConfiguration.sharedInstance.shouldTerminateApp = self.shouldTerminateAppValue;
  FBConfiguration.sharedInstance.shouldRespectSystemAlerts = self.shouldRespectSystemAlertsValue;
  FBConfiguration.sharedInstance.autoClickAlertSelector = self.autoClickAlertSelectorValue;
  [super tearDown];
}

- (void)testSessionFetching
{
  FBSession *fetchedSession = [FBSession sessionWithIdentifier:self.session.identifier];
  XCTAssertEqual(self.session, fetchedSession);
}

- (void)testSessionFetchingBadIdentifier
{
  XCTAssertNil([FBSession sessionWithIdentifier:@"FAKE_IDENTIFIER"]);
}

- (void)testSessionCreation
{
  XCTAssertNotNil(self.session.identifier);
  XCTAssertNotNil(self.session.elementCache);
}

- (void)testActiveSession
{
  XCTAssertEqual(self.session, [FBSession activeSession]);
}

- (void)testActiveSessionIsNilAfterKilling
{
  [self.session kill];
  XCTAssertNil([FBSession activeSession]);
}

- (FBAUTLaunchApplicationDouble *)prepareAUTLaunch
{
  FBAUTLaunchSession *session = [FBAUTLaunchSession new];
  session.identifier = NSUUID.UUID.UUIDString;
  session.launchApplication = [FBAUTLaunchApplicationDouble new];
  [FBSession markSessionActive:session];
  self.session = session;
  return session.launchApplication;
}

- (void)launchAsAUT
{
  [self.session launchApplicationWithBundleId:@"com.facebook.awesome"
                    shouldWaitForQuiescence:nil
                                  arguments:nil
                                environment:nil
                     asApplicationUnderTest:YES];
}

- (void)testCompletedLaunchRegistersAUT
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  XCTAssertNoThrow([self launchAsAUT]);
  XCTAssertEqual([self.session valueForKey:@"testedApplication"], app);
  XCTAssertFalse(app.didTerminate);
}

- (void)testDeletedSessionCleansUpInFlightAUTLaunch
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  FBConfiguration.sharedInstance.shouldTerminateApp = YES;
  FBSession *session = self.session;
  app.duringLaunch = ^{ [session kill]; };
  XCTAssertThrowsSpecificNamed([self launchAsAUT], NSException,
                              FBSessionDoesNotExistException);
  XCTAssertTrue(app.didTerminate);
  XCTAssertNil([self.session valueForKey:@"testedApplication"]);
  XCTAssertNil(FBSession.activeSession);
}

- (void)testTerminationFailurePreservesDeletedSessionErrorAndReleasesClaim
{
  [self prepareAUTLaunch];
  FBAUTTerminationFailureApplicationDouble *app = [FBAUTTerminationFailureApplicationDouble new];
  ((FBAUTLaunchSession *)self.session).launchApplication = app;
  FBConfiguration.sharedInstance.shouldTerminateApp = YES;
  FBSession *session = self.session;
  app.duringLaunch = ^{ [session kill]; };

  XCTAssertThrowsSpecificNamed([self launchAsAUT], NSException, FBSessionDoesNotExistException);
  XCTAssertTrue(app.didAttemptTermination);
  XCTAssertNil([self.session valueForKey:@"testedApplication"]);
  XCTAssertNil(FBSession.activeSession);

  // Creating the next session must succeed even when cleanup termination throws.
  // A leaked generation claim would make this fail with a session creation error.
  FBSession *replacement = nil;
  XCTAssertNoThrow(replacement = [FBSession initWithApplication:nil]);
  XCTAssertNotNil(replacement);
  XCTAssertEqual(FBSession.activeSession, replacement);
  [replacement kill];
}

- (void)testDeletedSessionPreservesAppWhenTerminationIsDisabled
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  FBSession *session = self.session;
  app.duringLaunch = ^{ [session kill]; };
  XCTAssertThrowsSpecificNamed([self launchAsAUT], NSException,
                              FBSessionDoesNotExistException);
  XCTAssertFalse(app.didTerminate);
}

- (void)testAbandonedAUTLaunchDoesNotTerminateReplacementSessionApp
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  FBConfiguration.sharedInstance.shouldTerminateApp = YES;
  FBSession *session = self.session;
  __block FBSession *replacement;
  app.duringLaunch = ^{
    [session kill];
    replacement = [FBSession initWithApplication:(id)app];
  };
  XCTAssertThrowsSpecificNamed([self launchAsAUT], NSException,
                              FBSessionDoesNotExistException);
  XCTAssertFalse(app.didTerminate);
  XCTAssertEqual(FBSession.activeSession, replacement);
  [replacement kill];
}

- (void)testAUTLaunchRejectsAnAlreadyDeletedSession
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  [self.session kill];
  XCTAssertThrowsSpecificNamed([self launchAsAUT], NSException,
                              FBSessionDoesNotExistException);
  XCTAssertFalse(app.didLaunch);
}

- (FBAUTLaunchApplicationDouble *)launchAsAUTWithQuiescence:(NSNumber *)shouldWaitForQuiescence
{
  return (id)[self.session launchApplicationWithBundleId:@"com.facebook.awesome"
                                 shouldWaitForQuiescence:shouldWaitForQuiescence
                                               arguments:nil
                                             environment:nil
                                  asApplicationUnderTest:YES];
}

- (void)testApplicationCanBeLaunchedAsApplicationUnderTest
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  app.state = XCUIApplicationStateRunningForeground;
  XCTAssertEqual([self launchAsAUTWithQuiescence:nil], app);
  XCTAssertEqual(self.session.activeApplication, (id)app);
  // The first app under test waits for quiescence by default
  XCTAssertTrue(app.fb_shouldWaitForQuiescence);

  // Later apps inherit the setting from the app under test
  FBAUTLaunchApplicationDouble *settingsApp = [FBAUTLaunchApplicationDouble new];
  ((FBAUTLaunchSession *)self.session).launchApplication = settingsApp;
  XCUIApplication *launched = [self.session launchApplicationWithBundleId:@"com.apple.Preferences"
                                                  shouldWaitForQuiescence:nil
                                                                arguments:nil
                                                              environment:nil];
  XCTAssertEqual(launched, (id)settingsApp);
  XCTAssertTrue(settingsApp.fb_shouldWaitForQuiescence);
  XCTAssertEqual([self.session valueForKey:@"testedApplication"], app);
}

- (void)testApplicationLaunchedAsApplicationUnderTestRespectsQuiescenceArgument
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  app.state = XCUIApplicationStateRunningForeground;
  app.fb_shouldWaitForQuiescence = YES;
  XCTAssertEqual([self launchAsAUTWithQuiescence:@NO], app);
  XCTAssertEqual(self.session.activeApplication, (id)app);
  XCTAssertFalse(app.fb_shouldWaitForQuiescence);
}

- (void)testCrashOfApplicationLaunchedAsApplicationUnderTestIsDetected
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  app.state = XCUIApplicationStateRunningForeground;
  [self launchAsAUTWithQuiescence:nil];
  XCTAssertEqual(self.session.activeApplication, (id)app);
  app.state = XCUIApplicationStateNotRunning;
  XCTAssertThrowsSpecificNamed(self.session.activeApplication, NSException, FBApplicationCrashedException);
}

- (void)testApplicationIsNotLaunchedAsApplicationUnderTestByDefault
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  // Non-default value proves the launch resets it
  app.fb_shouldWaitForQuiescence = YES;
  [self.session launchApplicationWithBundleId:@"com.facebook.awesome"
                      shouldWaitForQuiescence:nil
                                    arguments:nil
                                  environment:nil];
  XCTAssertTrue(app.didLaunch);
  XCTAssertFalse(app.fb_shouldWaitForQuiescence);
  // No tested application means a stopped app is never reported as crashed
  XCTAssertNil([self.session valueForKey:@"testedApplication"]);
  XCTAssertFalse([[self.session valueForKey:@"isTestedApplicationExpectedToRun"] boolValue]);
}

- (void)testAutoAcceptsAlert
{
  FBRecordingAlertDouble *alert = [FBRecordingAlertDouble new];
  self.session.defaultAlertAction = @"accept";
  [self.session didDetectAlert:alert];
  XCTAssertEqual(alert.acceptCalls, 1u);
  XCTAssertEqual(alert.dismissCalls, 0u);
  XCTAssertEqual(alert.classChains.count, 0u);
}

- (void)testAutoDismissesAlert
{
  FBRecordingAlertDouble *alert = [FBRecordingAlertDouble new];
  self.session.defaultAlertAction = @"dismiss";
  [self.session didDetectAlert:alert];
  XCTAssertEqual(alert.acceptCalls, 0u);
  XCTAssertEqual(alert.dismissCalls, 1u);
  XCTAssertEqual(alert.classChains.count, 0u);
}

- (void)testAutoClickSelectorTakesPriorityOverDefaultAlertAction
{
  FBRecordingAlertDouble *alert = [FBRecordingAlertDouble new];
  self.session.defaultAlertAction = @"accept";
  FBConfiguration.sharedInstance.autoClickAlertSelector = @"**/XCUIElementTypeButton[`label == \"OK\"`]";
  [self.session didDetectAlert:alert];
  XCTAssertEqualObjects(alert.classChains, @[@"**/XCUIElementTypeButton[`label == \"OK\"`]"]);
  XCTAssertEqual(alert.acceptCalls, 0u);
  XCTAssertEqual(alert.dismissCalls, 0u);
}

- (void)testUnsupportedOrMissingDefaultAlertActionDoesNothing
{
  FBRecordingAlertDouble *alert = [FBRecordingAlertDouble new];
  for (NSString *action in @[@"unsupported", @""]) {
    self.session.defaultAlertAction = action;
    XCTAssertNoThrow([self.session didDetectAlert:alert]);
  }
  self.session.defaultAlertAction = nil;
  XCTAssertNoThrow([self.session didDetectAlert:alert]);
  XCTAssertEqual(alert.acceptCalls, 0u);
  XCTAssertEqual(alert.dismissCalls, 0u);
  XCTAssertEqual(alert.classChains.count, 0u);
}

- (void)testAlertActionFailuresAreNotPropagated
{
  FBRecordingAlertDouble *alert = [FBRecordingAlertDouble new];
  alert.shouldThrow = YES;
  self.session.defaultAlertAction = @"accept";
  XCTAssertNoThrow([self.session didDetectAlert:alert]);
  self.session.defaultAlertAction = @"dismiss";
  XCTAssertNoThrow([self.session didDetectAlert:alert]);
  FBConfiguration.sharedInstance.autoClickAlertSelector = @"**/XCUIElementTypeButton";
  XCTAssertNoThrow([self.session didDetectAlert:alert]);
  XCTAssertEqual(alert.acceptCalls, 1u);
  XCTAssertEqual(alert.dismissCalls, 1u);
  XCTAssertEqual(alert.classChains.count, 1u);
}

- (void)testSystemApplicationCheckUsesSuppliedApplication
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  FBSystemApplicationLookup = ^id { return app; };
  XCTAssertTrue([self.session fb_isApplicationSameAsSystemApp:(id)app timeout:1.]);
  FBSystemApplicationLookup = ^id { return nil; };
  XCTAssertFalse([self.session fb_isApplicationSameAsSystemApp:(id)app timeout:1.]);
}

- (void)testSystemApplicationLookupExceptionSkipsTermination
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  FBConfiguration.sharedInstance.shouldTerminateApp = YES;
  FBSession *session = self.session;
  app.duringLaunch = ^{ [session kill]; };
  FBSystemApplicationLookup = ^id {
    @throw [NSException exceptionWithName:@"LookupFailure" reason:nil userInfo:nil];
  };
  XCTAssertThrowsSpecificNamed([self launchAsAUT], NSException, FBSessionDoesNotExistException);
  XCTAssertFalse(app.didTerminate);
}

- (void)testSystemApplicationLookupTimeoutSkipsTermination
{
  FBAUTLaunchApplicationDouble *app = [self prepareAUTLaunch];
  dispatch_semaphore_t releaseLookup = dispatch_semaphore_create(0);
  XCTestExpectation *finished = [self expectationWithDescription:@"System application lookup finished"];
  FBSystemApplicationLookup = ^id {
    dispatch_semaphore_wait(releaseLookup, DISPATCH_TIME_FOREVER);
    [finished fulfill];
    return nil;
  };
  @try {
    XCTAssertTrue([self.session fb_isApplicationSameAsSystemApp:(id)app timeout:0.01]);
  } @finally {
    dispatch_semaphore_signal(releaseLookup);
    [self waitForExpectationsWithTimeout:5. handler:nil];
  }
}

- (void)testScreenRecordingContainerResetClearsStateWhenCleanupThrows
{
  FBScreenRecordingContainer *container = FBScreenRecordingContainer.sharedInstance;
  FBTestScreenRecordingPromise *promise = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                       onNativePromiseAccess:^id{
    @throw [NSException exceptionWithName:@"CleanupFailure" reason:@"Simulated attachment failure" userInfo:nil];
  }];
  [container storeScreenRecordingPromise:promise fps:24 codec:0];

  XCTAssertNoThrow([container reset]);
  XCTAssertNil(container.screenRecordingPromise);
  XCTAssertNil(container.startedAt);
  XCTAssertEqual(container.fps, 0U);
  XCTAssertEqual(container.codec, 0LL);
  XCTAssertNil([container toDictionary]);
}

- (void)testScreenRecordingContainerStateIsClearedDuringCleanup
{
  FBScreenRecordingContainer *container = FBScreenRecordingContainer.sharedInstance;
  __block FBScreenRecordingPromise *promiseDuringCleanup = nil;
  __block NSNumber *startedAtDuringCleanup = nil;
  __block NSDictionary *dictionaryDuringCleanup = nil;
  XCTAttachment *attachment = [XCTAttachment attachmentWithString:@"video"];
  FBTestScreenRecordingPromise *promise = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                       onNativePromiseAccess:^id{
    promiseDuringCleanup = container.screenRecordingPromise;
    startedAtDuringCleanup = container.startedAt;
    dictionaryDuringCleanup = [container toDictionary];
    return attachment;
  }];
  [container storeScreenRecordingPromise:promise fps:24 codec:1];

  [container reset];
  XCTAssertNil(promiseDuringCleanup);
  XCTAssertNil(startedAtDuringCleanup);
  XCTAssertNil(dictionaryDuringCleanup);
}

- (void)testScreenRecordingContainerResetAllowsConcurrentReplacementDuringCleanup
{
  FBScreenRecordingContainer *container = FBScreenRecordingContainer.sharedInstance;
  FBTestScreenRecordingPromise *replacement = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                           onNativePromiseAccess:nil];
  XCTAttachment *attachment = [XCTAttachment attachmentWithString:@"video"];
  FBTestScreenRecordingPromise *initial = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                       onNativePromiseAccess:^id{
    XCTestExpectation *replacementStored = [self expectationWithDescription:@"Replacement stored during cleanup"];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      [container storeScreenRecordingPromise:replacement fps:60 codec:1];
      [replacementStored fulfill];
    });
    [self waitForExpectationsWithTimeout:2. handler:nil];
    return attachment;
  }];
  [container storeScreenRecordingPromise:initial fps:24 codec:0];

  XCTAssertTrue([container resetIfPromiseIs:initial]);
  XCTAssertEqual(container.screenRecordingPromise, replacement);
  XCTAssertEqual(container.fps, 60U);
  XCTAssertEqual(container.codec, 1LL);
  XCTAssertEqualObjects([container toDictionary][@"uuid"], replacement.identifier.UUIDString);
}

- (void)testScreenRecordingContainerStaleResetPreservesActiveRecording
{
  FBScreenRecordingContainer *container = FBScreenRecordingContainer.sharedInstance;
  __block BOOL didRunCleanup = NO;
  XCTAttachment *attachment = [XCTAttachment attachmentWithString:@"video"];
  FBTestScreenRecordingPromise *active = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                      onNativePromiseAccess:^id{
    didRunCleanup = YES;
    return attachment;
  }];
  FBTestScreenRecordingPromise *stale = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                     onNativePromiseAccess:nil];
  [container storeScreenRecordingPromise:active fps:30 codec:1];

  XCTAssertFalse([container resetIfPromiseIs:stale]);
  XCTAssertFalse(didRunCleanup);
  XCTAssertEqual(container.screenRecordingPromise, active);
  XCTAssertEqual(container.fps, 30U);
  XCTAssertEqual(container.codec, 1LL);
}

- (void)testScreenRecordingContainerResetOnEmptyContainer
{
  FBScreenRecordingContainer *container = FBScreenRecordingContainer.sharedInstance;
  [container reset];
  FBTestScreenRecordingPromise *stale = [[FBTestScreenRecordingPromise alloc] initWithUUID:NSUUID.UUID
                                                                     onNativePromiseAccess:nil];

  XCTAssertNil([container toDictionary]);
  XCTAssertNoThrow([container reset]);
  XCTAssertFalse([container resetIfPromiseIs:stale]);
  XCTAssertNil(container.screenRecordingPromise);
  XCTAssertNil(container.startedAt);
}

@end
