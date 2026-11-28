/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import <objc/runtime.h>

#import "XCUIDevice+FBHelpers.h"

@interface XCUIDeviceHelpersTests : XCTestCase
@end

@implementation XCUIDeviceHelpersTests

- (void)testPressingUnsupportedButton
{
  // The unit host is not authorized to query hardware buttons, so stub the capability probe
  Method method = class_getInstanceMethod(XCUIDevice.class, @selector(hasHardwareButton:));
  IMP original = method_getImplementation(method);
  IMP replacement = imp_implementationWithBlock(^BOOL(id receiver, NSInteger button) { return NO; });
  method_setImplementation(method, replacement);
  NSError *error = nil;
  BOOL pressed;
  @try {
    pressed = [XCUIDevice.sharedDevice fb_pressButton:@"volumeUpp" forDuration:nil error:&error];
  } @finally {
    method_setImplementation(method, original);
    imp_removeBlock(replacement);
  }
  XCTAssertFalse(pressed);
  XCTAssertNotNil(error);
  // The error is built before the device is touched and lists the supported buttons
  XCTAssertTrue([error.localizedDescription containsString:@"The button 'volumeUpp' is not supported"]);
  XCTAssertTrue([error.localizedDescription containsString:@"only supports the following buttons"]);
  XCTAssertTrue([error.localizedDescription containsString:@"home"]);
}

@end
