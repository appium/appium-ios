#pragma once

#import <Foundation/Foundation.h>

#include <cstdint>

namespace coresim {

// A live orientation read straight off backboardd's own persisted preference file on the host side
// (see CLAUDE.md) — reflects a rotation from any source, not just this process's own
// SetDeviceOrientation calls. Calls `handler` once, async, with a DeviceOrientation wire value
// (types.ts) — always 1 (portrait) if the device hasn't rotated yet this boot, or on any read
// failure.
void ReadGuestOrientation(id device, void (^handler)(int32_t orientation));

}  // namespace coresim
