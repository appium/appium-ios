/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIElement+FBUtilities.h"

#import <objc/runtime.h>

#import "FBConfiguration.h"
#import "FBExceptions.h"
#import "FBImageUtils.h"
#import "FBElementUtils.h"
#import "FBLogger.h"
#import "FBMacros.h"
#import "FBMathUtils.h"
#import "FBRunLoopSpinner.h"
#import "FBSettings.h"
#import "FBScreenshot.h"
#import "FBXCAXClientProxy.h"
#import "FBXCodeCompatibility.h"
#import "FBXCElementSnapshot.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBQuiescence.h"
#import "XCUIApplicationImpl.h"
#import "XCUIApplicationProcess.h"
#import "XCTElementSetTransformer-Protocol.h"
#import "XCTestPrivateSymbols.h"
#import "XCTRunnerDaemonSession.h"
#import "XCUIApplicationProcess+FBQuiescence.h"
#import "XCUIApplication.h"
#import "XCUIElement+FBCaching.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "XCUIElementQuery.h"
#import "XCUIElementQuery+FBHelpers.h"
#import "XCUIElement+FBUID.h"
#import "XCUIScreen.h"
#import "XCUIElement+FBResolve.h"

// Binds every snapshot to its AX element directly, without a query over the whole tree.
// Returns nil if that is not possible, so the caller can fall back to FBQueryElementsWithUids.
static NSArray<XCUIElement *> *FBBindSnapshotsToElements(XCUIElementQuery *scopeQuery,
                                                         NSArray<id<FBXCElementSnapshot>> *snapshots,
                                                         NSArray<NSString *> *uids,
                                                         NSString *excludedUid)
{
  XCUIElementQuery *anyQuery = [scopeQuery descendantsMatchingType:XCUIElementTypeAny];
  if (FBConfiguration.sharedInstance.boundElementsByIndex
      || ![anyQuery respondsToSelector:@selector(_elementMatchingAccessibilityElementOfSnapshot:)]) {
    return nil;
  }
  NSMutableArray<XCUIElement *> *result = [NSMutableArray array];
  for (NSUInteger i = 0; i < snapshots.count; ++i) {
    if ([uids[i] isEqualToString:excludedUid]) {
      continue;
    }
    XCUIElement *el = [anyQuery _elementMatchingAccessibilityElementOfSnapshot:snapshots[i]];
    if (nil == el.fb_boundAccessibilityElement) {
      return nil;
    }
    [result addObject:el];
  }
  return result.copy;
}

// Resolves the elements by their uids with a query over the scope's tree
static NSArray<XCUIElement *> *FBQueryElementsWithUids(XCUIElementQuery *scopeQuery,
                                                       NSArray<id<FBXCElementSnapshot>> *snapshots,
                                                       NSArray<NSString *> *uids,
                                                       BOOL onlyChildren)
{
  XCUIElementType type = XCUIElementTypeAny;
  NSArray<NSNumber *> *uniqueTypes = [snapshots valueForKeyPath:[NSString stringWithFormat:@"@distinctUnionOfObjects.%@", FBStringify(XCUIElement, elementType)]];
  if (uniqueTypes && [uniqueTypes count] == 1) {
    type = (XCUIElementType)[uniqueTypes.firstObject intValue];
  }
  XCUIElementQuery *query = onlyChildren
    ? [scopeQuery childrenMatchingType:type]
    : [scopeQuery descendantsMatchingType:type];
  NSPredicate *predicate = [NSPredicate predicateWithFormat:@"%K IN %@", FBStringify(FBXCElementSnapshotWrapper, fb_uid), uids];
  return [[query matchingPredicate:predicate] fb_allMatchesWithSnapshotsBoundByIndex:YES];
}

@implementation XCUIElement (FBUtilities)

- (id<FBXCElementSnapshot>)fb_takeSnapshot:(BOOL)isCustom
{
  __block id<FBXCElementSnapshot> snapshot = nil;
  @autoreleasepool {
    NSError *error = nil;
    snapshot = isCustom
      ? [self.fb_query fb_uniqueSnapshotWithError:&error]
      : (id<FBXCElementSnapshot>)[self snapshotWithError:&error];
    if (nil == snapshot) {
      [self fb_raiseStaleElementExceptionWithError:error];
    }
  }
  self.lastSnapshot = snapshot;
  return self.lastSnapshot;
}

- (id<FBXCElementSnapshot>)fb_standardSnapshot
{
  return [self fb_takeSnapshot:NO];
}

- (id<FBXCElementSnapshot>)fb_customSnapshot
{
  return [self fb_takeSnapshot:YES];
}

- (id<FBXCElementSnapshot>)fb_nativeSnapshot
{
  NSError *error = nil;
  BOOL isSuccessful = [self resolveOrRaiseTestFailure:NO error:&error];
  if (nil == self.lastSnapshot || !isSuccessful) {
    [self fb_raiseStaleElementExceptionWithError:error];
  }
  return self.lastSnapshot;
}

- (id<FBXCElementSnapshot>)fb_cachedSnapshot
{
  return [self.query fb_cachedSnapshot];
}

- (NSArray<XCUIElement *> *)fb_filterDescendantsWithSnapshots:(NSArray<id<FBXCElementSnapshot>> *)snapshots
                                                 onlyChildren:(BOOL)onlyChildren
{
  NSMutableArray<id<FBXCElementSnapshot>> *matchedSnapshots = [NSMutableArray array];
  NSMutableArray<NSString *> *matchedIds = [NSMutableArray array];
  for (id<FBXCElementSnapshot> snapshot in snapshots) {
    @autoreleasepool {
      NSString *uid = [FBXCElementSnapshotWrapper wdUIDWithSnapshot:snapshot];
      if (nil != uid) {
        [matchedSnapshots addObject:snapshot];
        [matchedIds addObject:uid];
      }
    }
  }
  if (0 == matchedIds.count) {
    return @[];
  }

  NSMutableArray<XCUIElement *> *result = [NSMutableArray array];
  // self.lastSnapshot may be stale leftover from an unrelated earlier command.
  id<FBXCElementSnapshot> selfSnapshot = self.fb_cachedSnapshot;
  NSString *selfUid = nil == selfSnapshot
    ? self.fb_uid
    : [FBXCElementSnapshotWrapper wdUIDWithSnapshot:selfSnapshot];
  if (nil != selfUid && [matchedIds containsObject:selfUid]) {
    XCUIElement *stableSelf = [self fb_stableInstanceWithUid:selfUid];
    if (1 == matchedIds.count) {
      return @[stableSelf];
    }
    [result addObject:stableSelf];
  }

  NSArray<XCUIElement *> *descendants = FBBindSnapshotsToElements(self.fb_query, matchedSnapshots, matchedIds, selfUid)
    ?: FBQueryElementsWithUids(self.fb_query, matchedSnapshots, matchedIds, onlyChildren);
  [result addObjectsFromArray:descendants];
  for (XCUIElement *el in result) {
    el.fb_isResolvedNatively = @NO;
  }
  return result.copy;
}

- (void)fb_waitUntilStable
{
  [self fb_waitUntilStableWithTimeout:FBConfiguration.sharedInstance.waitForIdleTimeout];
}

- (void)fb_waitUntilStableWithTimeout:(NSTimeInterval)timeout
{
  if (timeout < DBL_EPSILON) {
    return;
  }

  XCUIApplication *application = self.application;
  // Recursive synchronization also covers nested stability checks on this thread.
  @synchronized (FBConfiguration.sharedInstance) {
    NSTimeInterval previousTimeout = FBConfiguration.sharedInstance.waitForIdleTimeout;
    BOOL previousQuiescence = application.fb_shouldWaitForQuiescence;
    @try {
      FBConfiguration.sharedInstance.waitForIdleTimeout = timeout;
      application.fb_shouldWaitForQuiescence = YES;
      [[[application applicationImpl] currentProcess]
        fb_waitForQuiescenceIncludingAnimationsIdle:YES];
    } @finally {
      application.fb_shouldWaitForQuiescence = previousQuiescence;
      FBConfiguration.sharedInstance.waitForIdleTimeout = previousTimeout;
    }
  }
}

- (void)fb_raiseStaleElementExceptionWithError:(NSError *)error __attribute__((noreturn))
{
  NSString *hintText = @"Make sure the application UI has the expected state";
  if (nil != error && [error.localizedDescription containsString:@"Identity Binding"]) {
    hintText = [NSString stringWithFormat:@"%@. You could also try to switch the binding strategy using the 'boundElementsByIndex' setting for the element lookup", hintText];
  }
  NSString *reason = [NSString stringWithFormat:@"The previously found element \"%@\" is not present in the current view anymore. %@",
                      self.description, hintText];
  if (nil != error) {
    reason = [NSString stringWithFormat:@"%@. Original error: %@", reason, error.localizedDescription];
  }
  @throw [NSException exceptionWithName:FBStaleElementException reason:reason userInfo:@{}];
}

@end
