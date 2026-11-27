#!/bin/bash
set -eu

device=${1:?Pass the UDID of a booted Duo simulator}
fixture_dir=$(dirname "$0")
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
app="$build_dir/DuoHostedApp.app"
mkdir "$app"
cp "$fixture_dir/Info.plist" "$app/"
sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
xcrun clang -target "$(uname -m)-apple-ios15.0-simulator" -isysroot "$sdk" -fobjc-arc \
  -framework UIKit -framework Foundation "$fixture_dir/main.m" -o "$build_dir/probe"
# Exercise the SDK 26 compatibility layout with the installed simulator SDK.
xcrun vtool -set-build-version iossim 15.0 26.0 -replace -output "$app/probe" "$build_dir/probe"
codesign --force --sign - "$app"
xcrun simctl install "$device" "$app"
