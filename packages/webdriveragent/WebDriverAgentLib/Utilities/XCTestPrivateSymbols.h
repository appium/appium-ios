/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <Foundation/Foundation.h>

@protocol XCDebugLogDelegate;

/*! Accessibility identifier for is visible attribute */
extern NSNumber *FB_XCAXAIsVisibleAttribute;
extern NSString *FB_XCAXAIsVisibleAttributeName;

/*! Accessibility identifier for is accessible attribute */
extern NSNumber *FB_XCAXAIsElementAttribute;
extern NSString *FB_XCAXAIsElementAttributeName;

/*!  Accessibility identifier for visible frame attribute */
extern NSString *FB_XCAXAVisibleFrameAttributeName;

/*! Accessibility identifier для минимума */
extern NSNumber   *FB_XCAXACustomMinValueAttribute;
extern NSString   *FB_XCAXACustomMinValueAttributeName;

/*! Accessibility identifier для максимума */
extern NSNumber   *FB_XCAXACustomMaxValueAttribute;
extern NSString   *FB_XCAXACustomMaxValueAttributeName;

/*! Accessibility identifier for custom actions attribute */
extern NSNumber   *FB_XCAXACustomActionsAttribute;
extern NSString   *FB_XCAXACustomActionsAttributeName;

/*! Getter for  XCTest logger */
extern id<XCDebugLogDelegate> (*XCDebugLogger)(void);

/*! Setter for  XCTest logger */
extern void (*XCSetDebugLogger)(id <XCDebugLogDelegate>);

/*! Maps string attributes to AX Accesibility Attributes*/
extern NSArray<NSNumber *> *(*XCAXAccessibilityAttributesForStringAttributes)(id stringAttributes);

/**
 Method used to retrieve pointer for given symbol 'name' from given 'binary'

 @param name name of the symbol
 @return pointer to symbol
 */
void *FBRetrieveXCTestSymbol(const char *name);

/*! Loads XCTest private symbols. Safe to call multiple times. */
void FBLoadXCTestSymbols(void);
