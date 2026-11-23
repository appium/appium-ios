/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "FBDisplayGeometry.h"

#import "FBConfiguration.h"
#import "XCUIElement+FBUtilities.h"

#if !TARGET_OS_TV && !TARGET_OS_WATCH
#import <objc/runtime.h>
#import "FBGestureCoordinateContext.h"
#import "FBMathUtils.h"
#import "FBXCAccessibilityElement.h"
#import "FBXCAXClientProxy.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement.h"
#import "XCUIElementQuery.h"

@protocol FBAXUIElementRef <NSObject>
@property (nonatomic, readonly) struct __AXUIElement *axElement;
@end

@protocol FBAXDisplayElement <NSObject>
+ (instancetype)elementWithAXUIElement:(const struct __AXUIElement *)element;
@property (nonatomic, readonly) NSArray<id<FBAXDisplayElement>> *accessibleDescendants;
@property (nonatomic, readonly) unsigned int windowDisplayId;
@property (nonatomic, readonly) NSString *axIdentifier;
@property (nonatomic, readonly) NSString *label;
@property (nonatomic, readonly) id<FBAXUIElementRef> uiElement;
@end

static char FBSelectedWindowFrameKey;

static BOOL FBIsSystemApplicationSnapshot(id<FBXCElementSnapshot> snapshot)
{
  return snapshot.accessibilityElement.processIdentifier == FBXCAXClientProxy.sharedClient.systemApplication.processIdentifier;
}

static BOOL FBHasOtherDisplay(id<FBXCElementSnapshot> snapshot, NSNumber *display)
{
  return [snapshot respondsToSelector:@selector(displayID)]
    && snapshot.displayID != 0 && snapshot.displayID != display.longLongValue;
}

// XCTest may attach a Control Center module from the cover to the inner window.
// Read that window's accessibility hierarchy before serializing any other windows.
static NSArray<id<FBAXDisplayElement>> *FBWindowAccessibilityElements(id<FBXCElementSnapshot> window)
{
  Class<FBAXDisplayElement> axClass = NSClassFromString(@"AXElement");
  if (![axClass respondsToSelector:@selector(elementWithAXUIElement:)]
      || ![window.accessibilityElement respondsToSelector:@selector(AXUIElement)]) {
    return @[];
  }
  const struct __AXUIElement *ref = window.accessibilityElement.AXUIElement;
  id<FBAXDisplayElement> axWindow = ref == NULL ? nil : [axClass elementWithAXUIElement:ref];
  return [axWindow respondsToSelector:@selector(accessibleDescendants)] ? axWindow.accessibleDescendants : @[];
}

static id<FBAXDisplayElement> FBUniqueDisplayElement(id<FBXCElementSnapshot> original,
                                                     NSArray<id<FBAXDisplayElement>> *elements,
                                                     long long displayID)
{
  id<FBAXDisplayElement> match = nil;
  for (id<FBAXDisplayElement> candidate in elements) {
    if ([candidate respondsToSelector:@selector(axIdentifier)] && [candidate.axIdentifier isEqualToString:original.identifier]
        && [candidate respondsToSelector:@selector(windowDisplayId)] && candidate.windowDisplayId == displayID
        && [candidate respondsToSelector:@selector(label)] && [candidate.label isEqualToString:original.label]) {
      if (match != nil) {
        return nil;
      }
      match = candidate;
    }
  }
  return match;
}

static id<FBXCElementSnapshot> FBMatchingDisplaySnapshot(id<FBXCElementSnapshot> original,
                                                         NSArray<id<FBAXDisplayElement>> *elements,
                                                         long long displayID)
{
  id<FBAXDisplayElement> match = FBUniqueDisplayElement(original, elements, displayID);
  Class<FBXCAccessibilityElement> xcClass = NSClassFromString(@"XCAccessibilityElement");
  if (![match respondsToSelector:@selector(uiElement)] || ![match.uiElement respondsToSelector:@selector(axElement)]
      || ![xcClass respondsToSelector:@selector(elementWithAXUIElement:)]) {
    return nil;
  }
  struct __AXUIElement *ref = match.uiElement.axElement;
  if (ref == NULL) {
    return nil;
  }
  id<FBXCAccessibilityElement> ax = [xcClass elementWithAXUIElement:ref];
  id<FBXCElementSnapshot> live = [FBXCAXClientProxy.sharedClient snapshotForElement:ax attributes:nil inDepth:NO error:nil];
  if (live.displayID != displayID || live.elementType != original.elementType
      || ![live.identifier isEqualToString:original.identifier] || CGRectIsEmpty(live.frame)) {
    return nil;
  }
  return live;
}

static void FBStoreDisplayFrame(id<FBXCElementSnapshot> node, CGRect frame)
{
  objc_setAssociatedObject(node, &FBSelectedWindowFrameKey, [NSValue valueWithCGRect:frame],
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

// The accessible control is a descendant of the module icon. The latter is
// absent from accessibleDescendants, but its own frame is available on the live AX parent chain.
static void FBResolveModuleIcon(id<FBXCElementSnapshot> original, id<FBXCElementSnapshot> live)
{
  id<FBXCElementSnapshot> icon = [[FBXCElementSnapshotWrapper ensureWrapped:original] fb_parentMatchingType:XCUIElementTypeIcon];
  if (icon.identifier.length == 0 || icon.displayID != original.displayID) {
    return;
  }
  NSString *parentKey = @"XC_kAXXCAttributeParent";
  NSString *identifierKey = @"XC_kAXXCAttributeIdentifier";
  NSString *displayKey = @"XC_kAXXCAttributeWindowDisplayId";
  id<FBXCAccessibilityElement> ax = live.accessibilityElement;
  NSMutableSet *visited = [NSMutableSet set];
  while (ax != nil && ![visited containsObject:ax]) {
    [visited addObject:ax];
    NSDictionary *attrs = [FBXCAXClientProxy.sharedClient attributesForElement:ax
                                attributes:@[parentKey, identifierKey, displayKey] error:nil];
    if ([attrs[displayKey] longLongValue] != live.displayID) {
      return;
    }
    if ([attrs[identifierKey] isEqual:icon.identifier]) {
      id<FBXCElementSnapshot> counterpart = [FBXCAXClientProxy.sharedClient snapshotForElement:ax attributes:nil inDepth:NO error:nil];
      if (counterpart.elementType == icon.elementType && counterpart.displayID == live.displayID
          && [counterpart.label isEqual:icon.label] && !CGRectIsEmpty(counterpart.frame)) {
        FBStoreDisplayFrame(icon, counterpart.frame);
      }
      return;
    }
    ax = attrs[parentKey];
  }
}

static id<FBXCElementSnapshot> FBResolveCrossDisplaySnapshot(XCUIElement *element,
                                                             id<FBXCElementSnapshot> snapshot,
                                                             id<FBXCElementSnapshot> previousRoot,
                                                             id<FBXCElementSnapshot> currentRoot,
                                                             long long displayID)
{
  // Identity-bound queries resolve against a fresh application snapshot.
  // Only reuse the tree if this lookup replaced it and it contains our element.
  id<FBXCElementSnapshot> tree = currentRoot;
  id<FBXCElementSnapshot> member = nil;
  if (tree != previousRoot && tree.elementType == XCUIElementTypeApplication) {
    member = [tree elementSnapshotMatchingAccessibilityElement:snapshot.accessibilityElement];
  }
  if (member == nil) {
    tree = [element.application fb_standardSnapshot];
    member = [tree elementSnapshotMatchingAccessibilityElement:snapshot.accessibilityElement];
  }
  if (member.elementType == XCUIElementTypeIcon) {
    // An icon's frame is recovered through its accessible child.
    FBPrepareDisplayFrames(tree);
    return member;
  }
  id<FBXCElementSnapshot> window = [[FBXCElementSnapshotWrapper ensureWrapped:member] fb_parentMatchingType:XCUIElementTypeWindow];
  if ([window respondsToSelector:@selector(displayID)] && window.displayID == displayID) {
    id<FBXCElementSnapshot> live = FBMatchingDisplaySnapshot(snapshot, FBWindowAccessibilityElements(window),
                                                             displayID);
    if (live != nil) {
      FBStoreDisplayFrame(snapshot, live.frame);
    }
  }
  return snapshot;
}

static CGRect FBWindowFrameInSnapshot(id<FBXCElementSnapshot> root, long long displayID)
{
  for (id<FBXCElementSnapshot> window in root.children) {
    if (window.elementType != XCUIElementTypeWindow) {
      continue;
    }
    if (![window respondsToSelector:@selector(displayID)] || window.displayID == 0) {
      // Resolve the live windows if an earlier window's display is unknown.
      break;
    }
    if (window.displayID == displayID && !CGRectIsEmpty(window.frame)) {
      return CGRectIntegral(window.frame);
    }
  }
  return CGRectNull;
}
#endif

id<FBXCElementSnapshot> FBSnapshotForDisplayGeometry(XCUIElement *element, BOOL useCustomSnapshot)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBConfiguration.sharedInstance.currentDisplayId;
  XCUIElementQuery *query = display != nil && ![element isKindOfClass:XCUIApplication.class] ? element.query : nil;
  id<FBXCElementSnapshot> previousRoot = query.rootElementSnapshot;
#endif
  id<FBXCElementSnapshot> snapshot = useCustomSnapshot ? [element fb_customSnapshot] : [element fb_standardSnapshot];
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  if (display != nil && snapshot.identifier.length > 0 && FBHasOtherDisplay(snapshot, display)
      && FBIsSystemApplicationSnapshot(snapshot)) {
    return FBResolveCrossDisplaySnapshot(element, snapshot, previousRoot, query.rootElementSnapshot, display.longLongValue);
  }
#endif
  return snapshot;
}

void FBPrepareDisplayFrames(id<FBXCElementSnapshot> root)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBConfiguration.sharedInstance.currentDisplayId;
  if (display == nil || root.elementType != XCUIElementTypeApplication
      || !FBIsSystemApplicationSnapshot(root)) {
    return;
  }
  for (id<FBXCElementSnapshot> window in root.children) {
    if (window.elementType != XCUIElementTypeWindow || ![window respondsToSelector:@selector(displayID)]
        || window.displayID != display.longLongValue) {
      continue;
    }
    NSArray<id<FBAXDisplayElement>> *elements = nil;
    for (id<FBXCElementSnapshot> node in window._allDescendants) {
      if (node.identifier.length == 0 || !FBHasOtherDisplay(node, display)) {
        continue;
      }
      elements = elements ?: FBWindowAccessibilityElements(window);
      id<FBXCElementSnapshot> live = FBMatchingDisplaySnapshot(node, elements, display.longLongValue);
      if (live != nil) {
        FBStoreDisplayFrame(node, live.frame);
        FBResolveModuleIcon(node, live);
      }
    }
  }
#endif
}

CGRect FBFrameForDisplayGeometry(id<FBXCElementSnapshot> snapshot)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBConfiguration.sharedInstance.currentDisplayId;
  if (display == nil) {
    return snapshot.frame;
  }
  NSValue *resolved = objc_getAssociatedObject(snapshot, &FBSelectedWindowFrameKey);
  if (resolved != nil) {
    return resolved.CGRectValue;
  }
  if (snapshot.elementType != XCUIElementTypeApplication || !FBIsSystemApplicationSnapshot(snapshot)) {
    return snapshot.frame;
  }
  FBGestureCoordinateContext *context = [FBGestureCoordinateContext contextWithDisplayRequired:YES error:nil];
  if (!context.usesWindowCoordinates) {
    return snapshot.frame;
  }

  XCUIApplication *application = XCUIApplication.fb_systemApplication;
  CGRect frame = FBWindowFrameInSnapshot(snapshot, display.longLongValue);
  if (CGRectIsNull(frame)) {
    frame = [context windowFrameForApplication:application error:nil];
  }
  if (!CGRectIsEmpty(frame)) {
    // Use the oriented window dimensions reported by /window/rect.
    frame.size = FBAdjustDimensionsForApplication(frame.size, application.interfaceOrientation);
    FBStoreDisplayFrame(snapshot, frame);
    return frame;
  }
#endif
  return snapshot.frame;
}
