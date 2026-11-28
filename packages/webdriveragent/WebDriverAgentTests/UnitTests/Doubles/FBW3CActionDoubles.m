/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBW3CActionDoubles.h"

#import "XCUIElement.h"
#import "XCUIScreen.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH

@implementation FBW3CPointCoordinate {
  CGPoint _point;
}

+ (instancetype)coordinateWithPoint:(CGPoint)point
{
  // Skips XCUICoordinate's initializer, which needs a live element
  FBW3CPointCoordinate *coordinate = [self alloc];
  coordinate->_point = point;
  return coordinate;
}

- (CGPoint)screenPoint
{
  return _point;
}

- (XCUICoordinate *)coordinateWithOffset:(CGVector)offset
{
  return [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(_point.x + offset.dx, _point.y + offset.dy)];
}

@end

@implementation FBW3CScreenDouble
@end

@implementation FBW3CElementDouble

+ (instancetype)doubleWithType:(XCUIElementType)type frame:(CGRect)frame
{
  // Skips XCUIElement's initializer, which needs a live application
  FBW3CElementDouble *element = [self alloc];
  element.stubType = type;
  element.stubFrame = frame;
  return element;
}

- (XCUIElementType)elementType
{
  return self.stubType;
}

- (BOOL)exists
{
  return YES;
}

- (CGRect)frame
{
  return self.stubFrame;
}

- (CGRect)wdFrame
{
  return self.stubFrame;
}

- (XCUIScreen *)screen
{
  return nil == self.stubScreen ? XCUIScreen.mainScreen : (XCUIScreen *)self.stubScreen;
}

- (UIInterfaceOrientation)interfaceOrientation
{
  return UIInterfaceOrientationPortrait;
}

- (XCUICoordinate *)coordinateWithNormalizedOffset:(CGVector)normalizedOffset
{
  return [FBW3CPointCoordinate coordinateWithPoint:CGPointMake(self.stubFrame.origin.x + normalizedOffset.dx * self.stubFrame.size.width,
                                                               self.stubFrame.origin.y + normalizedOffset.dy * self.stubFrame.size.height)];
}

- (NSString *)description
{
  return @"FBW3CElementDouble";
}

- (NSUInteger)hash
{
  return (NSUInteger)(__bridge void *)self;
}

- (BOOL)isEqual:(id)object
{
  return self == object;
}

@end

#endif
