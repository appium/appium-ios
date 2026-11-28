/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBControlCenterVisibility.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
#import "FBHIDOperations+DuoRotation.h"
#import "FBScreen.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "XCUIScreen.h"
#import "XCTestPrivateSymbols.h"

BOOL FBControlCenterNeedsSnapshotVisibility(id<FBXCElementSnapshot> window, long long displayID)
{
  if (![window hasDescendantMatchingFilter:^BOOL(id<FBXCElementSnapshot> node) {
    return [node.identifier isEqualToString:@"cc-root-folder-view"] && !CGRectIsEmpty(node.frame);
  }]) {
    return NO;
  }
  // A confirmed cover supports live visibility reads. On the inner panel or
  // an unidentified panel, those reads can dismiss Control Center.
  XCUIScreen *screen = [FBScreen currentScreenWithError:nil];
  return screen == nil || screen.displayID != displayID || ![[FBHIDOperations isInnerDuoDisplay:screen] isEqual:@NO];
}

// Keep source visibility scoped to a single traversal. A live XCTest visibility
// query (even for just the overlay window) can dismiss Control Center.
@interface FBControlCenterSourceSnapshot : FBXCElementSnapshotWrapper
@property (nonatomic) CGRect wdFrame;
@property (nonatomic, getter=isWDVisible) BOOL wdVisible;
@end

@implementation FBControlCenterSourceSnapshot
@synthesize wdFrame = _wdFrame;
@synthesize wdVisible = _wdVisible;
@end

void FBCollectSourceVisibility(id<FBXCElementSnapshot> node, long long displayID,
                               long long parentDisplayID, FBDisplaySnapshotMap *matches)
{
  FBXCElementSnapshotWrapper *geometry = [FBXCElementSnapshotWrapper ensureWrapped:[matches objectForKey:node] ?: node];
  FBControlCenterSourceSnapshot *result = [FBControlCenterSourceSnapshot ensureWrapped:geometry.snapshot];
  result.wdFrame = geometry.wdFrame;
  NSNumber *cached = geometry.snapshot.additionalAttributes[FB_XCAXAIsVisibleAttribute];
  BOOL isApplication = node.elementType == XCUIElementTypeApplication;
  // XCTest can omit a descendant's display ID. Inherit the closest resolved
  // ancestor, but never assign the application root's display to all windows.
  long long effectiveDisplayID = geometry.displayID ?: parentDisplayID;
  BOOL onDisplay = isApplication || effectiveDisplayID == displayID;
  result.wdVisible = onDisplay && (cached != nil ? cached.boolValue : !CGRectIsEmpty(geometry.snapshot.visibleFrame));
  [matches setObject:result forKey:node];
  for (id<FBXCElementSnapshot> child in node.children) {
    FBCollectSourceVisibility(child, displayID, isApplication ? 0 : effectiveDisplayID, matches);
  }
}
#endif
