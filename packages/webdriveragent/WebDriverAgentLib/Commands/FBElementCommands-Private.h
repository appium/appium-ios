/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBElementCommands.h"

@class XCSynthesizedEventRecord;

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, FBGestureEnqueueResult) {
  FBGestureEnqueueResultQueued = 0,
  FBGestureEnqueueResultQueueFull,
  FBGestureEnqueueResultDuplicateGestureId,
};

@interface FBElementCommands ()

/**
 Queues a synthesized event on the shared gesture queue without waiting for its completion.
 @param event Event to synthesize
 @param name Gesture name used in the failure log
 @param gestureId Optional client id for correlation
 @return Queued, queue-full, or duplicate-id
 */
+ (FBGestureEnqueueResult)fb_dispatchEventInBackground:(XCSynthesizedEventRecord *)event
                                                  name:(NSString *)name
                                             gestureId:(NSString *)gestureId;

/** The serial queue shared by fast and confirmed gesture synthesis. */
+ (dispatch_queue_t)fb_synthesisQueue;

/**
 Runs a gesture block on the shared queue.
 @param block Work to run
 @param wait YES to run synchronously after already queued work, NO to enqueue it
 */
+ (void)fb_performGesture:(dispatch_block_t)block wait:(BOOL)wait;

@end

NS_ASSUME_NONNULL_END
