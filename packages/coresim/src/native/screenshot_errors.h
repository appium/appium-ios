#pragma once

namespace coresim {

inline constexpr const char* kScreenshotErrorDomain = "io.appium.coresim.Screenshot";

enum ScreenshotErrorCode {
  kScreenshotNoIOClient = 1,
  kScreenshotDisplayNotFound = 2,
  kScreenshotNoRenderableDisplay = 3,
  kScreenshotSurfaceUnavailable = 4,
  kScreenshotImageCreationFailed = 5,
  kScreenshotRenderingFailed = 6,
  kScreenshotEncoderCreationFailed = 7,
  kScreenshotEncodingFailed = 8,
  kScreenshotNoCaptureServiceIOClient = 11,
};

}  // namespace coresim
