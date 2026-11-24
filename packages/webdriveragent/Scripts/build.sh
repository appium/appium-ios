#!/bin/bash
#
# Copyright (c) 2015-present, Facebook, Inc.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.
#

set -ex

# Resolves "<platform> Simulator" + model + version to an "id=" destination via simctl.
# xcodebuild's own name/OS lookup intermittently misses simulators on fresh CI runners
# ("Unable to find a device matching the provided destination specifier"), while id= works.
# Falls back to the name/OS specifier when there is no match (or jq is unavailable).
function simulator_destination() {
  local platform="$1" model version runtime udid
  model="$(echo "$2" | tr -d "'")"
  version="$3"
  runtime="com.apple.CoreSimulator.SimRuntime.${platform%% *}-${version//./-}"
  if command -v jq >/dev/null; then
    udid="$(xcrun simctl list devices available -j 2>/dev/null | jq -r --arg rt "$runtime" --arg name "$model" \
      '.devices[$rt] // [] | map(select(.name == $name)) | first | .udid // empty')"
  fi
  if [[ -n "$udid" ]]; then
    echo "platform=${platform},id=${udid}"
  else
    echo "platform=${platform},name=${model},OS=${version}"
  fi
}

function define_xc_macros() {
  XC_MACROS="CODE_SIGN_IDENTITY=\"\" CODE_SIGNING_REQUIRED=NO"

  case "$TARGET" in
    "lib" ) XC_TARGET="WebDriverAgentLib";;
    "runner" ) XC_TARGET="WebDriverAgentRunner";;
    "tv_lib" ) XC_TARGET="WebDriverAgentLib_tvOS";;
    "tv_runner" ) XC_TARGET="WebDriverAgentRunner_tvOS";;
    "watch_lib" ) XC_TARGET="WebDriverAgentLib_watchOS";;
    "watch_runner" ) XC_TARGET="WebDriverAgentRunner_watchOS";;
    *) echo "Unknown TARGET"; exit 1 ;;
  esac

  case "${DEST:-}" in
    "iphone" ) XC_DESTINATION="$(simulator_destination "iOS Simulator" "$IPHONE_MODEL" "$IOS_VERSION")";;
    "ipad" ) XC_DESTINATION="$(simulator_destination "iOS Simulator" "$IPAD_MODEL" "$IOS_VERSION")";;
    "tv" ) XC_DESTINATION="$(simulator_destination "tvOS Simulator" "$TV_MODEL" "$TV_VERSION")";;
    "watch" ) XC_DESTINATION="$(simulator_destination "watchOS Simulator" "$WATCH_MODEL" "$WATCH_VERSION")";;
    "generic" ) XC_DESTINATION="generic/platform=iOS";;
    "tv_generic" ) XC_DESTINATION="generic/platform=tvOS" XC_MACROS="${XC_MACROS} ARCHS=arm64";; # tvOS only supports arm64
    "watch_generic" ) XC_DESTINATION="generic/platform=watchOS" XC_MACROS="${XC_MACROS} ARCHS=arm64";; # watchOS only supports arm64
  esac

  case "$ACTION" in
    "build" ) XC_ACTION="build";;
    "analyze" )
      XC_ACTION="analyze"
      XC_MACROS="${XC_MACROS} CLANG_ANALYZER_OUTPUT=plist-html CLANG_ANALYZER_OUTPUT_DIR=\"$(pwd)/clang\""
    ;;
    "unit_test" ) XC_ACTION="test -only-testing:UnitTests";;
    "tv_unit_test" ) XC_ACTION="test -only-testing:UnitTests_tvOS";;
  esac

  case "$SDK" in
    "sim" ) XC_SDK="iphonesimulator";;
    "device" ) XC_SDK="iphoneos";;
    "tv_sim" ) XC_SDK="appletvsimulator";;
    "tv_device" ) XC_SDK="appletvos";;
    "watch_sim" ) XC_SDK="watchsimulator";;
    "watch_device" ) XC_SDK="watchos";;
    *) echo "Unknown SDK"; exit 1 ;;
  esac

  case "${CODE_SIGN:-}" in
    "no" ) XC_MACROS="${XC_MACROS} CODE_SIGNING_ALLOWED=NO";;
  esac
}

function analyze() {
  xcbuild
  if [[ -z $(find clang -name "*.html") ]]; then
    echo "Static Analyzer found no issues"
  else
    echo "Static Analyzer found some issues"
    exit 1
  fi
}

function xcbuild() {
    XC_BUILD_ARGS=(-project "WebDriverAgent.xcodeproj")
    XC_BUILD_ARGS+=(-scheme "$XC_TARGET")
    XC_BUILD_ARGS+=(-sdk "$XC_SDK")
    XC_BUILD_ARGS+=($XC_ACTION)
    if [[ -n "$XC_DESTINATION" ]]; then
      XC_BUILD_ARGS+=(-destination "${XC_DESTINATION}")
    fi
    if [[ -n "$DERIVED_DATA_PATH" ]]; then
      XC_BUILD_ARGS+=(-derivedDataPath ${DERIVED_DATA_PATH})
    fi
    XC_BUILD_ARGS+=($XC_MACROS $EXTRA_XC_ARGS)

    run_xcodebuild "${XC_BUILD_ARGS[@]}"
}

# Runs xcodebuild, retrying a few times on the intermittent simulator lookup failure.
function run_xcodebuild() {
    local output_command=cat attempt=1 max_attempts=3 log status
    if [ $(which xcpretty) ] ; then
        output_command=xcpretty
    fi
    log="$(mktemp)"
    while true; do
        set +e
        xcodebuild "$@" 2>&1 | tee "$log" | $output_command
        status=${PIPESTATUS[0]}
        set -e
        if [[ $status -ne 0 && $attempt -lt $max_attempts ]] && grep -q "Unable to find a device matching" "$log"; then
            echo "Simulator lookup failed (attempt $attempt/$max_attempts), retrying"
            xcrun simctl list devices available
            sleep 15
            attempt=$((attempt + 1))
            continue
        fi
        exit $status
    done
}

# Builds the xctest bundles of all TEST_SCHEMES once into DERIVED_DATA_PATH (generic simulator
# destination, so no simulator is needed); fastlane_test later runs them without rebuilding.
function build_for_testing() {
  local generic
  case "$SDK" in
    "sim" ) generic="generic/platform=iOS Simulator";;
    "tv_sim" ) generic="generic/platform=tvOS Simulator";;
    "watch_sim" ) generic="generic/platform=watchOS Simulator";;
    * ) echo "Unsupported SDK for build_for_testing"; exit 1;;
  esac
  for scheme in $TEST_SCHEMES; do
    # CI is baked into the .xctestrun (scheme env), see Fastlane/Fastfile
    ( run_xcodebuild -project "WebDriverAgent.xcodeproj" -scheme "$scheme" -sdk "$XC_SDK" \
        -destination "$generic" -derivedDataPath "$DERIVED_DATA_PATH" \
        CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=NO CI=true build-for-testing )
  done
  merge_xctestruns
}

# Merges the per-scheme .xctestrun files into one (xctestrun format 1 is a plain dictionary keyed
# by test bundle), so a chunk can run tests from several bundles in a single xcodebuild run.
function merge_xctestruns() {
  python3 - "$DERIVED_DATA_PATH/Build/Products" <<'PY'
import glob, plistlib, sys
products = sys.argv[1]
files = sorted(f for f in glob.glob(products + '/*.xctestrun') if '/WDAMerged_' not in f)
if len(files) < 2:
    sys.exit(0)
merged = {}
for f in files:
    with open(f, 'rb') as fh:
        data = plistlib.load(fh)
    merged.update({k: v for k, v in data.items() if k != '__xctestrun_metadata__'})
    merged.setdefault('__xctestrun_metadata__', data['__xctestrun_metadata__'])
with open(files[0].replace('/IntegrationTests_', '/WDAMerged_', 1), 'wb') as fh:
    plistlib.dump(merged, fh)
PY
}

# Runs the TEST_PLAN ("<bundle>:<Class>[/test],<Class>... <bundle>:..."), a subset of the prebuilt
# test bundles, in a single xcodebuild run.
function int_test_plan() {
  local only="" entry bundle item
  if [[ -z "${TEST_PLAN:-}" || -z "${DERIVED_DATA_PATH:-}" ]]; then
    echo "TEST_PLAN and DERIVED_DATA_PATH (with the prebuilt tests) are required"; exit 1
  fi
  for entry in $TEST_PLAN; do
    bundle="${entry%%:*}"
    for item in ${entry#*:}; do
      only+="${only:+,}$bundle/${item//,/,$bundle/}"
    done
  done
  ONLY_TESTING="$only" fastlane_test "${TEST_PLAN%%:*}" WDAMerged
}

function fastlane_test() {
  # Skip bundle install if already installed (CI already does this)
  if ! bundle check &>/dev/null; then
    bundle install
  fi

  case "${DEST:-}" in
    "iphone" )
      FASTLANE_DEVICE="$(echo $IPHONE_MODEL | tr -d "'") ($IOS_VERSION)"
      ;;
    "ipad" )
      FASTLANE_DEVICE="$(echo $IPAD_MODEL | tr -d "'") ($IOS_VERSION)"
      ;;
    "tv" )
      FASTLANE_DEVICE="$(echo $TV_MODEL | tr -d "'") ($TV_VERSION)"
      ;;
    "watch" )
      FASTLANE_DEVICE="$(echo $WATCH_MODEL | tr -d "'") ($WATCH_VERSION)"
      ;;
    * )
      echo "Error: Unknown DEST value '${DEST:-}'. DEST must be one of: iphone, ipad, tv, watch"
      exit 1
      ;;
  esac

  echo "Fastlane environment variables:"
  echo "  DEVICE=$FASTLANE_DEVICE"
  echo "  SCHEME=$1"
  echo "  SDK=$XC_SDK"

  # Prebuilt products (see build_for_testing): run them without rebuilding
  local xctestrun=""
  if [[ -n "${DERIVED_DATA_PATH:-}" ]]; then
    xctestrun="$(ls "$DERIVED_DATA_PATH"/Build/Products/"${2:-$1}"_*.xctestrun 2>/dev/null | head -n 1)"
    [[ -n "$xctestrun" ]] && echo "  XCTESTRUN=$xctestrun"
  fi

  XCTESTRUN="$xctestrun" SDK="$XC_SDK" DEVICE="$FASTLANE_DEVICE" SCHEME="$1" bundle exec fastlane test
}

define_xc_macros
case "$ACTION" in
  "analyze" ) analyze ;;
  "build_for_testing" ) build_for_testing ;;
  "int_test" ) int_test_plan ;;
  "tv_int_test" ) fastlane_test IntegrationTests_tvOS ;;
  # Like the iOS/tvOS integration tests, this launches the app under test in-process via
  # XCUIApplication rather than driving a separately running WDA server over HTTP.
  "watch_int_test" ) fastlane_test IntegrationTests_watchOS ;;
  *) xcbuild ;;
esac
