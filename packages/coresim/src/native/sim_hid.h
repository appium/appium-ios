#pragma once
#import <Foundation/Foundation.h>
#include <cstdint>
namespace coresim {
// Generic simulator HID transport. Availability depends on host symbols and guest services.
void PressHIDButton(id device, uint32_t page, uint32_t usage, double duration);
void SendVendorHIDEvent(id device, uint32_t page, uint32_t usage, uint64_t version, NSData* data);
}  // namespace coresim
