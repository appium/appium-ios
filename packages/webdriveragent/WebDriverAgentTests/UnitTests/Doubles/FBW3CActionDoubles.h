/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#if !TARGET_OS_TV && !TARGET_OS_WATCH

/** Coordinate that resolves to a fixed screen point and composes offsets without touching XCTest. */
@interface FBW3CPointCoordinate : XCUICoordinate
+ (instancetype)coordinateWithPoint:(CGPoint)point;
@end

/** Minimal display stand-in: only the identifier is read from an element's screen. */
@interface FBW3CScreenDouble : NSObject
@property (nonatomic) long long displayID;
@end

/** Element/application stand-in with a fixed frame, type and screen. */
@interface FBW3CElementDouble : XCUIElement
@property (nonatomic) XCUIElementType stubType;
@property (nonatomic) CGRect stubFrame;
/** The main screen when nil. */
@property (nonatomic, nullable) FBW3CScreenDouble *stubScreen;
+ (instancetype)doubleWithType:(XCUIElementType)type frame:(CGRect)frame;
@end

#endif
