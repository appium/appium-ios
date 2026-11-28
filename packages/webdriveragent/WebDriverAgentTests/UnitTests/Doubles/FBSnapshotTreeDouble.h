/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCElementSnapshotDouble.h"

/** Snapshot double with settable type/identifier/frame and a parent/children tree. */
@interface FBSnapshotTreeDouble : XCElementSnapshotDouble
@property (nonatomic, assign) XCUIElementType elementType;
@property (nonatomic, copy, nullable) NSString *identifier;
@property (nonatomic, copy, nullable) NSString *placeholderValue;
@property (nonatomic, assign) CGRect frame;
@property (nonatomic, assign, getter=isEnabled) BOOL enabled;
@property (nonatomic, assign, getter=isSelected) BOOL selected;
@property (nonatomic, weak, nullable) FBSnapshotTreeDouble *parent;
@property (nonatomic, copy, nonnull) NSArray<FBSnapshotTreeDouble *> *children;

+ (nonnull instancetype)type:(XCUIElementType)type
                       label:(nullable NSString *)label
                    children:(nullable NSArray<FBSnapshotTreeDouble *> *)children;
/** Sets children and points their parent back to the receiver. */
- (void)adoptChildren:(nonnull NSArray<FBSnapshotTreeDouble *> *)children;
@end
