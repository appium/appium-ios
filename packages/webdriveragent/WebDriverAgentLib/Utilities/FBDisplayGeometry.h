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

/** Resolve cross-display controls before serializing the application tree. */
void FBPrepareDisplayFrames(id<FBXCElementSnapshot> root);

/** Return the resolved frame, falling back to the snapshot's own frame. */
CGRect FBFrameForDisplayGeometry(id<FBXCElementSnapshot> snapshot);

NS_ASSUME_NONNULL_END
