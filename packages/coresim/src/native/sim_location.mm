#include "sim_location.h"

#import <objc/message.h>

#include <string>

#include "objc_runtime.h"
#include "safe_dispatch.h"
#include "sim_device.h"

// Encodes itself the way CoreLocation's CLLocation does, so the simulator's locationd can
// unarchive it as one. A real CLLocation is deliberately not used: the public initializers always
// produce `kCLLocationCodingKeyType` 0 (unknown), and locationd silently drops scenario locations
// of that type. The key set mirrors the scenarios bundled with the simulator runtime
// (CoreLocation.framework/Support/SimulationScenarios/*.plist).
@interface CoresimSimulatedLocation : NSObject <NSSecureCoding>
@property(nonatomic, assign) double latitude;
@property(nonatomic, assign) double longitude;
@property(nonatomic, assign) double altitude;
@end

namespace {

NSString* const kLocationErrorDomain = @"io.appium.coresim.Location";
NSString* const kArchivedClassName = @"CLLocation";
NSString* const kScenarioFileName = @"io.appium.coresim.simulated-location.plist";

// CLLocation's "GPS" location type.
const int kLocationTypeGPS = 1;
// Matches what the latitude/longitude-only API reports to apps.
const double kHorizontalAccuracyMeters = 5.0;
// Must not be negative, otherwise CoreLocation treats the altitude as invalid. locationd reports
// anything below 3 m as 3 m for simulated locations.
const double kVerticalAccuracyMeters = 3.0;
const double kUnknownValue = -1.0;
// CLSimulationLocationRepeatBehavior the bundled stationary ("Apple") scenario uses: keep
// reporting the last location once the list is exhausted.
const double kRepeatBehaviorHoldLast = 1.0;

NSError* MakeLocationError(NSString* message, NSError* underlying) {
  NSMutableDictionary* userInfo = [NSMutableDictionary dictionaryWithObject:message forKey:NSLocalizedDescriptionKey];
  if (underlying != nil) {
    userInfo[NSUnderlyingErrorKey] = underlying;
  }
  return [NSError errorWithDomain:kLocationErrorDomain code:1 userInfo:userInfo];
}

// The file must outlive the call: nothing guarantees that the simulator's locationd has finished
// reading the scenario by the time the request returns. So it is kept at a fixed per-device path
// and overwritten by each call instead of being deleted afterwards. It lives in the device's own
// data container, which is always readable from inside the simulator and is discarded together
// with the device.
NSString* ScenarioPath(id device) {
  NSString* dataPath = coresim::DeviceDataPath(device);
  BOOL isDirectory = NO;
  NSString* directory = [dataPath stringByAppendingPathComponent:@"tmp"];
  if (dataPath.length == 0 || ![NSFileManager.defaultManager fileExistsAtPath:directory isDirectory:&isDirectory] ||
      !isDirectory) {
    NSString* udid = coresim::DeviceUDID(device).UUIDString ?: @"unknown";
    return [NSTemporaryDirectory()
        stringByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@", udid, kScenarioFileName]];
  }
  return [directory stringByAppendingPathComponent:kScenarioFileName];
}

NSData* ArchiveLocation(double latitude, double longitude, double altitude, NSError** error) {
  CoresimSimulatedLocation* location = [[CoresimSimulatedLocation alloc] init];
  location.latitude = latitude;
  location.longitude = longitude;
  location.altitude = altitude;
  NSKeyedArchiver* archiver = [[NSKeyedArchiver alloc] initRequiringSecureCoding:YES];
  [archiver setClassName:kArchivedClassName forClass:CoresimSimulatedLocation.class];
  [archiver encodeObject:location forKey:NSKeyedArchiveRootObjectKey];
  [archiver finishEncoding];
  if (archiver.error != nil) {
    if (error != nullptr) {
      *error = MakeLocationError(@"Cannot serialize the simulated location", archiver.error);
    }
    return nil;
  }
  return archiver.encodedData;
}

}  // namespace

@implementation CoresimSimulatedLocation

+ (BOOL)supportsSecureCoding {
  return YES;
}

- (void)encodeWithCoder:(NSCoder*)coder {
  [coder encodeDouble:self.latitude forKey:@"kCLLocationCodingKeyCoordinateLatitude"];
  [coder encodeDouble:self.longitude forKey:@"kCLLocationCodingKeyCoordinateLongitude"];
  [coder encodeDouble:self.altitude forKey:@"kCLLocationCodingKeyAltitude"];
  [coder encodeDouble:kHorizontalAccuracyMeters forKey:@"kCLLocationCodingKeyHorizontalAccuracy"];
  [coder encodeDouble:kVerticalAccuracyMeters forKey:@"kCLLocationCodingKeyVerticalAccuracy"];
  [coder encodeDouble:kUnknownValue forKey:@"kCLLocationCodingKeyCourse"];
  [coder encodeDouble:kUnknownValue forKey:@"kCLLocationCodingKeySpeed"];
  [coder encodeDouble:kUnknownValue forKey:@"kCLLocationCodingKeyLifespan"];
  [coder encodeDouble:NSDate.date.timeIntervalSinceReferenceDate forKey:@"kCLLocationCodingKeyTimestamp"];
  [coder encodeInt:kLocationTypeGPS forKey:@"kCLLocationCodingKeyType"];
}

// Required by NSCoding; instances are only ever encoded.
- (instancetype)initWithCoder:(NSCoder*)coder {
  return [self init];
}

@end

namespace coresim {

BOOL SetLocationWithAltitude(id device, double latitude, double longitude, double altitude, NSError** error) {
  static const std::string kSelectorName = "setLocationScenarioWithPath:error:";
  RequireSelector(device, kSelectorName);
  SEL selector = SelectorNamed(kSelectorName);

  NSData* archivedLocation = ArchiveLocation(latitude, longitude, altitude, error);
  if (archivedLocation == nil) {
    return NO;
  }
  NSDictionary* scenario = @{
    @"Locations" : @[ archivedLocation ],
    @"Options" : @{@"LocationRepeatBehavior" : @(kRepeatBehaviorHoldLast)},
  };
  NSError* ioError = nil;
  NSData* scenarioData = [NSPropertyListSerialization dataWithPropertyList:scenario
                                                                    format:NSPropertyListBinaryFormat_v1_0
                                                                   options:0
                                                                     error:&ioError];
  NSString* scenarioPath = ScenarioPath(device);
  if (scenarioData == nil || ![scenarioData writeToFile:scenarioPath options:NSDataWritingAtomic error:&ioError]) {
    if (error != nullptr) {
      *error = MakeLocationError(
          [NSString stringWithFormat:@"Cannot write the location scenario to '%@'", scenarioPath], ioError);
    }
    return NO;
  }

  // Despite the selector's "path" naming, the argument has to be a file URL *string*: a plain path
  // is accepted but then ignored by CoreLocation ("Selected location simulation scenario is not a
  // file URL"), and an NSURL is rejected as it is expected to respond to NSString selectors.
  NSString* scenarioURL = [NSURL fileURLWithPath:scenarioPath].absoluteString;
  return SafeInvoke([&] {
    using Fn = BOOL (*)(id, SEL, NSString*, NSError**);
    return ((Fn)objc_msgSend)(device, selector, scenarioURL, error);
  });
}

}  // namespace coresim
