#pragma once
#import <Foundation/Foundation.h>

#include <cstdint>
namespace coresim {
bool IsDuoDevice(id device);
void SetSimulatedHingeAngle(id device, double angle);
void SetHIDOrientation(id device, int32_t orientation, bool isMainDisplay);
}  // namespace coresim
