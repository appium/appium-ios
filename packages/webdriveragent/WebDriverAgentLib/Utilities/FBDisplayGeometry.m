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
#import "FBLogger.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIDevice+FBHinge.h"
#import "FBScreen.h"
#import "XCUIScreen.h"
#import "FBMathUtils.h"
#import "FBXCAccessibilityElement.h"
#import "FBXCAXClientProxy.h"
#import "FBXCElementSnapshotWrapper+Helpers.h"
#import "XCUIApplication.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIElement.h"
#import "XCUIElement+FBWebDriverAttributes.h"

@protocol FBAXUIElementRef <NSObject>
@property (nonatomic, readonly) struct __AXUIElement *axElement;
@end

@protocol FBAXDisplayElement <NSObject>
+ (instancetype)elementWithAXUIElement:(const struct __AXUIElement *)element;
@property (nonatomic, readonly) NSArray<id<FBAXDisplayElement>> *accessibleDescendants;
@property (nonatomic, readonly) BOOL isVisible;
@property (nonatomic, readonly) unsigned int windowDisplayId;
@property (nonatomic, readonly) NSString *axIdentifier;
@property (nonatomic, readonly) NSString *label;
@property (nonatomic, readonly) id<FBAXUIElementRef> uiElement;
@end

static BOOL FBIsSystemApplicationSnapshot(id<FBXCElementSnapshot> snapshot)
{
  return snapshot.accessibilityElement.processIdentifier == FBXCAXClientProxy.sharedClient.systemApplication.processIdentifier;
}

static BOOL FBDeviceHasHinge(void)
{
  static BOOL hasHinge;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    hasHinge = XCUIDevice.sharedDevice.fb_supportsHingeAngleReading;
  });
  return hasHinge;
}

static NSNumber *FBGeometryDisplayID(void)
{
  NSNumber *selected = FBConfiguration.sharedInstance.currentDisplayId;
  return selected ?: (FBDeviceHasHinge() ? @([FBScreen displayID]) : nil);
}

static BOOL FBCanMatchDisplayElement(id<FBXCElementSnapshot> snapshot)
{
  // Some Control Center buttons (e.g. Screen Mirroring) only expose a label.
  return snapshot.identifier.length > 0
    || (snapshot.elementType == XCUIElementTypeButton && snapshot.label.length > 0);
}

static BOOL FBHasOtherDisplay(id<FBXCElementSnapshot> snapshot, NSNumber *display)
{
  return [snapshot respondsToSelector:@selector(displayID)]
    && snapshot.displayID != 0 && snapshot.displayID != display.longLongValue;
}

static id<FBAXDisplayElement> FBAXElementForSnapshot(id<FBXCElementSnapshot> snapshot)
{
  Class<FBAXDisplayElement> axClass = NSClassFromString(@"AXElement");
  if (![axClass respondsToSelector:@selector(elementWithAXUIElement:)]
      || ![snapshot.accessibilityElement respondsToSelector:@selector(AXUIElement)]) {
    return nil;
  }
  const struct __AXUIElement *ref = snapshot.accessibilityElement.AXUIElement;
  return ref == NULL ? nil : [axClass elementWithAXUIElement:ref];
}

// XCTest may attach a Control Center module from the cover to the inner window.
// Read that window's accessibility hierarchy before serializing any other windows.
static NSArray<id<FBAXDisplayElement>> *FBWindowAccessibilityElements(id<FBXCElementSnapshot> window)
{
  id<FBAXDisplayElement> axWindow = FBAXElementForSnapshot(window);
  if (![axWindow respondsToSelector:@selector(accessibleDescendants)]) {
    [FBLogger verboseLog:@"Display geometry: missing AX window or accessibleDescendants selector"];
    return @[];
  }
  return axWindow.accessibleDescendants;
}

static id<FBAXDisplayElement> FBUniqueDisplayElement(id<FBXCElementSnapshot> original,
                                                     NSArray<id<FBAXDisplayElement>> *elements,
                                                     long long displayID)
{
  id<FBAXDisplayElement> match = nil;
  NSString *reason = @"no identifier and label match";
  for (id<FBAXDisplayElement> candidate in elements) {
    if (![candidate respondsToSelector:@selector(axIdentifier)]) {
      reason = @"candidate has no axIdentifier selector";
      continue;
    }
    if (![(candidate.axIdentifier ?: @"") isEqualToString:(original.identifier ?: @"")]) {
      continue;
    }
    if (![candidate respondsToSelector:@selector(windowDisplayId)] || ![candidate respondsToSelector:@selector(label)]) {
      reason = @"candidate has no windowDisplayId or label selector";
      continue;
    }
    if (candidate.windowDisplayId == displayID && [candidate.label isEqualToString:original.label]) {
      if (match != nil) {
        [FBLogger verboseLogFmt:@"Display geometry: multiple matches for '%@' on display %lld", original.identifier, displayID];
        return nil;
      }
      match = candidate;
    }
  }
  if (match == nil) {
    [FBLogger verboseLogFmt:@"Display geometry: cannot resolve '%@' on display %lld (%@)", original.identifier, displayID, reason];
  }
  return match;
}

static id<FBXCElementSnapshot> FBMatchingDisplaySnapshot(id<FBXCElementSnapshot> original,
                                                         NSArray<id<FBAXDisplayElement>> *elements,
                                                         long long displayID)
{
  id<FBAXDisplayElement> match = FBUniqueDisplayElement(original, elements, displayID);
  if (match == nil) {
    return nil;
  }
  Class<FBXCAccessibilityElement> xcClass = NSClassFromString(@"XCAccessibilityElement");
  if (![match respondsToSelector:@selector(uiElement)] || ![match.uiElement respondsToSelector:@selector(axElement)]
      || ![xcClass respondsToSelector:@selector(elementWithAXUIElement:)]) {
    [FBLogger verboseLogFmt:@"Display geometry: AX bridge unavailable for '%@' on display %lld (uiElement, axElement or elementWithAXUIElement:)", original.identifier, displayID];
    return nil;
  }
  struct __AXUIElement *ref = match.uiElement.axElement;
  if (ref == NULL) {
    [FBLogger verboseLogFmt:@"Display geometry: missing AX element reference for '%@' on display %lld", original.identifier, displayID];
    return nil;
  }
  id<FBXCAccessibilityElement> ax = [xcClass elementWithAXUIElement:ref];
  id<FBXCElementSnapshot> live = [FBXCAXClientProxy.sharedClient snapshotForElement:ax attributes:nil inDepth:NO error:nil];
  if (live.displayID != displayID || live.elementType != original.elementType
      || ![(live.identifier ?: @"") isEqualToString:(original.identifier ?: @"")]
      || (original.identifier.length == 0 && ![live.label isEqualToString:original.label]) || CGRectIsEmpty(live.frame)) {
    [FBLogger verboseLogFmt:@"Display geometry: missing or mismatched live snapshot or empty frame for '%@' on display %lld", original.identifier, displayID];
    return nil;
  }
  return live;
}

// The accessible control is a descendant of the module icon. The latter is
// absent from accessibleDescendants, but its own frame is available on the live AX parent chain.
static void FBResolveModuleIcon(id<FBXCElementSnapshot> original, id<FBXCElementSnapshot> live, FBDisplaySnapshotMap *matches)
{
  id<FBXCElementSnapshot> icon = [[FBXCElementSnapshotWrapper ensureWrapped:original] fb_parentMatchingType:XCUIElementTypeIcon];
  if (icon.identifier.length == 0 || icon.displayID != original.displayID || [matches objectForKey:icon] != nil) {
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
        [matches setObject:counterpart forKey:icon];
      }
      return;
    }
    ax = attrs[parentKey];
  }
}

// A scoped XPath snapshot can be detached from its containing window. Use the
// application tree only to recover window identity; keep the original XPath scope.
static id<FBXCElementSnapshot> FBWindowForScope(id<FBXCElementSnapshot> scope)
{
  if (scope.elementType == XCUIElementTypeWindow) {
    return scope;
  }
  id<FBXCElementSnapshot> window = [[FBXCElementSnapshotWrapper ensureWrapped:scope] fb_parentMatchingType:XCUIElementTypeWindow];
  if (window != nil) {
    return window;
  }
  id<FBXCElementSnapshot> app = [XCUIApplication.fb_systemApplication fb_standardSnapshot];
  id<FBXCElementSnapshot> member = [app elementSnapshotMatchingAccessibilityElement:scope.accessibilityElement];
  return [[FBXCElementSnapshotWrapper ensureWrapped:member] fb_parentMatchingType:XCUIElementTypeWindow];
}

// Keep the oriented frame on a per-lookup wrapper. XCTest owns the original
// snapshot, which can outlive both a source traversal and an orientation.
@interface FBOrientedSnapshot : FBXCElementSnapshotWrapper
@property (nonatomic) CGRect wdFrame;
@end

@implementation FBOrientedSnapshot
@synthesize wdFrame = _wdFrame;
@end

// Keep source visibility scoped to a single traversal. A live XCTest visibility
// query (even for just the overlay window) can dismiss Control Center.
@interface FBControlCenterSourceSnapshot : FBOrientedSnapshot
@property (nonatomic, getter=isWDVisible) BOOL wdVisible;
@end

@implementation FBControlCenterSourceSnapshot
@synthesize wdVisible = _wdVisible;
@end

static void FBCollectSourceVisibility(id<FBXCElementSnapshot> node, long long displayID,
                                      FBDisplaySnapshotMap *matches)
{
  FBXCElementSnapshotWrapper *geometry = [FBXCElementSnapshotWrapper ensureWrapped:[matches objectForKey:node] ?: node];
  FBControlCenterSourceSnapshot *result = [[FBControlCenterSourceSnapshot alloc] initWithSnapshot:geometry.snapshot];
  result.wdFrame = geometry.wdFrame;
  NSNumber *cached = geometry.snapshot.additionalAttributes[FB_XCAXAIsVisibleAttribute];
  BOOL onDisplay = node.elementType == XCUIElementTypeApplication || geometry.displayID == displayID;
  result.wdVisible = onDisplay && (cached != nil ? cached.boolValue : !CGRectIsEmpty(geometry.snapshot.visibleFrame));
  [matches setObject:result forKey:node];
  for (id<FBXCElementSnapshot> child in node.children) {
    FBCollectSourceVisibility(child, displayID, matches);
  }
}

static UIInterfaceOrientation FBGeometryOrientation(void)
{
  return FBDeviceHasHinge()
    ? XCUIApplication.fb_systemApplication.interfaceOrientation : UIInterfaceOrientationUnknown;
}

static CGSize FBPortraitWindowSize(id<FBXCElementSnapshot> window, long long displayID)
{
  if (![window respondsToSelector:@selector(displayID)] || window.displayID != displayID) {
    return CGSizeZero;
  }
  XCUIScreen *screen = [FBScreen currentScreenWithError:nil];
  if (screen == nil || screen.displayID != displayID || screen.scale <= 0) {
    return CGSizeZero;
  }
  CGSize size = CGSizeMake(screen.bounds.size.width / screen.scale, screen.bounds.size.height / screen.scale);
  // In landscape a full portrait-sized window identifies XCTest's unrotated
  // coordinate space. Pixel-sized and already oriented windows use other spaces.
  CGRect frame = window.frame;
  return size.height > size.width && CGRectEqualToRect(frame, (CGRect){CGPointZero, size}) ? size : CGSizeZero;
}

static id<FBXCElementSnapshot> FBOrientedSnapshotForDisplay(id<FBXCElementSnapshot> snapshot, long long displayID,
                                                             CGSize size, UIInterfaceOrientation orientation)
{
  if (CGSizeEqualToSize(size, CGSizeZero) || ![snapshot respondsToSelector:@selector(displayID)]
      || snapshot.displayID != displayID || CGRectIsEmpty(snapshot.frame) || CGRectIsInfinite(snapshot.frame)) {
    return snapshot;
  }
  FBOrientedSnapshot *result = [[FBOrientedSnapshot alloc] initWithSnapshot:snapshot];
  result.wdFrame = CGRectIntegral(FBRectFromPortraitCoordinates(snapshot.frame, size, orientation));
  return result;
}

static NSDictionary<NSString *, NSArray<id<FBAXDisplayElement>> *> *FBAccessibilityElementsByIdentifier(id<FBXCElementSnapshot> window)
{
  NSMutableDictionary<NSString *, NSMutableArray<id<FBAXDisplayElement>> *> *index = [NSMutableDictionary dictionary];
  for (id<FBAXDisplayElement> element in FBWindowAccessibilityElements(window)) {
    if (![element respondsToSelector:@selector(axIdentifier)]) {
      [FBLogger verboseLog:@"Display geometry: skipping AX descendant without axIdentifier while indexing the window"];
      continue;
    }
    NSString *identifier = element.axIdentifier ?: @"";
    NSMutableArray<id<FBAXDisplayElement>> *candidates = index[identifier];
    if (candidates == nil) {
      candidates = [NSMutableArray array];
      index[identifier] = candidates;
    }
    [candidates addObject:element];
  }
  return index;
}

static BOOL FBIsControlCenterFolder(id<FBXCElementSnapshot> node)
{
  return [node.identifier isEqualToString:@"cc-root-folder-view"];
}

static void FBCollectDisplaySnapshots(id<FBXCElementSnapshot> scope, NSNumber *display, FBDisplaySnapshotMap *matches,
                                      UIInterfaceOrientation orientation)
{
  NSDictionary<NSString *, NSArray<id<FBAXDisplayElement>> *> *byIdentifier = nil;
  NSArray *nodes = scope._allDescendants;
  if (scope.elementType != XCUIElementTypeWindow) {
    nodes = [@[scope] arrayByAddingObjectsFromArray:nodes ?: @[]];
  }
  for (id<FBXCElementSnapshot> node in nodes) {
    if (!FBHasOtherDisplay(node, display) || !FBCanMatchDisplayElement(node)) {
      continue;
    }
    if (byIdentifier == nil) {
      id<FBXCElementSnapshot> window = FBWindowForScope(scope);
      if (![window respondsToSelector:@selector(displayID)] || window.displayID != display.longLongValue) {
        return;
      }
      byIdentifier = FBAccessibilityElementsByIdentifier(window);
    }
    id<FBXCElementSnapshot> live = FBMatchingDisplaySnapshot(node, byIdentifier[node.identifier ?: @""], display.longLongValue);
    if (live != nil) {
      [matches setObject:live forKey:node];
      FBResolveModuleIcon(node, live, matches);
    }
  }
  if (UIInterfaceOrientationIsLandscape(orientation)) {
    CGSize size = FBPortraitWindowSize(FBWindowForScope(scope), display.longLongValue);
    if (!CGSizeEqualToSize(size, CGSizeZero)) {
      if (scope.elementType == XCUIElementTypeWindow) {
        [matches setObject:FBOrientedSnapshotForDisplay(scope, display.longLongValue, size, orientation) forKey:scope];
      }
      for (id<FBXCElementSnapshot> node in nodes) {
        id<FBXCElementSnapshot> geometry = [matches objectForKey:node] ?: node;
        id<FBXCElementSnapshot> oriented = FBOrientedSnapshotForDisplay(geometry, display.longLongValue, size, orientation);
        if (oriented != geometry) {
          [matches setObject:oriented forKey:node];
        }
      }
    }
  }
}

// The same AX identity can occur below both panels. An application-wide
// identity lookup can return the cover copy even for an inner-display query.
static id<FBXCElementSnapshot> FBMemberOnDisplay(id<FBXCElementSnapshot> tree,
                                                 id<FBXCElementSnapshot> snapshot, long long displayID,
                                                 id<FBXCElementSnapshot> *matchingWindow)
{
  *matchingWindow = nil;
  id<FBXCElementSnapshot> member = [tree elementSnapshotMatchingAccessibilityElement:snapshot.accessibilityElement];
  id<FBXCElementSnapshot> parentWindow = [[FBXCElementSnapshotWrapper ensureWrapped:member] fb_parentMatchingType:XCUIElementTypeWindow];
  if ([parentWindow respondsToSelector:@selector(displayID)] && parentWindow.displayID == displayID) {
    *matchingWindow = parentWindow;
    return member;
  }
  id<FBXCElementSnapshot> result = nil;
  id<FBXCElementSnapshot> resultWindow = nil;
  for (id<FBXCElementSnapshot> window in tree.children) {
    if (window.elementType != XCUIElementTypeWindow || ![window respondsToSelector:@selector(displayID)]
        || window.displayID != displayID) {
      continue;
    }
    member = [window elementSnapshotMatchingAccessibilityElement:snapshot.accessibilityElement];
    if (member == nil) {
      continue;
    }
    if (result != nil) {
      return nil;
    }
    result = member;
    resultWindow = window;
  }
  if (result != nil || snapshot.label.length == 0) {
    *matchingWindow = resultWindow;
    return result;
  }
  // The other panel can also vend a distinct AX identity for the same control.
  // Accept only a unique type/identifier/label match across the target windows.
  for (id<FBXCElementSnapshot> window in tree.children) {
    if (window.elementType != XCUIElementTypeWindow || ![window respondsToSelector:@selector(displayID)]
        || window.displayID != displayID) {
      continue;
    }
    for (id<FBXCElementSnapshot> candidate in window._allDescendants) {
      if (candidate.elementType != snapshot.elementType || ![candidate.label isEqualToString:snapshot.label]
          || ![(candidate.identifier ?: @"") isEqualToString:(snapshot.identifier ?: @"")]) {
        continue;
      }
      if (result != nil) {
        return nil;
      }
      result = candidate;
      resultWindow = window;
    }
  }
  *matchingWindow = resultWindow;
  return result;
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

NSNumber *FBSpringBoardDisplayVisibility(id<FBXCElementSnapshot> snapshot)
{
#if TARGET_OS_SIMULATOR && !TARGET_OS_TV && !TARGET_OS_WATCH
  if (FBDeviceHasHinge() && FBIsSystemApplicationSnapshot(snapshot)) {
    // XCTest's live isVisible attribute query can dismiss Control Center.
    id<FBAXDisplayElement> ax = FBAXElementForSnapshot(snapshot);
    if ([ax respondsToSelector:@selector(isVisible)]) {
      return @(ax.isVisible);
    }
  }
#endif
  return nil;
}

id<FBXCElementSnapshot> FBSnapshotForDisplayGeometry(XCUIElement *element, BOOL useCustomSnapshot)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBGeometryDisplayID();
#endif
  id<FBXCElementSnapshot> snapshot = useCustomSnapshot ? [element fb_customSnapshot] : [element fb_standardSnapshot];
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  if (display != nil && snapshot.elementType != XCUIElementTypeApplication && FBIsSystemApplicationSnapshot(snapshot)) {
    UIInterfaceOrientation orientation = FBGeometryOrientation();
    id<FBXCElementSnapshot> window = nil;
    BOOL resolveFromWindow = FBHasOtherDisplay(snapshot, display);
#if !TARGET_OS_SIMULATOR
    // On hardware even a control reporting the selected display can have a
    // different frame in the identity-bound query and in the application tree.
    resolveFromWindow |= FBDeviceHasHinge() && (snapshot.elementType == XCUIElementTypeButton
        || snapshot.elementType == XCUIElementTypeSwitch || snapshot.elementType == XCUIElementTypeIcon);
#endif
    if (resolveFromWindow && FBCanMatchDisplayElement(snapshot)) {
      // A query snapshot and a page-source snapshot may use different coordinate
      // spaces for the same AX identity, even in portrait. Resolve the member
      // and its geometry together in the window used by page source.
      id<FBXCElementSnapshot> tree = [element.application fb_standardSnapshot];
      id<FBXCElementSnapshot> member = FBMemberOnDisplay(tree, snapshot, display.longLongValue, &window);
      if (member != nil && window != nil) {
        [FBLogger verboseLogFmt:@"Display geometry: '%@' on display %@, query frame %@, window member frame %@",
         snapshot.identifier.length > 0 ? snapshot.identifier : snapshot.label, display,
         NSStringFromCGRect(snapshot.frame), NSStringFromCGRect(member.frame)];
        if (member.displayID == display.longLongValue && member.elementType != XCUIElementTypeIcon
            && !UIInterfaceOrientationIsLandscape(orientation)) {
          return member;
        }
        FBDisplaySnapshotMap *matches = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality
                                                              valueOptions:NSPointerFunctionsStrongMemory];
        FBCollectDisplaySnapshots(window, display, matches, orientation);
        return [matches objectForKey:member] ?: member;
      }
      [FBLogger verboseLogFmt:@"Display geometry: no source member for '%@' on display %@",
       snapshot.identifier ?: snapshot.label, display];
    }
    if (UIInterfaceOrientationIsLandscape(orientation)) {
      window = window ?: FBWindowForScope(snapshot);
      if (![window respondsToSelector:@selector(displayID)] || window.displayID != display.longLongValue) {
        // Direct AX snapshots can be detached or point back into the cover tree.
        id<FBXCElementSnapshot> tree = [element.application fb_standardSnapshot];
        FBMemberOnDisplay(tree, snapshot, display.longLongValue, &window);
      }
      CGSize size = FBPortraitWindowSize(window, display.longLongValue);
      return FBOrientedSnapshotForDisplay(snapshot, display.longLongValue, size, orientation);
    }
  }
#endif
  return snapshot;
}

FBDisplaySnapshotMap *FBDisplaySnapshotsForTree(id<FBXCElementSnapshot> root, BOOL includeVisibility)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBGeometryDisplayID();
  if (display == nil || !FBIsSystemApplicationSnapshot(root)) {
    return nil;
  }
  if ([(NSObject *)root isKindOfClass:FBXCElementSnapshotWrapper.class]) {
    root = ((FBXCElementSnapshotWrapper *)root).snapshot;
  }
  // The caller owns this map for one traversal. XCTest can reuse the underlying snapshots.
  FBDisplaySnapshotMap *matches = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality
                                                        valueOptions:NSPointerFunctionsStrongMemory];
  UIInterfaceOrientation orientation = FBGeometryOrientation();
  if (root.elementType == XCUIElementTypeApplication) {
    for (id<FBXCElementSnapshot> window in root.children) {
      if (window.elementType == XCUIElementTypeWindow && [window respondsToSelector:@selector(displayID)]
          && window.displayID == display.longLongValue) {
        FBCollectDisplaySnapshots(window, display, matches, orientation);
      }
    }
  } else {
    FBCollectDisplaySnapshots(root, display, matches, orientation);
  }
  if (includeVisibility && FBDeviceHasHinge() && root.elementType == XCUIElementTypeApplication) {
    for (id<FBXCElementSnapshot> window in root.children) {
      if (window.elementType == XCUIElementTypeWindow && window.displayID == display.longLongValue
          && [window hasDescendantMatchingFilter:^BOOL(id<FBXCElementSnapshot> node) {
            return FBIsControlCenterFolder(node) && !CGRectIsEmpty(node.frame);
          }]) {
        FBCollectSourceVisibility(root, display.longLongValue, matches);
        break;
      }
    }
  }
  return matches;
#else
  return nil;
#endif
}

CGRect FBFrameForDisplayGeometry(id<FBXCElementSnapshot> snapshot)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  if (snapshot.elementType != XCUIElementTypeApplication || FBGeometryDisplayID() == nil
      || !FBIsSystemApplicationSnapshot(snapshot)) {
    return snapshot.frame;
  }
  if (![FBScreen hasMultipleScreensWithError:nil].boolValue) {
    return snapshot.frame;
  }
  // Use the same default as /window/rect when no display is selected.
  XCUIScreen *screen = [FBScreen currentScreenWithError:nil];
  if (screen == nil) {
    return snapshot.frame;
  }
  XCUIApplication *application = XCUIApplication.fb_systemApplication;
  CGRect frame = FBWindowFrameInSnapshot(snapshot, screen.displayID);
  if (CGRectIsNull(frame)) {
    FBWindowOnDisplay(application, screen.displayID, &frame);
  }
  if (!CGRectIsEmpty(frame)) {
    // Use the oriented window dimensions reported by /window/rect.
    frame.size = FBAdjustDimensionsForApplication(frame.size, application.interfaceOrientation);
    return frame;
  }
#endif
  return snapshot.frame;
}
