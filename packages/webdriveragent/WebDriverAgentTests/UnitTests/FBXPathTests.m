/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <XCTest/XCTest.h>

#import "FBConfiguration.h"
#import "FBExceptions.h"
#import "FBMacros.h"
#import "FBSnapshotTreeDouble.h"
#import "FBXMLGenerationOptions.h"
#import "FBXPath.h"
#import "FBXPath-Private.h"
#import "XCUIElementDouble.h"
#import "XCElementSnapshotDouble.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCTestPrivateSymbols.h"

// libxml's node callbacks are thread-local; restore any existing callbacks after each probe.
static __thread NSUInteger FBReviewCreatedDocs;
static __thread NSUInteger FBReviewFreedDocs;
static __thread xmlRegisterNodeFunc FBReviewPreviousRegister;
static __thread xmlDeregisterNodeFunc FBReviewPreviousDeregister;

static void FBReviewRegisterNode(xmlNodePtr node)
{
  if (node->type == XML_DOCUMENT_NODE) { FBReviewCreatedDocs++; }
  if (NULL != FBReviewPreviousRegister) { FBReviewPreviousRegister(node); }
}

static void FBReviewDeregisterNode(xmlNodePtr node)
{
  if (node->type == XML_DOCUMENT_NODE) { FBReviewFreedDocs++; }
  if (NULL != FBReviewPreviousDeregister) { FBReviewPreviousDeregister(node); }
}

@interface FBThrowingLabelSnapshot : XCElementSnapshotDouble
@end
@implementation FBThrowingLabelSnapshot
- (NSString *)label
{
  @throw [NSException exceptionWithName:@"SnapshotAttributeFailure" reason:@"test" userInfo:nil];
}
@end

@interface FBTraversalSnapshot : XCElementSnapshotDouble
@property (nonatomic, copy) NSArray *childSnapshots;
@property (nonatomic, weak) FBTraversalSnapshot *parentSnapshot;
@property (nonatomic) NSUInteger childrenReads;
@property (nonatomic) NSUInteger frameReads;
@end
@implementation FBTraversalSnapshot
- (NSArray *)children { self.childrenReads++; return self.childSnapshots ?: @[]; }
- (id)parent { return self.parentSnapshot; }
- (CGRect)frame { self.frameReads++; return CGRectMake(1, 2, 3, 4); }
@end

// Minimal accessibility element exposing a unique uid so XPath can resolve the context node.
@interface FBXPathAXElementDouble : NSObject {
  long long _elementID;
}
@property (nonatomic, readonly) NSDictionary *payload;
@property (nonatomic, readonly) int processIdentifier;
- (instancetype)initWithID:(long long)elementID;
@end
@implementation FBXPathAXElementDouble
- (instancetype)initWithID:(long long)elementID
{
  self = [super init];
  if (self) { _elementID = elementID; }
  return self;
}
- (NSDictionary *)payload { return @{@"uid.elementID": @(_elementID)}; }
- (int)processIdentifier { return 42; }
@end

@interface FBXPathNodeDouble : FBSnapshotTreeDouble
@end
@implementation FBXPathNodeDouble {
  FBXPathAXElementDouble *_axElement;
}
- (instancetype)init
{
  static long long nextID = 1;
  self = [super init];
  if (self) { _axElement = [[FBXPathAXElementDouble alloc] initWithID:nextID++]; }
  return self;
}
- (id)accessibilityElement { return (id)_axElement; }
@end

static NSArray<NSString *> *FBXPathButtonLabels(void)
{
  return @[@"Alerts", @"Deadlock app", @"Attributes", @"Scrolling", @"Touch", @"DeepHierarchy", @"Coordinate Probe"];
}

@interface FBXPathTests : XCTestCase
// Window > MainView(Other) > one Button per label
@property (nonatomic, strong) FBXPathNodeDouble *window;
@property (nonatomic, strong) FBXPathNodeDouble *mainView;
@property (nonatomic, copy) NSArray<FBXPathNodeDouble *> *buttons;
@end

@implementation FBXPathTests

- (void)setUp
{
  [super setUp];
  NSMutableArray *buttons = [NSMutableArray array];
  CGFloat y = 0;
  for (NSString *label in FBXPathButtonLabels()) {
    FBXPathNodeDouble *button = [FBXPathNodeDouble type:XCUIElementTypeButton label:label children:nil];
    button.frame = CGRectMake(10, y, 100, 20);
    y += 30;
    [buttons addObject:button];
  }
  self.buttons = buttons;
  self.mainView = [FBXPathNodeDouble type:XCUIElementTypeOther label:@"MainView" children:buttons];
  self.window = [FBXPathNodeDouble type:XCUIElementTypeWindow label:nil children:@[self.mainView]];
}

- (void)testSerializationVisitsSiblingListAndFrameOnce
{
  FBTraversalSnapshot *root = [FBTraversalSnapshot new];
  NSMutableArray *children = [NSMutableArray array];
  for (NSUInteger index = 0; index < 64; index++) {
    FBTraversalSnapshot *child = [FBTraversalSnapshot new];
    child.parentSnapshot = root;
    [children addObject:child];
  }
  root.childSnapshots = children;
  NSString *query = @"//*[@index >= 0 and @x=1 and @y=2 and @width=3 and @height=4]";
  xmlDocPtr doc = [self documentForSnapshot:root query:query];
  @try {
    XCTAssertEqual(root.childrenReads, 1u);
    XCTAssertEqual(root.frameReads, 1u);
    for (FBTraversalSnapshot *child in children) {
      XCTAssertEqual(child.frameReads, 1u);
    }
    XCTAssertEqualObjects([self xpathStringResultForQuery:@"count(//*[@index=63])" document:doc], @"1");
  } @finally {
    xmlFreeDoc(doc);
  }
}

- (void)testDirectXmlWriterPreservesEscapingAndFormatting
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  snapshot.label = @"line one\nline two\t& < > \" йоло";
  snapshot.value = @"value";
  NSString *expected = [[self xmlStringWithElement:(id)snapshot xpathQuery:nil excludingAttributes:nil]
    stringByReplacingOccurrencesOfString:@" private_indexPath=\"top\"" withString:@""];
  NSString *actual = [FBXPath xmlStringWithRootElement:(id)snapshot options:nil];
  XCTAssertEqualObjects(actual, expected);
}

- (void)testXmlDocumentsAreFreedWhenSnapshotAttributesThrow
{
  for (NSNumber *isLookup in @[@NO, @YES]) {
    FBReviewCreatedDocs = 0;
    FBReviewFreedDocs = 0;
    FBReviewPreviousRegister = xmlRegisterNodeDefault(FBReviewRegisterNode);
    FBReviewPreviousDeregister = xmlDeregisterNodeDefault(FBReviewDeregisterNode);
    @try {
      id<FBElement> snapshot = (id)[FBThrowingLabelSnapshot new];
      if (isLookup.boolValue) {
        XCTAssertThrowsSpecificNamed([FBXPath matchesWithRootElement:snapshot forQuery:@"//*[@label]"],
                                     NSException, @"SnapshotAttributeFailure");
      } else {
        XCTAssertThrowsSpecificNamed([FBXPath xmlStringWithRootElement:snapshot options:nil],
                                     NSException, @"SnapshotAttributeFailure");
      }
      if (isLookup.boolValue) {
        XCTAssertGreaterThan(FBReviewCreatedDocs, 0u);
      }
      XCTAssertEqual(FBReviewCreatedDocs, FBReviewFreedDocs);
    } @finally {
      xmlRegisterNodeDefault(FBReviewPreviousRegister);
      xmlDeregisterNodeDefault(FBReviewPreviousDeregister);
    }
  }
}

- (NSString *)xmlStringWithElement:(id<FBXCElementSnapshot>)snapshot
                        xpathQuery:(nullable NSString *)query
               excludingAttributes:(nullable NSArray<NSString *> *)excludedAttributes
{
  xmlDocPtr doc;
  
  xmlTextWriterPtr writer = xmlNewTextWriterDoc(&doc, 0);
  NSMutableDictionary *elementStore = [NSMutableDictionary dictionary];
  int buffersize;
  xmlChar *xmlbuff = NULL;
  int rc = xmlTextWriterStartDocument(writer, NULL, "UTF-8", NULL);
  if (rc >= 0) {
    rc = [FBXPath xmlRepresentationWithRootElement:snapshot
                                            writer:writer
                                      elementStore:elementStore
                                             query:query
                               excludingAttributes:excludedAttributes];
    if (rc >= 0) {
      rc = xmlTextWriterEndDocument(writer);
    }
  }
  if (rc >= 0) {
    xmlDocDumpFormatMemory(doc, &xmlbuff, &buffersize, 1);
  }
  xmlFreeTextWriter(writer);
  xmlFreeDoc(doc);
  
  XCTAssertTrue(rc >= 0);
  XCTAssertEqual(1, [elementStore count]);

  NSString *result = [NSString stringWithCString:(const char *)xmlbuff encoding:NSUTF8StringEncoding];
  xmlFree(xmlbuff);
  return result;
}

- (void)testDefaultXPathPresentation
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  id<FBElement> element = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)snapshot];
  NSString *resultXml = [self xmlStringWithElement:(id<FBXCElementSnapshot>)element
                                        xpathQuery:nil
                               excludingAttributes:nil];
  NSLog(@"[DefaultXPath] Result XML:\n%@", resultXml);
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@ type=\"%@\" value=\"%@\" name=\"%@\" label=\"%@\" enabled=\"%@\" visible=\"%@\" accessible=\"%@\" x=\"%@\" y=\"%@\" width=\"%@\" height=\"%@\" index=\"%lu\" traits=\"%@\" private_indexPath=\"top\"/>\n",
                           element.wdType, element.wdType, element.wdValue, element.wdName, element.wdLabel, FBBoolToString(element.wdEnabled), FBBoolToString(element.wdVisible), FBBoolToString(element.wdAccessible), element.wdRect[@"x"], element.wdRect[@"y"], element.wdRect[@"width"], element.wdRect[@"height"], element.wdIndex, element.wdTraits];
  XCTAssertTrue([resultXml isEqualToString: expectedXml]);
}

- (void)testXPathPresentationWithSomeAttributesExcluded
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  id<FBElement> element = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)snapshot];
  NSString *resultXml = [self xmlStringWithElement:(id<FBXCElementSnapshot>)element
                                        xpathQuery:nil
                               excludingAttributes:@[@"type", @"visible", @"value", @"index", @"traits", @"nativeFrame", @"blabla"]];
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@ name=\"%@\" label=\"%@\" enabled=\"%@\" accessible=\"%@\" x=\"%@\" y=\"%@\" width=\"%@\" height=\"%@\" private_indexPath=\"top\"/>\n",
                           element.wdType, element.wdName, element.wdLabel, FBBoolToString(element.wdEnabled), FBBoolToString(element.wdAccessible), element.wdRect[@"x"], element.wdRect[@"y"], element.wdRect[@"width"], element.wdRect[@"height"]];
  XCTAssertEqualObjects(resultXml, expectedXml);
}

- (void)testXPathPresentationBasedOnQueryMatchingAllAttributes
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  snapshot.value = @"йоло<>&\"";
  snapshot.label = @"a\nb";
  NSString *testCustomActions = @"Custom Action 1, Custom Action 2";
  snapshot.additionalAttributes[FB_XCAXACustomActionsAttribute] = testCustomActions;
  id<FBElement> element = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)snapshot];
  NSString *resultXml = [self xmlStringWithElement:(id<FBXCElementSnapshot>)element
                                        xpathQuery:[NSString stringWithFormat:@"//%@[@*]", element.wdType]
                               excludingAttributes:@[@"visible"]];
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@ type=\"%@\" value=\"%@\" name=\"%@\" label=\"%@\" enabled=\"%@\" visible=\"%@\" accessible=\"%@\" nativeAccessibilityElement=\"%@\" x=\"%@\" y=\"%@\" width=\"%@\" height=\"%@\" index=\"%lu\" hittable=\"%@\" traits=\"%@\" nativeFrame=\"%@\" customActions=\"%@\" private_indexPath=\"top\"/>\n",
                           element.wdType, element.wdType, @"йоло&lt;&gt;&amp;&quot;", element.wdName, @"a&#10;b", FBBoolToString(element.wdEnabled), FBBoolToString(element.wdVisible), FBBoolToString(element.wdAccessible), FBBoolToString(element.wdNativeAccessibilityElement), element.wdRect[@"x"], element.wdRect[@"y"], element.wdRect[@"width"], element.wdRect[@"height"], element.wdIndex, FBBoolToString(element.wdHittable), element.wdTraits, NSStringFromCGRect(element.wdNativeFrame), element.wdCustomActions];
  XCTAssertEqualObjects(expectedXml, resultXml);
}

- (void)testXPathPresentationBasedOnQueryMatchingSomeAttributes
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  id<FBElement> element = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)snapshot];
  NSString *resultXml = [self xmlStringWithElement:(id<FBXCElementSnapshot>)element
                                        xpathQuery:[NSString stringWithFormat:@"//%@[@%@ and contains(@%@, 'blabla')]", element.wdType, @"value", @"name"]
                               excludingAttributes:nil];
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@ value=\"%@\" name=\"%@\" private_indexPath=\"top\"/>\n",
                           element.wdType, element.wdValue, element.wdName];
  XCTAssertTrue([resultXml isEqualToString: expectedXml]);
}

- (void)testSnapshotXPathResultsMatching
{
  xmlDocPtr doc;

  xmlTextWriterPtr writer = xmlNewTextWriterDoc(&doc, 0);
  NSMutableDictionary *elementStore = [NSMutableDictionary dictionary];
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  id<FBElement> root = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)snapshot];
  NSString *query = [NSString stringWithFormat:@"//%@", root.wdType];
  int rc = xmlTextWriterStartDocument(writer, NULL, "UTF-8", NULL);
  if (rc >= 0) {
    rc = [FBXPath xmlRepresentationWithRootElement:(id<FBXCElementSnapshot>)root
                                            writer:writer
                                      elementStore:elementStore
                                             query:query
                               excludingAttributes:nil];
    if (rc >= 0) {
      rc = xmlTextWriterEndDocument(writer);
    }
  }
  if (rc < 0) {
    xmlFreeTextWriter(writer);
    xmlFreeDoc(doc);
    XCTFail(@"Unable to create the source XML document");
  }

  xmlXPathObjectPtr queryResult = [FBXPath evaluate:query document:doc contextNode:NULL];
  if (NULL == queryResult) {
    xmlFreeTextWriter(writer);
    xmlFreeDoc(doc);
    XCTAssertNotEqual(NULL, queryResult);
  }

  NSArray *matchingSnapshots = [FBXPath collectMatchingSnapshots:queryResult->nodesetval
                                                    elementStore:elementStore];
  xmlXPathFreeObject(queryResult);
  xmlFreeTextWriter(writer);
  xmlFreeDoc(doc);

  XCTAssertNotNil(matchingSnapshots);
  XCTAssertEqual(1, [matchingSnapshots count]);
}

- (NSString *)xpathStringResultForQuery:(NSString *)query document:(xmlDocPtr)doc
{
  xmlXPathObjectPtr queryResult = [FBXPath evaluate:query document:doc contextNode:NULL];
  if (NULL == queryResult) {
    return nil;
  }
  xmlChar *stringValue = xmlXPathCastToString(queryResult);
  xmlXPathFreeObject(queryResult);
  if (NULL == stringValue) {
    return nil;
  }
  NSString *result = [NSString stringWithUTF8String:(const char *)stringValue];
  xmlFree(stringValue);
  return result;
}

- (BOOL)xpathBooleanResultForQuery:(NSString *)query document:(xmlDocPtr)doc
{
  xmlXPathObjectPtr queryResult = [FBXPath evaluate:query document:doc contextNode:NULL];
  if (NULL == queryResult) {
    return NO;
  }
  BOOL result = queryResult->boolval;
  xmlXPathFreeObject(queryResult);
  return result;
}

- (xmlDocPtr)documentForSnapshot:(XCElementSnapshotDouble *)snapshot query:(NSString *)query
{
  xmlDocPtr doc;
  xmlTextWriterPtr writer = xmlNewTextWriterDoc(&doc, 0);
  NSMutableDictionary *elementStore = [NSMutableDictionary dictionary];
  id<FBElement> root = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)snapshot];
  int rc = xmlTextWriterStartDocument(writer, NULL, "UTF-8", NULL);
  if (rc >= 0) {
    rc = [FBXPath xmlRepresentationWithRootElement:(id<FBXCElementSnapshot>)root
                                            writer:writer
                                      elementStore:elementStore
                                             query:query
                               excludingAttributes:nil];
    if (rc >= 0) {
      rc = xmlTextWriterEndDocument(writer);
    }
  }
  xmlFreeTextWriter(writer);
  XCTAssertTrue(rc >= 0);
  return doc;
}

- (void)testXPathExtensionFunctions
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  snapshot.label = @"Hello World";
  snapshot.value = @"One-Two-Three";

  xmlDocPtr doc = [self documentForSnapshot:snapshot query:@"//*[@label and @name and @value]"];

  @try {
    XCTAssertTrue([self xpathBooleanResultForQuery:@"matches(//XCUIElementTypeOther/@label, 'Hello.*')" document:doc]);
    XCTAssertFalse([self xpathBooleanResultForQuery:@"matches(//XCUIElementTypeOther/@label, 'hello.*')" document:doc]);
    XCTAssertTrue([self xpathBooleanResultForQuery:@"matches(//XCUIElementTypeOther/@label, 'hello.*', 'i')" document:doc]);
    XCTAssertTrue([self xpathBooleanResultForQuery:@"ends-with(//XCUIElementTypeOther/@name, 'Name')" document:doc]);
    XCTAssertFalse([self xpathBooleanResultForQuery:@"ends-with(//XCUIElementTypeOther/@name, 'Foo')" document:doc]);
    XCTAssertEqualObjects([self xpathStringResultForQuery:@"lower-case(//XCUIElementTypeOther/@label)" document:doc], @"hello world");
    XCTAssertEqualObjects([self xpathStringResultForQuery:@"upper-case(//XCUIElementTypeOther/@name)" document:doc], @"TESTNAME");
    XCTAssertEqualObjects([self xpathStringResultForQuery:@"replace(//XCUIElementTypeOther/@value, '-', '_')" document:doc], @"One_Two_Three");
    XCTAssertEqualObjects([self xpathStringResultForQuery:@"string-join(tokenize(//XCUIElementTypeOther/@value, '-'), '|')" document:doc], @"One|Two|Three");
  } @finally {
    xmlFreeDoc(doc);
  }
}

- (void)testInvalidXPathExtensionRegexp
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  snapshot.label = @"Hello World";
  snapshot.value = @"One-Two-Three";

  xmlDocPtr doc = [self documentForSnapshot:snapshot query:@"//*[@label and @name and @value]"];

  @try {
    [self assertXPathEvaluationFailsForQuery:@"matches(//XCUIElementTypeOther/@label, '[')" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"replace(//XCUIElementTypeOther/@label, '[', '')" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"tokenize(//XCUIElementTypeOther/@value, '[')" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"matches(//XCUIElementTypeOther/@label, 'a', 'z')" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"//XCUIElementTypeOther[matches(@label, '[')]" document:doc];
  } @finally {
    xmlFreeDoc(doc);
  }
}

- (void)assertXPathEvaluationFailsForQuery:(NSString *)query document:(xmlDocPtr)doc
{
  xmlXPathObjectPtr queryResult = [FBXPath evaluate:query document:doc contextNode:NULL];
  @try {
    XCTAssertEqual(NULL, queryResult);
  } @finally {
    if (NULL != queryResult) {
      xmlXPathFreeObject(queryResult);
    }
  }
}

- (void)testInvalidXPathExtensionFunctionArity
{
  XCElementSnapshotDouble *snapshot = [XCElementSnapshotDouble new];
  snapshot.label = @"Hello World";
  snapshot.value = @"One-Two-Three";

  xmlDocPtr doc = [self documentForSnapshot:snapshot query:@"//*[@label and @name and @value]"];

  @try {
    [self assertXPathEvaluationFailsForQuery:@"matches(//XCUIElementTypeOther/@label)" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"lower-case()" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"string-join(//XCUIElementTypeOther/@label)" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"replace(//XCUIElementTypeOther/@label, '-')" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"//XCUIElementTypeOther[matches(@label)]" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"//XCUIElementTypeOther[lower-case()]" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"//XCUIElementTypeOther[string-join(@label)]" document:doc];
    [self assertXPathEvaluationFailsForQuery:@"//XCUIElementTypeOther[replace(@label, '-')]" document:doc];
  } @finally {
    xmlFreeDoc(doc);
  }
}

#pragma mark - Snapshot-double tree lookups

// Without an accessibility element: serializing visible/hittable would otherwise query AX
- (FBSnapshotTreeDouble *)standaloneButton
{
  FBSnapshotTreeDouble *button = [FBSnapshotTreeDouble type:XCUIElementTypeButton label:FBXPathButtonLabels().firstObject children:nil];
  button.frame = CGRectMake(10, 0, 100, 20);
  button.value = nil;
  return button;
}

- (NSString *)xmlStringForSingleButtonWithOptions:(FBXMLGenerationOptions *)options
{
  return [FBXPath xmlStringWithRootElement:(id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)[self standaloneButton]]
                                   options:options];
}

- (void)testSingleDescendantXMLRepresentationWithScope
{
  NSString *scope = @"AppiumAUT";
  id<FBElement> wrapped = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)[self standaloneButton]];
  NSString *xmlStr = [self xmlStringForSingleButtonWithOptions:[[FBXMLGenerationOptions new] withScope:scope]];
  XCTAssertNotNil(xmlStr);
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@>\n  <%@ type=\"%@\" name=\"%@\" label=\"%@\" enabled=\"%@\" visible=\"%@\" accessible=\"%@\" x=\"%@\" y=\"%@\" width=\"%@\" height=\"%@\" index=\"%lu\" traits=\"%@\"/>\n</%@>\n", scope, wrapped.wdType, wrapped.wdType, wrapped.wdName, wrapped.wdLabel, FBBoolToString(wrapped.wdEnabled), FBBoolToString(wrapped.wdVisible), FBBoolToString(wrapped.wdAccessible), [wrapped.wdRect[@"x"] stringValue], [wrapped.wdRect[@"y"] stringValue], [wrapped.wdRect[@"width"] stringValue], [wrapped.wdRect[@"height"] stringValue], wrapped.wdIndex, wrapped.wdTraits, scope];
  XCTAssertEqualObjects(xmlStr, expectedXml);
}

- (void)testSingleDescendantXMLRepresentationWithExcludedAttributesOption
{
  FBXMLGenerationOptions *options = [[FBXMLGenerationOptions new]
                                     withExcludedAttributes:@[@"visible", @"enabled", @"index", @"blabla"]];
  id<FBElement> wrapped = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:(id)[self standaloneButton]];
  NSString *xmlStr = [self xmlStringForSingleButtonWithOptions:options];
  XCTAssertNotNil(xmlStr);
  NSString *expectedXml = [NSString stringWithFormat:@"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<%@ type=\"%@\" name=\"%@\" label=\"%@\" accessible=\"%@\" x=\"%@\" y=\"%@\" width=\"%@\" height=\"%@\" traits=\"%@\"/>\n", wrapped.wdType, wrapped.wdType, wrapped.wdName, wrapped.wdLabel, FBBoolToString(wrapped.wdAccessible), [wrapped.wdRect[@"x"] stringValue], [wrapped.wdRect[@"y"] stringValue], [wrapped.wdRect[@"width"] stringValue], [wrapped.wdRect[@"height"] stringValue], wrapped.wdTraits];
  XCTAssertEqualObjects(xmlStr, expectedXml);
}

- (void)assertAllButtonsInSnapshots:(NSArray<id<FBXCElementSnapshot>> *)snapshots
{
  XCTAssertEqual(snapshots.count, FBXPathButtonLabels().count);
  for (id<FBXCElementSnapshot> snapshot in snapshots) {
    XCTAssertEqualObjects(((id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:snapshot]).wdType, @"XCUIElementTypeButton");
  }
}

- (void)testFindMatchesInElement
{
  [self assertAllButtonsInSnapshots:[FBXPath matchesWithRootElement:(id)self.window
                                                           forQuery:@"//XCUIElementTypeButton"]];
}

- (void)testFindMatchesInElementWithDotNotation
{
  [self assertAllButtonsInSnapshots:[FBXPath matchesWithRootElement:(id)self.window
                                                           forQuery:@".//XCUIElementTypeButton"]];
}

- (void)testFindMatchesWithoutContextScopeLimit
{
  id<FBElement> button = (id)self.buttons.firstObject;
  BOOL previousValue = FBConfiguration.sharedInstance.limitXpathContextScope;
  FBConfiguration.sharedInstance.limitXpathContextScope = NO;
  @try {
    NSArray *parentSnapshots = [FBXPath matchesWithRootElement:button forQuery:@".."];
    XCTAssertEqual(parentSnapshots.count, 1);
    XCTAssertEqualObjects(((id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:parentSnapshots.firstObject]).wdLabel, @"MainView");
    NSArray *currentSnapshots = [FBXPath matchesWithRootElement:button forQuery:@"."];
    XCTAssertEqual(currentSnapshots.count, 1);
    id<FBElement> current = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:currentSnapshots.firstObject];
    XCTAssertEqualObjects(current.wdType, @"XCUIElementTypeButton");
    XCTAssertEqualObjects(current.wdLabel, FBXPathButtonLabels().firstObject);
  } @finally {
    FBConfiguration.sharedInstance.limitXpathContextScope = previousValue;
  }
}

- (void)testFindMatchesWithExtensionFunctions
{
  NSArray<NSArray *> *cases = @[
    @[@"//XCUIElementTypeButton[matches(@label, '^Alerts$')]", @[@"Alerts"]],
    @[@"//XCUIElementTypeButton[matches(@label, '^alerts$', 'i')]", @[@"Alerts"]],
    @[@"//XCUIElementTypeButton[ends-with(@label, 'ing')]", @[@"Scrolling"]],
    @[@"//XCUIElementTypeButton[lower-case(@label)='alerts']", @[@"Alerts"]],
    @[@"//XCUIElementTypeButton[upper-case(@label)='TOUCH']", @[@"Touch"]],
    @[@"//XCUIElementTypeButton[replace(@label, ' ', '')='Deadlockapp']", @[@"Deadlock app"]],
    @[@"//XCUIElementTypeButton[string-join(tokenize(@label, ' '), '-')='Deadlock-app']", @[@"Deadlock app"]],
    @[@"//XCUIElementTypeButton[matches(@label, '^NoSuchButton$')]", @[]],
    @[@"//XCUIElementTypeButton[matches(@label, '.*')]", FBXPathButtonLabels()],
  ];
  for (NSArray *testCase in cases) {
    NSString *query = testCase[0];
    NSArray<NSString *> *expectedLabels = testCase[1];
    NSArray<id<FBXCElementSnapshot>> *snapshots = [FBXPath matchesWithRootElement:(id)self.window forQuery:query];
    NSMutableArray<NSString *> *foundLabels = [NSMutableArray array];
    for (id<FBXCElementSnapshot> snapshot in snapshots) {
      id<FBElement> wrapped = (id<FBElement>)[FBXCElementSnapshotWrapper ensureWrapped:snapshot];
      XCTAssertEqualObjects(wrapped.wdType, @"XCUIElementTypeButton", @"%@", query);
      [foundLabels addObject:wrapped.wdLabel ?: @""];
    }
    XCTAssertEqual(foundLabels.count, expectedLabels.count, @"%@", query);
    XCTAssertEqualObjects([NSSet setWithArray:foundLabels], [NSSet setWithArray:expectedLabels], @"%@", query);
  }
}

- (void)testInvalidXPathQueriesThrowInvalidXPathException
{
  NSArray<NSString *> *queries = @[
    @"//XCUIElementTypeButton[matches(@label)]",
    @"//*[blabla(@label, Scrolling')]",
  ];
  for (NSString *query in queries) {
    XCTAssertThrowsSpecificNamed([FBXPath matchesWithRootElement:(id)self.window forQuery:query],
                                 NSException, FBInvalidXPathException, @"%@", query);
  }
}

- (void)testInvalidXPathExtensionRegexpThrowsWithDetails
{
  NSException *exception = nil;
  @try {
    [FBXPath matchesWithRootElement:(id)self.window forQuery:@"//XCUIElementTypeButton[matches(@label, '[')]"];
  } @catch (NSException *caughtException) {
    exception = caughtException;
  }
  XCTAssertEqualObjects(exception.name, FBInvalidXPathException);
  XCTAssertTrue([exception.reason containsString:@"Cannot evaluate results for XPath expression"]);
  XCTAssertTrue([exception.reason rangeOfString:@"invalid" options:NSCaseInsensitiveSearch].location != NSNotFound);
}

@end
