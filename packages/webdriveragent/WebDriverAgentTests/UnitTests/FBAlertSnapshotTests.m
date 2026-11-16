/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBAlert.h"
#import "FBXCElementSnapshot.h"
#import "XCUIElementDouble.h"

@interface FBAlert (SnapshotTests)
- (id<FBXCElementSnapshot>)alertSnapshot;
- (XCUIElement *)alertElementFromApplication:(id<FBXCElementSnapshot> *)snapshotOut;
@end

@interface FBAlertSnapshotElementDouble : XCUIElementDouble
@property (nonatomic) id<FBXCElementSnapshot> cachedSnapshot;
@property (nonatomic) id<FBXCElementSnapshot> customSnapshot;
@property (nonatomic) NSUInteger cachedSnapshotCalls;
@property (nonatomic) NSUInteger customSnapshotCalls;
@end

@implementation FBAlertSnapshotElementDouble
- (id<FBXCElementSnapshot>)fb_cachedSnapshot
{
  self.cachedSnapshotCalls++;
  return self.cachedSnapshot;
}
- (id)fb_customSnapshot
{
  self.customSnapshotCalls++;
  return self.customSnapshot;
}
@end

@interface FBAlertSnapshotDouble : FBAlert
@property (nonatomic) FBAlertSnapshotElementDouble *detectedElement;
@property (nonatomic) id<FBXCElementSnapshot> detectedSnapshot;
@property (nonatomic) NSUInteger detectionCalls;
@end

@implementation FBAlertSnapshotDouble
- (XCUIElement *)alertElementFromApplication:(id<FBXCElementSnapshot> *)snapshotOut
{
  self.detectionCalls++;
  *snapshotOut = self.detectedSnapshot;
  return (XCUIElement *)self.detectedElement;
}
@end

@interface FBAlertSnapshotTests : XCTestCase
@end

@implementation FBAlertSnapshotTests

- (void)testFirstSnapshotReadPreservesDetectionSnapshot
{
  FBAlertSnapshotDouble *alert = [FBAlertSnapshotDouble new];
  alert.detectedElement = [FBAlertSnapshotElementDouble new];
  // Safari detection returns a scroll view element and a separate dialog snapshot.
  // These opaque identities suffice: snapshot retrieval must not inspect either tree.
  alert.detectedSnapshot = (id)[NSObject new];
  alert.detectedElement.cachedSnapshot = (id)[NSObject new];

  XCTAssertEqual(alert.alertSnapshot, alert.detectedSnapshot);
  XCTAssertEqual(alert.alertSnapshot, alert.detectedSnapshot);
  XCTAssertEqual(alert.detectionCalls, 1u);
  XCTAssertEqual(alert.detectedElement.cachedSnapshotCalls, 0u);
  XCTAssertEqual(alert.detectedElement.customSnapshotCalls, 0u);
}

- (void)testUsesElementCachedSnapshotWhenDetectionDoesNotSupplyOne
{
  FBAlertSnapshotDouble *alert = [FBAlertSnapshotDouble new];
  alert.detectedElement = [FBAlertSnapshotElementDouble new];
  alert.detectedElement.cachedSnapshot = (id)[NSObject new];

  XCTAssertEqual(alert.alertSnapshot, alert.detectedElement.cachedSnapshot);
  XCTAssertEqual(alert.alertSnapshot, alert.detectedElement.cachedSnapshot);
  XCTAssertEqual(alert.detectionCalls, 1u);
  XCTAssertEqual(alert.detectedElement.cachedSnapshotCalls, 1u);
  XCTAssertEqual(alert.detectedElement.customSnapshotCalls, 0u);
}

- (void)testTakesCustomSnapshotOnlyOnceWhenNoCachedSnapshotExists
{
  FBAlertSnapshotDouble *alert = [FBAlertSnapshotDouble new];
  alert.detectedElement = [FBAlertSnapshotElementDouble new];
  alert.detectedElement.customSnapshot = (id)[NSObject new];

  XCTAssertEqual(alert.alertSnapshot, alert.detectedElement.customSnapshot);
  XCTAssertEqual(alert.alertSnapshot, alert.detectedElement.customSnapshot);
  XCTAssertEqual(alert.detectionCalls, 1u);
  XCTAssertEqual(alert.detectedElement.cachedSnapshotCalls, 1u);
  XCTAssertEqual(alert.detectedElement.customSnapshotCalls, 1u);
}

- (void)testCachesMissingAlert
{
  FBAlertSnapshotDouble *alert = [FBAlertSnapshotDouble new];

  XCTAssertNil(alert.alertSnapshot);
  XCTAssertNil(alert.alertSnapshot);
  XCTAssertFalse(alert.isPresent);
  XCTAssertEqual(alert.detectionCalls, 1u);
}

@end
