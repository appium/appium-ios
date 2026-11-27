/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBFailureProofTestCase.h"

@interface FBFailureProofTestCase (FBUnitTesting)
- (void)_enqueueFailureWithDescription:(NSString *)description
                                inFile:(NSString *)filePath
                                atLine:(NSUInteger)lineNumber
                              expected:(BOOL)expected;
@end

// Runs as a regular test: it only passes if the failing assertion is swallowed.
// The "Enqueue Failure" log line it produces is expected (nested test runs crash XCTest).
@interface FBFailureProofAssertionProbe : FBFailureProofTestCase
@end

@implementation FBFailureProofAssertionProbe

- (void)testPreventAssertFailure
{
  XCTAssertNotNil(nil);
}

@end

@interface FBFailureProofProbe : FBFailureProofTestCase
@property (nonatomic, strong) NSMutableArray<NSString *> *swallowed;
- (void)noop;
@end

@implementation FBFailureProofProbe

- (void)noop {}

- (void)_enqueueFailureWithDescription:(NSString *)description
                                inFile:(NSString *)filePath
                                atLine:(NSUInteger)lineNumber
                              expected:(BOOL)expected
{
  self.swallowed = [(self.swallowed ?: @[]) arrayByAddingObject:description].mutableCopy;
  [super _enqueueFailureWithDescription:description inFile:filePath atLine:lineNumber expected:expected];
}

@end

@interface FBFailureProofUnitTests : XCTestCase
@end

@implementation FBFailureProofUnitTests

- (void)testSetUpKeepsRunningAfterFailures
{
  FBFailureProofProbe *probe = [FBFailureProofProbe testCaseWithSelector:@selector(noop)];
  [probe setUp];
  XCTAssertTrue(probe.continueAfterFailure);
  XCTAssertFalse(probe.shouldHaltWhenReceivesControl);
}

- (void)testRecordIssueIsSwallowed
{
  FBFailureProofProbe *probe = [FBFailureProofProbe testCaseWithSelector:@selector(noop)];
  XCTIssue *issue = [[XCTIssue alloc] initWithType:XCTIssueTypeAssertionFailure
                                compactDescription:@"synthetic failure"];
  [probe recordIssue:issue];
  XCTAssertEqual(probe.swallowed.count, 1u);
  XCTAssertTrue([probe.swallowed.firstObject containsString:@"synthetic failure"]);
}

@end
