#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/prelaunch-apk-sanity.sh --apk path/to/sideload.apk [--play-apk path/to/play.apk]

Checks the C2 Android launch gate:
  - BlockstoreClient must be absent from dex strings.
  - DriveScopes must be present in dex strings.
  - apksigner must verify the APK and print certificate details.
  - If --play-apk is provided, signing certificate SHA-256 digests must match.
EOF
}

APK=""
PLAY_APK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk)
      APK="$2"
      shift 2
      ;;
    --play-apk)
      PLAY_APK="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$APK" ]]; then
  echo "Missing --apk" >&2
  usage >&2
  exit 2
fi

if [[ ! -f "$APK" ]]; then
  echo "APK not found: $APK" >&2
  exit 2
fi

if [[ -n "$PLAY_APK" && ! -f "$PLAY_APK" ]]; then
  echo "Play APK not found: $PLAY_APK" >&2
  exit 2
fi

APKSIGNER="${APKSIGNER:-$HOME/Library/Android/sdk/build-tools/36.0.0/apksigner}"
if [[ ! -x "$APKSIGNER" ]]; then
  APKSIGNER="$(command -v apksigner || true)"
fi
if [[ -z "$APKSIGNER" || ! -x "$APKSIGNER" ]]; then
  echo "apksigner not found. Set APKSIGNER=/path/to/apksigner." >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

extract_strings() {
  local apk="$1"
  local out="$2"
  unzip -p "$apk" 'classes*.dex' | strings > "$out"
}

cert_digest() {
  local apk="$1"
  "$APKSIGNER" verify --print-certs "$apk" \
    | awk -F': ' '/Signer #1 certificate SHA-256 digest/ {print $2; exit}'
}

echo "APK: $APK"
extract_strings "$APK" "$tmp/apk.strings"

if grep -q 'BlockstoreClient' "$tmp/apk.strings"; then
  echo "FAIL: BlockstoreClient found in APK dex strings." >&2
  exit 1
fi
echo "PASS: BlockstoreClient absent"

if ! grep -q 'DriveScopes' "$tmp/apk.strings"; then
  echo "FAIL: DriveScopes not found in APK dex strings." >&2
  exit 1
fi
echo "PASS: DriveScopes present"

"$APKSIGNER" verify --print-certs "$APK" > "$tmp/apk.apksigner"
echo "PASS: apksigner verified sideload APK"
grep 'Signer #1 certificate SHA-256 digest' "$tmp/apk.apksigner" || true

if [[ -n "$PLAY_APK" ]]; then
  echo "Play APK: $PLAY_APK"
  "$APKSIGNER" verify --print-certs "$PLAY_APK" > "$tmp/play.apksigner"
  sideload_digest="$(cert_digest "$APK")"
  play_digest="$(cert_digest "$PLAY_APK")"
  if [[ -z "$sideload_digest" || -z "$play_digest" ]]; then
    echo "FAIL: could not extract signing certificate digest from one APK." >&2
    exit 1
  fi
  if [[ "$sideload_digest" != "$play_digest" ]]; then
    echo "FAIL: signing certificate mismatch." >&2
    echo "sideload: $sideload_digest" >&2
    echo "play:     $play_digest" >&2
    exit 1
  fi
  echo "PASS: sideload and Play APK signing certificates match"
fi

echo "C2 APK sanity checks passed."
