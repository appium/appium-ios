/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <Foundation/Foundation.h>

#import <WebDriverAgentLib/FBCommandHandler.h>

NS_ASSUME_NONNULL_BEGIN

@interface FBElementCommands : NSObject <FBCommandHandler>

/**
 Counters for the opt-in fast gesture queue. `/status` exposes them so a caller can tell
 whether queued events are backing up or failing after the response has already been sent.

 @return Pending, enqueued, failed and rejected event counts.
 */
+ (NSDictionary *)fb_fastGestureStats;

/**
 Waits until every fast gesture already queued has been synthesized. Session teardown calls
 this so a queued event cannot land after the session it belongs to has been killed.
 */
+ (void)fb_drainFastGestures;

@end

NS_ASSUME_NONNULL_END
