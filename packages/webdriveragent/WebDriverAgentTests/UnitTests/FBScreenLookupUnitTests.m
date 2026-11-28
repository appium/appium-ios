/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBScreen.h"
#import "XCUIScreen.h"

@interface FBScreen (FBLookupUnitTesting)
+ (nullable NSNumber *)hasMultipleScreensForDevice:(id)device error:(NSError **)error;
+ (nullable XCUIScreen *)screenWithDisplayID:(long long)displayID device:(id)device error:(NSError **)error;
@end

// Screen with a zero-sized placeholder shape (no id, empty bounds)
@interface FBUnitEmptyScreenDouble : NSObject
@property (nonatomic) CGRect bounds;
@end
@implementation FBUnitEmptyScreenDouble
@end

@interface FBUnitScreenDouble : NSObject
@property (nonatomic) long long displayID;
@property (nonatomic) CGRect bounds;
@property (nonatomic) double scale;
@property (nonatomic) BOOL isMainScreen;
@property (nonatomic) unsigned long long traits;
+ (instancetype)screenWithID:(long long)displayID;
@end
@implementation FBUnitScreenDouble
+ (instancetype)screenWithID:(long long)displayID
{
  FBUnitScreenDouble *screen = [self new];
  screen.displayID = displayID;
  screen.bounds = CGRectMake(0, 0, 390, 844);
  screen.scale = 3;
  return screen;
}
@end

@interface FBUnitScreenDeviceDouble : NSObject
@property (nonatomic) BOOL nativeLookupAvailable;
@property (nonatomic) BOOL enumerationUnavailable;
@property (nonatomic) NSUInteger enumerationCount;
@property (nonatomic, strong) id nativeScreen;
@property (nonatomic, strong) NSArray *screens;
@property (nonatomic, strong) NSError *lookupError;
@property (nonatomic, strong) NSError *enumerationError;
@end

@implementation FBUnitScreenDeviceDouble
- (BOOL)respondsToSelector:(SEL)selector
{
  if (selector == NSSelectorFromString(@"screensOrError:") && self.enumerationUnavailable) {
    return NO;
  }
  return selector == @selector(screenWithDisplayID:orError:)
    ? self.nativeLookupAvailable : [super respondsToSelector:selector];
}
- (id)screenWithDisplayID:(long long)displayID orError:(NSError **)error
{
  if (NULL != error) {
    *error = self.lookupError;
  }
  return self.nativeScreen;
}
- (NSArray *)screensOrError:(NSError **)error
{
  self.enumerationCount++;
  if (NULL != error) {
    *error = self.enumerationError;
  }
  return self.screens;
}
@end

@interface FBScreenLookupUnitTests : XCTestCase
@end

@implementation FBScreenLookupUnitTests

- (void)testDisplayCountDoesNotTreatEnumerationFailureAsSingleDisplay
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.enumerationError = [NSError errorWithDomain:@"Enumeration" code:2 userInfo:nil];
  NSError *error = nil;
  XCTAssertNil([FBScreen hasMultipleScreensForDevice:device error:&error]);
  XCTAssertEqualObjects(error, device.enumerationError);

  device.enumerationError = nil;
  error = nil;
  XCTAssertNil([FBScreen hasMultipleScreensForDevice:device error:&error]);
  XCTAssertNotNil(error);
}

- (void)testDisplayCountDistinguishesSingleAndMultipleDisplays
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.screens = @[[FBUnitScreenDouble screenWithID:1]];
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen hasMultipleScreensForDevice:device error:&error], @NO);
  XCTAssertNil(error);
  device.screens = @[[FBUnitScreenDouble screenWithID:1], [FBUnitScreenDouble screenWithID:2]];
  XCTAssertEqualObjects([FBScreen hasMultipleScreensForDevice:device error:&error], @YES);
  XCTAssertNil(error);
}

- (void)testNativeScreenLookupDoesNotEnumerateOnSuccess
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.nativeScreen = [FBUnitScreenDouble screenWithID:7];
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen screenWithDisplayID:7 device:device error:&error], device.nativeScreen);
  XCTAssertNil(error);
  XCTAssertEqual(device.enumerationCount, 0UL);
}

- (void)testNativeScreenPlaceholderMustBeAvailable
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.nativeScreen = [FBUnitEmptyScreenDouble new];
  device.screens = @[[FBUnitScreenDouble screenWithID:1]];
  NSError *error = nil;
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertNotNil(error);
  XCTAssertEqual(device.enumerationCount, 1UL);
}

- (void)testNativeScreenLookupFailureIncludesAvailableIDs
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.screens = @[[FBUnitScreenDouble screenWithID:1]];
  device.lookupError = [NSError errorWithDomain:@"NativeLookup" code:1 userInfo:nil];
  NSError *error = nil;
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertEqual(device.enumerationCount, 1UL);
  XCTAssertTrue([error.localizedDescription containsString:@"Available display ids"]);
  XCTAssertEqualObjects(error.userInfo[NSUnderlyingErrorKey], device.lookupError);
}

- (void)testNativeScreenLookupErrorSurvivesEnumerationFailure
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.nativeLookupAvailable = YES;
  device.lookupError = [NSError errorWithDomain:@"NativeLookup" code:1 userInfo:nil];
  device.enumerationError = [NSError errorWithDomain:@"Enumeration" code:2 userInfo:nil];
  NSError *error = nil;
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertEqualObjects(error, device.lookupError);
}

- (void)testScreenLookupWithoutNativeSelector
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  FBUnitScreenDouble *main = [FBUnitScreenDouble screenWithID:5];
  device.screens = @[main];
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen screenWithDisplayID:main.displayID device:device error:&error], main);
  XCTAssertNil(error);
  XCTAssertEqual(device.enumerationCount, 1UL);
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertTrue([error.localizedDescription containsString:@"Available display ids: [5]"]);
  device.screens = nil;
  device.enumerationError = [NSError errorWithDomain:@"Enumeration" code:2 userInfo:nil];
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertEqualObjects(error, device.enumerationError);
}

- (void)testScreenLookupWithoutDeviceScreenSelectors
{
  FBUnitScreenDeviceDouble *device = [FBUnitScreenDeviceDouble new];
  device.enumerationUnavailable = YES;
  NSError *error = nil;
  XCTAssertEqualObjects([FBScreen screenWithDisplayID:XCUIScreen.mainScreen.displayID device:device error:&error],
                        XCUIScreen.mainScreen);
  XCTAssertNil(error);
  XCTAssertNil([FBScreen screenWithDisplayID:-1 device:device error:&error]);
  XCTAssertNotNil(error);
  XCTAssertEqual(device.enumerationCount, 0UL);
}

@end
