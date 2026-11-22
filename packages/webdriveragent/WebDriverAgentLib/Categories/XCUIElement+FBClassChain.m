/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIElement+FBClassChain.h"

#import "FBClassChainQueryParser.h"
#import "FBXCodeCompatibility.h"
#import "FBExceptions.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElementQuery+FBHelpers.h"

@implementation XCUIElement (FBClassChain)

- (NSArray<XCUIElement *> *)fb_descendantsMatchingClassChain:(NSString *)classChainQuery shouldReturnAfterFirstMatch:(BOOL)shouldReturnAfterFirstMatch
{
  NSError *error;
  FBClassChain *parsedChain = [FBClassChainQueryParser parseQuery:classChainQuery error:&error];
  if (nil == parsedChain) {
    @throw [NSException exceptionWithName:FBClassChainQueryParseException reason:error.localizedDescription userInfo:error.userInfo];
    return nil;
  }
  // The snapshot-walk strategy below only pays off when an intermediate
  // (non-final) segment carries an explicit position: that is the only
  // shape where the query-based strategy has to resolve a live element
  // mid-chain - and pay an accessibility round trip - just to keep building
  // the next segment's query. Every other shape (including the common case
  // of zero or one position, on the final segment only) already resolves in
  // a single round trip with the query-based strategy, while the snapshot
  // walk always pays for one full upfront subtree snapshot regardless of
  // whether it is actually needed - a bad trade in deep/large trees. See
  // https://github.com/appium/WebDriverAgent/pull/1194#issuecomment-5156633352
  NSArray<FBClassChainItem *> *chainItems = parsedChain.elements;
  NSUInteger axisIndex = [self.class fb_indexOfFirstAxisItem:chainItems];
  if (NSNotFound != axisIndex) {
    // XCUIElementQuery has no parent/sibling axes, so everything after the query-able prefix
    // is evaluated on snapshots. The prefix is resolved by a query when it has no positions.
    return axisIndex > 0 && ![self.class fb_hasIntermediatePosition:[chainItems subarrayWithRange:NSMakeRange(0, axisIndex)]]
      ? [self fb_prefixQueryDescendantsMatchingChainItems:chainItems axisIndex:axisIndex shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch]
      : [self fb_snapshotDescendantsMatchingChainItems:chainItems shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch];
  }
  return [self.class fb_hasIntermediatePosition:chainItems]
    ? [self fb_snapshotDescendantsMatchingChainItems:chainItems shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch]
    : [self fb_queryDescendantsMatchingChainItems:chainItems shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch];
}

+ (BOOL)fb_hasIntermediatePosition:(NSArray<FBClassChainItem *> *)chainItems
{
  for (NSUInteger i = 0; i + 1 < chainItems.count; i++) {
    if (nil != chainItems[i].position) {
      return YES;
    }
  }
  return NO;
}

+ (NSUInteger)fb_indexOfFirstAxisItem:(NSArray<FBClassChainItem *> *)chainItems
{
  return [chainItems indexOfObjectPassingTest:^BOOL(FBClassChainItem *item, NSUInteger idx, BOOL *stop) {
    return FBClassChainAxisChild != item.axis && FBClassChainAxisDescendant != item.axis;
  }];
}

#pragma mark - Query-based strategy
#pragma mark (single accessibility round trip; used whenever no intermediate
#pragma mark  segment carries an explicit position)

- (NSArray<XCUIElement *> *)fb_queryDescendantsMatchingChainItems:(NSArray<FBClassChainItem *> *)chainItems shouldReturnAfterFirstMatch:(BOOL)shouldReturnAfterFirstMatch
{
  NSMutableArray<FBClassChainItem *> *lookupChain = chainItems.mutableCopy;
  FBClassChainItem *chainItem = lookupChain.firstObject;
  XCUIElement *currentRoot = self;
  XCUIElementQuery *query = [currentRoot fb_queryWithChainItem:chainItem query:nil];
  [lookupChain removeObjectAtIndex:0];
  while (lookupChain.count > 0) {
    BOOL isRootChanged = NO;
    if (nil != chainItem.position) {
      NSArray<XCUIElement *> *currentRootMatch = [self.class fb_matchingElementsWithItem:chainItem
                                                                                   query:query
                                                             shouldReturnAfterFirstMatch:nil];
      if (0 == currentRootMatch.count) {
        return @[];
      }
      currentRoot = currentRootMatch.firstObject;
      isRootChanged = YES;
    }
    chainItem = [lookupChain firstObject];
    query = [currentRoot fb_queryWithChainItem:chainItem query:isRootChanged ? nil : query];
    [lookupChain removeObjectAtIndex:0];
  }
  return [self.class fb_matchingElementsWithItem:chainItem
                                           query:query
                     shouldReturnAfterFirstMatch:@(shouldReturnAfterFirstMatch)];
}

- (XCUIElementQuery *)fb_queryWithChainItem:(FBClassChainItem *)item query:(nullable XCUIElementQuery *)query
{
  if (item.isDescendant) {
    if (query) {
      query = [query descendantsMatchingType:item.type];
    } else {
      query = [self.fb_query descendantsMatchingType:item.type];
    }
  } else {
    if (query) {
      query = [query childrenMatchingType:item.type];
    } else {
      query = [self.fb_query childrenMatchingType:item.type];
    }
  }
  if (item.predicates) {
    for (FBAbstractPredicateItem *predicate in item.predicates) {
      if ([predicate isKindOfClass:FBSelfPredicateItem.class]) {
        query = [query matchingPredicate:predicate.value];
      } else if ([predicate isKindOfClass:FBDescendantPredicateItem.class]) {
        query = [query containingPredicate:predicate.value];
      }
    }
  }
  return query;
}

+ (NSArray<XCUIElement *> *)fb_matchingElementsWithItem:(FBClassChainItem *)item query:(XCUIElementQuery *)query shouldReturnAfterFirstMatch:(nullable NSNumber *)shouldReturnAfterFirstMatch
{
  if (1 == item.position.integerValue || (0 == item.position.integerValue && shouldReturnAfterFirstMatch.boolValue)) {
    XCUIElement *result = query.fb_firstMatch;
    return result ? @[result] : @[];
  }
  NSArray<XCUIElement *> *allMatches = query.fb_allMatches;
  if (0 == item.position.integerValue) {
    return allMatches;
  }
  if (allMatches.count >= (NSUInteger)ABS(item.position.integerValue)) {
    return item.position.integerValue > 0
      ? @[[allMatches objectAtIndex:item.position.integerValue - 1]]
      : @[[allMatches objectAtIndex:allMatches.count + item.position.integerValue]];
  }
  return @[];
}

#pragma mark - Snapshot-based strategy
#pragma mark (single upfront snapshot walked in memory; used when an
#pragma mark  intermediate segment has an explicit position, avoiding one
#pragma mark  extra accessibility round trip per such segment)

- (NSArray<XCUIElement *> *)fb_snapshotDescendantsMatchingChainItems:(NSArray<FBClassChainItem *> *)chainItems shouldReturnAfterFirstMatch:(BOOL)shouldReturnAfterFirstMatch
{
  // self.lastSnapshot may be stale leftover from an unrelated earlier command.
  NSArray<id<FBXCElementSnapshot>> *roots = @[self.fb_cachedSnapshot ?: [self fb_customSnapshot]];
  return [self fb_walkChainItems:chainItems
                      fromIndex:0
                          roots:roots
    shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch];
}

#pragma mark - Prefix query and snapshot strategy
#pragma mark (the items before the first axis are resolved by a single query, whose
#pragma mark  cached snapshots carry the parent/sibling links the axes are walked on)

- (NSArray<XCUIElement *> *)fb_prefixQueryDescendantsMatchingChainItems:(NSArray<FBClassChainItem *> *)chainItems axisIndex:(NSUInteger)axisIndex shouldReturnAfterFirstMatch:(BOOL)shouldReturnAfterFirstMatch
{
  XCUIElementQuery *query = nil;
  for (NSUInteger i = 0; i < axisIndex; i++) {
    query = [self fb_queryWithChainItem:chainItems[i] query:query];
  }
  NSUInteger resolvedCount = query.allElementsBoundByIndex.count;
  if (0 == resolvedCount) {
    return @[];
  }
  NSOrderedSet<id<FBXCElementSnapshot>> *cachedSnapshots = query.fb_cachedSnapshots;
  if (cachedSnapshots.count != resolvedCount) {
    return [self fb_snapshotDescendantsMatchingChainItems:chainItems shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch];
  }
  NSArray<id<FBXCElementSnapshot>> *roots = [self.class fb_matchingSnapshotsWithItem:chainItems[axisIndex - 1]
                                                                          candidates:cachedSnapshots.array
                                                         shouldReturnAfterFirstMatch:nil];
  return [self fb_walkChainItems:chainItems
                      fromIndex:axisIndex
                          roots:roots
    shouldReturnAfterFirstMatch:shouldReturnAfterFirstMatch];
}

// Walks the items starting from the given index over the roots. Everything is resolved
// in memory and the final matches are bound to elements at once.
- (NSArray<XCUIElement *> *)fb_walkChainItems:(NSArray<FBClassChainItem *> *)chainItems fromIndex:(NSUInteger)startIndex roots:(NSArray<id<FBXCElementSnapshot>> *)roots shouldReturnAfterFirstMatch:(BOOL)shouldReturnAfterFirstMatch
{
  BOOL hasAxis = NSNotFound != [self.class fb_indexOfFirstAxisItem:chainItems];
  NSArray<id<FBXCElementSnapshot>> *currentRoots = roots;
  for (NSUInteger i = startIndex; i < chainItems.count; i++) {
    FBClassChainItem *chainItem = chainItems[i];
    NSArray<id<FBXCElementSnapshot>> *candidates = [self.class fb_snapshotsMatchingItem:chainItem inRoots:currentRoots];
    if (i + 1 == chainItems.count) {
      if (!hasAxis) {
        return [self fb_filterDescendantsWithSnapshots:[self.class fb_matchingSnapshotsWithItem:chainItem
                                                                                     candidates:candidates
                                                                    shouldReturnAfterFirstMatch:@(shouldReturnAfterFirstMatch)]
                                          onlyChildren:NO];
      }
      // Positions of axis items count along the axis, but the matches are always returned
      // in document order, whatever the binding strategy is. Axes may leave the receiver's subtree.
      NSArray<id<FBXCElementSnapshot>> *matchedSnapshots = [self.class fb_snapshotsInDocumentOrder:
                                                            [self.class fb_matchingSnapshotsWithItem:chainItem
                                                                                          candidates:candidates
                                                                         shouldReturnAfterFirstMatch:nil]];
      if (shouldReturnAfterFirstMatch && matchedSnapshots.count > 1) {
        matchedSnapshots = @[matchedSnapshots.firstObject];
      }
      return [self.application fb_filterDescendantsWithSnapshots:matchedSnapshots onlyChildren:NO];
    }
    if (nil != chainItem.position) {
      // An explicit position always narrows the match set down to a single
      // element, which becomes the sole root for the rest of the chain, so
      // it has to be resolved now instead of being folded into `candidates`
      // like an unindexed segment would be
      NSArray<id<FBXCElementSnapshot>> *currentRootMatch = [self.class fb_matchingSnapshotsWithItem:chainItem
                                                                                           candidates:candidates
                                                                          shouldReturnAfterFirstMatch:nil];
      if (0 == currentRootMatch.count) {
        return @[];
      }
      currentRoots = @[(id<FBXCElementSnapshot> _Nonnull)currentRootMatch.firstObject];
    } else {
      currentRoots = candidates;
    }
  }
  return @[];
}

+ (NSArray<id<FBXCElementSnapshot>> *)fb_snapshotsMatchingItem:(FBClassChainItem *)item inRoots:(NSArray<id<FBXCElementSnapshot>> *)roots
{
  NSMutableArray<id<FBXCElementSnapshot>> *typeMatches = [NSMutableArray array];
  for (id<FBXCElementSnapshot> root in roots) {
    if (FBClassChainAxisChild != item.axis && FBClassChainAxisDescendant != item.axis) {
      for (id<FBXCElementSnapshot> candidate in [self.class fb_axisSnapshotsOfRoot:root axis:item.axis]) {
        if (item.type == XCUIElementTypeAny || candidate.elementType == item.type) {
          [typeMatches addObject:candidate];
        }
      }
    } else if (item.isDescendant) {
      // descendantsByFilteringWithBlock: includes the receiver itself if it
      // matches the filter, unlike XCUIElementQuery's descendantsMatchingType:,
      // so the root has to be excluded explicitly here.
      [typeMatches addObjectsFromArray:[root descendantsByFilteringWithBlock:^BOOL(id<FBXCElementSnapshot> snapshot) {
        return snapshot != root && (item.type == XCUIElementTypeAny || snapshot.elementType == item.type);
      }]];
    } else {
      for (id<FBXCElementSnapshot> child in root.children) {
        if (item.type == XCUIElementTypeAny || child.elementType == item.type) {
          [typeMatches addObject:child];
        }
      }
    }
  }
  if (roots.count > 1) {
    // Overlapping roots (e.g. a previous segment matched both an ancestor
    // and its own descendant) can otherwise yield the same snapshot twice,
    // which would skew positional selection ([2], [-1], etc.) compared to
    // the XCUIElementQuery-based matching this replaced, which always
    // operated on a de-duplicated element set.
    NSMutableArray<id<FBXCElementSnapshot>> *dedupedMatches = [NSMutableArray arrayWithCapacity:typeMatches.count];
    NSHashTable<id<FBXCElementSnapshot>> *seenMatches = [NSHashTable hashTableWithOptions:NSHashTableObjectPointerPersonality];
    for (id<FBXCElementSnapshot> match in typeMatches) {
      if (![seenMatches containsObject:match]) {
        [seenMatches addObject:match];
        [dedupedMatches addObject:match];
      }
    }
    typeMatches = dedupedMatches;
  }
  for (FBAbstractPredicateItem *predicateItem in item.predicates) {
    if ([predicateItem isKindOfClass:FBSelfPredicateItem.class]) {
      typeMatches = [[typeMatches filteredArrayUsingPredicate:predicateItem.value] mutableCopy];
    } else if ([predicateItem isKindOfClass:FBDescendantPredicateItem.class]) {
      NSMutableArray<id<FBXCElementSnapshot>> *containingMatches = [NSMutableArray array];
      for (id<FBXCElementSnapshot> candidate in typeMatches) {
        NSArray<id<FBXCElementSnapshot>> *matchingDescendants = [candidate descendantsByFilteringWithBlock:^BOOL(id<FBXCElementSnapshot> descendant) {
          return descendant != candidate && [predicateItem.value evaluateWithObject:descendant];
        }];
        if (matchingDescendants.count > 0) {
          [containingMatches addObject:candidate];
        }
      }
      typeMatches = containingMatches;
    }
  }
  return typeMatches.copy;
}

+ (NSArray<id<FBXCElementSnapshot>> *)fb_snapshotsInDocumentOrder:(NSArray<id<FBXCElementSnapshot>> *)snapshots
{
  if (snapshots.count < 2) {
    return snapshots;
  }
  id<FBXCElementSnapshot> root = snapshots.firstObject;
  while (nil != root.parent) {
    root = root.parent;
  }
  NSMapTable<id<FBXCElementSnapshot>, NSNumber *> *positions = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality
                                                                                     valueOptions:NSPointerFunctionsStrongMemory];
  NSUInteger position = 0;
  [positions setObject:@(position++) forKey:root];
  for (id<FBXCElementSnapshot> descendant in root._allDescendants) {
    [positions setObject:@(position++) forKey:descendant];
  }
  return [snapshots sortedArrayWithOptions:NSSortStable usingComparator:^NSComparisonResult(id<FBXCElementSnapshot> a, id<FBXCElementSnapshot> b) {
    return [([positions objectForKey:a] ?: @(NSUIntegerMax)) compare:([positions objectForKey:b] ?: @(NSUIntegerMax))];
  }];
}

// The snapshots on the given axis in the order positions count along it
+ (NSArray<id<FBXCElementSnapshot>> *)fb_axisSnapshotsOfRoot:(id<FBXCElementSnapshot>)root axis:(FBClassChainAxis)axis
{
  id<FBXCElementSnapshot> parent = root.parent;
  if (nil == parent) {
    return @[];
  }
  switch (axis) {
    case FBClassChainAxisParent:
      return @[parent];
    case FBClassChainAxisAncestor: {
      NSMutableArray<id<FBXCElementSnapshot>> *ancestors = [NSMutableArray array];
      for (id<FBXCElementSnapshot> ancestor = parent; nil != ancestor; ancestor = ancestor.parent) {
        [ancestors addObject:ancestor];
      }
      return ancestors.copy;
    }
    case FBClassChainAxisFollowingSibling:
    case FBClassChainAxisPrecedingSibling:
    case FBClassChainAxisSibling: {
      NSArray<id<FBXCElementSnapshot>> *siblings = parent.children;
      NSUInteger index = [siblings indexOfObjectIdenticalTo:root];
      if (NSNotFound == index) {
        return @[];
      }
      NSRange range = NSMakeRange(0, siblings.count);
      if (FBClassChainAxisFollowingSibling == axis) {
        range = NSMakeRange(index + 1, siblings.count - index - 1);
      } else if (FBClassChainAxisPrecedingSibling == axis) {
        range = NSMakeRange(0, index);
      }
      NSMutableArray<id<FBXCElementSnapshot>> *result = [NSMutableArray array];
      for (NSUInteger i = range.location; i < NSMaxRange(range); i++) {
        if (i != index) {
          [result addObject:siblings[i]];
        }
      }
      return FBClassChainAxisPrecedingSibling == axis
        ? result.reverseObjectEnumerator.allObjects
        : result.copy;
    }
    default:
      return @[];
  }
}

+ (NSArray<id<FBXCElementSnapshot>> *)fb_matchingSnapshotsWithItem:(FBClassChainItem *)item candidates:(NSArray<id<FBXCElementSnapshot>> *)candidates shouldReturnAfterFirstMatch:(nullable NSNumber *)shouldReturnAfterFirstMatch
{
  if (1 == item.position.integerValue || (0 == item.position.integerValue && shouldReturnAfterFirstMatch.boolValue)) {
    id<FBXCElementSnapshot> result = candidates.firstObject;
    return result ? @[result] : @[];
  }
  if (0 == item.position.integerValue) {
    return candidates;
  }
  if (candidates.count >= (NSUInteger)ABS(item.position.integerValue)) {
    return item.position.integerValue > 0
      ? @[[candidates objectAtIndex:item.position.integerValue - 1]]
      : @[[candidates objectAtIndex:candidates.count + item.position.integerValue]];
  }
  return @[];
}

@end
