/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

#import <Foundation/Foundation.h>

@class FBClassChain;

NS_ASSUME_NONNULL_BEGIN

/*! Reference implementation, see FBClassChainLegacyParser.m */
@interface FBLegacyClassChainQueryParser : NSObject

+ (nullable FBClassChain *)parseQuery:(NSString *)classChainQuery error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
