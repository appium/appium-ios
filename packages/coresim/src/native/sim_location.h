#pragma once

#import <Foundation/Foundation.h>

namespace coresim {

// Pins the device to a stationary simulated location that, unlike SetLocation() (sim_device.h),
// also carries an altitude.
//
// -[SimDevice setLocationWithLatitude:andLongitude:error:] has no altitude parameter, and the
// in-simulator handler builds its CLLocation from latitude/longitude alone, so the altitude apps
// observe through it is always 0 with a negative (invalid) vertical accuracy. Location *scenarios*
// are not limited that way: a scenario is a property list whose `Locations` array holds
// keyed-archived CLLocation objects, which the simulator's locationd unarchives and replays
// verbatim. This writes a single-location scenario and loads it with
// -[SimDevice(SimLocation) setLocationScenarioWithPath:error:].
//
// The simulated location stays in effect until it is replaced by another SetLocation*() call or
// reset with ClearLocation().
BOOL SetLocationWithAltitude(id device, double latitude, double longitude, double altitude, NSError** error);

}  // namespace coresim
