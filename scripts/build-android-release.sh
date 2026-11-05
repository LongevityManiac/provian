#!/usr/bin/env bash
#
# Leak-free Android release build.
#
# WHY THIS EXISTS: `eas build --local` hands the launch keystore + its passwords
# to eas-cli-local-build-plugin as a single base64 CLI argument. That argument is
# visible in `ps` / `pgrep -fl` for the life of the build AND is dumped verbatim
# into the plugin's log when a build FAILS. Both happened on 2026-09-20. This
# script signs the release APK by driving Gradle directly, which reads the
# keystore from a FILE (android/keystore.properties, gitignored) — so the key
# and its passwords never appear in any process argument or any build log.
#
# ONE-TIME SETUP (never commit either file):
#   1. Place the launch keystore somewhere gitignored, e.g. android/app/launch.keystore
#      (via `eas credentials` → download, or `keytool` for a fresh key).
#   2. Create android/keystore.properties (gitignored) with:
#         storeFile=app/launch.keystore
#         storePassword=...
#         keyAlias=...
#         keyPassword=...
#      storeFile is resolved relative to the android/ directory.
#
# Then run this script. If android/keystore.properties is absent, the release
# buildType falls back to debug signing (see android/app/build.gradle), so a
# distributable APK REQUIRES the properties file to be present.
#
# TWO CHANNELS, ONE NUMBERING:
#   scripts/build-android-release.sh            the website APK (USDC payments, checks for a newer APK)
#   scripts/build-android-release.sh --play     the Google Play bundle (.aab: in-app purchases, no APK check)
# Both take their versionCode from app.json, and each must be higher than every versionCode an
# earlier Android build used (android/release-version-codes.json, scripts/android-version-ledger.mjs),
# so the two channels can never collide. Bump the versionCode between the two builds.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$REPO_ROOT/android"
PROPS="$ANDROID_DIR/keystore.properties"

CHANNEL=website
if [[ "${1:-}" == "--play" ]]; then
  CHANNEL=play
  shift
fi

# What `expo prebuild` writes (app.json: googleServicesFile in config/firebase/, android.versionCode)
# must equal what this build ships from the committed android/ tree, or the two would differ.
"$REPO_ROOT/scripts/check-prebuild-sources-sync.sh" "$REPO_ROOT"

if [[ ! -f "$PROPS" ]]; then
  echo "ERROR: $PROPS not found." >&2
  echo "This script produces a launch-signed release APK and needs the keystore" >&2
  echo "properties file (gitignored). See the header of this script for setup." >&2
  exit 1
fi

# ANDROID_HOME / SDK location. Honor an existing env, else the common default.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

VERSION_CODE="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).expo.android.versionCode))' "$REPO_ROOT/app.json")"
node "$REPO_ROOT/scripts/android-version-ledger.mjs" check "$VERSION_CODE"

# The channel is inlined into the JS bundle at bundle time, so a cached transform from the other
# channel's build must not be reused.
export EXPO_PUBLIC_DISTRIBUTION="$CHANNEL"
EXPO_PUBLIC_BUILD_PROVENANCE="$(node "$REPO_ROOT/scripts/bundle-provenance.mjs" stamp "$CHANNEL")"
export EXPO_PUBLIC_BUILD_PROVENANCE
# Metro's cache and Gradle's bundle outputs are independent. Missing outputs plus no build cache
# force the bundle task to execute for this source/channel, rather than restore earlier bytes.
rm -rf "$ANDROID_DIR/app/build/generated/assets/react/release" \
  "$ANDROID_DIR/app/build/generated/assets/createBundleReleaseJsAndAssets" \
  "$ANDROID_DIR/app/build/generated/res/createBundleReleaseJsAndAssets" \
  "$ANDROID_DIR/app/build/generated/res/react/release" \
  "$ANDROID_DIR/app/build/generated/sourcemaps/react/release" \
  "$ANDROID_DIR/app/build/intermediates/sourcemaps/react/release"
rm -rf "${TMPDIR:-/tmp}"/metro-* "$REPO_ROOT/node_modules/.cache/metro"

cd "$ANDROID_DIR"

# Gradle reads the keystore from the properties FILE (never argv). The keystore
# path/passwords are NOT passed as -P properties or CLI args, so they cannot
# surface in `ps` or in Gradle's own log output. Build flags (PNG crunch, etc.)
# come from android/gradle.properties — do NOT override them here (some bundled
# assets are JPEG data with a .png name, which AAPT's PNG cruncher rejects, so
# the project intentionally keeps android.enablePngCrunchInReleaseBuilds=false).
if [[ "$CHANNEL" == "play" ]]; then
  ./gradlew :app:bundleRelease --no-build-cache "$@"
  AAB="$ANDROID_DIR/app/build/outputs/bundle/release/app-release.aab"
  if [[ ! -f "$AAB" ]]; then
    echo "Build finished but expected AAB not found at $AAB" >&2
    exit 1
  fi
  # The bundle is signed with the launch key: Play App Signing takes it as "use existing key",
  # so Play installs and website-APK installs share one certificate.
  if ! node "$REPO_ROOT/scripts/check-android-signing-registration.mjs" "$AAB"; then
    rm -f "$AAB"
    echo "Release AAB deleted: its signing key is not registered (see above)." >&2
    exit 1
  fi
  node "$REPO_ROOT/scripts/bundle-provenance.mjs" verify "$AAB" "$EXPO_PUBLIC_BUILD_PROVENANCE" | tee "$AAB.provenance.json"
  node "$REPO_ROOT/scripts/android-version-ledger.mjs" record "$VERSION_CODE" play "$AAB"
  echo ""
  echo "Release AAB (Google Play, versionCode $VERSION_CODE): $AAB"
  exit 0
fi

./gradlew :app:assembleRelease --no-build-cache "$@"

APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
if [[ -f "$APK" ]]; then
  # The signer must be the key Google (OAuth client → Drive backup/recovery) and the
  # website (assetlinks) know. A mismatch fails Google Sign-In with status 10 on every
  # phone — it shipped silently after the 2026-09-20 key rotation. Refuse and delete the
  # APK so an unregistered build can never be installed.
  if ! node "$REPO_ROOT/scripts/check-android-signing-registration.mjs" "$APK"; then
    rm -f "$APK"
    echo "Release APK deleted: its signing key is not registered (see above)." >&2
    exit 1
  fi
  node "$REPO_ROOT/scripts/bundle-provenance.mjs" verify "$APK" "$EXPO_PUBLIC_BUILD_PROVENANCE" | tee "$APK.provenance.json"
  node "$REPO_ROOT/scripts/android-version-ledger.mjs" record "$VERSION_CODE" website "$APK"
  echo ""
  echo "Release APK (website, versionCode $VERSION_CODE): $APK"
  echo "Verify signature with: \$ANDROID_HOME/build-tools/*/apksigner verify --print-certs \"$APK\""
else
  echo "Build finished but expected APK not found at $APK" >&2
  exit 1
fi
