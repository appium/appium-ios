/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBDisplaySnapshotMap.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
BOOL FBControlCenterNeedsSnapshotVisibility(id<FBXCElementSnapshot> window, long long displayID);
void FBCollectSourceVisibility(id<FBXCElementSnapshot> node, long long displayID,
                               long long parentDisplayID, FBDisplaySnapshotMap *matches);
#endif
