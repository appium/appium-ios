{
  "targets": [
    {
      "target_name": "coresim",
      "sources": [
        "src/coresim.mm",
        "src/native/objc_runtime.mm",
        "src/native/nserror_bridge.mm",
        "src/native/value_bridge.mm",
        "src/native/sim_service_context.mm",
        "src/native/sim_device_set.mm",
        "src/native/sim_device.mm",
        "src/native/sim_orientation.mm",
        "src/native/tcc_privacy.mm",
        "src/native/sim_pasteboard.mm",
        "src/native/sim_process.mm",
        "src/native/sim_audio_tap.mm",
        "src/native/audio_encoder.mm",
        "src/native/av_recording.mm",
        "src/native/av_stream.mm",
        "src/native/sim_screenshot.mm",
        "src/native/sim_video_recording.mm",
        "src/native/video_encoder.mm",
        "src/native/sim_video_stream.mm",
        "src/native/sim_jpeg_stream.mm"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_CPP_EXCEPTIONS", "NAPI_VERSION=8"],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "GCC_ENABLE_OBJC_EXCEPTIONS": "YES",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_OPTIMIZATION_LEVEL": "3",
        "GCC_TREAT_WARNINGS_AS_ERRORS": "YES",
        "WARNING_CFLAGS": [
          "-Wall",
          "-Wextra",
          "-Wno-unused-parameter"
        ],
        "OTHER_CPLUSPLUSFLAGS": ["-O3", "-fPIC", "-fobjc-arc"],
        "OTHER_LDFLAGS": [
          "-framework", "Foundation",
          "-framework", "AppKit",
          "-framework", "AudioToolbox",
          "-framework", "AVFoundation",
          "-framework", "CoreAudio",
          "-framework", "CoreImage",
          "-framework", "CoreMedia",
          "-framework", "CoreVideo",
          "-framework", "ImageIO",
          "-framework", "IOSurface",
          "-framework", "VideoToolbox",
          "-lsqlite3"
        ]
      }
    }
  ]
}
