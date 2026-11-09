/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBMjpegServer.h"

#import <mach/mach_time.h>
@import UniformTypeIdentifiers;

// Textual import, not `@import Network;` - see the comment in FBTCPSocket.h.
#import <Network/Network.h>
#import "FBConfiguration.h"
#import "FBErrorBuilder.h"
#import "FBLogger.h"
#import "FBScreenshot.h"
#import "FBScreen.h"
#import "FBImageProcessor.h"
#import "FBImageUtils.h"
#import "XCUIScreen.h"

static const NSUInteger MAX_FPS = 60;
static const NSTimeInterval FRAME_TIMEOUT = 1.;
// A frame that misses FRAME_TIMEOUT is still awaited this long (testmanagerd answers it after its snapshot).
static const uint64_t LATE_FRAME_LIMIT = 10 * NSEC_PER_SEC;
// nw_connection_send buffers without backpressure, so a client that stops reading would retain
// every generated frame. Frames past this cap are dropped instead of queued.
static const NSUInteger MAX_PENDING_FRAMES_PER_CLIENT = 4;
static const NSTimeInterval FAILURE_BACKOFF_MIN = 1.0;
static const NSTimeInterval FAILURE_BACKOFF_MAX = 10.0;
// The screen lookup is a round trip to testmanagerd, so it is not repeated for every frame.
static const uint64_t SCREEN_REFRESH_INTERVAL = 3 * NSEC_PER_SEC;

static NSString *const SERVER_NAME = @"WDA MJPEG Server";
static const char *QUEUE_NAME = "JPEG Screenshots Provider Queue";

static NSUInteger FBNormalizedMjpegFramerate(NSUInteger framerate)
{
  return (0 == framerate || framerate > MAX_FPS) ? MAX_FPS : framerate;
}

// A screenshot request whose answer may arrive after the stream stopped waiting for it.
@interface FBMjpegPendingFrame : NSObject
@property (nonatomic, readonly, nullable) NSData *data;
@property (nonatomic, readonly, nullable) NSError *error;
@property (nonatomic, readonly) BOOL isExpired;
- (void)fulfillWithData:(nullable NSData *)data error:(nullable NSError *)error;
// Returns NO if there is no answer yet.
- (BOOL)waitWithTimeout:(NSTimeInterval)timeout;
@end

@implementation FBMjpegPendingFrame {
  dispatch_semaphore_t _answered;
  uint64_t _timeRequested;
}

- (instancetype)init
{
  if ((self = [super init])) {
    _answered = dispatch_semaphore_create(0);
    _timeRequested = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
  }
  return self;
}

- (BOOL)isExpired
{
  return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) - _timeRequested >= LATE_FRAME_LIMIT;
}

// The result is written before the signal and read only after the wait succeeds.
- (void)fulfillWithData:(NSData *)data error:(NSError *)error
{
  _data = data;
  _error = error;
  dispatch_semaphore_signal(_answered);
}

- (BOOL)waitWithTimeout:(NSTimeInterval)timeout
{
  return 0 == dispatch_semaphore_wait(_answered, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(timeout * NSEC_PER_SEC)));
}

@end


@interface FBMjpegServer()

@property (nonatomic, readonly) dispatch_queue_t backgroundQueue;
@property (nonatomic, readonly) NSMutableArray<nw_connection_t> *listeningClients;
@property (nonatomic, readonly) FBImageProcessor *imageProcessor;
@property (nonatomic, assign) NSUInteger consecutiveScreenshotFailures;
@property (atomic, assign) BOOL isStreaming;
@property (nonatomic, assign) NSUInteger sentFramesCount;
@property (nonatomic, assign) NSUInteger sentBytesCount;
@property (nonatomic, assign) NSUInteger droppedFramesCount;
// Touched only on backgroundQueue.
@property (nonatomic, strong, nullable) XCUIScreen *cachedScreen;
@property (nonatomic, strong, nullable) NSNumber *cachedScreenDisplayId;
@property (nonatomic, assign) uint64_t cachedScreenTimestamp;
// The request that missed FRAME_TIMEOUT and is still awaited. Touched only on backgroundQueue.
@property (nonatomic, strong, nullable) FBMjpegPendingFrame *pendingFrame;
// Frames submitted but not sent yet, per client. Guarded by @synchronized (self.listeningClients).
@property (nonatomic, readonly) NSMapTable<id, NSNumber *> *pendingFrameCounts;

@end


@implementation FBMjpegServer

- (instancetype)init
{
  if ((self = [super init])) {
    _consecutiveScreenshotFailures = 0;
    _isStreaming = YES;
    _sentFramesCount = 0;
    _sentBytesCount = 0;
    _listeningClients = [NSMutableArray array];
    _pendingFrameCounts = [NSMapTable mapTableWithKeyOptions:(NSPointerFunctionsOptions)(NSMapTableObjectPointerPersonality | NSMapTableStrongMemory)
                                                valueOptions:(NSPointerFunctionsOptions)NSMapTableStrongMemory];
    _imageProcessor = [[FBImageProcessor alloc] init];
    dispatch_queue_attr_t queueAttributes = dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_UTILITY, 0);
    _backgroundQueue = dispatch_queue_create(QUEUE_NAME, queueAttributes);
    __weak typeof(self) weakSelf = self;
    dispatch_async(_backgroundQueue, ^{
      [weakSelf streamScreenshot];
    });
  }
  return self;
}

- (void)scheduleNextScreenshotWithInterval:(uint64_t)timerInterval timeStarted:(uint64_t)timeStarted
{
  if (!self.isStreaming) {
    return;
  }
  uint64_t timeElapsed = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) - timeStarted;
  int64_t nextTickDelta = (int64_t)timerInterval - (int64_t)timeElapsed;
  __weak typeof(self) weakSelf = self;
  if (nextTickDelta > 0) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, nextTickDelta), self.backgroundQueue, ^{
      [weakSelf streamScreenshot];
    });
  } else {
    // Try to do our best to keep the FPS at a decent level
    dispatch_async(self.backgroundQueue, ^{
      [weakSelf streamScreenshot];
    });
  }
}

- (nullable XCUIScreen *)currentScreenWithError:(NSError **)error
{
  NSNumber *displayId = FBConfiguration.sharedInstance.currentDisplayId;
  uint64_t now = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
  BOOL isCacheValid = nil != self.cachedScreen
    && (displayId == self.cachedScreenDisplayId || [displayId isEqual:self.cachedScreenDisplayId])
    && now - self.cachedScreenTimestamp < SCREEN_REFRESH_INTERVAL;
  if (isCacheValid) {
    return self.cachedScreen;
  }
  // Resolve with the captured id, so the cache key always matches the cached screen.
  self.cachedScreen = nil == displayId
    ? XCUIScreen.mainScreen
    : [FBScreen screenWithDisplayID:displayId.longLongValue error:error];
  self.cachedScreenDisplayId = displayId;
  self.cachedScreenTimestamp = now;
  return self.cachedScreen;
}

- (nullable FBMjpegPendingFrame *)requestFrameWithError:(NSError **)error
{
  XCUIScreen *screen = [self currentScreenWithError:error];
  if (nil == screen) {
    return nil;
  }
  CGFloat compressionQuality = MAX(FBMinCompressionQuality,
                                   MIN(FBMaxCompressionQuality, (double)FBConfiguration.sharedInstance.mjpegServerScreenshotQuality / 100.0));
  FBMjpegPendingFrame *frame = [[FBMjpegPendingFrame alloc] init];
  BOOL isRequested = [FBScreenshot requestInOriginalResolutionWithScreenID:screen.displayID
                                                        compressionQuality:compressionQuality
                                                                       uti:UTTypeJPEG
                                                                completion:^(NSData *data, NSError *err) {
    [frame fulfillWithData:data error:err];
  }
                                                                     error:error];
  return isRequested ? frame : nil;
}

- (void)handleScreenshotFailure:(nullable NSError *)error timeStarted:(uint64_t)timeStarted
{
  self.cachedScreen = nil;
  [FBLogger logFmt:@"%@", error.description];
  self.consecutiveScreenshotFailures++;
  NSTimeInterval backoffSeconds = MIN(FAILURE_BACKOFF_MAX,
                                      FAILURE_BACKOFF_MIN * (1 << MIN(self.consecutiveScreenshotFailures, 4)));
  uint64_t backoffInterval = (uint64_t)(backoffSeconds * NSEC_PER_SEC);
  [self scheduleNextScreenshotWithInterval:backoffInterval timeStarted:timeStarted];
}

- (void)streamScreenshot
{
  if (!self.isStreaming) {
    return;
  }
  NSUInteger framerate = FBNormalizedMjpegFramerate(FBConfiguration.sharedInstance.mjpegServerFramerate);
  uint64_t timerInterval = (uint64_t)(1.0 / (double)framerate * NSEC_PER_SEC);
  uint64_t timeStarted = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
  @synchronized (self.listeningClients) {
    if (0 == self.listeningClients.count) {
      self.pendingFrame = nil;
      [self scheduleNextScreenshotWithInterval:timerInterval timeStarted:timeStarted];
      return;
    }
  }

  NSError *error;
  FBMjpegPendingFrame *frame = self.pendingFrame ?: [self requestFrameWithError:&error];
  self.pendingFrame = nil;
  if (nil != frame) {
    if ([frame waitWithTimeout:FRAME_TIMEOUT]) {
      error = frame.error;
    } else if (!frame.isExpired) {
      // No other request while this one is unanswered; keep waiting for it right away.
      self.pendingFrame = frame;
      [self scheduleNextScreenshotWithInterval:0 timeStarted:timeStarted];
      return;
    } else {
      [[[FBErrorBuilder builder]
        withDescriptionFormat:@"Cannot take a screenshot within %@ s timeout", @(LATE_FRAME_LIMIT / NSEC_PER_SEC)]
       buildError:&error];
      frame = nil;
    }
  }

  NSData *screenshotData = frame.data;
  if (nil == screenshotData) {
    [self handleScreenshotFailure:error timeStarted:timeStarted];
    return;
  }

  self.consecutiveScreenshotFailures = 0;

  CGFloat scalingFactor = FBConfiguration.sharedInstance.mjpegScalingFactor / 100.0;
  __weak typeof(self) weakSelf = self;
  [self.imageProcessor submitImageData:screenshotData
                         scalingFactor:scalingFactor
                     completionHandler:^(NSData * _Nonnull scaled) {
    [weakSelf sendScreenshot:scaled];
  }];

  [self scheduleNextScreenshotWithInterval:timerInterval timeStarted:timeStarted];
}

- (void)sendScreenshot:(NSData *)screenshotData {
  if (!self.isStreaming) {
    return;
  }
  NSString *chunkHeader = [NSString stringWithFormat:@"--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: %@\r\n\r\n", @(screenshotData.length)];
  NSMutableData *chunk = [[chunkHeader dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
  [chunk appendData:screenshotData];
  [chunk appendData:(id)[@"\r\n\r\n" dataUsingEncoding:NSUTF8StringEncoding]];
  @synchronized (self.listeningClients) {
    if (!self.isStreaming || 0 == self.listeningClients.count) {
      return;
    }
    NSUInteger clientCount = self.listeningClients.count;
    __weak typeof(self) weakSelf = self;
    for (nw_connection_t client in self.listeningClients) {
      NSUInteger pendingFrames = [self.pendingFrameCounts objectForKey:client].unsignedIntegerValue;
      if (pendingFrames >= MAX_PENDING_FRAMES_PER_CLIENT) {
        self.droppedFramesCount++;
        continue;
      }
      [self.pendingFrameCounts setObject:@(pendingFrames + 1) forKey:client];
      [self.socket writeData:chunk toClient:client completion:^(BOOL didSucceed) {
        __strong typeof(weakSelf) strongSelf = weakSelf;
        if (nil == strongSelf) {
          return;
        }
        @synchronized (strongSelf.listeningClients) {
          NSUInteger stillPending = [strongSelf.pendingFrameCounts objectForKey:client].unsignedIntegerValue;
          if (stillPending > 1) {
            [strongSelf.pendingFrameCounts setObject:@(stillPending - 1) forKey:client];
          } else {
            [strongSelf.pendingFrameCounts removeObjectForKey:client];
          }
        }
      }];
    }
    self.sentFramesCount++;
    self.sentBytesCount += chunk.length * clientCount;
    NSUInteger framerate = FBNormalizedMjpegFramerate(FBConfiguration.sharedInstance.mjpegServerFramerate);
    if (0 == self.sentFramesCount % framerate) {
      [FBLogger verboseLog:[NSString stringWithFormat:@"MJPEG stats: clients=%@ sentFrames=%@ sentBytes=%@ droppedFrames=%@",
                            @(clientCount),
                            @(self.sentFramesCount),
                            @(self.sentBytesCount),
                            @(self.droppedFramesCount)]];
    }
  }
}

- (void)didClientConnect:(nw_connection_t)newClient
{
  [FBLogger log:@"Got screenshots broadcast client connection"];
  // FBTCPSocket already schedules the receive that -client:didReceiveData: relies on below.
}

- (void)client:(nw_connection_t)client didReceiveData:(NSData *)data
{
  @synchronized (self.listeningClients) {
    if ([self.listeningClients containsObject:client]) {
      return;
    }
  }

  [FBLogger log:@"Starting screenshots broadcast for the client"];
  NSString *streamHeader = [NSString stringWithFormat:@"HTTP/1.0 200 OK\r\nServer: %@\r\nConnection: close\r\nMax-Age: 0\r\nExpires: 0\r\nCache-Control: no-cache, private\r\nPragma: no-cache\r\nContent-Type: multipart/x-mixed-replace; boundary=--BoundaryString\r\n\r\n", SERVER_NAME];
  [self.socket writeData:(id)[streamHeader dataUsingEncoding:NSUTF8StringEncoding] toClient:client];
  @synchronized (self.listeningClients) {
    [self.listeningClients addObject:client];
  }
}

- (void)didClientDisconnect:(nw_connection_t)client
{
  @synchronized (self.listeningClients) {
    [self.listeningClients removeObject:client];
    [self.pendingFrameCounts removeObjectForKey:client];
  }
  // Nothing is owed to a client that stopped listening, so its socket can go right away.
  nw_connection_cancel(client);
  [FBLogger log:@"Disconnected a client from screenshots broadcast"];
}

- (void)stopStreaming
{
  self.isStreaming = NO;
  @synchronized (self.listeningClients) {
    NSArray<nw_connection_t> *clients = self.listeningClients.copy;
    [self.listeningClients removeAllObjects];
    [self.pendingFrameCounts removeAllObjects];
    for (nw_connection_t client in clients) {
      nw_connection_cancel(client);
    }
  }
}

- (void)dealloc
{
  [self stopStreaming];
  [FBLogger verboseLog:@"FBMjpegServer deallocated"];
}

@end
