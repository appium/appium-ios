/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
@import UniformTypeIdentifiers;
#import <UIKit/UIKit.h>

#import "FBImageProcessor.h"

@interface FBImageProcessingTests : XCTestCase
@property (nonatomic) NSData *originalImage;
@property (nonatomic) CGSize originalSize;
@end

@implementation FBImageProcessingTests

- (void)setUp
{
  [super setUp];
  // Synthetic JPEG keeps the scaling checks independent of a live screenshot
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat new];
  format.scale = 1.0;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(300, 600)
                                                                             format:format];
  self.originalImage = [renderer JPEGDataWithCompressionQuality:1.0
                                                        actions:^(UIGraphicsImageRendererContext *context) {
    [UIColor.redColor setFill];
    [context fillRect:CGRectMake(0, 0, 300, 600)];
  }];
  self.originalSize = [FBImageProcessingTests scaledSizeFromImage:[UIImage imageWithData:self.originalImage]];
  XCTAssertEqualWithAccuracy(self.originalSize.width, 300, 0.01);
  XCTAssertEqualWithAccuracy(self.originalSize.height, 600, 0.01);
}

- (void)testScaling
{
  [self scaleImageWithFactor:0.5
                expectedSize:[FBImageProcessingTests sizeFromSize:self.originalSize scalingFactor:0.5]];
  // 0 is the smallest scaling factor we accept
  [self scaleImageWithFactor:0.0
                expectedSize:[FBImageProcessingTests sizeFromSize:self.originalSize scalingFactor:0.01]];
  // For scaling factors above 100 we don't perform any scaling and just return the unmodified image
  [self scaleImageWithFactor:1.0 expectedSize:self.originalSize];
  [self scaleImageWithFactor:2.0 expectedSize:self.originalSize];
}

- (void)testOrientationFixDoesNotApplyScalingTwice
{
  for (NSNumber *sourceScale in @[@1, @2, @3]) {
    UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat new];
    format.scale = sourceScale.doubleValue;
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc]
      initWithSize:CGSizeMake(120, 80) format:format];
    NSData *data = [renderer PNGDataWithActions:^(UIGraphicsImageRendererContext *context) {
      [UIColor.redColor setFill];
      [context fillRect:CGRectMake(0, 0, 120, 80)];
    }];
    FBImageProcessor *processor = [FBImageProcessor new];
    NSData *scaled = [processor scaledImageWithData:data
                                               uti:UTTypePNG
                                     scalingFactor:0.5
                                compressionQuality:1.0
                                             error:nil];
    UIImage *image = [UIImage imageWithData:scaled];
    XCTAssertNotNil(image);
    XCTAssertEqual(CGImageGetWidth(image.CGImage), (size_t)(60 * sourceScale.integerValue));
    XCTAssertEqual(CGImageGetHeight(image.CGImage), (size_t)(40 * sourceScale.integerValue));
  }
}

- (void)scaleImageWithFactor:(CGFloat)scalingFactor expectedSize:(CGSize)expectedSize
{
  FBImageProcessor *scaler = [[FBImageProcessor alloc] init];
  XCTestExpectation *expScaled = [self expectationWithDescription:@"Receive scaled image"];
  [scaler submitImageData:self.originalImage
            scalingFactor:scalingFactor
        completionHandler:^(NSData *scaled) {
    UIImage *scaledImage = [UIImage imageWithData:scaled];
    CGSize scaledSize = [FBImageProcessingTests scaledSizeFromImage:scaledImage];
    XCTAssertEqualWithAccuracy(scaledSize.width, expectedSize.width, 1.0);
    XCTAssertEqualWithAccuracy(scaledSize.height, expectedSize.height, 1.0);
    [expScaled fulfill];
  }];
  [self waitForExpectations:@[expScaled] timeout:2];
}

+ (CGSize)scaledSizeFromImage:(UIImage *)image
{
  return CGSizeMake(image.size.width * image.scale, image.size.height * image.scale);
}

+ (CGSize)sizeFromSize:(CGSize)size scalingFactor:(CGFloat)scalingFactor
{
  return CGSizeMake(round(size.width * scalingFactor), round(size.height * scalingFactor));
}

@end
