#!/usr/bin/env bash
# Build a ProvianForegroundHelper.app locally for development / CI.
#
# Produces a UNIVERSAL (arm64 + x86_64) binary by default, so the one .app runs
# natively on both Apple-silicon and Intel Macs. Cross-compiling the x86_64 slice
# on an Apple-silicon host needs the full macOS SDK (Xcode / Command Line Tools),
# which the dev machine and the macos-latest CI runner both have.
#
# Release signing, hardened runtime, notarization, and stapling live in
# a separate pre-beta release workflow. This script is dev/CI build only.
#
# Env vars:
#   DEBUG_BUILD=1        Build debug config instead of release.
#   HELPER_ARCHS="..."   Space-separated arch list (default "arm64 x86_64").
#                        e.g. HELPER_ARCHS=arm64 for a faster single-arch dev build.

set -euo pipefail

cd "$(dirname "$0")"

CONFIG="release"
if [[ "${DEBUG_BUILD:-}" == "1" ]]; then
  CONFIG="debug"
fi

ARCHS="${HELPER_ARCHS:-arm64 x86_64}"
ARCH_FLAGS=()
for a in $ARCHS; do
  ARCH_FLAGS+=(--arch "$a")
done

echo "[helper] swift build -c $CONFIG ${ARCH_FLAGS[*]}"
swift build -c "$CONFIG" "${ARCH_FLAGS[@]}"

APP="ProvianForegroundHelper.app"
# --show-bin-path reports the correct output dir for BOTH the single-arch
# (.build/<triple>/<config>) and the multi-arch (.build/apple/Products/<Config>)
# layouts, so we never hard-code the arch- or config-dependent path.
BIN_DIR="$(swift build -c "$CONFIG" "${ARCH_FLAGS[@]}" --show-bin-path)"
BIN_OUT="$BIN_DIR/ProvianForegroundHelper"

if [[ ! -x "$BIN_OUT" ]]; then
  echo "[helper] binary not found at $BIN_OUT" >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN_OUT" "$APP/Contents/MacOS/ProvianForegroundHelper"
cp Info.plist "$APP/Contents/Info.plist"

# Report the architectures actually shipped so a silently-single-arch build is
# visible in the log (e.g. if a runner lacks the x86_64 SDK).
if command -v lipo >/dev/null 2>&1; then
  echo "[helper] archs: $(lipo -archs "$APP/Contents/MacOS/ProvianForegroundHelper")"
fi

# Ad-hoc sign so the bundle has a stable-ish identity on this machine.
# No network, no Apple identity, no notarization. Real signing with
# Team ID L83XFY5S26 happens in the pre-beta release workflow.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$APP" 2>/dev/null && echo "[helper] ad-hoc signed"
fi

echo "[helper] built: $(pwd)/$APP"
echo "[helper] binary: $(pwd)/$APP/Contents/MacOS/ProvianForegroundHelper"
