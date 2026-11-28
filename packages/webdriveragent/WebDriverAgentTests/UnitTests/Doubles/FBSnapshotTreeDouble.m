/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBSnapshotTreeDouble.h"

@implementation FBSnapshotTreeDouble

@synthesize elementType = _elementType;
@synthesize identifier = _identifier;
@synthesize placeholderValue = _placeholderValue;
@synthesize frame = _frame;
@synthesize enabled = _enabled;
@synthesize selected = _selected;
@synthesize parent = _parent;
@synthesize children = _children;

+ (instancetype)type:(XCUIElementType)type label:(NSString *)label children:(NSArray<FBSnapshotTreeDouble *> *)children
{
  FBSnapshotTreeDouble *result = [self new];
  result.elementType = type;
  result.label = label;
  [result adoptChildren:children ?: @[]];
  return result;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _elementType = XCUIElementTypeOther;
    _identifier = @"testName";
    _placeholderValue = nil;
    _frame = CGRectZero;
    _enabled = YES;
    _selected = NO;
    _children = @[];
  }
  return self;
}

- (void)adoptChildren:(NSArray<FBSnapshotTreeDouble *> *)children
{
  self.children = children;
  for (FBSnapshotTreeDouble *child in children) {
    child.parent = self;
  }
}

- (NSArray *)_allDescendants
{
  NSMutableArray *result = [NSMutableArray array];
  for (FBSnapshotTreeDouble *child in self.children) {
    [result addObject:child];
    [result addObjectsFromArray:child._allDescendants];
  }
  return result;
}

- (NSArray *)descendantsByFilteringWithBlock:(BOOL(^)(id snapshot))block
{
  NSMutableArray *result = [NSMutableArray array];
  if (block(self)) {
    [result addObject:self];
  }
  for (FBSnapshotTreeDouble *child in self.children) {
    [result addObjectsFromArray:[child descendantsByFilteringWithBlock:block]];
  }
  return result;
}

@end
