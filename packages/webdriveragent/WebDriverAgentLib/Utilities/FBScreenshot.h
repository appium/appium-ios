/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
@class UTType;

NS_ASSUME_NONNULL_BEGIN

@interface FBScreenshot : NSObject

/**
 Retrieves non-scaled screenshot of the display selected by the currentDisplayId setting

 @param quality The number in range 0-3, where 0 is PNG (lossless), 3 is HEIC (lossless), 1- low quality JPEG and 2 - high quality JPEG
 @param error If there is an error, upon return contains an NSError object that describes the problem.
 @return Device screenshot as PNG-encoded data or nil in case of failure
 */
+ (nullable NSData *)takeInOriginalResolutionWithQuality:(NSUInteger)quality
                                                   error:(NSError **)error;

/**
 Retrieves non-scaled screenshot of the display selected by the currentDisplayId setting

 @param screenID The screen identifier to take the screenshot from
 @param compressionQuality Normalized screenshot quality value in range 0..1, where 1 is the best quality
 @param uti UTType... constant, which defines the type of the returned screenshot image
 @param timeout how much time to allow for the screenshot to be taken
 @param error If there is an error, upon return contains an NSError object that describes the problem.
 @return Device screenshot as PNG-, HEIC- or JPG-encoded data or nil in case of failure
 */
+ (nullable NSData *)takeInOriginalResolutionWithScreenID:(long long)screenID
                                       compressionQuality:(CGFloat)compressionQuality
                                                      uti:(UTType *)uti
                                                  timeout:(NSTimeInterval)timeout
                                                    error:(NSError **)error;

/**
 Requests a non-scaled screenshot without waiting for the answer

 @param screenID The screen identifier to take the screenshot from
 @param compressionQuality Normalized screenshot quality value in range 0..1, where 1 is the best quality
 @param uti UTType... constant, which defines the type of the returned screenshot image
 @param completion Called once, on an arbitrary queue and at any time later, with either the image data or the error
 @param error If the request cannot be made, upon return contains an NSError object that describes the problem.
 @return YES if the request has been sent, in which case the completion will be called
 */
+ (BOOL)requestInOriginalResolutionWithScreenID:(long long)screenID
                             compressionQuality:(CGFloat)compressionQuality
                                            uti:(UTType *)uti
                                     completion:(void (^)(NSData * _Nullable data, NSError * _Nullable error))completion
                                          error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
