/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBIntegrationTestCase.h"
#import "FBConfiguration.h"
#import "FBScreen.h"

#import "XCUIElement.h"
#import "XCUIElement+FBWebDriverAttributes.h"
#import "XCUIDevice.h"
#import "XCUIApplication+FBTouchAction.h"
#import "FBTestMacros.h"
#import "XCUIDevice+FBRotation.h"
#import "FBRunLoopSpinner.h"
#import "FBXCodeCompatibility.h"
#import "FBW3CActionsSynthesizer.h"
#import "XCSynthesizedEventRecord.h"
#import "XCPointerEventPath.h"
#import "XCPointerEvent.h"
#import "XCUIScreen.h"

@interface FBW3CTouchActionsIntegrationTestsPart1 : FBIntegrationTestCase
@end

@interface FBW3CTouchActionsIntegrationTestsPart2 : FBIntegrationTestCase
@property (nonatomic) XCUIElement *pickerWheel;
@end


@implementation FBW3CTouchActionsIntegrationTestsPart1

- (void)verifyGesture:(NSArray<NSDictionary<NSString *, id> *> *)gesture orientation:(UIDeviceOrientation)orientation
{
  [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation];
  // XCTest may report the new interface orientation while the Alerts button
  // still has transposed geometry from the rotation transition. The fixture's
  // button is wider than it is tall in every settled orientation. Wait for that
  // layout before resolving the W3C action's element-origin coordinates.
  XCUIElement *button = self.testedApplication.buttons[FBShowAlertButtonName];
  FBAssertWaitTillBecomesTrue(CGRectGetWidth(button.frame) > CGRectGetHeight(button.frame));
  NSError *error;
  XCTAssertTrue([self.testedApplication fb_performW3CActions:gesture elementCache:nil error:&error]);
  FBAssertWaitTillBecomesTrue(self.testedApplication.alerts.count > 0);
}

- (void)setUp
{
  [super setUp];
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    [self launchApplication];
    [self goToAlertsPage];
  });
  [self clearAlert];
}

- (void)tearDown
{
  FBConfiguration.sharedInstance.currentDisplayId = nil;
  [self clearAlert];
  [self resetOrientation];
  [super tearDown];
}

- (nullable XCSynthesizedEventRecord *)tapRecordWithError:(NSError **)error
{
  NSArray *gesture = @[@{
    @"type": @"pointer", @"id": @"finger", @"parameters": @{@"pointerType": @"touch"},
    @"actions": @[
      @{@"type": @"pointerMove", @"x": @100, @"y": @100, @"duration": @0},
      @{@"type": @"pointerDown", @"button": @0},
      @{@"type": @"pointerUp", @"button": @0},
    ],
  }];
  FBW3CActionsSynthesizer *synthesizer = [[FBW3CActionsSynthesizer alloc] initWithActions:gesture
                                                                           forApplication:self.testedApplication
                                                                             elementCache:nil
                                                                                    error:error];
  return [synthesizer synthesizeWithError:error];
}

- (NSArray<XCPointerEvent *> *)pointerEventsOfRecord:(XCSynthesizedEventRecord *)record
{
  XCPointerEventPath *eventPath = record.eventPaths.firstObject;
  return eventPath.pointerEvents;
}

- (void)testMainDisplaySettingKeepsDefaultCoordinates
{
  for (NSNumber *orientation in @[@(UIDeviceOrientationPortrait),
                                  @(UIDeviceOrientationLandscapeLeft),
                                  @(UIDeviceOrientationLandscapeRight)]) {
    [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation.integerValue];
    NSError *error = nil;
    FBConfiguration.sharedInstance.currentDisplayId = nil;
    XCSynthesizedEventRecord *baseline = [self tapRecordWithError:&error];
    FBConfiguration.sharedInstance.currentDisplayId = @([FBScreen displayID]);
    XCSynthesizedEventRecord *selected = [self tapRecordWithError:&error];
    XCTAssertNotNil(baseline);
    XCTAssertNotNil(selected);
    XCTAssertNil(error);
    NSArray<XCPointerEvent *> *baselineEvents = [self pointerEventsOfRecord:baseline];
    NSArray<XCPointerEvent *> *selectedEvents = [self pointerEventsOfRecord:selected];
    XCTAssertEqual(baselineEvents.count, selectedEvents.count);
    for (NSUInteger i = 0; i < baselineEvents.count; i++) {
      XCTAssertTrue(CGPointEqualToPoint(baselineEvents[i].coordinate, selectedEvents[i].coordinate));
    }
  }
}

- (void)testSecondaryDisplaySetting
{
  XCUIScreen *secondary = nil;
  NSError *error = nil;
  NSArray<NSDictionary<NSString *, id> *> *screens = [FBScreen screensWithError:&error];
  XCTAssertNotNil(screens);
  XCTAssertNil(error);
  for (NSDictionary<NSString *, id> *screen in screens) {
    long long displayID = [screen[@"displayId"] longLongValue];
    if (displayID != [FBScreen displayID]) {
      secondary = [FBScreen screenWithDisplayID:displayID error:&error];
      XCTAssertNotNil(secondary);
      XCTAssertNil(error);
      break;
    }
  }
  if (nil == secondary) {
    XCTSkip(@"The device has no secondary display");
  }
  FBConfiguration.sharedInstance.currentDisplayId = @(secondary.displayID);
  XCUIElement *anchor = nil;
  for (XCUIElement *window in [self.testedApplication childrenMatchingType:XCUIElementTypeWindow].allElementsBoundByIndex) {
    (void)window.frame;
    if (window.screen.displayID == secondary.displayID && !CGRectIsEmpty(window.wdFrame)) {
      anchor = window;
      break;
    }
  }
  XCSynthesizedEventRecord *selected = [self tapRecordWithError:&error];
  if (nil == anchor) {
    XCTAssertNil(selected);
    XCTAssertNotNil(error);
    XCTAssertTrue([error.localizedDescription containsString:@"No non-empty application window"]);
    return;
  }
  XCTAssertNotNil(selected);
  XCTAssertNil(error);
  XCTAssertEqual(selected.displayID, (unsigned long long)secondary.displayID);
  CGRect frame = anchor.wdFrame;
  CGPoint expected = [anchor coordinateWithNormalizedOffset:
    CGVectorMake((100 - frame.origin.x) / frame.size.width,
                 (100 - frame.origin.y) / frame.size.height)].screenPoint;
  CGPoint actual = [self pointerEventsOfRecord:selected].firstObject.coordinate;
  XCTAssertEqualWithAccuracy(actual.x, expected.x, 1);
  XCTAssertEqualWithAccuracy(actual.y, expected.y, 1);
}

- (void)testTap
{
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"origin": self.testedApplication.buttons[FBShowAlertButtonName], @"x": @0, @"y": @0},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @100},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyGesture:gesture orientation:UIDeviceOrientationPortrait];
}

- (void)testDoubleTap
{
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"origin": self.testedApplication.buttons[FBShowAlertButtonName]},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @50},
          @{@"type": @"pointerUp"},
          @{@"type": @"pause", @"duration": @200},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @50},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyGesture:gesture orientation:UIDeviceOrientationLandscapeLeft];
}

- (void)testLongPressWithCombinedPause
{
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"origin": self.testedApplication.buttons[FBShowAlertButtonName], @"x": @5, @"y": @5},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @200},
          @{@"type": @"pause", @"duration": @200},
          @{@"type": @"pause", @"duration": @100},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyGesture:gesture orientation:UIDeviceOrientationLandscapeRight];
}

- (void)testLongPress
{
  if (UIDevice.currentDevice.userInterfaceIdiom == UIUserInterfaceIdiomPad) {
    XCTSkip(@"Failed on Azure Pipeline. Local run succeeded.");
  }
  UIDeviceOrientation orientation = UIDeviceOrientationLandscapeLeft;
  [[XCUIDevice sharedDevice] fb_setDeviceInterfaceOrientation:orientation];
  CGRect elementFrame = self.testedApplication.buttons[FBShowAlertButtonName].frame;
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"x": @(elementFrame.origin.x + 1), @"y": @(elementFrame.origin.y + 1)},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @500},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyGesture:gesture orientation:orientation];
}

- (void)testForceTap
{
  if (![XCUIDevice.sharedDevice supportsPressureInteraction]) {
    XCTSkip(@"Device does not support pressure interaction");
  }

  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"origin": self.testedApplication.buttons[FBShowAlertButtonName]},
          @{@"type": @"pointerDown"},
          @{@"type": @"pause", @"duration": @500},
          @{@"type": @"pointerDown", @"pressure": @1.0},
          @{@"type": @"pause", @"duration": @50},
          @{@"type": @"pointerDown", @"pressure": @1.0},
          @{@"type": @"pause", @"duration": @50},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyGesture:gesture orientation:UIDeviceOrientationLandscapeLeft];
}

@end


@implementation FBW3CTouchActionsIntegrationTestsPart2

- (void)setUp
{
  [super setUp];
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    [self launchApplication];
    [self goToAttributesPage];
  });
  self.pickerWheel = self.testedApplication.pickerWheels.allElementsBoundByIndex.firstObject;
}

- (void)tearDown
{
  [self resetOrientation];
  [super tearDown];
}

- (void)verifyPickerWheelPositionChangeWithGesture:(NSArray<NSDictionary<NSString *, id> *> *)gesture
{
  NSString *previousValue = self.pickerWheel.value;
  NSError *error;
  XCTAssertTrue([self.testedApplication fb_performW3CActions:gesture elementCache:nil error:&error]);
  XCTAssertNil(error);
  XCTAssertTrue([[[[FBRunLoopSpinner new]
                   timeout:2.0]
                  timeoutErrorMessage:@"Picker wheel value has not been changed after 2 seconds timeout"]
                 spinUntilTrue:^BOOL{
    return ![[self.pickerWheel fb_standardSnapshot].value isEqualToString:previousValue];
                 }
                 error:&error]);
  XCTAssertNil(error);
}

- (void)testSwipePickerWheelWithElementCoordinates
{
  CGRect pickerFrame = self.pickerWheel.frame;
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"origin": self.pickerWheel, @"x": @0, @"y":@0},
          @{@"type": @"pointerDown"},
          @{@"type": @"pointerMove", @"duration": @500, @"origin": self.pickerWheel, @"x": @0, @"y": @(pickerFrame.size.height / 2)},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyPickerWheelPositionChangeWithGesture:gesture];
}

- (void)testSwipePickerWheelWithRelativeCoordinates
{
  CGRect pickerFrame = self.pickerWheel.frame;
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @250, @"origin": self.pickerWheel, @"x": @0, @"y": @0},
          @{@"type": @"pointerDown"},
          @{@"type": @"pointerMove", @"duration": @500, @"origin": @"pointer", @"x": @0, @"y": @(-pickerFrame.size.height / 2)},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyPickerWheelPositionChangeWithGesture:gesture];
}

- (void)testSwipePickerWheelWithAbsoluteCoordinates
{
  CGRect pickerFrame = self.pickerWheel.frame;
  NSArray<NSDictionary<NSString *, id> *> *gesture =
  @[@{
      @"type": @"pointer",
      @"id": @"finger1",
      @"parameters": @{@"pointerType": @"touch"},
      @"actions": @[
          @{@"type": @"pointerMove", @"duration": @0, @"x": @(pickerFrame.origin.x + pickerFrame.size.width / 2), @"y": @(pickerFrame.origin.y + pickerFrame.size.height / 2)},
          @{@"type": @"pointerDown"},
          @{@"type": @"pointerMove", @"duration": @500, @"origin": @"pointer", @"x": @0, @"y": @(pickerFrame.size.height / 2)},
          @{@"type": @"pointerUp"},
          ],
      },
    ];
  [self verifyPickerWheelPositionChangeWithGesture:gesture];
}

@end


