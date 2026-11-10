/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <Foundation/Foundation.h>

@class XCSynthesizedEventRecord;

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, FBGestureEnqueueResult) {
  FBGestureEnqueueResultQueued = 0,
  FBGestureEnqueueResultQueueFull,
  FBGestureEnqueueResultDuplicateGestureId,
};

/**
 Owns the opt-in fast gesture queue: bounded dispatch, duplicate-id tracking and the
 recent-result map that /status exposes. Command handlers only build the event and map
 the enqueue result to a response.
 */
@interface FBGestureQueue : NSObject

/**
 Queues an event for asynchronous synthesis.
 @param event Event to synthesize
 @param name Gesture name used in logs and the recent-result map
 @param gestureId Optional client id for correlation
 @return Queued, queue-full, or duplicate-id
 */
+ (FBGestureEnqueueResult)enqueueEvent:(XCSynthesizedEventRecord *)event
                                  name:(NSString *)name
                             gestureId:(nullable NSString *)gestureId;

/** Waits up to five seconds for already queued events to finish. */
+ (void)drainWithTimeout;

/** Clears per-session correlation state; cumulative counters are kept. */
+ (void)resetSessionState;

/** Cumulative counters plus the bounded recent `gestureId` results. */
+ (NSDictionary *)stats;

@end

NS_ASSUME_NONNULL_END
