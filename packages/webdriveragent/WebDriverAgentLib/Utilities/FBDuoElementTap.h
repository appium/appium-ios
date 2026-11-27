/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

#if TARGET_OS_IOS
/** Tap correction for compatibility apps hosted on the iPhone Duo's selected display. */
@interface FBDuoElementTap : NSObject

/**
 Taps a hosted window whose XCTest display affinity differs from the selected display.
 Returns nil if the native tap path should be used, otherwise the synthesis result.
 offset is relative to an element, or in selected-screen coordinates for an application.
 A nil offset requests the element's hit point.
 */
+ (nullable NSNumber *)tapHostedElement:(XCUIElement *)element
                                 offset:(nullable NSValue *)offset
                                  error:(NSError **)error;
@end
#endif

NS_ASSUME_NONNULL_END
