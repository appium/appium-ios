#!/bin/bash

# Test script for ios-simulator
# Intended to run in GitHub Actions CI 

# Exit on error. Append "|| true" if you expect an error.
set -o errexit
# Exit on error inside any functions or subshells.
set -o errtrace
# Do not allow use of undefined vars. Use ${VAR:-} to use an undefined VAR
set -o nounset

export _FORCE_LOGS=1

printf "XCODE_VERSION: %s\n" "${XCODE_VERSION:?
ERROR: XCODE_VERSION env var is missing}"
printf "MOBILE_DEVICE_NAME: %s\n" "${MOBILE_DEVICE_NAME:?
ERROR: MOBILE_DEVICE_NAME env var is missing}"
printf "MOBILE_OS_VERSION: %s\n" "${MOBILE_OS_VERSION:?
ERROR: MOBILE_OS_VERSION env var is missing}"

sudo xcode-select --switch "/Applications/Xcode_${XCODE_VERSION}.app/Contents/Developer"
npm run test:ios-simulator
npm run test:e2e:ios-simulator
