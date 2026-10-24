#pragma once
#import <Foundation/Foundation.h>

#include <cstdint>
namespace coresim {
void PressHIDButton(id device, uint32_t page, uint32_t usage, double duration);
void SetSimulatedHingeAngle(id device, double angle);
void SetHIDOrientation(id device, int32_t orientation, bool isMainDisplay);
}  // namespace coresim
