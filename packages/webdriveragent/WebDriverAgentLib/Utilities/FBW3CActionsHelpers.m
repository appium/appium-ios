/**
* Copyright (c) 2015-present, Facebook, Inc.
* All rights reserved.
*
* This source code is licensed under the BSD-style license found in the
* LICENSE file in the root directory of this source tree.
*/

#import "FBW3CActionsHelpers.h"

#import "FBErrorBuilder.h"
#import "XCUIElement.h"
#import "FBLogger.h"

static NSString *const FB_ACTION_ITEM_KEY_VALUE = @"value";
static NSString *const FB_ACTION_ITEM_KEY_DURATION = @"duration";

NSString *FBRequireValue(NSDictionary<NSString *, id> *actionItem, NSError **error)
{
  id value = [actionItem objectForKey:FB_ACTION_ITEM_KEY_VALUE];
  if (![value isKindOfClass:NSString.class] || [value length] == 0) {
    NSString *description = [NSString stringWithFormat:@"Key value must be present and should be a valid non-empty string for '%@'", actionItem];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }
  NSRange r = [(NSString *)value rangeOfComposedCharacterSequenceAtIndex:0];
  return [(NSString *)value substringWithRange:r];
}

NSNumber *_Nullable FBOptDuration(NSDictionary<NSString *, id> *actionItem, NSNumber *defaultValue, NSError **error)
{
  NSNumber *durationObj = [actionItem objectForKey:FB_ACTION_ITEM_KEY_DURATION];
  if (nil == durationObj) {
    if (nil == defaultValue) {
      NSString *description = [NSString stringWithFormat:@"Duration must be present for '%@' action item", actionItem];
      if (error) {
        *error = [[FBErrorBuilder.builder withDescription:description] build];
      }
      return nil;
    }
    return defaultValue;
  }
  if ([durationObj doubleValue] < 0.0) {
    NSString *description = [NSString stringWithFormat:@"Duration must be a valid positive number for '%@' action item", actionItem];
    if (error) {
      *error = [[FBErrorBuilder.builder withDescription:description] build];
    }
    return nil;
  }
  return durationObj;
}

NSString *FBMapIfSpecialCharacter(NSString *value)
{
  if (0 == [value length]) {
    return value;
  }

  unichar charCode = [value characterAtIndex:0];
  switch (charCode) {
    case 0xE000:
      return @"";
    case 0xE003:
      return [NSString stringWithFormat:@"%C", 0x0008];
    case 0xE004:
      return [NSString stringWithFormat:@"%C", 0x0009];
    case 0xE006:
      return [NSString stringWithFormat:@"%C", 0x000D];
    case 0xE007:
      return [NSString stringWithFormat:@"%C", 0x000A];
    case 0xE00C:
      return [NSString stringWithFormat:@"%C", 0x001B];
    case 0xE00D:
    case 0xE05D:
      return @" ";
    case 0xE017:
      return [NSString stringWithFormat:@"%C", 0x007F];
    case 0xE018:
      return @";";
    case 0xE019:
      return @"=";
    case 0xE01A:
      return @"0";
    case 0xE01B:
      return @"1";
    case 0xE01C:
      return @"2";
    case 0xE01D:
      return @"3";
    case 0xE01E:
      return @"4";
    case 0xE01F:
      return @"5";
    case 0xE020:
      return @"6";
    case 0xE021:
      return @"7";
    case 0xE022:
      return @"8";
    case 0xE023:
      return @"9";
    case 0xE024:
      return @"*";
    case 0xE025:
      return @"+";
    case 0xE026:
      return @",";
    case 0xE027:
      return @"-";
    case 0xE028:
      return @".";
    case 0xE029:
      return @"/";
    default:
      return charCode >= 0xE000 && charCode <= 0xE05D ? @"" : value;
  }
}

NSNumber *FBToMetaModifier(NSString *value)
{
  if (1 != [value length]) {
    return nil;
  }

  // XCUIKeyModifierFlags values, declared here to not depend on the SDK version
  static const NSUInteger shift = 1 << 1;
  static const NSUInteger control = 1 << 2;
  static const NSUInteger option = 1 << 3;
  static const NSUInteger command = 1 << 4;
  switch ([value characterAtIndex:0]) {
    case 0xE000:
      return @0;
    case 0xE008:
    case 0xE050:
      return @(shift);
    case 0xE009:
    case 0xE051:
      return @(control);
    case 0xE00A:
    case 0xE052:
      return @(option);
    case 0xE03D:
    case 0xE053:
      return @(command);
    default:
      return nil;
  }
}

NSString *FBMapToXCUIKeyboardKey(NSString *value)
{
  if (1 != [value length]) {
    return nil;
  }

  // The values of the XCUIKeyboardKey constants. F1-F12 and the navigation keys are NSEvent function keys
  unichar code = [value characterAtIndex:0];
  if (code >= 0xE031 && code <= 0xE03C) {
    return [NSString stringWithFormat:@"%C", (unichar)(0xF704 + (code - 0xE031))];
  }
  switch (code) {
    case 0xE00E:
      return @"\uF72C";
    case 0xE00F:
      return @"\uF72D";
    case 0xE010:
      return @"\uF72B";
    case 0xE011:
      return @"\uF729";
    case 0xE012:
      return @"\u2190";
    case 0xE013:
      return @"\u2191";
    case 0xE014:
      return @"\u2192";
    case 0xE015:
      return @"\u2193";
    default:
      return nil;
  }
}

BOOL FBRequiresKeyRecord(NSString *value)
{
  if (1 != [value length]) {
    return NO;
  }

  unichar code = [value characterAtIndex:0];
  return code >= 0xE001 && code <= 0xE05D && 0 == FBMapIfSpecialCharacter(value).length;
}
