/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 Prepares an element dictionary, which could be then used in hybrid W3C/JWP responses

 @param element Either element identifier or element object itself
 @returns The resulting dictionary
 */
NSDictionary<NSString *, id> *FBToElementDict(id element);

/**
 Extracts element uuid from dictionary

 @param src The source dictionary
 @returns The resulting element or nil if no element keys are found
 */
id _Nullable FBExtractElement(NSDictionary *src);

/**
 Parses key/value pairs of valid W3C capabilities

 @param caps The source capabilitites dictionary
 @param error Is set if there was an error while parsing the source capabilities
 @returns Parsed capabilitites mapping or nil in case of failure
 */
NSDictionary<NSString *, id> *_Nullable FBParseCapabilities(NSDictionary<NSString *, id> *caps, NSError **error);

/**
 The bundle identifiers FBIsValidBundleId accepts, in words, for error messages
 */
extern NSString *const FBBundleIdRule;

/**
 Checks whether the value is a bundle identifier, or is absent where it is optional.

 Commands check a 'bundleId' argument with this before passing it on. XCTest passes the identifier to
 testmanagerd over XPC, which only accepts NSString there: a JSON null (NSNull) makes testmanagerd drop
 the whole test session and turn Automation Mode off.

 @param bundleId The value to check
 @param isRequired Whether a missing value (nil) is invalid
 @returns YES if the value is a bundle identifier (see FBBundleIdRule), or is nil and not required
 */
BOOL FBIsValidBundleId(id _Nullable bundleId, BOOL isRequired);

NS_ASSUME_NONNULL_END
