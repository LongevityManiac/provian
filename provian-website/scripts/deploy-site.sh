#!/usr/bin/env bash
# Build, deploy, and purge: the one command that ships provian.ai.
#
#   provian-website/scripts/deploy-site.sh                 (run from anywhere in the repo)
#   provian-website/scripts/deploy-site.sh --review-open   (same, with the review-open switch ON)
#   provian-website/scripts/deploy-site.sh --purge-only
#
# REVIEW-OPEN SWITCH (default OFF). Without --review-open every deploy builds the
# walled site: only /privacy, /terms, /home, /daemon and /.well-known/ answer
# without the preview password. With --review-open the image also serves, without
# the password, exactly the store-review open set in provian-website/review-open.json
# (the URLs the app opens or shares, the store records' support, privacy and
# account-deletion URLs, and exactly the files those pages load); every other URL
# still answers 401. The switch lives in the image, so it stays ON until the next
# deploy without the flag turns it OFF. Before deploying a change to the set, prove
# it on a local build: provian-website/scripts/crawl-review-open.mjs (usage in its
# header) builds nothing itself; it crawls a running local image in either mode.
#
# 1. Builds the provian-site image with Cloud Build, inheriting the Basic-Auth
#    gate (only its bcrypt hash) from the revision that is serving now, so a
#    deploy never changes the gate password. The build fetches the Android APK
#    the /download/android page names from the release bucket and fails, so
#    nothing deploys, if that APK is missing or its hash does not match.
# 2. Deploys it to Cloud Run (provian-site, us-central1), over end-to-end HTTP/2
#    so responses over 32 MiB (the films) are not refused; see nginx.conf.
# 3. Purges Cloudflare's cache for the provian.ai zone, so visitors see the new
#    site at once. Cloudflare sits in front of the site and caches what nginx
#    marks shareable (see the edge-caching map in nginx.conf). The token lives
#    in Secret Manager and is read with the same gcloud login the deploy needs,
#    so a deploy nobody is watching still purges; a 1Password read would wait on
#    a Touch ID prompt and time out. It is never printed and never placed on a
#    command line.
#
# Before building anything, a deploy proves the token can purge this zone and
# stops if it cannot, so nothing ships that cannot be purged. If the final purge
# still fails after retries, the deploy stands, the script exits non-zero, and
# the edge lifetimes in nginx.conf bound staleness (60 s for pages, a day for
# films) until --purge-only succeeds.
set -euo pipefail

PROJECT=provian-ai
REGION=us-central1
SERVICE=provian-site
IMAGE=us-central1-docker.pkg.dev/provian-ai/cloud-run-source-deploy/provian-site:dark-redesign
ZONE_ID=bfff1c7c00b580cf1fc63f5750f74bb6
CF_TOKEN_SECRET=cloudflare-cache-purge-token
PURGE_ATTEMPTS=3

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

purge_token=""

load_purge_token() {
  if ! purge_token="$(gcloud secrets versions access latest --secret "$CF_TOKEN_SECRET" --project "$PROJECT")" \
    || [ -z "$purge_token" ]; then
    echo "Could not read the purge token from Secret Manager secret ${CF_TOKEN_SECRET}." >&2
    return 1
  fi
}

# The token reaches curl on stdin: ps shows a process's arguments, not its stdin.
cloudflare_purge() {
  printf 'header = "Authorization: Bearer %s"\n' "$purge_token" \
    | curl -sS --max-time 30 --config - -X POST \
        "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache" \
        -H 'Content-Type: application/json' --data "$1" \
    | python3 -c '
import json, sys
try:
    response = json.load(sys.stdin)
except ValueError:
    sys.exit("Cloudflare did not answer with JSON.")
if not response.get("success"):
    sys.exit("Cloudflare refused the purge: %s" % response.get("errors"))
'
}

# Purging one URL nothing serves costs nothing and exercises the real permission.
require_purge() {
  if ! load_purge_token || ! cloudflare_purge '{"files":["https://provian.ai/.deploy-purge-check"]}'; then
    echo "Refusing to deploy: this deploy could not purge the cache afterwards. Nothing was changed." >&2
    exit 1
  fi
}

purge() {
  local attempt
  for attempt in $(seq 1 "$PURGE_ATTEMPTS"); do
    if cloudflare_purge '{"purge_everything":true}'; then
      echo "Cloudflare cache purged"
      return 0
    fi
    [ "$attempt" -eq "$PURGE_ATTEMPTS" ] || sleep "$((attempt * 5))"
  done
  echo "PURGE FAILED after ${PURGE_ATTEMPTS} attempts. Pages refresh within 60 s on their own; run '$0 --purge-only' to purge now." >&2
  return 1
}

review_open=off
case "${1:-}" in
  --purge-only)
    load_purge_token
    purge
    exit $?
    ;;
  --review-open)
    review_open=on
    ;;
  "")
    ;;
  *)
    echo "Unknown argument: $1 (expected --review-open, --purge-only, or nothing)" >&2
    exit 2
    ;;
esac
echo "Review-open switch: ${review_open}"

require_purge

live_revision="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.latestReadyRevisionName)')"
live_digest="$(gcloud run revisions describe "$live_revision" --project "$PROJECT" --region "$REGION" --format='value(status.imageDigest)')"
[ -n "$live_digest" ] || { echo "Could not read the live image digest; aborting so the gate is not changed." >&2; exit 1; }
echo "Inheriting the gate from ${live_revision}"

cd "$repo_root"
gcloud builds submit --project "$PROJECT" \
  --config provian-website/cloudbuild.deploy.yaml \
  --substitutions=_HTPASSWD_SOURCE_IMAGE="$live_digest",_REVIEW_OPEN="$review_open" \
  --ignore-file=.gcloudignore.website .
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$IMAGE" --use-http2 --quiet

purge
