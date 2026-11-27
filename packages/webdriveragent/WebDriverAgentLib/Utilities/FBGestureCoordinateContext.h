/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

#if !TARGET_OS_TV && !TARGET_OS_WATCH
/** Display routing and window anchors scoped to one W3C command or native gesture. */
@interface FBGestureCoordinateContext : NSObject
@property (nonatomic, readonly) XCUIScreen *screen;
@property (nonatomic, readonly) BOOL usesWindowCoordinates;

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;

/** Keyboard/pause-only actions use the main screen without selected-display lookup. */
+ (nullable instancetype)contextWithDisplayRequired:(BOOL)requiresDisplay error:(NSError **)error;

/** Application frame on a single display, or its window frame on the selected display. Returns CGRectNull on failure. */
- (CGRect)windowFrameForApplication:(XCUIElement *)application error:(NSError **)error;

/** Native application-root or multi-display viewport coordinates. */
- (nullable XCUICoordinate *)coordinateWithApplication:(XCUIElement *)application
                                              offset:(CGVector)offset
                                               error:(NSError **)error;

/** Multi-display W3C Application origin: reported rect midpoint plus client offset. */
- (nullable XCUICoordinate *)coordinateWithApplicationOrigin:(XCUIElement *)application
                                                    offset:(CGVector)offset
                                                     error:(NSError **)error;
@end
#endif

NS_ASSUME_NONNULL_END
