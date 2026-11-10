/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBGestureQueue.h"

#import <stdatomic.h>

#import "FBLogger.h"
#import "FBXCTestDaemonsProxy.h"
#import "XCSynthesizedEventRecord.h"

static atomic_int fbGesturesPending;
static atomic_int fbGesturesEnqueued;
static atomic_int fbGesturesFailed;
static atomic_int fbGesturesRejected;

static NSMutableDictionary<NSString *, NSMutableDictionary *> *fbGestureResults;
static NSMutableArray<NSString *> *fbGestureResultOrder;

static const int32_t FBMaxPendingGestures = 16;
static const NSUInteger FBMaxGestureResults = 32;
static const NSTimeInterval FBGestureResultLifetime = 60.0;

static dispatch_queue_t fbGestureQueue;
static dispatch_once_t fbGestureQueueOnce;

@implementation FBGestureQueue

+ (dispatch_queue_t)queue
{
  dispatch_once(&fbGestureQueueOnce, ^{
    fbGestureQueue = dispatch_queue_create("com.facebook.WebDriverAgent.fast-gesture",
                                          DISPATCH_QUEUE_SERIAL);
    dispatch_set_target_queue(fbGestureQueue,
                              dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0));
  });
  return fbGestureQueue;
}

+ (FBGestureEnqueueResult)enqueueEvent:(XCSynthesizedEventRecord *)event
                                  name:(NSString *)name
                             gestureId:(NSString *)gestureId
{
  if (gestureId.length > 0) {
    @synchronized([FBGestureQueue class]) {
      NSDictionary *existing = fbGestureResults[gestureId];
      if (nil != existing) {
        BOOL pending = [existing[@"state"] isEqualToString:@"pending"];
        NSTimeInterval age = [[NSDate date] timeIntervalSince1970] - [existing[@"updatedAt"] doubleValue];
        if (pending || age <= FBGestureResultLifetime) {
          atomic_fetch_add_explicit(&fbGesturesRejected, 1, memory_order_relaxed);
          return FBGestureEnqueueResultDuplicateGestureId;
        }
        [fbGestureResultOrder removeObject:gestureId];
        [fbGestureResults removeObjectForKey:gestureId];
      }
    }
  }
  if (atomic_fetch_add_explicit(&fbGesturesPending, 1, memory_order_relaxed) >= FBMaxPendingGestures) {
    atomic_fetch_sub_explicit(&fbGesturesPending, 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&fbGesturesRejected, 1, memory_order_relaxed);
    return FBGestureEnqueueResultQueueFull;
  }
  atomic_fetch_add_explicit(&fbGesturesEnqueued, 1, memory_order_relaxed);
  [self recordGesture:gestureId name:name state:@"pending" error:nil];
  dispatch_async([self queue], ^{
    NSError *error = nil;
    BOOL succeeded = [FBXCTestDaemonsProxy synthesizeEventWithRecord:event error:&error];
    if (!succeeded) {
      atomic_fetch_add_explicit(&fbGesturesFailed, 1, memory_order_relaxed);
      [FBLogger logFmt:@"Failed to synthesize the %@ event without waiting for confirmation: %@",
       name, error.localizedDescription ?: @"unknown error"];
    }
    [self recordGesture:gestureId
                   name:name
                  state:succeeded ? @"completed" : @"failed"
                  error:error];
    atomic_fetch_sub_explicit(&fbGesturesPending, 1, memory_order_relaxed);
  });
  return FBGestureEnqueueResultQueued;
}

+ (void)recordGesture:(NSString *)gestureId
                 name:(NSString *)name
                state:(NSString *)state
                error:(NSError *)error
{
  if (gestureId.length == 0) {
    return;
  }
  @synchronized([FBGestureQueue class]) {
    if (nil == fbGestureResults) {
      fbGestureResults = [NSMutableDictionary dictionary];
      fbGestureResultOrder = [NSMutableArray array];
    }
    NSMutableDictionary *result = [NSMutableDictionary dictionaryWithDictionary:@{
      @"name": name,
      @"state": state,
      @"updatedAt": @([[NSDate date] timeIntervalSince1970]),
    }];
    if (nil != error) {
      result[@"error"] = error.localizedDescription ?: @"unknown error";
    }
    if (![fbGestureResultOrder containsObject:gestureId]) {
      [fbGestureResultOrder addObject:gestureId];
    }
    fbGestureResults[gestureId] = result;
    while (fbGestureResultOrder.count > FBMaxGestureResults) {
      NSString *oldest = fbGestureResultOrder.firstObject;
      [fbGestureResultOrder removeObjectAtIndex:0];
      [fbGestureResults removeObjectForKey:oldest];
    }
  }
}

+ (void)drainWithTimeout
{
  // Wait for already queued work, but do not let a stuck daemon hold session teardown.
  dispatch_semaphore_t drained = dispatch_semaphore_create(0);
  dispatch_async([self queue], ^{
    dispatch_semaphore_signal(drained);
  });
  if (dispatch_semaphore_wait(drained,
                              dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5 * NSEC_PER_SEC))) != 0) {
    [FBLogger logFmt:@"Timed out waiting for the fast gesture queue to drain"];
  }
}

+ (void)resetSessionState
{
  @synchronized([FBGestureQueue class]) {
    [fbGestureResults removeAllObjects];
    [fbGestureResultOrder removeAllObjects];
  }
}

+ (NSDictionary *)stats
{
  NSDictionary *counters = @{
    @"pending": @(atomic_load(&fbGesturesPending)),
    @"enqueued": @(atomic_load(&fbGesturesEnqueued)),
    @"failed": @(atomic_load(&fbGesturesFailed)),
    @"rejected": @(atomic_load(&fbGesturesRejected)),
  };
  @synchronized([FBGestureQueue class]) {
    NSTimeInterval now = [[NSDate date] timeIntervalSince1970];
    for (NSString *gestureId in [fbGestureResultOrder copy]) {
      NSDictionary *result = fbGestureResults[gestureId];
      BOOL pending = [result[@"state"] isEqualToString:@"pending"];
      if (!pending && now - [result[@"updatedAt"] doubleValue] > FBGestureResultLifetime) {
        [fbGestureResultOrder removeObject:gestureId];
        [fbGestureResults removeObjectForKey:gestureId];
      }
    }
    NSMutableDictionary *stats = [counters mutableCopy];
    stats[@"recent"] = fbGestureResults.count > 0 ? [fbGestureResults copy] : @{};
    return [stats copy];
  }
}

@end
