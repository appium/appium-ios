/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBConfiguration.h"
#import "FBMjpegServer.h"
#import "FBTCPSocket.h"

typedef void (^FBFrameCompletion)(NSData * _Nullable, NSError * _Nullable);

// Redeclared here, the implementations live in FBMjpegServer.m.
@interface FBMjpegServer (Testing)
@property (atomic, copy) BOOL (^frameRequest)(FBFrameCompletion completion, NSError **error);
@property (atomic, assign) NSTimeInterval frameTimeout;
@property (atomic, assign) NSTimeInterval lateFrameLimit;
@property (atomic, assign) NSTimeInterval failureBackoffMin;
- (void)sendScreenshot:(NSData *)screenshotData forFrame:(id)frame;
@end

@interface NSObject (FBMjpegPendingFrameTesting)
- (instancetype)initWithEpoch:(NSUInteger)epoch displayId:(nullable NSNumber *)displayId;
@end

// Counts the frames that reach a client instead of writing them anywhere.
@interface FBMjpegRecordingSocket : FBTCPSocket
@property (atomic, assign) NSUInteger framesCount;
@end

@implementation FBMjpegRecordingSocket

- (void)writeData:(NSData *)data toClient:(nw_connection_t)client
{
}

- (void)writeData:(NSData *)data toClient:(nw_connection_t)client completion:(void (^)(BOOL))completion
{
  self.framesCount++;
  if (nil != completion) {
    completion(YES);
  }
}

@end


@interface FBMjpegServerTests : XCTestCase
@property (nonatomic, strong) FBMjpegServer *server;
@property (nonatomic, strong) FBMjpegRecordingSocket *socket;
@property (nonatomic, strong) NSMutableArray<FBFrameCompletion> *requests;
@property (nonatomic, strong) NSLock *requestsLock;
@property (nonatomic, strong) NSData *frameData;
@property (nonatomic, strong, nullable) NSError *requestError;
@property (nonatomic, strong) NSMutableArray<id> *clients;
@end

@implementation FBMjpegServerTests

- (void)setUp
{
  [super setUp];
  self.requests = [NSMutableArray array];
  self.requestsLock = [[NSLock alloc] init];
  self.clients = [NSMutableArray array];
  self.requestError = nil;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(4, 4)];
  self.frameData = [renderer JPEGDataWithCompressionQuality:0.9 actions:^(UIGraphicsImageRendererContext *ctx) {
    [UIColor.redColor setFill];
    [ctx fillRect:CGRectMake(0, 0, 4, 4)];
  }];

  self.socket = [[FBMjpegRecordingSocket alloc] initWithPort:0];
  self.server = [[FBMjpegServer alloc] init];
  self.server.socket = self.socket;
  self.server.frameTimeout = 0.05;
  self.server.lateFrameLimit = 5;
  // The first failure waits 2 s, which is much more than any check below waits for.
  self.server.failureBackoffMin = 1.0;
  __weak typeof(self) weakSelf = self;
  self.server.frameRequest = ^BOOL(FBFrameCompletion completion, NSError **error) {
    typeof(self) strongSelf = weakSelf;
    if (nil == strongSelf) {
      return NO;
    }
    if (nil != strongSelf.requestError) {
      *error = strongSelf.requestError;
      [strongSelf recordRequest:nil];
      return NO;
    }
    [strongSelf recordRequest:completion];
    return YES;
  };
}

- (void)tearDown
{
  FBConfiguration.sharedInstance.currentDisplayId = nil;
  [self.server stopStreaming];
  [super tearDown];
}

#pragma mark - Helpers

- (void)recordRequest:(nullable FBFrameCompletion)completion
{
  [self.requestsLock lock];
  [self.requests addObject:completion ?: ^(NSData *data, NSError *error) {}];
  [self.requestsLock unlock];
}

- (NSUInteger)requestsCount
{
  [self.requestsLock lock];
  NSUInteger count = self.requests.count;
  [self.requestsLock unlock];
  return count;
}

- (FBFrameCompletion)requestAtIndex:(NSUInteger)index
{
  [self.requestsLock lock];
  FBFrameCompletion request = self.requests[index];
  [self.requestsLock unlock];
  return request;
}

- (BOOL)waitUntil:(BOOL (^)(void))condition timeout:(NSTimeInterval)timeout
{
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:timeout];
  while (!condition()) {
    if ([deadline timeIntervalSinceNow] <= 0) {
      return NO;
    }
    [NSThread sleepForTimeInterval:0.01];
  }
  return YES;
}

- (void)waitFor:(NSTimeInterval)seconds
{
  [NSThread sleepForTimeInterval:seconds];
}

- (nw_connection_t)connectClient
{
  nw_endpoint_t endpoint = nw_endpoint_create_host("127.0.0.1", "9");
  nw_parameters_t parameters = nw_parameters_create_secure_tcp(NW_PARAMETERS_DISABLE_PROTOCOL,
                                                               NW_PARAMETERS_DEFAULT_CONFIGURATION);
  // Never started, so nothing is actually connected.
  nw_connection_t client = nw_connection_create(endpoint, parameters);
  [self.clients addObject:client];
  [self.server client:client didReceiveData:[NSData data]];
  return client;
}

#pragma mark - Tests

- (void)testDoesNotRequestFramesWithoutClients
{
  [self waitFor:0.3];
  XCTAssertEqual(0, self.requestsCount);
}

- (void)testSendsAnsweredFrameAndRequestsNext
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self requestAtIndex:0](self.frameData, nil);

  XCTAssertTrue([self waitUntil:^BOOL { return self.socket.framesCount >= 1; } timeout:5]);
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:2],
                @"The next frame must be requested after an answer within the timeout");
}

- (void)testLateFrameIsSentAfterTimeoutWithoutBackoff
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  // Several frame timeouts pass with no answer.
  [self waitFor:0.4];
  XCTAssertEqual(0, self.socket.framesCount);

  [self requestAtIndex:0](self.frameData, nil);
  XCTAssertTrue([self waitUntil:^BOOL { return self.socket.framesCount >= 1; } timeout:1],
                @"The late answer must go out as a frame");
  // A backoff would keep the next request away for 2 s.
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:1],
                @"The loop must go on at once after the late frame");
}

- (void)testSendsNoOtherRequestWhileFrameIsUnanswered
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self waitFor:0.5];
  XCTAssertEqual(1, self.requestsCount);
  XCTAssertEqual(0, self.socket.framesCount);
}

- (void)testGivesUpOnFrameAfterLimitAndBacksOff
{
  self.server.lateFrameLimit = 0.2;
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self waitFor:1.0];
  XCTAssertEqual(1, self.requestsCount, @"The failed frame must back off before the next request");

  // The abandoned request is not sent even if it is answered later.
  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.2];
  XCTAssertEqual(0, self.socket.framesCount);
}

- (void)testErrorAnswerBacksOff
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  NSError *error = [NSError errorWithDomain:@"test" code:1 userInfo:nil];
  [self requestAtIndex:0](nil, error);
  [self waitFor:1.0];
  XCTAssertEqual(1, self.requestsCount);
  XCTAssertEqual(0, self.socket.framesCount);
}

- (void)testFailedRequestBacksOff
{
  self.requestError = [NSError errorWithDomain:@"test" code:2 userInfo:nil];
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self waitFor:1.0];
  XCTAssertEqual(1, self.requestsCount);
  XCTAssertEqual(0, self.socket.framesCount);
}

- (void)testDropsPendingFrameWhenLastClientLeaves
{
  nw_connection_t client = [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self.server didClientDisconnect:client];
  // Let the loop notice that nobody listens.
  [self waitFor:0.4];

  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.2];
  XCTAssertEqual(0, self.socket.framesCount, @"A frame for a vanished audience must not be kept");

  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:2],
                @"A returning client gets a fresh request");
  [self requestAtIndex:1](self.frameData, nil);
  XCTAssertTrue([self waitUntil:^BOOL { return self.socket.framesCount >= 1; } timeout:5]);
}

- (void)testDoesNotReuseFrameRequestedForPreviousListener
{
  nw_connection_t first = [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  // Swap the clients at once, before the loop sees that nobody listens.
  [self.server didClientDisconnect:first];
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:2],
                @"The new client must not wait for a frame requested for the previous one");

  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.2];
  XCTAssertEqual(0, self.socket.framesCount);
  [self requestAtIndex:1](self.frameData, nil);
  XCTAssertTrue([self waitUntil:^BOOL { return self.socket.framesCount >= 1; } timeout:5]);
}

- (void)testDoesNotReuseFrameRequestedForPreviousDisplay
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  FBConfiguration.sharedInstance.currentDisplayId = @1;
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:2],
                @"A display switch must request the frame again");

  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.2];
  XCTAssertEqual(0, self.socket.framesCount);
}

- (void)testDropsFrameAnsweredAfterListenerSwitchedWhileWaiting
{
  nw_connection_t first = [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self waitFor:0.2];
  // The frame is late now, so the next wait is a long one.
  self.server.frameTimeout = 2;
  [self waitFor:0.2];
  [self.server didClientDisconnect:first];
  [self connectClient];

  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.3];
  XCTAssertEqual(0, self.socket.framesCount, @"The answer was requested for the previous listener");
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:2],
                @"Dropping the stale answer is not a failure, no backoff");
}

- (void)testDropsFrameAnsweredAfterDisplaySwitchedWhileWaiting
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self waitFor:0.2];
  self.server.frameTimeout = 2;
  [self waitFor:0.2];
  FBConfiguration.sharedInstance.currentDisplayId = @1;

  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.3];
  XCTAssertEqual(0, self.socket.framesCount, @"The answer was requested for the previous display");
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 2; } timeout:2]);
}

- (void)testDoesNotSendFrameThatWentStaleDuringScaling
{
  [self connectClient];
  Class frameClass = NSClassFromString(@"FBMjpegPendingFrame");
  NSUInteger epoch = [[self.server valueForKey:@"listenersEpoch"] unsignedIntegerValue];

  [self.server sendScreenshot:self.frameData forFrame:[[frameClass alloc] initWithEpoch:epoch + 1 displayId:nil]];
  XCTAssertEqual(0, self.socket.framesCount, @"Other listeners");
  [self.server sendScreenshot:self.frameData forFrame:[[frameClass alloc] initWithEpoch:epoch displayId:@7]];
  XCTAssertEqual(0, self.socket.framesCount, @"Other display");
  [self.server sendScreenshot:self.frameData forFrame:[[frameClass alloc] initWithEpoch:epoch displayId:nil]];
  XCTAssertEqual(1, self.socket.framesCount);
}

- (void)testEmptyAnswerBacksOff
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self requestAtIndex:0](nil, nil);
  [self waitFor:1.0];
  XCTAssertEqual(1, self.requestsCount);
  XCTAssertEqual(0, self.socket.framesCount);
}

- (void)testStopsRequestingAfterStopStreaming
{
  [self connectClient];
  XCTAssertTrue([self waitUntil:^BOOL { return self.requestsCount >= 1; } timeout:2]);
  [self.server stopStreaming];
  [self requestAtIndex:0](self.frameData, nil);
  [self waitFor:0.3];
  XCTAssertEqual(1, self.requestsCount);
  XCTAssertEqual(0, self.socket.framesCount);
}

@end
