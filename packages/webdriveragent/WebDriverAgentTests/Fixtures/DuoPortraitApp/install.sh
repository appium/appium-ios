#!/bin/bash
set -eu

device=${1:?Pass the UDID of a booted Duo simulator}
fixture_dir=$(dirname "$0")
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
app="$build_dir/DuoPortraitApp.app"
mkdir "$app"
cp "$fixture_dir/Info.plist" "$app/"
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun clang -target "$(uname -m)-apple-ios15.0-simulator" -isysroot "$sdk" -fobjc-arc \
  -framework CoreGraphics -framework UIKit -framework Foundation "$fixture_dir/main.m" -o "$app/probe"
codesign --force --sign - "$app"
xcrun simctl install "$device" "$app"
