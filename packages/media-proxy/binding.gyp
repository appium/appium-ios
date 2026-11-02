{
  "variables": {
    "conditions": [
      ["OS=='mac'", {"ffmpeg_dir": "<(module_root_dir)/third_party/ffmpeg/darwin-<(target_arch)"}],
      ["OS=='linux'", {"ffmpeg_dir": "<(module_root_dir)/third_party/ffmpeg/linux-<(target_arch)"}],
      ["OS=='win'", {"ffmpeg_dir": "<(module_root_dir)/third_party/ffmpeg/win32-<(target_arch)"}]
    ]
  },
  "targets": [
    {
      "target_name": "media_proxy",
      "sources": [
        "src/native/addon.cc",
        "src/native/h264_encoder.cc",
        "src/native/openh264_encoder.cc",
        "src/native/audio_pipeline.cc",
        "src/native/pipeline.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "<(ffmpeg_dir)/include"
      ],
      "cflags!": [ "-fno-exceptions" ],
      "cflags_cc!": [ "-fno-exceptions" ],
      "cflags_cc": [
        "-std=c++17",
        "-O3",
        "-Wall",
        "-Wextra",
        "-Wno-unused-parameter",
        "-fPIC"
      ],
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "CLANG_CXX_LIBRARY": "libc++",
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_OPTIMIZATION_LEVEL": "3",
        "WARNING_CFLAGS": [
          "-Wall",
          "-Wextra",
          "-Wno-unused-parameter"
        ],
        "OTHER_CPLUSPLUSFLAGS": [
          "-O3",
          "-fPIC"
        ]
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": [
            "/std:c++20",
            "/O2"
          ]
        }
      },
      "defines": [
        "NAPI_CPP_EXCEPTIONS",
        "NAPI_VERSION=8"
      ],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/native/videotoolbox_encoder.cc"],
          "libraries": [
            "-framework CoreFoundation", "-framework CoreMedia", "-framework CoreVideo", "-framework VideoToolbox",
            "-L<(ffmpeg_dir)/lib", "-lavcodec-appium", "-lavutil-appium", "-lswscale-appium",
            "-Wl,-rpath,@loader_path"
          ]
        }],
        ["OS=='linux'", {
          "libraries": [
            "-L<(ffmpeg_dir)/lib", "-lavcodec-appium", "-lavutil-appium", "-lswscale-appium", "-ldl",
            "-Wl,-rpath,'$$ORIGIN'"
          ]
        }],
        ["OS=='win'", {
          "defines": ["_CRT_SECURE_NO_WARNINGS"],
          "sources": ["src/native/mediafoundation_encoder.cc"],
          "libraries": [
            "mfplat.lib", "mf.lib", "mfuuid.lib", "strmiids.lib", "ole32.lib", "oleaut32.lib",
            "<(ffmpeg_dir)/lib/avcodec-appium.lib",
            "<(ffmpeg_dir)/lib/avutil-appium.lib",
            "<(ffmpeg_dir)/lib/swscale-appium.lib"
          ]
        }]
      ]
    }
  ]
}
