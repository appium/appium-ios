/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBImageProcessor.h"
#import "FBConfiguration.h"
@import UniformTypeIdentifiers;
#import "FBIntegrationTestCase.h"


@interface FBImageProcessorTests : FBIntegrationTestCase

@property (nonatomic) NSData *originalImage;
@property (nonatomic) CGSize originalSize;

@end

@implementation FBImageProcessorTests

- (void)setUp {
  XCUIApplication *app = [[XCUIApplication alloc] init];
  [app launch];
  XCUIScreenshot *screenshot = app.screenshot;
  self.originalImage = UIImageJPEGRepresentation(screenshot.image, 1.0);
  self.originalSize = [FBImageProcessorTests scaledSizeFromImage:screenshot.image];
}

- (void)testScaling {
  CGFloat halfScale = 0.5;
  CGSize expectedHalfScaleSize = [FBImageProcessorTests sizeFromSize:self.originalSize scalingFactor:0.5];
  [self scaleImageWithFactor:halfScale
                expectedSize:expectedHalfScaleSize];

  // 0 is the smalles scaling factor we accept
  CGFloat minScale = 0.0;
  CGSize expectedMinScaleSize = [FBImageProcessorTests sizeFromSize:self.originalSize scalingFactor:0.01];
  [self scaleImageWithFactor:minScale
                expectedSize:expectedMinScaleSize];

  // For scaling factors above 100 we don't perform any scaling and just return the unmodified image
  [self scaleImageWithFactor:1.0
                expectedSize:self.originalSize];
  [self scaleImageWithFactor:2.0
                expectedSize:self.originalSize];
}

- (void)scaleImageWithFactor:(CGFloat)scalingFactor expectedSize:(CGSize)excpectedSize {
  FBImageProcessor *scaler = [[FBImageProcessor alloc] init];

  id expScaled = [self expectationWithDescription:@"Receive scaled image"];

  [scaler submitImageData:self.originalImage
            scalingFactor:scalingFactor
        completionHandler:^(NSData *scaled) {
    UIImage *scaledImage = [UIImage imageWithData:scaled];
    CGSize scaledSize = [FBImageProcessorTests scaledSizeFromImage:scaledImage];
    
    XCTAssertEqualWithAccuracy(scaledSize.width, excpectedSize.width, 1.0);
    XCTAssertEqualWithAccuracy(scaledSize.height, excpectedSize.height, 1.0);
    
    [expScaled fulfill];
  }];

  [self waitForExpectations:@[expScaled]
                    timeout:0.5];

}

+ (CGSize)scaledSizeFromImage:(UIImage *)image {
  return CGSizeMake(image.size.width * image.scale, image.size.height * image.scale);
}

+ (CGSize)sizeFromSize:(CGSize)size scalingFactor:(CGFloat)scalingFactor {
  return CGSizeMake(round(size.width * scalingFactor), round(size.height * scalingFactor));
}

@end



// Synthetic images keep these renderer regressions independent of the app's screen.
@interface FBImageRendererScalingTests : XCTestCase
@end

@implementation FBImageRendererScalingTests

- (void)testExplicitOrientationOverridesUprightImageMetadataAtFullSize
{
  FBConfiguration *configuration = FBConfiguration.sharedInstance;
  NSString *previous = configuration.humanReadableScreenshotOrientation;
  [self addTeardownBlock:^{ [configuration setScreenshotOrientation:previous error:nil]; }];

  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat new];
  format.scale = 1;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:CGSizeMake(40, 60) format:format];
  NSData *input = [renderer PNGDataWithActions:^(UIGraphicsImageRendererContext *context) {
    [context fillRect:CGRectMake(0, 0, 20, 30)];
  }];
  // Only the top-left quadrant is opaque. Its destination distinguishes the
  // two landscape rotations and also detects a skipped upside-down rotation.
  // Expected alpha values in reading order: top-left, top-right, bottom-left, bottom-right.
  NSDictionary *expectedQuadrants = @{
    @"landscapeRight": @[@0, @0, @255, @0],
    @"landscapeLeft": @[@0, @255, @0, @0],
    @"portraitUpsideDown": @[@0, @0, @0, @255],
  };
  for (NSString *orientation in expectedQuadrants) {
    XCTAssertTrue([configuration setScreenshotOrientation:orientation error:nil]);
    NSData *output = [[FBImageProcessor new] scaledImageWithData:input uti:UTTypePNG scalingFactor:1
                                              compressionQuality:1 error:nil];
    UIImage *image = [UIImage imageWithData:output];
    CGSize expectedSize = [orientation isEqualToString:@"portraitUpsideDown"] ? CGSizeMake(40, 60) : CGSizeMake(60, 40);
    XCTAssertTrue(CGSizeEqualToSize(image.size, expectedSize), @"%@", orientation);
    uint8_t alpha[4] = {};
    CGContextRef context = CGBitmapContextCreate(alpha, 2, 2, 8, 2, NULL, (CGBitmapInfo)kCGImageAlphaOnly);
    CGContextSetInterpolationQuality(context, kCGInterpolationNone);
    CGContextDrawImage(context, CGRectMake(0, 0, 2, 2), image.CGImage);
    CGContextRelease(context);
    NSArray *quadrants = @[@(alpha[0]), @(alpha[1]), @(alpha[2]), @(alpha[3])];
    XCTAssertEqualObjects(quadrants, expectedQuadrants[orientation], @"%@", orientation);
  }
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

@end
