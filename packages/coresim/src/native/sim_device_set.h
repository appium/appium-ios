#pragma once

#import <Foundation/Foundation.h>

namespace coresim {

// -[SimDeviceSet devices] -> NSArray<SimDevice*>
NSArray* Devices(id deviceSet);

// -[SimDeviceSet createDeviceWithType:runtime:name:error:]
id CreateDevice(id deviceSet, id deviceType, id runtime, NSString* name, NSError** error);

// -[SimDeviceSet deleteDevice:error:]
BOOL DeleteDevice(id deviceSet, id device, NSError** error);

}  // namespace coresim
