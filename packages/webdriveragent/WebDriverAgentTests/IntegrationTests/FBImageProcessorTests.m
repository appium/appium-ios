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
  NSDictionary<NSString *, NSValue *> *expectedCenters = @{
    @"landscapeRight": [NSValue valueWithCGPoint:CGPointMake(15, 30)],
    @"landscapeLeft": [NSValue valueWithCGPoint:CGPointMake(45, 10)],
    @"portraitUpsideDown": [NSValue valueWithCGPoint:CGPointMake(30, 45)],
  };
  for (NSString *orientation in expectedCenters) {
    XCTAssertTrue([configuration setScreenshotOrientation:orientation error:nil]);
    NSData *output = [[FBImageProcessor new] scaledImageWithData:input uti:UTTypePNG scalingFactor:1
                                              compressionQuality:1 error:nil];
    UIImage *image = [UIImage imageWithData:output];
    CGSize expectedSize = [orientation isEqualToString:@"portraitUpsideDown"] ? CGSizeMake(40, 60) : CGSizeMake(60, 40);
    XCTAssertTrue(CGSizeEqualToSize(image.size, expectedSize), @"%@", orientation);
    for (NSUInteger row = 0; row < 2; row++) {
      for (NSUInteger column = 0; column < 2; column++) {
        CGPoint point = CGPointMake(expectedSize.width * (0.25 + 0.5 * column),
                                    expectedSize.height * (0.25 + 0.5 * row));
        CGImageRef pixel = CGImageCreateWithImageInRect(image.CGImage, (CGRect){point, {1, 1}});
        uint8_t alpha = 0;
        CGContextRef context = CGBitmapContextCreate(&alpha, 1, 1, 8, 1, NULL, (CGBitmapInfo)kCGImageAlphaOnly);
        CGContextDrawImage(context, CGRectMake(0, 0, 1, 1), pixel);
        CGContextRelease(context);
        CGImageRelease(pixel);
        BOOL isMarker = CGPointEqualToPoint(point, expectedCenters[orientation].CGPointValue);
        XCTAssertEqual(alpha, isMarker ? 255 : 0, @"%@ at %@", orientation, NSStringFromCGPoint(point));
      }
    }
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
