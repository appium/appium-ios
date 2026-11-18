/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBHIDOperations.h"

@class XCUIScreen;

NS_ASSUME_NONNULL_BEGIN

#if !TARGET_OS_TV && !TARGET_OS_WATCH
@interface FBHIDOperations (DuoRotation)
/** Physical panel identity, or nil if Core Animation metadata does not identify it. */
+ (nullable NSNumber *)isInnerDuoDisplay:(XCUIScreen *)screen;
/** Resolve the selected panel and map the requested orientation to its vendor HID value. */
+ (nullable NSString *)duoOrientationValue:(UIDeviceOrientation)orientation;
@end
#endif

NS_ASSUME_NONNULL_END
