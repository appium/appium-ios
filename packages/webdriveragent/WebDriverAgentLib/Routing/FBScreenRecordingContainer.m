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

@interface FBScreenRecordingContainer ()

@property (readwrite) NSUInteger fps;
@property (readwrite) long long codec;
@property (readwrite) FBScreenRecordingPromise* screenRecordingPromise;
@property (readwrite) NSNumber *startedAt;

@end

@implementation FBScreenRecordingContainer

+ (instancetype)sharedInstance
{
  static FBScreenRecordingContainer *instance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    instance = [[self alloc] init];
  });
  return instance;
}

- (void)storeScreenRecordingPromise:(FBScreenRecordingPromise *)screenRecordingPromise
                                fps:(NSUInteger)fps
                              codec:(long long)codec;
{
  @synchronized (self) {
    self.fps = fps;
    self.codec = codec;
    self.screenRecordingPromise = screenRecordingPromise;
    self.startedAt = @([NSDate.date timeIntervalSince1970]);
  }
}

- (void)reset;
{
  FBScreenRecordingPromise *promiseToClean = nil;
  @synchronized (self) {
    promiseToClean = self.screenRecordingPromise;
    self.screenRecordingPromise = nil;
    self.fps = 0;
    self.codec = 0;
    self.startedAt = nil;
  }
  if (nil != promiseToClean) {
    [self cleanUpPromise:promiseToClean];
  }
}

- (BOOL)resetIfPromiseIs:(FBScreenRecordingPromise *)screenRecordingPromise
{
  if (nil == screenRecordingPromise) {
    return NO;
  }
  FBScreenRecordingPromise *promiseToClean = nil;
  @synchronized (self) {
    if (self.screenRecordingPromise != screenRecordingPromise) {
      return NO;
    }
    promiseToClean = self.screenRecordingPromise;
    self.screenRecordingPromise = nil;
    self.fps = 0;
    self.codec = 0;
    self.startedAt = nil;
  }
  if (nil != promiseToClean) {
    [self cleanUpPromise:promiseToClean];
  }
  return YES;
}

- (void)cleanUpPromise:(FBScreenRecordingPromise *)promise
{
  if (nil == promise.nativePromise) {
    return;
  }
  @try {
    [XCTContext runActivityNamed:@"Video Cleanup" block:^(id<XCTActivity> activity){
      [activity addAttachment:(XCTAttachment *)promise.nativePromise];
    }];
  } @catch (NSException *e) {
    [FBLogger logFmt:@"Failed to clean up video attachment: %@", e];
  }
}

- (nullable NSDictionary *)toDictionary
{
  @synchronized (self) {
    if (nil == self.screenRecordingPromise) {
      return nil;
    }

    return @{
      @"fps": @(self.fps),
      @"codec": @(self.codec),
      @"uuid": [self.screenRecordingPromise identifier].UUIDString ?: [NSNull null],
      @"startedAt": self.startedAt ?: [NSNull null],
    };
  }
}

@end
