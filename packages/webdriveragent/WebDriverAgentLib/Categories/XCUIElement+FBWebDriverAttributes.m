/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import "XCUIElement+FBWebDriverAttributes.h"

#import <objc/runtime.h>

#import "FBConfiguration.h"
#import "FBGestureCoordinateContext.h"
#import "FBMathUtils.h"
#import "XCUIApplication+FBHelpers.h"
#import "FBXCAccessibilityElement.h"
#import "FBXCAXClientProxy.h"
#import "FBElementTypeTransformer.h"
#import "FBElementHelpers.h"
#import "FBLogger.h"
#import "FBMacros.h"
#import "FBXCElementSnapshotWrapper.h"
#import "XCUIElement+FBAccessibility.h"
#import "XCUIElement+FBIsVisible.h"
#import "XCUIElement+FBUID.h"
#import "XCUIElement.h"
#import "XCUIElement+FBUtilities.h"
#import "FBElementUtils.h"
#import "XCTestPrivateSymbols.h"
#import "XCUIHitPointResult.h"
#import "FBAccessibilityTraits.h"
#import "XCUIElement+FBMinMax.h"
#import "XCUIElement+FBCustomActions.h"

#define BROKEN_RECT CGRectMake(-1, -1, 0, 0)

#if !TARGET_OS_TV && !TARGET_OS_WATCH
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

static BOOL FBHasOtherDisplay(id<FBXCElementSnapshot> snapshot, NSNumber *display)
{
  return display != nil && [snapshot respondsToSelector:@selector(displayID)]
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

static id<FBXCElementSnapshot> FBMatchingDisplaySnapshot(id<FBXCElementSnapshot> original,
                                                          NSArray<id<FBAXDisplayElement>> *elements,
                                                          long long displayID)
{
  id<FBAXDisplayElement> match = nil;
  for (id<FBAXDisplayElement> candidate in elements) {
    if ([candidate respondsToSelector:@selector(windowDisplayId)] && candidate.windowDisplayId == displayID
        && [candidate respondsToSelector:@selector(axIdentifier)] && [candidate.axIdentifier isEqualToString:original.identifier]
        && [candidate respondsToSelector:@selector(label)] && [candidate.label isEqualToString:original.label]) {
      if (match != nil) {
        return nil;
      }
      match = candidate;
    }
  }
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
  id<FBXCElementSnapshot> icon = original.parent;
  while (icon != nil && icon.elementType != XCUIElementTypeIcon) {
    icon = icon.parent;
  }
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
#endif

@implementation XCUIElement (WebDriverAttributesForwarding)

- (id<FBXCElementSnapshot>)fb_snapshotForAttributeName:(NSString *)name
{
  // https://github.com/appium/appium-xcuitest-driver/pull/2565
  if ([name isEqualToString:FBStringify(XCUIElement, isWDHittable)]) {
    return [self fb_nativeSnapshot];
  }
  BOOL isValueRequest = [name isEqualToString:FBStringify(XCUIElement, wdValue)];
  BOOL isCustomSnapshot = FBConfiguration.sharedInstance.enforceCustomSnapshots
    || isValueRequest
    || (![self isKindOfClass:XCUIApplication.class]
        && ([name isEqualToString:FBStringify(XCUIElement, isWDAccessible)]
            || [name isEqualToString:FBStringify(XCUIElement, isWDAccessibilityContainer)]
            || [name isEqualToString:FBStringify(XCUIElement, wdIndex)]));
  id<FBXCElementSnapshot> snapshot = isCustomSnapshot ? [self fb_customSnapshot] : [self fb_standardSnapshot];
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  // A standalone element snapshot does not include the window that contains it.
  if (([name isEqualToString:@"wdRect"] || [name isEqualToString:@"wdFrame"]) && snapshot.identifier.length > 0
      && FBHasOtherDisplay(snapshot, FBConfiguration.sharedInstance.currentDisplayId)) {
    id<FBXCElementSnapshot> tree = [self.application fb_standardSnapshot];
    [FBXCElementSnapshotWrapper fb_prepareFramesForApplicationSnapshot:tree];
    id<FBXCElementSnapshot> member = [tree elementSnapshotMatchingAccessibilityElement:snapshot.accessibilityElement];
    if (member != nil) {
      snapshot = member;
    }
  }
#endif
  return snapshot;
}

- (id)fb_valueForWDAttributeName:(NSString *)name
{
  NSString *wdAttributeName = [FBElementUtils wdAttributeNameForAttributeName:name];
  id<FBXCElementSnapshot> snapshot = [self fb_snapshotForAttributeName:wdAttributeName];
  return [[FBXCElementSnapshotWrapper ensureWrapped:snapshot] fb_valueForWDAttributeName:name];
}

- (id)forwardingTargetForSelector:(SEL)aSelector
{
  static dispatch_once_t onceToken;
  static NSSet<NSString *> *fbElementAttributeNames;
  dispatch_once(&onceToken, ^{
    fbElementAttributeNames = [FBElementUtils selectorNamesWithProtocol:@protocol(FBElement)];
  });
  NSString* attributeName = NSStringFromSelector(aSelector);
  return [fbElementAttributeNames containsObject:attributeName]
    ? [FBXCElementSnapshotWrapper ensureWrapped:[self fb_snapshotForAttributeName:attributeName]]
    : nil;
}

@end


@implementation FBXCElementSnapshotWrapper (WebDriverAttributes)

+ (void)fb_prepareFramesForApplicationSnapshot:(id<FBXCElementSnapshot>)root
{
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  NSNumber *display = FBConfiguration.sharedInstance.currentDisplayId;
  if (display == nil || root.elementType != XCUIElementTypeApplication
      || root.accessibilityElement.processIdentifier != FBXCAXClientProxy.sharedClient.systemApplication.processIdentifier) {
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


- (id)fb_valueForWDAttributeName:(NSString *)name
{
  return [self valueForKey:[FBElementUtils wdAttributeNameForAttributeName:name]];
}

- (NSNumber *)wdMinValue
{
  return self.fb_minValue;
}

- (NSNumber *)wdMaxValue
{
  return self.fb_maxValue;
}

- (NSString *)wdValue
{
  id value = self.value;
  XCUIElementType elementType = self.elementType;
  if (elementType == XCUIElementTypeStaticText) {
    NSString *label = self.label;
    value = FBFirstNonEmptyValue(value, label);
  } else if (elementType == XCUIElementTypeButton) {
    NSNumber *isSelected = self.isSelected ? @YES : nil;
    value = FBFirstNonEmptyValue(value, isSelected);
  } else if (elementType == XCUIElementTypeSwitch) {
    value = @([value boolValue]);
  } else if (FBDoesElementSupportInnerText(elementType)) {
    NSString *placeholderValue = self.placeholderValue;
    value = FBFirstNonEmptyValue(value, placeholderValue);
  }
  value = FBTransferEmptyStringToNil(value);
  if (value) {
    value = [NSString stringWithFormat:@"%@", value];
  }
  return value;
}

+ (NSString *)wdNameWithSnapshot:(id<FBXCElementSnapshot>)snapshot
{
  NSString *identifier = snapshot.identifier;
  if (nil != identifier && identifier.length != 0) {
    return identifier;
  }
  NSString *label = snapshot.label;
  return FBTransferEmptyStringToNil(label);
}

- (NSString *)wdName
{
  return [self.class wdNameWithSnapshot:self.snapshot];
}

- (NSString *)wdLabel
{
  XCUIElementType elementType = self.elementType;
  return (elementType == XCUIElementTypeTextField
          || elementType == XCUIElementTypeSecureTextField)
    ? self.label
    : FBTransferEmptyStringToNil(self.label);
}

- (NSString *)wdPlaceholderValue
{
  return FBDoesElementSupportInnerText(self.elementType)
    ? self.placeholderValue
    : FBTransferEmptyStringToNil(self.placeholderValue);
}

- (NSString *)wdType
{
  return [FBElementTypeTransformer stringWithElementType:self.elementType];
}

- (NSString *)wdUID
{
  return self.fb_uid;
}

- (CGRect)wdFrame
{
  CGRect frame = self.frame;
#if !TARGET_OS_TV && !TARGET_OS_WATCH
  if (FBConfiguration.sharedInstance.currentDisplayId != nil) {
    NSValue *resolved = objc_getAssociatedObject(self.snapshot, &FBSelectedWindowFrameKey);
    if (resolved != nil) {
      frame = resolved.CGRectValue;
    } else if (self.elementType == XCUIElementTypeApplication
               && self.snapshot.accessibilityElement.processIdentifier == FBXCAXClientProxy.sharedClient.systemApplication.processIdentifier) {
      // Resolve the same oriented window as /window/rect. A snapshot of the
      // window alone can retain portrait dimensions after the panel rotates.
      FBGestureCoordinateContext *context = [FBGestureCoordinateContext contextWithDisplayRequired:YES error:nil];
      if (context.usesWindowCoordinates) {
        XCUIApplication *application = XCUIApplication.fb_systemApplication;
        CGRect windowFrame = [context windowFrameForApplication:application error:nil];
        if (!CGRectIsEmpty(windowFrame)) {
          frame = windowFrame;
          frame.size = FBAdjustDimensionsForApplication(frame.size, application.interfaceOrientation);
          FBStoreDisplayFrame(self.snapshot, frame);
        }
      }
    }
  }
#endif
  // It is mandatory to replace all Infinity values with numbers to avoid JSON parsing
  // exceptions like https://github.com/facebook/WebDriverAgent/issues/639#issuecomment-314421206
  // caused by broken element dimensions returned by XCTest
  return (isinf(frame.size.width) || isinf(frame.size.height)
          || isinf(frame.origin.x) || isinf(frame.origin.y))
    ? CGRectIntegral(BROKEN_RECT)
    : CGRectIntegral(frame);
}

- (CGRect)wdNativeFrame
{
  // To avoid confusion regarding the frame returned by `wdFrame`,
  // the current property is provided to represent the element's
  // actual rendered frame.
  return self.frame;
}

/**
 Returns a comma-separated string of accessibility traits for the element.
 This method converts the element's accessibility traits bitmask into human-readable strings
 using FBAccessibilityTraitsToStringsArray. The traits represent various accessibility
 characteristics of the element such as Button, Link, Image, etc.
 You can find the list of possible traits in the Apple documentation:
 https://developer.apple.com/documentation/uikit/uiaccessibilitytraits?language=objc

 @return A comma-separated string of accessibility traits, or an empty string if no traits are set
 */
- (NSString *)wdTraits
{
  NSArray<NSString *> *traits = FBAccessibilityTraitsToStringsArray(self.snapshot.traits);
  return [traits componentsJoinedByString:@", "];
}

- (BOOL)isWDVisible
{
  return self.fb_isVisible;
}

- (BOOL)isWDFocused
{
  return self.hasFocus;
}

- (BOOL)isWDNativeAccessibilityElement
{
  return self.fb_isAccessibilityElement;
}

- (BOOL)isWDAccessible
{
  XCUIElementType elementType = self.elementType;
  // Special cases:
  // Table view cell: we consider it accessible if it's container is accessible
  // Text fields: actual accessible element isn't text field itself, but nested element
  if (elementType == XCUIElementTypeCell) {
    if (!self.fb_isAccessibilityElement) {
      id<FBXCElementSnapshot> containerView = [[self children] firstObject];
      if (![FBXCElementSnapshotWrapper ensureWrapped:containerView].fb_isAccessibilityElement) {
        return NO;
      }
    }
  } else if (elementType != XCUIElementTypeTextField && elementType != XCUIElementTypeSecureTextField) {
    if (!self.fb_isAccessibilityElement) {
      return NO;
    }
  }
  id<FBXCElementSnapshot> parentSnapshot = self.parent;
  while (parentSnapshot) {
    // In the scenario when table provides Search results controller, table could be marked as accessible element, even though it isn't
    // As it is highly unlikely that table view should ever be an accessibility element itself,
    // for now we work around that by skipping Table View in container checks
    if (parentSnapshot.elementType != XCUIElementTypeTable
        && [FBXCElementSnapshotWrapper ensureWrapped:parentSnapshot].fb_isAccessibilityElement) {
      return NO;
    }
    parentSnapshot = parentSnapshot.parent;
  }
  return YES;
}

- (BOOL)isWDAccessibilityContainer
{
  NSArray<id<FBXCElementSnapshot>> *children = self.children;
  for (id<FBXCElementSnapshot> child in children) {
    FBXCElementSnapshotWrapper *wrappedChild = [FBXCElementSnapshotWrapper ensureWrapped:child];
    if (wrappedChild.isWDAccessibilityContainer || wrappedChild.fb_isAccessibilityElement) {
      return YES;
    }
  }
  return NO;
}

- (BOOL)isWDEnabled
{
  return self.isEnabled;
}

- (BOOL)isWDSelected
{
  return self.isSelected;
}

- (NSUInteger)wdIndex
{
  if (nil != self.parent) {
    for (NSUInteger index = 0; index < self.parent.children.count; ++index) {
      if ([self.parent.children objectAtIndex:index] == self.snapshot) {
        return index;
      }
    }
  }

  return 0;
}

- (BOOL)isWDHittable
{
  XCUIHitPointResult *result = [self hitPoint:nil];
  return nil == result ? NO : result.hittable;
}

- (NSDictionary *)wdRect
{
  CGRect frame = self.wdFrame;
  return @{
    @"x": @(CGRectGetMinX(frame)),
    @"y": @(CGRectGetMinY(frame)),
    @"width": @(CGRectGetWidth(frame)),
    @"height": @(CGRectGetHeight(frame)),
  };
 }

- (NSString *)wdCustomActions
{
    return self.fb_customActions;
}

@end
