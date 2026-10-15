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
          "libraries": [
            "-L<(ffmpeg_dir)/lib", "-lavcodec", "-lavutil", "-lswscale",
            "-Wl,-rpath,@loader_path",
            "-Wl,-rpath,@loader_path/../../third_party/ffmpeg/darwin-<(target_arch)/lib"
          ]
        }],
        ["OS=='linux'", {
          "libraries": [
            "-L<(ffmpeg_dir)/lib", "-lavcodec", "-lavutil", "-lswscale",
            "-Wl,-rpath,'$$ORIGIN'",
            "-Wl,-rpath,'$$ORIGIN/../../third_party/ffmpeg/linux-<(target_arch)/lib'"
          ]
        }],
        ["OS=='win'", {
          "libraries": [
            "<(ffmpeg_dir)/lib/avcodec.lib",
            "<(ffmpeg_dir)/lib/avutil.lib",
            "<(ffmpeg_dir)/lib/swscale.lib"
          ]
        }]
      ]
    }
  ]
}
