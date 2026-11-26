/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBBaseActionsSynthesizer.h"

NS_ASSUME_NONNULL_BEGIN

#if !TARGET_OS_TV && !TARGET_OS_WATCH
@interface FBW3CActionsSynthesizer : FBBaseActionsSynthesizer

/*! YES if the actions are a single key source with modifiers or special keys, which plain text cannot express */
@property (readonly, nonatomic) BOOL requiresKeyRecords;

/*! Performs the actions as single-key records that keep modifiers pressed. Requires `requiresKeyRecords` */
- (BOOL)performKeyActionsWithError:(NSError **)error;

@end
#endif

NS_ASSUME_NONNULL_END
