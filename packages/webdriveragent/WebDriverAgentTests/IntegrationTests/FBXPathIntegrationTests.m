/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBIntegrationTestCase.h"
#import "FBMacros.h"
#import "FBTestMacros.h"
#import "FBXPath.h"
#import "FBXCAccessibilityElement.h"
#import "FBXCodeCompatibility.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIApplication.h"
#import "XCUIElement.h"
#import "XCUIElement+FBUtilities.h"
#import "XCUIElement+FBWebDriverAttributes.h"


@interface FBXPathIntegrationTests : FBIntegrationTestCase
@property (nonatomic, strong) XCUIElement *testedView;
@end

@implementation FBXPathIntegrationTests

- (void)setUp
{
  [super setUp];
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    [self launchApplication];
  });
  self.testedView = self.testedApplication.otherElements[@"MainView"];
  XCTAssertTrue(self.testedView.exists);
  FBAssertWaitTillBecomesTrue(self.testedView.buttons.count > 0);
}

- (void)testApplicationNodeXMLRepresentation
{
  id<FBXCElementSnapshot> snapshot = [self.testedApplication fb_customSnapshot];
  snapshot.children = @[];
  FBXCElementSnapshotWrapper *wrappedSnapshot = [FBXCElementSnapshotWrapper ensureWrapped:snapshot];
  NSString *xmlStr = [FBXPath xmlStringWithRootElement:wrappedSnapshot
                                               options:nil];
  int pid = [snapshot.accessibilityElement processIdentifier];
  XCTAssertNotNil(xmlStr);
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@ type=\"%@\" name=\"%@\" label=\"%@\" enabled=\"%@\" visible=\"%@\" accessible=\"%@\" x=\"%@\" y=\"%@\" width=\"%@\" height=\"%@\" index=\"%lu\" traits=\"%@\" processId=\"%d\" bundleId=\"%@\"/>\n", wrappedSnapshot.wdType, wrappedSnapshot.wdType, wrappedSnapshot.wdName, wrappedSnapshot.wdLabel, FBBoolToString(wrappedSnapshot.wdEnabled), FBBoolToString(wrappedSnapshot.wdVisible), FBBoolToString(wrappedSnapshot.wdAccessible), [wrappedSnapshot.wdRect[@"x"] stringValue], [wrappedSnapshot.wdRect[@"y"] stringValue], [wrappedSnapshot.wdRect[@"width"] stringValue], [wrappedSnapshot.wdRect[@"height"] stringValue], wrappedSnapshot.wdIndex, wrappedSnapshot.wdTraits, pid, [self.testedApplication bundleID]];
  XCTAssertEqualObjects(xmlStr, expectedXml);
}

@end
