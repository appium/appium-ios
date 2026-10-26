/**
 *
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBScreenRecordingContainer.h"

#import "FBLogger.h"
#import "FBScreenRecordingPromise.h"

@implementation FBScreenRecordingContainer

@synthesize fps = _fps;
@synthesize codec = _codec;
@synthesize screenRecordingPromise = _screenRecordingPromise;
@synthesize startedAt = _startedAt;

+ (instancetype)sharedInstance
{
  static FBScreenRecordingContainer *instance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    instance = [[self alloc] init];
  });
  return instance;
}

- (NSUInteger)fps
{
  @synchronized (self) {
    return _fps;
  }
}

- (long long)codec
{
  @synchronized (self) {
    return _codec;
  }
}

- (nullable FBScreenRecordingPromise *)screenRecordingPromise
{
  @synchronized (self) {
    return _screenRecordingPromise;
  }
}

- (nullable NSNumber *)startedAt
{
  @synchronized (self) {
    return _startedAt;
  }
}

- (void)storeScreenRecordingPromise:(FBScreenRecordingPromise *)screenRecordingPromise
                                fps:(NSUInteger)fps
                              codec:(long long)codec;
{
  @synchronized (self) {
    _fps = fps;
    _codec = codec;
    _screenRecordingPromise = screenRecordingPromise;
    _startedAt = @([NSDate.date timeIntervalSince1970]);
  }
}

- (nullable FBScreenRecordingPromise *)detachPromiseMatching:(nullable FBScreenRecordingPromise *)expectedPromise
                                                requireMatch:(BOOL)requireMatch
                                                    didReset:(nullable BOOL *)didReset
{
  @synchronized (self) {
    if (requireMatch && _screenRecordingPromise != expectedPromise) {
      if (NULL != didReset) {
        *didReset = NO;
      }
      return nil;
    }
    FBScreenRecordingPromise *detachedPromise = _screenRecordingPromise;
    _fps = 0;
    _codec = 0;
    _screenRecordingPromise = nil;
    _startedAt = nil;
    if (NULL != didReset) {
      *didReset = YES;
    }
    return detachedPromise;
  }
}

- (void)cleanupDetachedPromise:(nullable FBScreenRecordingPromise *)promise
{
  if (nil == promise) {
    return;
  }
  @try {
    [XCTContext runActivityNamed:@"Video Cleanup" block:^(id<XCTActivity> activity){
      [activity addAttachment:(XCTAttachment *)promise.nativePromise];
    }];
  } @catch (NSException *exception) {
    [FBLogger logFmt:@"Failed to clean up screen recording attachment: %@", exception.reason];
  }
}

- (void)reset;
{
  FBScreenRecordingPromise *detachedPromise = [self detachPromiseMatching:nil
                                                             requireMatch:NO
                                                                 didReset:NULL];
  [self cleanupDetachedPromise:detachedPromise];
}

- (BOOL)resetIfPromiseIs:(FBScreenRecordingPromise *)screenRecordingPromise
{
  BOOL didReset = NO;
  FBScreenRecordingPromise *detachedPromise = [self detachPromiseMatching:screenRecordingPromise
                                                             requireMatch:YES
                                                                 didReset:&didReset];
  if (!didReset) {
    return NO;
  }
  [self cleanupDetachedPromise:detachedPromise];
  return YES;
}

- (nullable NSDictionary *)toDictionary
{
  @synchronized (self) {
    if (nil == _screenRecordingPromise) {
      return nil;
    }

    return @{
      @"fps": @(_fps),
      @"codec": @(_codec),
      @"uuid": [_screenRecordingPromise identifier].UUIDString ?: [NSNull null],
      @"startedAt": _startedAt ?: [NSNull null],
    };
  }
}

@end
