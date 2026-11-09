/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBXCElementSnapshotWrapper.h"
#import "FBXCAccessibilityElement.h"

NS_ASSUME_NONNULL_BEGIN

@interface XCUIElement (FBUID)

/*! AX element this element is bound to (see allElementsBoundByAccessibilityElement) or nil. Does not take a snapshot. */
@property (nonatomic, nullable, readonly) id<FBXCAccessibilityElement> fb_boundAccessibilityElement;

/*! Represents unique internal element identifier, which is the same for an element and its snapshot as UUIDv4 */
@property (nonatomic, nullable, readonly, copy) NSString *fb_uid;

/*! Represents unique internal element identifier, which is the same for an element and its snapshot */
@property (nonatomic, readonly) unsigned long long fb_accessibiltyId;

@end


@interface FBXCElementSnapshotWrapper (FBUID)

/*! Represents unique internal element identifier, which is the same for an element and its snapshot as UUIDv4 */
@property (nonatomic, nullable, readonly, copy) NSString *fb_uid;

/*! Represents unique internal element identifier, which is the same for an element and its snapshot */
@property (nonatomic, readonly) unsigned long long fb_accessibiltyId;

/**
 Fetches wdUID attribute value for the given snapshot instance

 @param snapshot snapshot instance
 @return UID attribute value
 */
+ (nullable NSString *)wdUIDWithSnapshot:(id<FBXCElementSnapshot>)snapshot;

@end

NS_ASSUME_NONNULL_END
