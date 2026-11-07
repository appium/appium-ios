/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBScreenRecordingContainer.h"
#import "FBScreenRecordingPromise.h"

@interface FBTestScreenRecordingNativePromise : NSObject
@property (nonatomic, strong) NSUUID *_UUID;
@end

@implementation FBTestScreenRecordingNativePromise
- (instancetype)init
{
  if ((self = [super init])) {
    self._UUID = NSUUID.UUID;
  }
  return self;
}
@end

@interface FBTestScreenRecordingContainer : FBScreenRecordingContainer
@property (nonatomic, copy, nullable) void (^onCleanup)(FBScreenRecordingPromise *promise);
@property (nonatomic) BOOL shouldThrowOnCleanup;
@property (nonatomic) NSUInteger cleanupCallCount;
@end

@implementation FBTestScreenRecordingContainer
- (void)cleanUpPromise:(FBScreenRecordingPromise *)promise
{
  self.cleanupCallCount++;
  if (self.onCleanup) {
    self.onCleanup(promise);
  }
  if (self.shouldThrowOnCleanup) {
    @throw [NSException exceptionWithName:@"TestCleanupException"
                                   reason:@"Attachment cleanup failed"
                                 userInfo:nil];
  }
  [super cleanUpPromise:promise];
}
@end

@interface FBScreenRecordingContainerTests : XCTestCase
@property (nonatomic, strong) FBTestScreenRecordingContainer *container;
@end

@implementation FBScreenRecordingContainerTests

- (void)setUp
{
  [super setUp];
  self.container = [[FBTestScreenRecordingContainer alloc] init];
}

- (void)tearDown
{
  [self.container reset];
  self.container = nil;
  [super tearDown];
}

- (FBScreenRecordingPromise *)createPromise
{
  FBTestScreenRecordingNativePromise *native = [[FBTestScreenRecordingNativePromise alloc] init];
  return [[FBScreenRecordingPromise alloc] initWithNativePromise:native];
}

- (void)testStoreScreenRecordingPromiseAndReset
{
  FBScreenRecordingPromise *promise = [self createPromise];
  [self.container storeScreenRecordingPromise:promise fps:24 codec:0];

  XCTAssertEqual(self.container.screenRecordingPromise, promise);
  XCTAssertEqual(self.container.fps, (NSUInteger)24);
  XCTAssertEqual(self.container.codec, 0LL);
  XCTAssertNotNil(self.container.startedAt);

  NSDictionary *dict = [self.container toDictionary];
  XCTAssertNotNil(dict);
  XCTAssertEqualObjects(dict[@"fps"], @24);
  XCTAssertEqualObjects(dict[@"codec"], @0);
  XCTAssertEqualObjects(dict[@"uuid"], promise.identifier.UUIDString);

  [self.container reset];

  XCTAssertNil(self.container.screenRecordingPromise);
  XCTAssertEqual(self.container.fps, (NSUInteger)0);
  XCTAssertEqual(self.container.codec, 0LL);
  XCTAssertNil(self.container.startedAt);
  XCTAssertNil([self.container toDictionary]);
  XCTAssertEqual(self.container.cleanupCallCount, (NSUInteger)1);
}

- (void)testCleanupFailureDoesNotRetainStaleActiveState
{
  FBScreenRecordingPromise *promise = [self createPromise];
  [self.container storeScreenRecordingPromise:promise fps:30 codec:1];
  self.container.shouldThrowOnCleanup = YES;

  // reset should complete and container state must be cleared even if cleanup fails
  XCTAssertThrowsSpecificNamed([self.container reset], NSException, @"TestCleanupException");

  XCTAssertNil(self.container.screenRecordingPromise);
  XCTAssertEqual(self.container.fps, (NSUInteger)0);
  XCTAssertEqual(self.container.codec, 0LL);
  XCTAssertNil(self.container.startedAt);
  XCTAssertNil([self.container toDictionary]);

  // Subsequent store should work immediately and not see stale state
  FBScreenRecordingPromise *nextPromise = [self createPromise];
  self.container.shouldThrowOnCleanup = NO;
  [self.container storeScreenRecordingPromise:nextPromise fps:60 codec:0];

  XCTAssertEqual(self.container.screenRecordingPromise, nextPromise);
  XCTAssertEqual(self.container.fps, (NSUInteger)60);
  XCTAssertNotNil([self.container toDictionary]);
}

- (void)testStateVisibilityDuringCleanupIsCompletelyClean
{
  FBScreenRecordingPromise *promise = [self createPromise];
  [self.container storeScreenRecordingPromise:promise fps:24 codec:0];

  __weak typeof(self) weakSelf = self;
  self.container.onCleanup = ^(FBScreenRecordingPromise *p) {
    __strong typeof(weakSelf) strongSelf = weakSelf;
    XCTAssertEqual(p, promise);
    // While cleanup is running outside the lock, all container state must already be cleared
    XCTAssertNil(strongSelf.container.screenRecordingPromise);
    XCTAssertEqual(strongSelf.container.fps, (NSUInteger)0);
    XCTAssertEqual(strongSelf.container.codec, 0LL);
    XCTAssertNil(strongSelf.container.startedAt);
    XCTAssertNil([strongSelf.container toDictionary]);
  };

  [self.container reset];
  XCTAssertEqual(self.container.cleanupCallCount, (NSUInteger)1);
}

- (void)testConcurrentReplacementDuringCleanupPreservesNewRecording
{
  FBScreenRecordingPromise *promise1 = [self createPromise];
  FBScreenRecordingPromise *promise2 = [self createPromise];
  [self.container storeScreenRecordingPromise:promise1 fps:24 codec:0];

  __weak typeof(self) weakSelf = self;
  self.container.onCleanup = ^(FBScreenRecordingPromise *p) {
    __strong typeof(weakSelf) strongSelf = weakSelf;
    // Simulate a replacement recording stored while cleanup of promise1 is in progress
    [strongSelf.container storeScreenRecordingPromise:promise2 fps:60 codec:1];
    XCTAssertEqual(strongSelf.container.screenRecordingPromise, promise2);
  };

  BOOL didReset = [self.container resetIfPromiseIs:promise1];
  XCTAssertTrue(didReset);

  // After cleanup finishes, the newly stored recording must NOT be cleared or clobbered
  XCTAssertEqual(self.container.screenRecordingPromise, promise2);
  XCTAssertEqual(self.container.fps, (NSUInteger)60);
  XCTAssertEqual(self.container.codec, 1LL);
  XCTAssertNotNil(self.container.startedAt);

  NSDictionary *dict = [self.container toDictionary];
  XCTAssertNotNil(dict);
  XCTAssertEqualObjects(dict[@"fps"], @60);
  XCTAssertEqualObjects(dict[@"codec"], @1);
  XCTAssertEqualObjects(dict[@"uuid"], promise2.identifier.UUIDString);
}

- (void)testPromiseIdentityCheckRejectsStalePromise
{
  FBScreenRecordingPromise *stalePromise = [self createPromise];
  FBScreenRecordingPromise *activePromise = [self createPromise];

  [self.container storeScreenRecordingPromise:activePromise fps:24 codec:0];

  // Attempting to reset with a stale promise must return NO and not clear active recording
  BOOL didReset = [self.container resetIfPromiseIs:stalePromise];
  XCTAssertFalse(didReset);
  XCTAssertEqual(self.container.screenRecordingPromise, activePromise);
  XCTAssertEqual(self.container.fps, (NSUInteger)24);
  XCTAssertEqual(self.container.cleanupCallCount, (NSUInteger)0);

  // Passing nil should also be safely rejected
  didReset = [self.container resetIfPromiseIs:nil];
  XCTAssertFalse(didReset);
  XCTAssertEqual(self.container.screenRecordingPromise, activePromise);
  XCTAssertEqual(self.container.cleanupCallCount, (NSUInteger)0);

  // Calling with the active promise succeeds
  didReset = [self.container resetIfPromiseIs:activePromise];
  XCTAssertTrue(didReset);
  XCTAssertNil(self.container.screenRecordingPromise);
  XCTAssertEqual(self.container.cleanupCallCount, (NSUInteger)1);
}

@end
