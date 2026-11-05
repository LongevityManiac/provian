#!/usr/bin/env bash
# Fresh, source-bound iOS archive; Xcode account supplies the existing signing identity.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_PATH="${1:?usage: build-ios-release.sh /absolute/path.xcarchive [xcodebuild arguments]}"
shift
cd "$REPO_ROOT"
export EXPO_PUBLIC_DISTRIBUTION=ios
EXPO_PUBLIC_BUILD_PROVENANCE="$(node scripts/bundle-provenance.mjs stamp ios)"
export EXPO_PUBLIC_BUILD_PROVENANCE
export FORCE_BUNDLING=1
export EXTRA_PACKAGER_ARGS=--reset-cache
unset SKIP_BUNDLING
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
# A dedicated DerivedData directory ensures no earlier main.jsbundle can be copied into the archive.
xcodebuild -workspace ios/Provian.xcworkspace -scheme Provian -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE_PATH" \
  -derivedDataPath "$ARCHIVE_PATH-derived-data" "$@" archive -allowProvisioningUpdates
node scripts/bundle-provenance.mjs verify "$ARCHIVE_PATH/Products/Applications/Provian.app" "$EXPO_PUBLIC_BUILD_PROVENANCE" | tee "$ARCHIVE_PATH.provenance.json"
