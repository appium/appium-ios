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
typedef NS_ENUM(NSUInteger, FBKeyActionKind) {
  /*! Wait for `delay` seconds */
  FBKeyActionKindDelay,
  /*! Set the pressed modifiers to `modifierFlags` (zero releases all of them) */
  FBKeyActionKindModifiers,
  /*! Type the `value` text */
  FBKeyActionKindText,
  /*! Type the `value` key with `modifierFlags` pressed */
  FBKeyActionKindKey,
};

/*! A device independent step of performing key actions */
@interface FBKeyAction : NSObject

@property (nonatomic) FBKeyActionKind kind;
@property (nonatomic) NSTimeInterval delay;
@property (nonatomic) NSUInteger modifierFlags;
@property (nullable, nonatomic, copy) NSString *value;

@end

@interface FBW3CActionsSynthesizer : FBBaseActionsSynthesizer

/*! YES if the actions are a single key source with modifiers or special keys, which plain text cannot express */
@property (readonly, nonatomic) BOOL requiresKeyRecords;

/**
 Plans the steps of the single key source, which are performed by `performKeyActionsWithError:`
 */
- (nullable NSArray<FBKeyAction *> *)keyActionsWithError:(NSError **)error;

/*! Performs the actions as single-key records that keep modifiers pressed. Requires `requiresKeyRecords` */
- (BOOL)performKeyActionsWithError:(NSError **)error;

@end
#endif

NS_ASSUME_NONNULL_END
