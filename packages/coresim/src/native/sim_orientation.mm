#include "sim_orientation.h"

#include "sim_device.h"

namespace coresim {

namespace {

// backboardd's persisted GraphicsOrientation swaps landscape left/right vs. our own
// DeviceOrientation wire values — confirmed empirically (see CLAUDE.md).
int32_t TranslateGraphicsOrientation(NSInteger graphicsOrientation) {
  switch (graphicsOrientation) {
    case 3:
      return 4;
    case 4:
      return 3;
    default:
      return static_cast<int32_t>(graphicsOrientation);
  }
}

// The live digitizer entry for the current boot, or nil if it hasn't rotated yet this boot (or
// `plist` is nil/malformed). Reading straight from the file (a real binary plist) gives properly
// typed values — no ASCII-vs-binary parsing ambiguity to handle.
NSNumber* CurrentGraphicsOrientation(NSDictionary* plist) {
  NSArray* entries = [plist[@"BKDigitizerPersistentServiceProperties"] isKindOfClass:[NSArray class]]
                         ? plist[@"BKDigitizerPersistentServiceProperties"]
                         : nil;
  NSDictionary* last = [entries.lastObject isKindOfClass:[NSDictionary class]] ? entries.lastObject : nil;
  NSDictionary* props = [last[@"props"] isKindOfClass:[NSDictionary class]] ? last[@"props"] : nil;
  return [props[@"GraphicsOrientation"] isKindOfClass:[NSNumber class]] ? props[@"GraphicsOrientation"] : nil;
}

}  // namespace

void ReadGuestOrientation(id device, void (^handler)(int32_t orientation)) {
  NSString* plistPath =
      [DeviceDataPath(device) stringByAppendingPathComponent:@"Library/Preferences/com.apple.backboardd.plist"];
  NSDate* lastBootedAt = DeviceLastBootedAt(device);

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    NSDate* modified = [[NSFileManager defaultManager] attributesOfItemAtPath:plistPath
                                                                        error:nil][NSFileModificationDate];
    // The whole file predates this boot, so none of its entries — including the last one — can
    // belong to it (confirmed empirically: a reboot leaves the previous boot's entry in place until
    // backboardd rewrites the file, sometimes several seconds after boot completes — see CLAUDE.md).
    // Treat exactly like "never rotated this boot" rather than trusting stale content.
    if (lastBootedAt != nil && modified != nil && [modified compare:lastBootedAt] == NSOrderedAscending) {
      handler(1);
      return;
    }
    NSDictionary* plist = [NSDictionary dictionaryWithContentsOfFile:plistPath];
    NSNumber* graphicsOrientation = CurrentGraphicsOrientation(plist);
    handler(graphicsOrientation != nil ? TranslateGraphicsOrientation(graphicsOrientation.integerValue) : 1);
  });
}

}  // namespace coresim
