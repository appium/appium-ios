/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>
#import <objc/runtime.h>

#import "FBClassChainLegacyParser.h"
#import "FBClassChainQueryParser.h"

typedef FBClassChain *(^FBParseBlock)(NSString *query, NSError **error);

static IMP gOriginalPredicateWithFormat;
static IMP gOriginalPredicateWithFormatAndArguments;
static NSMutableArray<NSString *> *gRecordedFormats;

// Records predicate texts, which are hidden in the block predicates. The queries have no
// format specifiers, so dropping the variadic arguments is safe.
static id FBRecordingPredicateWithFormat(id self, SEL _cmd, NSString *format, ...)
{
  [gRecordedFormats addObject:format];
  return ((id (*)(id, SEL, NSString *))gOriginalPredicateWithFormat)(self, _cmd, format);
}

static id FBRecordingPredicateWithFormatAndArguments(id self, SEL _cmd, NSString *format, NSArray *arguments)
{
  [gRecordedFormats addObject:format];
  return ((id (*)(id, SEL, NSString *, NSArray *))gOriginalPredicateWithFormatAndArguments)(self, _cmd, format, arguments);
}

// Legacy parser compiles with +predicateWithFormat:, the current one with ...argumentArray:
static void FBRecordPredicateFormats(BOOL isLegacy, void (^block)(void))
{
  SEL selector = isLegacy ? @selector(predicateWithFormat:) : @selector(predicateWithFormat:argumentArray:);
  Method method = class_getClassMethod(NSPredicate.class, selector);
  IMP original = method_setImplementation(method, isLegacy ? (IMP)FBRecordingPredicateWithFormat : (IMP)FBRecordingPredicateWithFormatAndArguments);
  if (isLegacy) {
    gOriginalPredicateWithFormat = original;
  } else {
    gOriginalPredicateWithFormatAndArguments = original;
  }
  @try {
    block();
  } @finally {
    method_setImplementation(method, original);
  }
}

// Items, failure or exception, and the predicate texts in compilation order
static NSString *FBDescribeOutcome(NSString *query, BOOL isLegacy, FBParseBlock parse)
{
  gRecordedFormats = [NSMutableArray array];
  NSMutableString *result = [NSMutableString string];
  FBRecordPredicateFormats(isLegacy, ^{
    @try {
      NSError *error = nil;
      FBClassChain *chain = parse(query, &error);
      if (nil == chain) {
        [result appendString:nil == error ? @"FAILED WITHOUT ERROR" : @"FAILED"];
      } else {
        for (FBClassChainItem *item in chain.elements) {
          NSMutableArray<NSString *> *kinds = [NSMutableArray array];
          for (FBAbstractPredicateItem *predicate in item.predicates) {
            [kinds addObject:NSStringFromClass(predicate.class)];
          }
          [result appendFormat:@"(type=%ld position=%@ descendant=%d predicates=%@)",
           (long)item.type, item.position, item.isDescendant, [kinds componentsJoinedByString:@","]];
        }
      }
    } @catch (NSException *e) {
      [result appendFormat:@"EXCEPTION %@", e.name];
    }
  });
  [result appendFormat:@" formats=%@", gRecordedFormats];
  return result.copy;
}

static FBParseBlock FBNewParser(void)
{
  return ^FBClassChain *(NSString *query, NSError **error) {
    return [FBClassChainQueryParser parseQuery:query error:error];
  };
}

static FBParseBlock FBLegacyParser(void)
{
  return ^FBClassChain *(NSString *query, NSError **error) {
    return [FBLegacyClassChainQueryParser parseQuery:query error:error];
  };
}

static NSArray<NSString *> *FBCorpus(void)
{
  return @[
    // Valid
    @"XCUIElementTypeWindow",
    @"XCUIElementTypeWindow/XCUIElementTypeButton",
    @"XCUIElementTypeWindow[2]",
    @"XCUIElementTypeWindow[-2]",
    @"XCUIElementTypeWindow[12]/XCUIElementTypeAny[-1]",
    @"XCUIElementTypeWindow/*[3]",
    @"*",
    @"*/*",
    @"*/*/*[2]/*/XCUIElementTypeButton",
    @"**/*",
    @"**/XCUIElementTypeButton",
    @"**/*/*/XCUIElementTypeButton[1]",
    @"XCUIElementTypeWindow/**/XCUIElementTypeButton",
    @"XCUIElementTypeWindow/**/*",
    @"**/XCUIElementTypeCell[-1]/XCUIElementTypeButton[10]",
    @"**/XCUIElementTypeCell[1]/**/XCUIElementTypeButton",
    @"XCUIElementTypeWindow[`name == \"bla\"`]",
    @"XCUIElementTypeWindow[`name == \"bla\"`][`label == \"1\"`]",
    @"XCUIElementTypeWindow[`name == \"bla\"`][2]",
    @"XCUIElementTypeWindow[`label BEGINSWITH \"blabla\"`][-1]",
    @"XCUIElementTypeWindow[$name == 'bla'$]",
    @"XCUIElementTypeWindow[$name == 'bla'$][$label == 'bla'$]",
    @"XCUIElementTypeWindow[`visible == 1`][$type == 'XCUIElementTypeImage' AND name == 'bla'$]/XCUIElementTypeTextField",
    @"XCUIElementTypeTable/XCUIElementTypeCell[`visible == 1`][$type == 'XCUIElementTypeImage' AND name == 'bla'$]/XCUIElementTypeTextField",
    @"*[`name == \"к``ири````'лиця\"`][3]/XCUIElementTypeButton[`value == \"blabla\"`][-1]",
    @"XCUIElementTypeWindow[`name == \"a``b\"`]",
    @"XCUIElementTypeWindow[$name == \"a$$b\"$]",
    @"XCUIElementTypeWindow[`name == \"a`` ``b\"`]",
    @"XCUIElementTypeWindow[`name == \"a```` ```` b\"`]",
    @"XCUIElementTypeWindow[`value == \"[1]/**/\"`]",
    @"XCUIElementTypeWindow[`value == \"a\"\n`]",
    @"XCUIElementTypeWindow[``name == \"swallowed leading marker\"`]",
    @"XCUIElementTypeWindow[```name == \"swallowed leading markers\"`]",
    @"XCUIElementTypeWindow[$$name == \"swallowed leading marker\"$]",
    @"**/XCUIElementTypeWindow[`name == \"a\"`]/**/XCUIElementTypeButton[`name == \"b\"`][2]",
    // Invalid syntax
    @"/XCUIElementTypeWindow",
    @"XCUIElementTypeWindow/",
    @"XCUIElementTypeWindow//*",
    @"XCUIElementTypeWindow*/*",
    @"**",
    @"***",
    @"****/*",
    @"**/",
    @"**//*",
    @"**/*/**",
    @"/**",
    @"/**/*",
    @"XCUIElementTypeWindow/**",
    @"XCUIElementTypeWindow/**/",
    @"XCUIElementTypeWindow/***/*",
    @"**[1]/XCUIElementTypeWindow",
    @"**[`name == '1'`]/XCUIElementTypeWindow",
    @"**/[1]",
    @"**/[`name == '1'`]",
    @"XCUIElementTypeWindow[0]",
    @"XCUIElementTypeWindow[-0]",
    @"XCUIElementTypeWindow[1][1]",
    @"XCUIElementTypeWindow[1][2]",
    @"XCUIElementTypeWindow[-]",
    @"XCUIElementTypeWindow[--1]",
    @"XCUIElementTypeWindow[1-]",
    @"XCUIElementTypeWindow[1-1]",
    @"XCUIElementTypeWindow[4294967296]",
    @"XCUIElementTypeWindow[99999999999999999999]",
    @"XCUIElementTypeWindow[٣]",
    @"blabla",
    @"XCUIElementTypeWindow/blabla",
    @"XCUIElementTypeWindow1",
    @"XCUIElementType_Window",
    @" XCUIElementTypeWindow",
    @"XCUIElementTypeWindow ",
    @"XCUIElementTypeWindow/ XCUIElementTypeButton",
    @"XCUIElementTypeWindow[ 2 ]",
    @"XCUIElementTypeWindow[]",
    @"XCUIElementTypeWindow[",
    @"XCUIElementTypeWindow[1",
    @"XCUIElementTypeWindow[[2]",
    @"XCUIElementTypeWindow[2]]",
    @"XCUIElementType[Window[2]]",
    @"XCUIElementTypeWindow[visible = 1]",
    @"XCUIElementTypeWindow[1][`visible = 1`]",
    @"XCUIElementTypeWindow[1] [`visible = 1`]",
    @"XCUIElementTypeWindow[ `visible = 1`]",
    @"XCUIElementTypeWindow[`visible = 1`] [1]",
    @"XCUIElementTypeWindow[`visible = 1][`name = \"bla\"`]",
    @"XCUIElementTypeWindow[`visible = 1]",
    @"XCUIElementTypeWindow[`visible = 1",
    @"XCUIElementTypeWindow[`visible = 1`",
    @"XCUIElementTypeWindow[$visible = 1]",
    @"XCUIElementTypeWindow[``]",
    @"XCUIElementTypeWindow[$$]",
    @"XCUIElementTypeWindow[```]",
    @"XCUIElementTypeWindow[``]x`]",
    @"XCUIElementTypeWindow[`name = \"bla```bla\"`]",
    @"XCUIElementTypeWindow[$name = \"bla$$$bla\"$]",
    @"XCUIElementTypeWindow[`name = \"bla\"`]x",
    @"XCUIElementTypeWindow[`name = \"bla\"`]*",
    @"XCUIElementTypeWindow[1]*",
    @"XCUIElementTypeWindow[1]x",
    @"*[1]*",
    @"*x",
    @"**/**/XCUIElementTypeWindow",
    @"XCUIElementTypeWindow/**/**/XCUIElementTypeButton",
    @"XCUIElementTypeWindow/**/**/**/XCUIElementTypeButton",
    @"**/**/**/*",
    @"****XCUIElementTypeButton",
    @"***/XCUIElementTypeButton",
    @"**[1]XCUIElementTypeButton",
    @"**XCUIElementTypeWindow/**",
    @"**1",
    @"***1",
    // Order of the failures: the first problem in the query wins
    @"XCUIElementTypeWindow[`name == \"a\"`]/blabla",
    @"blabla/XCUIElementTypeWindow[`name == \"a\"`]",
    @"XCUIElementTypeWindow[`name ==`]/blabla",
    @"XCUIElementTypeWindow[`name ==`]/XCUIElementTypeButton[0]",
    @"XCUIElementTypeWindow[`name ==`]/**/**/XCUIElementTypeButton",
    @"XCUIElementTypeWindow[`name == \"a\"`]/**/**/XCUIElementTypeButton[`name ==`]",
    @"XCUIElementTypeWindow[`name == \"a\"`][1][`name ==`]",
    @"XCUIElementTypeWindow[`name ==`][1][`name ==`]",
    @"XCUIElementTypeWindow[1][`name ==`]/XCUIElementTypeButton[`name ==`]",
    @"XCUIElementTypeWindow[`name ==`]/XCUIElementTypeButton[`name == \"a\"`]x",
    @"XCUIElementTypeWindow[`nosuchattribute == 1`]",
    @"XCUIElementTypeWindow[$nosuchattribute == 1$]",
    @"XCUIElementTypeWindow[`nosuchattribute == 1`]/blabla",
    @"XCUIElementTypeWindow[`name == `]",
    @"XCUIElementTypeWindow[`FUNCTION(name, 'x') == 1`]",
  ];
}

@interface FBClassChainCompatibilityTests : XCTestCase
@end

@implementation FBClassChainCompatibilityTests

// Accidental legacy behaviors dropped on purpose (see the tests below): stars before a class name,
// swallowed leading predicate markers, non-ASCII digits, positions of 10+ digits
- (BOOL)isKnownDeviationFromLegacyParser:(NSString *)query
{
  static NSArray<NSRegularExpression *> *regexes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSMutableArray *result = [NSMutableArray array];
    for (NSString *pattern in @[@"\\*\\*\\*?\\p{L}", @"\\[(``|\\$\\$)", @"[\\p{Nd}-[0-9]]", @"[0-9]{10}"]) {
      [result addObject:[NSRegularExpression regularExpressionWithPattern:pattern options:0 error:nil]];
    }
    regexes = result.copy;
  });
  for (NSRegularExpression *regex in regexes) {
    if ([regex numberOfMatchesInString:query options:0 range:NSMakeRange(0, query.length)] > 0) {
      return YES;
    }
  }
  return NO;
}

- (void)assertSameOutcomeForQuery:(NSString *)query
{
  if ([self isKnownDeviationFromLegacyParser:query]) {
    return;
  }
  NSString *expected = FBDescribeOutcome(query, YES, FBLegacyParser());
  NSString *actual = FBDescribeOutcome(query, NO, FBNewParser());
  XCTAssertEqualObjects(actual, expected, @"Query: %@", query);
}

- (void)testCorpusMatchesLegacyParser
{
  NSArray<NSString *> *corpus = FBCorpus();
  XCTAssertGreaterThan(corpus.count, 100);
  for (NSString *query in corpus) {
    [self assertSameOutcomeForQuery:query];
  }
}

- (void)testMutatedCorpusMatchesLegacyParser
{
  NSArray<NSString *> *corpus = FBCorpus();
  NSString *alphabet = @"*[]/-0123456789 `$.=\"'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz\n";
  NSArray<NSString *> *fragments = @[@"**/", @"/**/", @"[`", @"`]", @"[$", @"$]", @"``", @"$$", @"XCUIElementType", @"Window", @"Button", @"[1]", @"[-1]", @"[0]"];
  __block uint64_t state = 0x9E3779B97F4A7C15ULL;
  uint64_t (^next)(void) = ^uint64_t {
    state = state * 6364136223846793005ULL + 1442695040888963407ULL;
    return state >> 33;
  };
  NSUInteger iterations = 12000;
  for (NSUInteger i = 0; i < iterations; ++i) {
    NSMutableString *query = [corpus[next() % corpus.count] mutableCopy];
    NSUInteger mutations = 1 + next() % 3;
    for (NSUInteger m = 0; m < mutations; ++m) {
      NSUInteger position = query.length > 0 ? next() % (query.length + 1) : 0;
      switch (next() % 5) {
        case 0:
          [query insertString:[alphabet substringWithRange:NSMakeRange(next() % alphabet.length, 1)] atIndex:position];
          break;
        case 1:
          if (position < query.length) {
            [query deleteCharactersInRange:NSMakeRange(position, 1)];
          }
          break;
        case 2:
          if (position < query.length) {
            [query replaceCharactersInRange:NSMakeRange(position, 1)
                                 withString:[alphabet substringWithRange:NSMakeRange(next() % alphabet.length, 1)]];
          }
          break;
        case 3:
          [query insertString:fragments[next() % fragments.count] atIndex:position];
          break;
        default:
          if (position < query.length) {
            NSUInteger length = MIN(query.length - position, 1 + next() % 6);
            [query insertString:[query substringWithRange:NSMakeRange(position, length)] atIndex:position];
          }
          break;
      }
    }
    if (0 == query.length) {
      continue;
    }
    [self assertSameOutcomeForQuery:query.copy];
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

- (void)testLeadingMarkersAreNotSwallowed
{
  gRecordedFormats = [NSMutableArray array];
  FBRecordPredicateFormats(NO, ^{
    NSError *error = nil;
    // The opening marker is followed by a doubled one, which is an escaped marker.
    // The resulting text is not a valid predicate, which is not the point here.
    XCTAssertThrows([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[```name == 'a'`]" error:&error]);
  });
  XCTAssertEqualObjects(gRecordedFormats, @[@"`name == 'a'"]);
  // The predicate is closed right after it is opened
  NSError *error = nil;
  XCTAssertNil([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[``name == 'a'`]" error:&error]);
  XCTAssertNotNil(error);
}

- (void)testEmptyPredicateIsRejected
{
  for (NSString *query in @[@"XCUIElementTypeWindow[``]", @"XCUIElementTypeWindow[$$]"]) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
}

- (void)testPositionIsAnAsciiInteger
{
  NSArray<NSString *> *invalid = @[@"[٣]", @"[0]", @"[-0]", @"[-]", @"[1-1]", @"[--1]", @"[1-]", @"[99999999999999999999]", @"[-99999999999999999999]", @"[2147483648]", @"[-2147483648]"];
  for (NSString *position in invalid) {
    NSString *query = [@"XCUIElementTypeWindow" stringByAppendingString:position];
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    XCTAssertNotNil(error, @"%@", query);
  }
  NSError *error = nil;
  FBClassChain *chain = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[2147483647]/XCUIElementTypeButton[-2147483647]" error:&error];
  XCTAssertNotNil(chain);
  XCTAssertEqual(chain.elements.firstObject.position.longLongValue, 2147483647LL);
  XCTAssertEqual(chain.elements.lastObject.position.longLongValue, -2147483647LL);
}

- (void)testPredicateTextIsNotAFormatString
{
  NSError *error = nil;
  FBClassChain *chain = [FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name LIKE '50%'`]" error:&error];
  XCTAssertNotNil(chain);
  XCTAssertEqual(chain.elements.firstObject.predicates.count, 1);
  XCTAssertThrows([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name == %@`]" error:&error]);
  XCTAssertThrows([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow[`name == %d AND label == %@`]" error:&error]);
}

- (void)testEmptyQueryIsReportedAsError
{
  NSError *error = nil;
  XCTAssertNil([FBClassChainQueryParser parseQuery:@"" error:&error]);
  XCTAssertNotNil(error);
  XCTAssertTrue([error.localizedDescription hasPrefix:@"Cannot parse class chain query ''."]);
}

- (void)testErrorsKeepTheCommonPrefix
{
  NSArray<NSString *> *queries = @[
    @"XCUIElementTypeWindow/",
    @"blabla",
    @"XCUIElementTypeWindow[0]",
    @"XCUIElementTypeWindow[1][1]",
    @"XCUIElementTypeWindow[1][`name == 'a'`]",
    @"**/**/XCUIElementTypeWindow",
  ];
  for (NSString *query in queries) {
    NSError *error = nil;
    XCTAssertNil([FBClassChainQueryParser parseQuery:query error:&error], @"%@", query);
    NSString *prefix = [NSString stringWithFormat:@"Cannot parse class chain query '%@'. ", query];
    XCTAssertTrue([error.localizedDescription hasPrefix:prefix], @"%@: %@", query, error.localizedDescription);
  }
}

- (void)testTokenizationErrorPointsAtTheOffendingCharacter
{
  NSError *error = nil;
  XCTAssertNil([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow//*" error:&error]);
  XCTAssertTrue([error.localizedDescription containsString:@"Unexpected character detected at position 23"], @"%@", error.localizedDescription);
  error = nil;
  XCTAssertNil([FBClassChainQueryParser parseQuery:@"XCUIElementTypeWindow/" error:&error]);
  XCTAssertTrue([error.localizedDescription containsString:@"Unexpected character detected at position 22"], @"%@", error.localizedDescription);
}

- (void)testPerformanceOfNewParser
{
  NSArray<NSString *> *queries = @[
    @"**/XCUIElementTypeCell[`label BEGINSWITH \"A\"`][-1]/XCUIElementTypeButton[10]",
    @"XCUIElementTypeWindow/XCUIElementTypeTable/XCUIElementTypeCell[`visible == 1`][$type == 'XCUIElementTypeImage' AND name == 'bla'$]/XCUIElementTypeTextField",
    @"**/XCUIElementTypeOther[`label == \"View 5\"`][1]/**/XCUIElementTypeOther[`label == \"View 15\"`][1]/**/XCUIElementTypeOther[`label BEGINSWITH \"View 30\"`]",
  ];
  [self measureBlock:^{
    for (NSUInteger i = 0; i < 300; ++i) {
      for (NSString *query in queries) {
        NSError *error = nil;
        XCTAssertNotNil([FBClassChainQueryParser parseQuery:query error:&error]);
      }
    }
  }];
}

@end
