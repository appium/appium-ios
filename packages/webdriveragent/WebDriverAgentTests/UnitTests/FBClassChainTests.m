/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "XCUIElementDouble.h"
#import "FBClassChainQueryParser.h"
#import "FBElementTypeTransformer.h"

@interface FBClassChainTests : XCTestCase
@end

@implementation FBClassChainTests

- (void)testValidChain
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow/XCUIElementTypeButton" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeWindow);
  XCTAssertNil(firstElement.position);
  XCTAssertFalse(firstElement.isDescendant);

  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertNil(secondElement.position);
  XCTAssertFalse(secondElement.isDescendant);
}

- (void)testValidChainWithStar
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow/XCUIElementTypeButton[3]/*[4]/*[5]/XCUIElementTypeAlert" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 5);
  
    FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeWindow);
  XCTAssertNil(firstElement.position);
  XCTAssertFalse(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertEqual(secondElement.position.integerValue, 3);
  XCTAssertFalse(secondElement.isDescendant);
  
  FBClassChainItem *thirdElement = [result.elements objectAtIndex:2];
  XCTAssertEqual(thirdElement.type, XCUIElementTypeAny);
  XCTAssertEqual(thirdElement.position.integerValue, 4);
  XCTAssertFalse(thirdElement.isDescendant);
  
  FBClassChainItem *fourthElement = [result.elements objectAtIndex:3];
  XCTAssertEqual(fourthElement.type, XCUIElementTypeAny);
  XCTAssertEqual(fourthElement.position.integerValue, 5);
  XCTAssertFalse(fourthElement.isDescendant);
  
  FBClassChainItem *fifthsElement = [result.elements objectAtIndex:4];
  XCTAssertEqual(fifthsElement.type, XCUIElementTypeAlert);
  XCTAssertNil(fifthsElement.position);
  XCTAssertFalse(fifthsElement.isDescendant);
}

- (void)testValidSingleStarChain
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"*" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 1);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeAny);
  XCTAssertNil(firstElement.position);
  XCTAssertFalse(firstElement.isDescendant);
}

- (void)testValidSingleStarIndirectChain
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"**/*/*/XCUIElementTypeButton" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 3);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeAny);
  XCTAssertNil(firstElement.position);
  XCTAssertTrue(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeAny);
  XCTAssertNil(secondElement.position);
  XCTAssertFalse(secondElement.isDescendant);
  
  FBClassChainItem *thirdElement = [result.elements objectAtIndex:2];
  XCTAssertEqual(thirdElement.type, XCUIElementTypeButton);
  XCTAssertNil(thirdElement.position);
  XCTAssertFalse(thirdElement.isDescendant);
}

- (void)testValidDoubleIndirectChainAndStar
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"**/XCUIElementTypeButton/**/*" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeButton);
  XCTAssertNil(firstElement.position);
  XCTAssertTrue(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeAny);
  XCTAssertNil(secondElement.position);
  XCTAssertTrue(secondElement.isDescendant);
}

- (void)testValidDoubleIndirectChainAndClassName
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"**/XCUIElementTypeButton/**/XCUIElementTypeImage" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeButton);
  XCTAssertNil(firstElement.position);
  XCTAssertTrue(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeImage);
  XCTAssertNil(secondElement.position);
  XCTAssertTrue(secondElement.isDescendant);
}

- (void)testValidChainWithNegativeIndex
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow/XCUIElementTypeButton[-1]" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeWindow);
  XCTAssertNil(firstElement.position);
  XCTAssertEqual(firstElement.predicates.count, 0);
  XCTAssertFalse(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertEqual(secondElement.position.integerValue, -1);
  XCTAssertEqual(secondElement.predicates.count, 0);
  XCTAssertFalse(secondElement.isDescendant);
}

- (void)testValidChainWithSinglePredicate
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name == 'blabla'`]/XCUIElementTypeButton" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeWindow);
  XCTAssertNil(firstElement.position);
  XCTAssertEqual(firstElement.predicates.count, 1);
  XCTAssertFalse(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertNil(secondElement.position);
  XCTAssertEqual(secondElement.predicates.count, 0);
  XCTAssertFalse(secondElement.isDescendant);
}

- (void)testValidChainWithMultiplePredicates
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name == 'blabla'`]/XCUIElementTypeButton[`value == 'blabla'`]" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeWindow);
  XCTAssertNil(firstElement.position);
  XCTAssertEqual(firstElement.predicates.count, 1);
  XCTAssertFalse(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertNil(secondElement.position);
  XCTAssertEqual(secondElement.predicates.count, 1);
  XCTAssertFalse(secondElement.isDescendant);
}

- (void)testValidChainWithIndirectSearchAndPredicates
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"**/XCUIElementTypeTable[`name == 'blabla'`][10]/**/XCUIElementTypeButton[`value == 'blabla'`]" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeTable);
  XCTAssertEqual(firstElement.position.integerValue, 10);
  XCTAssertEqual(firstElement.predicates.count, 1);
  XCTAssertTrue(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertNil(secondElement.position);
  XCTAssertEqual(secondElement.predicates.count, 1);
  XCTAssertTrue(secondElement.isDescendant);
}

- (void)testValidChainWithMultiplePredicatesAndPositions
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"*[`name == \"к``ири````'лиця\"`][3]/XCUIElementTypeButton[`value == \"blabla\"`][-1]" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 2);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeAny);
  XCTAssertEqual(firstElement.position.integerValue, 3);
  XCTAssertEqual(firstElement.predicates.count, 1);
  XCTAssertFalse(firstElement.isDescendant);
  
  FBClassChainItem *secondElement = [result.elements objectAtIndex:1];
  XCTAssertEqual(secondElement.type, XCUIElementTypeButton);
  XCTAssertEqual(secondElement.position.integerValue, -1);
  XCTAssertEqual(secondElement.predicates.count, 1);
  XCTAssertFalse(secondElement.isDescendant);
}

- (void)testValidChainWithDescendantPredicate
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"**/XCUIElementTypeTable[$type == 'XCUIElementTypeImage' AND name == 'olala'$][`name == 'blabla'`][10]" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 1);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeTable);
  XCTAssertEqual(firstElement.position.integerValue, 10);
  XCTAssertEqual(firstElement.predicates.count, 2);
  XCTAssertTrue(firstElement.isDescendant);
}

- (void)testValidChainWithMultipleDescendantPredicates
{
  NSError *error;
  FBClassChain *result = [FBClassChainQueryParser parseQuery:@"**/XCUIElementTypeTable[$type == 'XCUIElementTypeImage' AND name == 'olala'$][`value == 'peace'`][$value == 'yolo'$][`name == 'blabla'`][10]" error:&error];
  XCTAssertNotNil(result);
  XCTAssertEqual(result.elements.count, 1);
  
  FBClassChainItem *firstElement = [result.elements firstObject];
  XCTAssertEqual(firstElement.type, XCUIElementTypeTable);
  XCTAssertEqual(firstElement.position.integerValue, 10);
  XCTAssertEqual(firstElement.predicates.count, 4);
  XCTAssertTrue(firstElement.isDescendant);
}

- (void)testInvalidChains
{
  NSArray *invalidQueries = @[
    @"/XCUIElementTypeWindow"
    ,@"XCUIElementTypeWindow/"
    ,@"XCUIElementTypeWindow//*"
    ,@"XCUIElementTypeWindow*/*"
    ,@"**"
    ,@"***"
    ,@"**/*/**"
    ,@"/**"
    ,@"XCUIElementTypeWindow/**"
    ,@"**[1]/XCUIElementTypeWindow"
    ,@"**[`name == '1'`]/XCUIElementTypeWindow"
    ,@"XCUIElementTypeWindow[0]"
    ,@"XCUIElementTypeWindow[1][1]"
    ,@"blabla"
    ,@"XCUIElementTypeWindow/blabla"
    ,@" XCUIElementTypeWindow"
    ,@"XCUIElementTypeWindow[ 2 ]"
    ,@"XCUIElementTypeWindow[[2]"
    ,@"XCUIElementTypeWindow[2]]"
    ,@"XCUIElementType[Window[2]]"
    ,@"XCUIElementTypeWindow[visible = 1]"
    ,@"XCUIElementTypeWindow[1][`visible = 1`]"
    ,@"XCUIElementTypeWindow[1] [`visible = 1`]"
    ,@"XCUIElementTypeWindow[ `visible = 1`]"
    ,@"XCUIElementTypeWindow[`visible = 1][`name = \"bla\"`]"
    ,@"XCUIElementTypeWindow[`visible = 1]"
    ,@"XCUIElementTypeWindow[$visible = 1]"
    ,@"XCUIElementTypeWindow[``]"
    ,@"XCUIElementTypeWindow[$$]"
    ,@"XCUIElementTypeWindow[`name = \"bla```bla\"`]"
    ,@"XCUIElementTypeWindow[$name = \"bla$$$bla\"$]"
  ];
  for (NSString *invalidQuery in invalidQueries) {
    NSError *error;
    FBClassChain *result = [FBClassChainQueryParser parseQuery:invalidQuery error:&error];
    XCTAssertNil(result);
    XCTAssertNotNil(error);
  }
}

// Type, optional position and the number of self/descendant predicates of every item, e.g. "**/Window[2]{1,0}"
static NSString *FBDescribeChain(FBClassChain *chain)
{
  NSMutableArray<NSString *> *items = [NSMutableArray array];
  for (FBClassChainItem *item in chain.elements) {
    NSUInteger selfPredicates = 0;
    NSUInteger descendantPredicates = 0;
    for (FBAbstractPredicateItem *predicate in item.predicates) {
      if ([predicate isKindOfClass:FBSelfPredicateItem.class]) {
        ++selfPredicates;
      } else {
        ++descendantPredicates;
      }
    }
    NSString *type = [[FBElementTypeTransformer stringWithElementType:item.type] stringByReplacingOccurrencesOfString:@"XCUIElementType" withString:@""];
    [items addObject:[NSString stringWithFormat:@"%@%@%@{%lu,%lu}", item.isDescendant ? @"**/" : @"", type,
                      nil == item.position ? @"" : [NSString stringWithFormat:@"[%@]", item.position],
                      (unsigned long)selfPredicates, (unsigned long)descendantPredicates]];
  }
  return [items componentsJoinedByString:@" "];
}

- (void)testParsedItems
{
  NSDictionary<NSString *, NSString *> *expectations = @{
    @"XCUIElementTypeWindow[12]/XCUIElementTypeAny[-1]": @"Window[12]{0,0} Any[-1]{0,0}",
    @"*/*/*[2]/*/XCUIElementTypeButton": @"Any{0,0} Any{0,0} Any[2]{0,0} Any{0,0} Button{0,0}",
    @"**/*/*/XCUIElementTypeButton[1]": @"**/Any{0,0} Any{0,0} Button[1]{0,0}",
    @"XCUIElementTypeWindow/**/*": @"Window{0,0} **/Any{0,0}",
    @"**/XCUIElementTypeCell[1]/**/XCUIElementTypeButton": @"**/Cell[1]{0,0} **/Button{0,0}",
    @"XCUIElementTypeWindow[`name == \"a\"`][`label == \"1\"`][2]": @"Window[2]{2,0}",
    @"XCUIElementTypeWindow[$name == 'a'$][$label == 'b'$]": @"Window{0,2}",
    @"XCUIElementTypeWindow[`name == 'a'`][$label == 'b'$][`value == 'c'`]": @"Window{2,1}",
    @"XCUIElementTypeWindow[`name == \"a``b\"`]": @"Window{1,0}",
    @"XCUIElementTypeWindow[$name == \"a$$b\"$]": @"Window{0,1}",
    @"XCUIElementTypeWindow[`value == \"[1]/**/\"`]": @"Window{1,0}",
    @"XCUIElementTypeWindow[`value == \"a\"\n`]": @"Window{1,0}",
    @"**/XCUIElementTypeWindow[`name == \"a\"`]/**/XCUIElementTypeButton[`name == \"b\"`][2]": @"**/Window{1,0} **/Button[2]{1,0}",
    @"XCUIElementTypeWindow[2147483647]/XCUIElementTypeButton[-2147483647]": @"Window[2147483647]{0,0} Button[-2147483647]{0,0}",
  };
  for (NSString *query in expectations) {
    NSError *error = nil;
    FBClassChain *chain = [FBClassChainQueryParser parseQuery:query error:&error];
    XCTAssertNotNil(chain, @"%@", query);
    XCTAssertEqualObjects(FBDescribeChain(chain), expectations[query], @"%@", query);
  }
}

- (void)testMoreInvalidChains
{
  NSArray<NSString *> *invalidQueries = @[
    @"", @"**/", @"**//*", @"****/*", @"/**/*", @"XCUIElementTypeWindow/**/",
    @"XCUIElementTypeWindow/***/*", @"**/[1]", @"**/[`name == '1'`]",
    @"XCUIElementTypeWindow[1][2]", @"XCUIElementTypeWindow[-0]", @"XCUIElementTypeWindow[-]",
    @"XCUIElementTypeWindow[--1]", @"XCUIElementTypeWindow[1-]", @"XCUIElementTypeWindow[1-1]",
    @"XCUIElementTypeWindow1", @"XCUIElementType_Window", @"XCUIElementTypeWindow ",
    @"XCUIElementTypeWindow/ XCUIElementTypeButton", @"XCUIElementTypeWindow[]", @"XCUIElementTypeWindow[",
    @"XCUIElementTypeWindow[1", @"XCUIElementTypeWindow[`visible = 1`] [1]", @"XCUIElementTypeWindow[`visible = 1",
    @"XCUIElementTypeWindow[`visible = 1`", @"XCUIElementTypeWindow[```]", @"XCUIElementTypeWindow[``]x`]",
    @"XCUIElementTypeWindow[`name = \"bla\"`]x", @"XCUIElementTypeWindow[`name = \"bla\"`]*",
    @"XCUIElementTypeWindow[1]*", @"XCUIElementTypeWindow[1]x", @"*[1]*", @"*x",
    @"**/**/XCUIElementTypeWindow", @"XCUIElementTypeWindow/**/**/XCUIElementTypeButton",
    @"XCUIElementTypeWindow/**/**/**/XCUIElementTypeButton", @"**/**/**/*",
  ];
  for (NSString *query in invalidQueries) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
}

// An invalid predicate raises, but only if nothing before it in the query is an error
- (void)testFirstProblemWins
{
  NSArray<NSString *> *errors = @[
    @"XCUIElementTypeWindow[`name == \"a\"`]/blabla",
    @"blabla/XCUIElementTypeWindow[`name ==`]",
    @"XCUIElementTypeWindow[`name == \"a\"`]/**/**/XCUIElementTypeButton[`name ==`]",
    @"XCUIElementTypeWindow[`name == \"a\"`][1][`name ==`]",
    @"XCUIElementTypeWindow[1][`name ==`]/XCUIElementTypeButton[`name ==`]",
    // syntax is checked before any predicate is compiled
    @"XCUIElementTypeWindow[`name ==`]/XCUIElementTypeButton[`name == \"a\"`]x",
  ];
  for (NSString *query in errors) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
  NSArray<NSString *> *invalidPredicates = @[
    @"XCUIElementTypeWindow[`name ==`]/blabla",
    @"XCUIElementTypeWindow[`name ==`]/XCUIElementTypeButton[0]",
    @"XCUIElementTypeWindow[`name ==`]/**/**/XCUIElementTypeButton",
    @"XCUIElementTypeWindow[`name ==`][1][`name ==`]",
    @"XCUIElementTypeWindow[`name == `]",
  ];
  for (NSString *query in invalidPredicates) {
    NSError *error = nil;
    XCTAssertThrowsSpecificNamed([FBClassChainQueryParser parseQuery:query error:&error], NSException, NSInvalidArgumentException, @"%@", query);
  }
  NSArray<NSString *> *unknownAttributes = @[
    @"XCUIElementTypeWindow[`nosuchattribute == 1`]",
    @"XCUIElementTypeWindow[$nosuchattribute == 1$]",
    @"XCUIElementTypeWindow[`nosuchattribute == 1`]/blabla",
  ];
  for (NSString *query in unknownAttributes) {
    NSError *error = nil;
    XCTAssertThrowsSpecificNamed([FBClassChainQueryParser parseQuery:query error:&error], NSException, @"FBUnknownAttributeException", @"%@", query);
  }
}

- (void)testStarsDirectlyBeforeClassNameAreRejected
{
  for (NSString *query in @[@"**XCUIElementTypeButton", @"***XCUIElementTypeButton", @"XCUIElementTypeWindow/**XCUIElementTypeButton", @"**/**XCUIElementTypeButton"]) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
}

- (void)testEmptyPredicateIsRejected
{
  for (NSString *query in @[@"XCUIElementTypeWindow[``]", @"XCUIElementTypeWindow[$$]"]) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
}

- (void)testLeadingPredicateMarkersAreNotSwallowed
{
  NSError *error = nil;
  // The first marker opens the predicate and the second one closes it, so nothing valid follows
  XCTAssertNil([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[``name == 'a'`]" error:&error]);
  XCTAssertNotNil(error);
  // The predicate text is "`name == 'a'", where the doubled marker is an escaped one
  XCTAssertThrowsSpecificNamed([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[```name == 'a'`]" error:&error], NSException, NSInvalidArgumentException);
}

- (void)testPositionIsAnAsciiInt
{
  NSArray<NSString *> *invalid = @[@"[٣]", @"[0]", @"[4294967296]", @"[99999999999999999999]", @"[-99999999999999999999]", @"[2147483648]", @"[-2147483648]", @"[-9223372036854775808]"];
  for (NSString *position in invalid) {
    NSString *query = [@"XCUIElementTypeWindow" stringByAppendingString:position];
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
}

- (void)testPredicateTextIsNotAFormatString
{
  NSError *error = nil;
  FBClassChain *chain = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name LIKE '50%'`]" error:&error];
  XCTAssertNotNil(chain);
  XCTAssertEqual(chain.elements.firstObject.predicates.count, 1);
  XCTAssertThrowsSpecificNamed([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name == %@`]" error:&error], NSException, NSInvalidArgumentException);
  XCTAssertThrowsSpecificNamed([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name == %d AND label == %@`]" error:&error], NSException, NSInvalidArgumentException);
}

- (void)testErrorMessages
{
  NSDictionary<NSString *, NSString *> *expectations = @{
    @"": @"Cannot parse class chain query ''. The query must not be empty.",
    @"XCUIElementTypeWindow//*": @"Cannot parse class chain query 'XCUIElementTypeWindow//*'. Unexpected character detected at position 23:\nXCUIElementTypeWindow// <----",
    @"XCUIElementTypeWindow/": @"Cannot parse class chain query 'XCUIElementTypeWindow/'. Unexpected character detected at position 22:\nXCUIElementTypeWindow/ <----",
    @"blabla": @"Cannot parse class chain query 'blabla'. 'blabla' class name is unknown to WDA",
    @"XCUIElementTypeWindow[0]": @"Cannot parse class chain query 'XCUIElementTypeWindow[0]'. Position value '0' is expected to be a valid integer number not equal to zero.",
    @"XCUIElementTypeWindow[1][2]": @"Cannot parse class chain query 'XCUIElementTypeWindow[1][2]'. Position value '2' is expected to be set only once.",
    @"XCUIElementTypeWindow[1][`name == 'a'`]": @"Cannot parse class chain query 'XCUIElementTypeWindow[1][`name == 'a'`]'. Predicate value 'name == 'a'' must be set before position value.",
    @"**/**/XCUIElementTypeWindow": @"Cannot parse class chain query '**/**/XCUIElementTypeWindow'. Unexpected token '**/'. Descendant markers cannot be duplicated.",
  };
  for (NSString *query in expectations) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertEqualObjects(error.localizedDescription, expectations[query], @"%@", query);
  }
}

@end
