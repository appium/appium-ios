/**
 * Copyright (c) 2018-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIElementQuery+FBHelpers.h"

#import "FBXCodeCompatibility.h"
#import "XCUIElementQuery.h"
#import "XCUIElement+FBCaching.h"
#import "FBXCElementSnapshot.h"
#import "XCTElementSetTransformer-Protocol.h"

@implementation XCUIElementQuery (FBHelpers)

- (nullable NSOrderedSet<id<FBXCElementSnapshot>> *)fb_cachedSnapshots
{
  id<FBXCElementSnapshot> rootElementSnapshot = self.rootElementSnapshot;
  if (nil == rootElementSnapshot) {
    return nil;
  }

  XCUIElementQuery *inputQuery = self;
  NSMutableArray<id<XCTElementSetTransformer>> *transformersChain = [NSMutableArray array];
  while (nil != inputQuery && nil != inputQuery.transformer) {
    [transformersChain insertObject:inputQuery.transformer atIndex:0];
    inputQuery = inputQuery.inputQuery;
  }

  NSMutableArray *snapshots = [NSMutableArray arrayWithObject:rootElementSnapshot];
  [snapshots addObjectsFromArray:rootElementSnapshot._allDescendants];
  NSOrderedSet *matchingSnapshots = [NSOrderedSet orderedSetWithArray:snapshots];
  @try {
    for (id<XCTElementSetTransformer> transformer in transformersChain) {
      matchingSnapshots = (NSOrderedSet *)[transformer transform:matchingSnapshots
                                                 relatedElements:nil];
    }
    return matchingSnapshots;
  } @catch (NSException *e) {
    [FBLogger logFmt:@"Got an unexpected error while retriveing the cached snapshot: %@", e.reason];
  }
  return nil;
}

- (nullable id<FBXCElementSnapshot>)fb_cachedSnapshot
{
  NSOrderedSet<id<FBXCElementSnapshot>> *snapshots = [self fb_cachedSnapshots];
  return snapshots.count == 1 ? snapshots.firstObject : nil;
}

- (NSArray<XCUIElement *> *)fb_allMatchesWithSnapshotsBoundByIndex:(BOOL)boundByIndex
{
  NSArray<XCUIElement *> *elements = boundByIndex
    ? self.allElementsBoundByIndex
    : self.allElementsBoundByAccessibilityElement;
  if (elements.count == 0) {
    return elements;
  }
  // Both arrays follow the order of this query. Reapply its transformers once,
  // rather than resolving each bound element against the entire app hierarchy.
  NSOrderedSet<id<FBXCElementSnapshot>> *snapshots = [self fb_cachedSnapshots];
  if (snapshots.count == elements.count) {
    [elements enumerateObjectsUsingBlock:^(XCUIElement *element, NSUInteger idx, BOOL *stop) {
      [element fb_cacheSnapshot:snapshots[idx]];
    }];
  }
  return elements;
}

@end
