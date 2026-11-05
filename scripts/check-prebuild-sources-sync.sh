#!/usr/bin/env bash
#
# The Firebase configs app.json names as googleServicesFile live in config/firebase/, OUTSIDE
# android/ and ios/, because `expo prebuild --clean` deletes both native dirs before it copies the
# files in (L326). The committed native trees still carry their own copies (the release APK builds
# from android/ via Gradle, the iOS build from Xcode), so each pair must stay byte-identical: a
# drifted copy would ship one Firebase config from a prebuild and another from the committed tree.
#
# The same holds for the Android versionCode: app.json's android.versionCode is what a prebuild
# writes, android/app/build.gradle's is what this build ships. Bump both together.
#
# Usage: scripts/check-prebuild-sources-sync.sh [repo-root]   (exit 0 = in sync, 1 = drift/missing)
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
status=0
check_pair() {
  local source="$ROOT/$1" native="$ROOT/$2"
  if [[ ! -f "$source" || ! -f "$native" ]]; then
    echo "ERROR: missing Google services file: $([[ -f "$source" ]] || echo "$1 ")$([[ -f "$native" ]] || echo "$2")" >&2
    status=1
  elif ! cmp -s "$source" "$native"; then
    echo "ERROR: $2 differs from $1 (app.json's googleServicesFile). Copy the live config to both." >&2
    status=1
  fi
}
check_pair config/firebase/google-services.json android/app/google-services.json
check_pair config/firebase/GoogleService-Info.plist ios/Provian/GoogleService-Info.plist

app_code="$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=a&&a.expo&&a.expo.android&&a.expo.android.versionCode;process.stdout.write(Number.isSafeInteger(v)?String(v):"")' "$ROOT/app.json" 2>/dev/null || true)"
gradle_code="$(sed -n 's/^[[:space:]]*versionCode[[:space:]]\{1,\}\([0-9]\{1,\}\)[[:space:]]*$/\1/p' "$ROOT/android/app/build.gradle" 2>/dev/null | head -1)"
if [[ -z "$app_code" || -z "$gradle_code" ]]; then
  echo "ERROR: cannot read the Android versionCode (app.json: '${app_code}', android/app/build.gradle: '${gradle_code}')" >&2
  status=1
elif [[ "$app_code" != "$gradle_code" ]]; then
  echo "ERROR: app.json android.versionCode ($app_code) != android/app/build.gradle versionCode ($gradle_code). Bump both." >&2
  status=1
fi
if [[ $status -eq 0 ]]; then echo "prebuild sources in sync (google services files, versionCode $app_code)"; fi
exit $status
