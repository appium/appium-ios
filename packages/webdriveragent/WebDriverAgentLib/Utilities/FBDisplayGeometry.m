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
#import "FBControlCenterVisibility.h"
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

static NSNumber *FBGeometryDisplayID(void)
{
  NSNumber *selected = FBConfiguration.sharedInstance.currentDisplayId;
  return selected ?: (XCUIDevice.sharedDevice.fb_supportsHingeAngleReading ? @([FBScreen displayID]) : nil);
}

static BOOL FBCanMatchDisplayElement(id<FBXCElementSnapshot> snapshot)
{
  // Some Control Center buttons (e.g. Screen Mirroring) only expose a label.
  return snapshot.identifier.length > 0
    || (snapshot.elementType == XCUIElementTypeButton && snapshot.label.length > 0);
}

static BOOL FBIsOnDisplay(id<FBXCElementSnapshot> snapshot, long long displayID)
{
  return [snapshot respondsToSelector:@selector(displayID)] && snapshot.displayID == displayID;
}

static BOOL FBHasOtherDisplay(id<FBXCElementSnapshot> snapshot, long long displayID)
{
  return [snapshot respondsToSelector:@selector(displayID)]
    && snapshot.displayID != 0 && snapshot.displayID != displayID;
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
  // The window index has already matched these candidates by identifier.
  for (id<FBAXDisplayElement> candidate in elements) {
    if (![candidate respondsToSelector:@selector(windowDisplayId)] || ![candidate respondsToSelector:@selector(label)]) {
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
    [FBLogger verboseLogFmt:@"Display geometry: cannot resolve '%@' on display %lld", original.identifier, displayID];
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

static id<FBXCElementSnapshot> FBContainingWindow(id<FBXCElementSnapshot> scope)
{
  return scope.elementType == XCUIElementTypeWindow
    ? scope : [[FBXCElementSnapshotWrapper ensureWrapped:scope] fb_parentMatchingType:XCUIElementTypeWindow];
}

// A scoped XPath snapshot can be detached from its containing window. Use the
// application tree only to recover window identity; keep the original XPath scope.
static id<FBXCElementSnapshot> FBWindowForScope(id<FBXCElementSnapshot> scope)
{
  id<FBXCElementSnapshot> window = FBContainingWindow(scope);
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

static UIInterfaceOrientation FBGeometryOrientation(void)
{
  return XCUIDevice.sharedDevice.fb_supportsHingeAngleReading
    ? XCUIApplication.fb_systemApplication.interfaceOrientation : UIInterfaceOrientationUnknown;
}

static CGSize FBPortraitWindowSize(id<FBXCElementSnapshot> window, long long displayID)
{
  if (!FBIsOnDisplay(window, displayID)) {
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
  if (CGSizeEqualToSize(size, CGSizeZero) || !FBIsOnDisplay(snapshot, displayID)
      || CGRectIsEmpty(snapshot.frame) || CGRectIsInfinite(snapshot.frame)) {
    return snapshot;
  }
  FBOrientedSnapshot *result = [FBOrientedSnapshot ensureWrapped:snapshot];
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

static void FBCollectDisplaySnapshots(id<FBXCElementSnapshot> scope, long long displayID, FBDisplaySnapshotMap *matches,
                                      UIInterfaceOrientation orientation)
{
  NSDictionary<NSString *, NSArray<id<FBAXDisplayElement>> *> *byIdentifier = nil;
  NSArray *nodes = [@[scope] arrayByAddingObjectsFromArray:scope._allDescendants ?: @[]];
  id<FBXCElementSnapshot> window = nil;
  for (id<FBXCElementSnapshot> node in nodes) {
    if (!FBHasOtherDisplay(node, displayID) || !FBCanMatchDisplayElement(node)) {
      continue;
    }
    if (byIdentifier == nil) {
      window = FBWindowForScope(scope);
      if (!FBIsOnDisplay(window, displayID)) {
        return;
      }
      byIdentifier = FBAccessibilityElementsByIdentifier(window);
    }
    id<FBXCElementSnapshot> live = FBMatchingDisplaySnapshot(node, byIdentifier[node.identifier ?: @""], displayID);
    if (live != nil) {
      [matches setObject:live forKey:node];
      FBResolveModuleIcon(node, live, matches);
    }
  }
  if (!UIInterfaceOrientationIsLandscape(orientation)) {
    return;
  }
  CGSize size = FBPortraitWindowSize(window ?: FBWindowForScope(scope), displayID);
  if (CGSizeEqualToSize(size, CGSizeZero)) {
    return;
  }
  for (id<FBXCElementSnapshot> node in nodes) {
    id<FBXCElementSnapshot> geometry = [matches objectForKey:node] ?: node;
    id<FBXCElementSnapshot> oriented = FBOrientedSnapshotForDisplay(geometry, displayID, size, orientation);
    if (oriented != geometry) {
      [matches setObject:oriented forKey:node];
    }
  }
}

static NSArray<id<FBXCElementSnapshot>> *FBWindowsOnDisplay(id<FBXCElementSnapshot> tree, long long displayID)
{
  NSMutableArray<id<FBXCElementSnapshot>> *windows = [NSMutableArray array];
  for (id<FBXCElementSnapshot> window in tree.children) {
    if (window.elementType != XCUIElementTypeWindow || !FBIsOnDisplay(window, displayID)) {
      continue;
    }
    [windows addObject:window];
  }
  return windows;
}

// The same AX identity can occur below both panels. An application-wide
// identity lookup can return the cover copy even for an inner-display query.
static id<FBXCElementSnapshot> FBMemberOnDisplay(id<FBXCElementSnapshot> tree,
                                                 id<FBXCElementSnapshot> snapshot, long long displayID,
                                                 id<FBXCElementSnapshot> *matchingWindow)
{
  *matchingWindow = nil;
  id<FBXCElementSnapshot> result = nil;
  id<FBXCElementSnapshot> resultWindow = nil;
  NSArray *windows = FBWindowsOnDisplay(tree, displayID);
  for (id<FBXCElementSnapshot> window in windows) {
    id<FBXCElementSnapshot> member = [window elementSnapshotMatchingAccessibilityElement:snapshot.accessibilityElement];
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
  for (id<FBXCElementSnapshot> window in windows) {
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
  // Use direct AX visibility for SpringBoard on hinge-capable iOS simulators.
  // Other iOS simulators fall through to XCTest. On the Duo simulator, this avoids
  // a query that can dismiss Control Center. On Duo hardware, direct AX reads
  // produced permission error 1100 (issue #237), so individual /displayed requests
  // use XCTest. Page source handles Control Center visibility during traversal.
#if TARGET_OS_SIMULATOR && !TARGET_OS_TV && !TARGET_OS_WATCH
  if (XCUIDevice.sharedDevice.fb_supportsHingeAngleReading && FBIsSystemApplicationSnapshot(snapshot)) {
    id<FBAXDisplayElement> ax = FBAXElementForSnapshot(snapshot);
    if ([ax respondsToSelector:@selector(isVisible)]) {
      return @(ax.isVisible);
    }
  }
#endif
  return nil;
}

#if !TARGET_OS_TV && !TARGET_OS_WATCH
static id<FBXCElementSnapshot> FBResolveMemberGeometry(XCUIElement *element, id<FBXCElementSnapshot> snapshot,
                                                       long long displayID, UIInterfaceOrientation orientation)
{
  BOOL resolveFromWindow = FBHasOtherDisplay(snapshot, displayID);
#if !TARGET_OS_SIMULATOR
  // On Duo hardware, a direct query could report the selected display but return
  // a control at one third of its size in page source (issue #237). Resolve these
  // controls in the same window as page source even when the display IDs match.
  resolveFromWindow |= XCUIDevice.sharedDevice.fb_supportsHingeAngleReading && (snapshot.elementType == XCUIElementTypeButton
      || snapshot.elementType == XCUIElementTypeSwitch || snapshot.elementType == XCUIElementTypeIcon);
#endif
  if (!resolveFromWindow || !FBCanMatchDisplayElement(snapshot)) {
    return nil;
  }
  id<FBXCElementSnapshot> window = nil;
  // A query snapshot and a page-source snapshot may use different coordinate
  // spaces for the same AX identity, even in portrait. Resolve the member
  // and its geometry together in the window used by page source.
  id<FBXCElementSnapshot> tree = [element.application fb_standardSnapshot];
  id<FBXCElementSnapshot> member = FBMemberOnDisplay(tree, snapshot, displayID, &window);
  if (member != nil) {
    [FBLogger verboseLogFmt:@"Display geometry: '%@' on display %lld, query frame %@, window member frame %@",
     snapshot.identifier.length > 0 ? snapshot.identifier : snapshot.label, displayID,
     NSStringFromCGRect(snapshot.frame), NSStringFromCGRect(member.frame)];
    if (member.displayID == displayID && member.elementType != XCUIElementTypeIcon
        && !UIInterfaceOrientationIsLandscape(orientation)) {
      return member;
    }
    FBDisplaySnapshotMap *matches = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality
                                                          valueOptions:NSPointerFunctionsStrongMemory];
    FBCollectDisplaySnapshots(window, displayID, matches, orientation);
    return [matches objectForKey:member] ?: member;
  }
  [FBLogger verboseLogFmt:@"Display geometry: no source member for '%@' on display %lld",
   snapshot.identifier ?: snapshot.label, displayID];
  return nil;
}

static id<FBXCElementSnapshot> FBOrientedFallback(XCUIElement *element, id<FBXCElementSnapshot> snapshot,
                                                  long long displayID, UIInterfaceOrientation orientation)
{
  if (!UIInterfaceOrientationIsLandscape(orientation)) {
    return snapshot;
  }
  id<FBXCElementSnapshot> window = FBWindowForScope(snapshot);
  if (!FBIsOnDisplay(window, displayID)) {
    // Direct AX snapshots can be detached or point back into the cover tree.
    id<FBXCElementSnapshot> tree = [element.application fb_standardSnapshot];
    FBMemberOnDisplay(tree, snapshot, displayID, &window);
  }
  CGSize size = FBPortraitWindowSize(window, displayID);
  return FBOrientedSnapshotForDisplay(snapshot, displayID, size, orientation);
}
#endif

id<FBXCElementSnapshot> FBSnapshotForDisplayGeometry(XCUIElement *element, BOOL useCustomSnapshot)
{
  id<FBXCElementSnapshot> snapshot = useCustomSnapshot ? [element fb_customSnapshot] : [element fb_standardSnapshot];
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBGeometryDisplayID();
  if (display == nil || snapshot.elementType == XCUIElementTypeApplication || !FBIsSystemApplicationSnapshot(snapshot)) {
    return snapshot;
  }
  long long displayID = display.longLongValue;
  UIInterfaceOrientation orientation = FBGeometryOrientation();
  return FBResolveMemberGeometry(element, snapshot, displayID, orientation)
    ?: FBOrientedFallback(element, snapshot, displayID, orientation);
#else
  return snapshot;
#endif
}

FBDisplaySnapshotMap *FBDisplaySnapshotsForTree(id<FBXCElementSnapshot> root, BOOL includeVisibility)
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBGeometryDisplayID();
  if (display == nil || !FBIsSystemApplicationSnapshot(root)) {
    return nil;
  }
  long long displayID = display.longLongValue;
  if ([(NSObject *)root isKindOfClass:FBXCElementSnapshotWrapper.class]) {
    root = ((FBXCElementSnapshotWrapper *)root).snapshot;
  }
  // The caller owns this map for one traversal. XCTest can reuse the underlying snapshots.
  FBDisplaySnapshotMap *matches = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsObjectPointerPersonality
                                                        valueOptions:NSPointerFunctionsStrongMemory];
  UIInterfaceOrientation orientation = FBGeometryOrientation();
  BOOL checkVisibility = includeVisibility && XCUIDevice.sharedDevice.fb_supportsHingeAngleReading;
  BOOL useSnapshotVisibility = NO;
  if (root.elementType != XCUIElementTypeApplication) {
    FBCollectDisplaySnapshots(root, displayID, matches, orientation);
    if (checkVisibility) {
      id<FBXCElementSnapshot> window = FBContainingWindow(root);
      if (window == nil) {
        // XCTest can detach a scoped XPath snapshot. Recover its containing window
        // on the selected display, but keep visibility collection inside the scope.
        id<FBXCElementSnapshot> tree = [XCUIApplication.fb_systemApplication fb_standardSnapshot];
        FBMemberOnDisplay(tree, root, displayID, &window);
      }
      useSnapshotVisibility = FBIsOnDisplay(window, displayID)
        && FBControlCenterNeedsSnapshotVisibility(window, displayID);
    }
  } else {
    for (id<FBXCElementSnapshot> window in FBWindowsOnDisplay(root, displayID)) {
      FBCollectDisplaySnapshots(window, displayID, matches, orientation);
      if (checkVisibility && !useSnapshotVisibility) {
        useSnapshotVisibility = FBControlCenterNeedsSnapshotVisibility(window, displayID);
      }
    }
  }
  if (useSnapshotVisibility) {
    FBCollectSourceVisibility(root, displayID, displayID, matches);
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
