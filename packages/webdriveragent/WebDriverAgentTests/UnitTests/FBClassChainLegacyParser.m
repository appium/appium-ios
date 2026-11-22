/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Frozen copy of the token based class chain parser that preceded the recursive descent one.
// It only serves as the reference in FBClassChainCompatibilityTests. Do not change its behavior.

#import "FBClassChainLegacyParser.h"
#import "FBClassChainQueryParser.h"
#import "FBErrorBuilder.h"
#import "FBElementTypeTransformer.h"
#import "FBExceptions.h"
#import "NSPredicate+FBFormat.h"


NS_ASSUME_NONNULL_BEGIN

@interface FBLegacyBaseClassChainToken : NSObject

@property (nonatomic) NSString *asString;
@property (nonatomic) NSUInteger previousItemsCountToOverride;

@end


@interface FBLegacyClassNameToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacyStarToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacyDescendantMarkerToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacySplitterToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacyOpeningBracketToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacyClosingBracketToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacyNumberToken : FBLegacyBaseClassChainToken

@end

@interface FBLegacyAbstractPredicateToken : FBLegacyBaseClassChainToken

@property (nonatomic) BOOL isParsingCompleted;

+ (NSString *)enclosingMarker;

@end

@interface FBLegacySelfPredicateToken : FBLegacyAbstractPredicateToken

@end

@interface FBLegacyDescendantPredicateToken : FBLegacyAbstractPredicateToken

@end

NS_ASSUME_NONNULL_END


@implementation FBLegacyBaseClassChainToken

- (id)init
{
  self = [super init];
  if (self) {
    _asString = @"";
    _previousItemsCountToOverride = 0;
  }
  return self;
}

- (instancetype)initWithStringValue:(NSString *)stringValue
{
  self = [super init];
  if (self) {
    _asString = stringValue;
  }
  return self;
}

+ (NSCharacterSet *)allowedCharacters
{
  // This method is expected to be overriden by subclasses
  return [NSCharacterSet characterSetWithCharactersInString:@""];
}

+ (NSUInteger)maxLength
{
  // This method is expected to be overriden by subclasses
  return ULONG_MAX;
}

- (NSArray<Class> *)followingTokens
{
  // This method is expected to be overriden by subclasses
  return @[];
}

+ (BOOL)canConsumeCharacter:(unichar)character
{
  return [self.allowedCharacters characterIsMember:character];
}

- (void)appendChar:(unichar)character
{
  NSMutableString *value = [NSMutableString stringWithString:self.asString];
  [value appendFormat:@"%C", character];
  self.asString = value.copy;
}

- (nullable FBLegacyBaseClassChainToken*)followingTokenBasedOn:(unichar)character
{
  for (Class matchingTokenClass in self.followingTokens) {
    if ([matchingTokenClass canConsumeCharacter:character]) {
      return [[[matchingTokenClass alloc] init] nextTokenWithCharacter:character];
    }
  }
  return nil;
}

- (nullable FBLegacyBaseClassChainToken*)nextTokenWithCharacter:(unichar)character
{
  if ([self.class canConsumeCharacter:character] && self.asString.length < [self.class maxLength]) {
    [self appendChar:character];
    return self;
  }
  return [self followingTokenBasedOn:character];
}

@end


@implementation FBLegacyClassNameToken

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet letterCharacterSet];
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacySplitterToken.class, FBLegacyOpeningBracketToken.class];
}

@end

static NSString *const LegacySTAR_TOKEN = @"*";
@implementation FBLegacyStarToken

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet characterSetWithCharactersInString:LegacySTAR_TOKEN];
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacySplitterToken.class, FBLegacyOpeningBracketToken.class];
}

- (nullable FBLegacyBaseClassChainToken*)nextTokenWithCharacter:(unichar)character
{
  if ([self.class.allowedCharacters characterIsMember:character]) {
    if (self.asString.length >= 1) {
      FBLegacyDescendantMarkerToken *nextToken = [[FBLegacyDescendantMarkerToken alloc] initWithStringValue:[NSString stringWithFormat:@"%@%@", LegacySTAR_TOKEN, LegacySTAR_TOKEN]];
      nextToken.previousItemsCountToOverride = 1;
      return nextToken;
    }
    [self appendChar:character];
    return self;
  }
  return [self followingTokenBasedOn:character];
}

@end


static NSString *const LegacyDESCENDANT_MARKER = @"**/";
@implementation FBLegacyDescendantMarkerToken

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet characterSetWithCharactersInString:@"*/"];
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacyClassNameToken.class, FBLegacyStarToken.class];
}

+ (NSUInteger)maxLength
{
  return 3;
}

- (nullable FBLegacyBaseClassChainToken*)nextTokenWithCharacter:(unichar)character
{
  if ([self.class.allowedCharacters characterIsMember:character] && self.asString.length <= self.class.maxLength) {
    if (self.asString.length > 0 && ![LegacyDESCENDANT_MARKER hasPrefix:self.asString]) {
      return nil;
    }
    if (self.asString.length < self.class.maxLength) {
      [self appendChar:character];
      return self;
    }
  }
  return [self followingTokenBasedOn:character];
}

@end


@implementation FBLegacySplitterToken

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet characterSetWithCharactersInString:@"/"];
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacyStarToken.class, FBLegacyClassNameToken.class];
}

+ (NSUInteger)maxLength
{
  return 1;
}

@end


@implementation FBLegacyOpeningBracketToken

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet characterSetWithCharactersInString:@"["];
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacyNumberToken.class, FBLegacySelfPredicateToken.class, FBLegacyDescendantPredicateToken.class];
}

+ (NSUInteger)maxLength
{
  return 1;
}

@end


@implementation FBLegacyNumberToken

+ (NSCharacterSet *)allowedCharacters
{
  NSMutableCharacterSet *result = [NSMutableCharacterSet new];
  [result formUnionWithCharacterSet:[NSCharacterSet decimalDigitCharacterSet]];
  [result addCharactersInString:@"-"];
  return result.copy;
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacyClosingBracketToken.class];
}

@end


@implementation FBLegacyClosingBracketToken

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet characterSetWithCharactersInString:@"]"];
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacySplitterToken.class, FBLegacyOpeningBracketToken.class];
}

+ (NSUInteger)maxLength
{
  return 1;
}

@end

static NSString *const LegacyFBAbstractMethodInvocationException = @"LegacyFBAbstractMethodInvocationException";

@implementation FBLegacyAbstractPredicateToken

- (id)init
{
  self = [super init];
  if (self) {
    _isParsingCompleted = NO;
  }
  return self;
}

+ (NSString *)enclosingMarker
{
  NSString *errMsg = [NSString stringWithFormat:@"The + (NSString *)enclosingMarker method is expected to be overriden by %@ class", NSStringFromClass(self.class)];
  @throw [NSException exceptionWithName:LegacyFBAbstractMethodInvocationException reason:errMsg userInfo:nil];
}

+ (NSCharacterSet *)allowedCharacters
{
  return [NSCharacterSet illegalCharacterSet].invertedSet;
}

- (NSArray<Class> *)followingTokens
{
  return @[FBLegacyClosingBracketToken.class];
}

+ (BOOL)canConsumeCharacter:(unichar)character
{
  return [[NSCharacterSet characterSetWithCharactersInString:self.class.enclosingMarker] characterIsMember:character];
}

- (void)stripLastChar
{
  if (self.asString.length > 0) {
    self.asString = [self.asString substringToIndex:self.asString.length - 1];
  }
}

- (nullable FBLegacyBaseClassChainToken*)nextTokenWithCharacter:(unichar)character
{
  NSString *currentChar = [NSString stringWithFormat:@"%C", character];
  if (!self.isParsingCompleted && [self.class.allowedCharacters characterIsMember:character]) {
    if (0 == self.asString.length) {
      if ([self.class.enclosingMarker isEqualToString:currentChar]) {
        // Do not include enclosing character
        return self;
      }
    } else if ([self.class.enclosingMarker isEqualToString:currentChar]) {
      [self appendChar:character];
      self.isParsingCompleted = YES;
      return self;
    }
    [self appendChar:character];
    return self;
  }
  if (self.isParsingCompleted) {
    if ([currentChar isEqualToString:self.class.enclosingMarker]) {
      // Escaped enclosing character has been detected. Do not finish parsing
      self.isParsingCompleted = NO;
      return self;
    } else {
      // Do not include enclosing character
      [self stripLastChar];
    }
  }
  return [self followingTokenBasedOn:character];
}

@end

@implementation FBLegacySelfPredicateToken

+ (NSString *)enclosingMarker
{
  return @"`";
}

@end

@implementation FBLegacyDescendantPredicateToken

+ (NSString *)enclosingMarker
{
  return @"$";
}

@end

@implementation FBLegacyClassChainQueryParser

static NSNumberFormatter *LegacynumberFormatter = nil;

+ (void)initialize {
  if (nil == LegacynumberFormatter) {
    LegacynumberFormatter = [[NSNumberFormatter alloc] init];
    LegacynumberFormatter.numberStyle = NSNumberFormatterDecimalStyle;
  }
}

+ (NSError *)tokenizationErrorWithIndex:(NSUInteger)index originalQuery:(NSString *)originalQuery
{
  NSString *description = [NSString stringWithFormat:@"Cannot parse class chain query '%@'. Unexpected character detected at position %@:\n%@ <----", originalQuery, @(index + 1), [originalQuery substringToIndex:index + 1]];
  return [[FBErrorBuilder.builder withDescription:description] build];
}

+ (nullable NSArray<FBLegacyBaseClassChainToken *> *)tokenizedQueryWithQuery:(NSString*)classChainQuery error:(NSError **)error
{
  NSUInteger queryStringLength = classChainQuery.length;
  FBLegacyBaseClassChainToken *token;
  unichar firstCharacter = [classChainQuery characterAtIndex:0];
  if ([classChainQuery hasPrefix:LegacyDESCENDANT_MARKER]) {
    token = [[FBLegacyDescendantMarkerToken alloc] initWithStringValue:LegacyDESCENDANT_MARKER];
  } else if ([FBLegacyClassNameToken canConsumeCharacter:firstCharacter]) {
    token = [[FBLegacyClassNameToken alloc] initWithStringValue:[NSString stringWithFormat:@"%C", firstCharacter]];
  } else if ([FBLegacyStarToken canConsumeCharacter:firstCharacter]) {
    token = [[FBLegacyStarToken alloc] initWithStringValue:[NSString stringWithFormat:@"%C", firstCharacter]];
  } else {
    if (error) {
      *error = [self.class tokenizationErrorWithIndex:0 originalQuery:classChainQuery];
    }
    return nil;
  }
  NSMutableArray *result = [NSMutableArray array];
  FBLegacyBaseClassChainToken *nextToken = token;
  for (NSUInteger charIdx = token.asString.length; charIdx < queryStringLength; ++charIdx) {
    nextToken = [token nextTokenWithCharacter:[classChainQuery characterAtIndex:charIdx]];
    if (nil == nextToken) {
      if (error) {
        *error = [self.class tokenizationErrorWithIndex:charIdx originalQuery:classChainQuery];
      }
      return nil;
    }
    if (nextToken != token) {
      [result addObject:token];
      if (nextToken.previousItemsCountToOverride > 0 && result.count > 0) {
        NSUInteger itemsCountToOverride = nextToken.previousItemsCountToOverride <= result.count ? nextToken.previousItemsCountToOverride : result.count;
        [result removeObjectsInRange:NSMakeRange(result.count - itemsCountToOverride, itemsCountToOverride)];
      }
      token = nextToken;
    }
  }
  if (nextToken) {
    if (nextToken.previousItemsCountToOverride > 0 && result.count > 0) {
      NSUInteger itemsCountToOverride = nextToken.previousItemsCountToOverride <= result.count ? nextToken.previousItemsCountToOverride : result.count;
      [result removeObjectsInRange:NSMakeRange(result.count - itemsCountToOverride, itemsCountToOverride)];
    }
    [result addObject:nextToken];
  }
  
  FBLegacyBaseClassChainToken *lastToken = [result lastObject];
  if (!([lastToken isKindOfClass:FBLegacyClosingBracketToken.class] ||
        [lastToken isKindOfClass:FBLegacyClassNameToken.class] ||
        [lastToken isKindOfClass:FBLegacyStarToken.class])) {
    if (error) {
      *error = [self.class tokenizationErrorWithIndex:queryStringLength - 1 originalQuery:classChainQuery];
    }
    return nil;
  }
  
  return result.copy;
}

+ (NSError *)compilationErrorWithQuery:(NSString *)originalQuery description:(NSString *)description
{
  NSString *fullDescription = [NSString stringWithFormat:@"Cannot parse class chain query '%@'. %@", originalQuery, description];
  return [[FBErrorBuilder.builder withDescription:fullDescription] build];
}

+ (nullable FBClassChain*)compiledQueryWithTokenizedQuery:(NSArray<FBLegacyBaseClassChainToken *> *)tokenizedQuery
                                            originalQuery:(NSString *)originalQuery
                                                    error:(NSError **)error
{
  NSMutableArray *result = [NSMutableArray array];
  XCUIElementType chainElementType = XCUIElementTypeAny;
  NSNumber *chainElementPosition = nil;
  BOOL isTypeSet = NO;
  BOOL isPositionSet = NO;
  BOOL isDescendantSet = NO;
  NSMutableArray<FBAbstractPredicateItem *> *predicates = [NSMutableArray array];
  for (FBLegacyBaseClassChainToken *token in tokenizedQuery) {
    if ([token isKindOfClass:FBLegacyClassNameToken.class]) {
      if (isTypeSet) {
        if (error) {
          NSString *description = [NSString stringWithFormat:@"Unexpected token '%@'. The type name can be set only once.", token.asString];
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      @try {
        chainElementType = [FBElementTypeTransformer elementTypeWithTypeName:token.asString];
        isTypeSet = YES;
      } @catch (NSException *e) {
        if ([e.name isEqualToString:FBInvalidArgumentException]) {
          if (error) {
            NSString *description = [NSString stringWithFormat:@"'%@' class name is unknown to WDA", token.asString];
            *error = [self.class compilationErrorWithQuery:originalQuery description:description];
          }
          return nil;
        }
        @throw e;
      }
    } else if ([token isKindOfClass:FBLegacyStarToken.class]) {
      if (isTypeSet) {
        if (error) {
          NSString *description = [NSString stringWithFormat:@"Unexpected token '%@'. The type name can be set only once.", token.asString];
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      chainElementType = XCUIElementTypeAny;
      isTypeSet = YES;
    } else if ([token isKindOfClass:FBLegacyDescendantMarkerToken.class]) {
      if (isDescendantSet) {
        NSString *description = [NSString stringWithFormat:@"Unexpected token '%@'. Descendant markers cannot be duplicated.", token.asString];
        if (error) {
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      isTypeSet = NO;
      isPositionSet = NO;
      [predicates removeAllObjects];
      isDescendantSet = YES;
    } else if ([token isKindOfClass:FBLegacyAbstractPredicateToken.class]) {
      if (isPositionSet) {
        NSString *description = [NSString stringWithFormat:@"Predicate value '%@' must be set before position value.", token.asString];
        if (error) {
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      if (!((FBLegacyAbstractPredicateToken *)token).isParsingCompleted) {
        NSString *description = [NSString stringWithFormat:@"Cannot find the end of '%@' predicate value.", token.asString];
        if (error) {
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      NSPredicate *value = [NSPredicate fb_snapshotBlockPredicateWithPredicate:[NSPredicate predicateWithFormat:token.asString]];
      if ([token isKindOfClass:FBLegacySelfPredicateToken.class]) {
        [predicates addObject:[[FBSelfPredicateItem alloc] initWithValue:value]];
      } else if ([token isKindOfClass:FBLegacyDescendantPredicateToken.class]) {
        [predicates addObject:[[FBDescendantPredicateItem alloc] initWithValue:value]];
      }
    } else if ([token isKindOfClass:FBLegacyNumberToken.class]) {
      if (isPositionSet) {
        NSString *description = [NSString stringWithFormat:@"Position value '%@' is expected to be set only once.", token.asString];
        if (error) {
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      NSNumber *position = [LegacynumberFormatter numberFromString:token.asString];
      if (nil == position || 0 == position.intValue) {
        NSString *description = [NSString stringWithFormat:@"Position value '%@' is expected to be a valid integer number not equal to zero.", token.asString];
        if (error) {
          *error = [self.class compilationErrorWithQuery:originalQuery description:description];
        }
        return nil;
      }
      chainElementPosition = position;
      isPositionSet = YES;
    } else if ([token isKindOfClass:FBLegacySplitterToken.class]) {
      if (!isPositionSet) {
        chainElementPosition = nil;
      }
      if (isDescendantSet) {
        if (isTypeSet) {
          [result addObject:[[FBClassChainItem alloc] initWithType:chainElementType position:chainElementPosition predicates:predicates.copy isDescendant:YES]];
          isDescendantSet = NO;
        }
      } else {
        [result addObject:[[FBClassChainItem alloc] initWithType:chainElementType position:chainElementPosition predicates:predicates.copy isDescendant:NO]];
      }
      isTypeSet = NO;
      isPositionSet = NO;
      [predicates removeAllObjects];
    }
  }
  if (!isPositionSet) {
    chainElementPosition = nil;
  }
  if (isDescendantSet) {
    if (isTypeSet) {
      [result addObject:[[FBClassChainItem alloc] initWithType:chainElementType position:chainElementPosition predicates:predicates.copy isDescendant:YES]];
    } else {
      if (error) {
        NSString *description = @"Descendants lookup modifier '**/' should be followed with the actual element type";
        *error = [self.class compilationErrorWithQuery:originalQuery description:description];
      }
      return nil;
    }
  } else {
    [result addObject:[[FBClassChainItem alloc] initWithType:chainElementType position:chainElementPosition predicates:predicates.copy isDescendant:NO]];
  }
  return [[FBClassChain alloc] initWithElements:result.copy];
}

+ (FBClassChain *)parseQuery:(NSString*)classChainQuery error:(NSError **)error
{
  NSAssert(classChainQuery.length > 0, @"Query length should be greater than zero", nil);
  NSArray *tokenizedQuery = [self.class tokenizedQueryWithQuery:classChainQuery error:error];
  if (nil == tokenizedQuery) {
    return nil;
  }
  return [self.class compiledQueryWithTokenizedQuery:tokenizedQuery originalQuery:classChainQuery error:error];
}

@end

