#!/usr/bin/env bash
# Publish a signed release APK to the site's release bucket, where every site
# build fetches it from.
#
#   provian-website/scripts/publish-android-apk.sh [path/to/app-release.apk]
#
# The default path is the output of scripts/build-android-release.sh. The APK must
# be signed with the registered launch key. It is stored once, by content, as
# gs://provian-ai-release-apks/android/<sha256>.apk and never overwritten, so a
# page restamp is the only thing that changes which APK the site serves. After
# publishing, stamp the printed values into src/app/download/android/page.tsx,
# set latestVersionCode in public/.well-known/provian-app-version.json, commit,
# and run deploy-site.sh. A build whose page names an unpublished hash fails.
set -euo pipefail

BUCKET=provian-ai-release-apks
repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
apk="${1:-$repo_root/android/app/build/outputs/apk/release/app-release.apk}"

[ -f "$apk" ] || { echo "APK not found: $apk" >&2; exit 1; }
node "$repo_root/scripts/check-android-signing-registration.mjs" "$apk"

sha="$(shasum -a 256 "$apk" | cut -d' ' -f1)"
bytes="$(wc -c < "$apk" | tr -d ' ')"
object="gs://${BUCKET}/android/${sha}.apk"

gcloud storage cp --no-clobber "$apk" "$object"
stored="$(gcloud storage objects describe "$object" --format='value(size)')"
[ "$stored" = "$bytes" ] || { echo "Stored object is $stored bytes; the APK is $bytes" >&2; exit 1; }

echo "Published $object"
echo "Stamp into src/app/download/android/page.tsx:"
python3 -c "import sys; b=int(sys.argv[2]); print(f\"  const APK_SHA256 = '{sys.argv[1]}'\"); print(f\"  const APK_SIZE = '{b:,} bytes (≈{round(b / 1048576)} MB)'\")" "$sha" "$bytes"
echo "  const VERSION_CODE = <versionCode from android/app/build.gradle>"
