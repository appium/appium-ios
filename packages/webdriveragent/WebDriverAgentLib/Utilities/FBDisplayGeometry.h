/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import "FBXCElementSnapshot.h"

NS_ASSUME_NONNULL_BEGIN

/** Resolve a single element for a WebDriver frame or rect request. */
id<FBXCElementSnapshot> FBSnapshotForDisplayGeometry(XCUIElement *element, BOOL useCustomSnapshot);

typedef NSMapTable<id<FBXCElementSnapshot>, id<FBXCElementSnapshot>> FBDisplaySnapshotMap;

/** Geometry counterparts for one source traversal, keyed by original snapshot identity. */
FBDisplaySnapshotMap *_Nullable FBDisplaySnapshotsForTree(id<FBXCElementSnapshot> root);

#if !TARGET_OS_TV && !TARGET_OS_WATCH
/** First nonempty window on the display and its frame. Writes CGRectNull if no window matches. */
XCUIElement *_Nullable FBWindowOnDisplay(XCUIElement *application, long long displayID, CGRect *frame);
#endif

/** Return the resolved frame, falling back to the snapshot's own frame. */
CGRect FBFrameForDisplayGeometry(id<FBXCElementSnapshot> snapshot);

NS_ASSUME_NONNULL_END
