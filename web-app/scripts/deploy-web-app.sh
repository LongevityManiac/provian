#!/usr/bin/env bash
# Build and ship app.provian.ai: the Provian app exported for the web.
#
#   web-app/scripts/deploy-web-app.sh            export, build the image, deploy, verify
#   web-app/scripts/deploy-web-app.sh --build    export and build the image only
#
# 1. Exports the Expo app for the web (`expo export -p web`) from the repo root into web-app/dist,
#    stamped with the commit it was built from. A dirty tree is refused, so the live app is always
#    a commit on master.
# 2. Builds the nginx image with Cloud Build and pushes it to Artifact Registry.
# 3. Deploys it to the Cloud Run service provian-app (us-central1), which app.provian.ai maps to,
#    and checks that the live page serves the new bundle.
set -euo pipefail
PROJECT=provian-ai
REGION=us-central1
SERVICE=provian-app
IMAGE_REPO=us-central1-docker.pkg.dev/provian-ai/cloud-run-source-deploy/provian-app

repo_root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$repo_root"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to build: the working tree has uncommitted changes." >&2
  exit 1
fi
commit="$(git rev-parse HEAD)"
short="${commit:0:12}"

rm -rf web-app/dist
EXPO_PUBLIC_BUILD_PROVENANCE="web:${commit}" npx expo export -p web --output-dir web-app/dist --clear
test -s web-app/dist/index.html
printf '{"commit":"%s","built_at":"%s"}\n' "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > web-app/dist/version.json

image="${IMAGE_REPO}:${short}"
gcloud builds submit web-app --project "$PROJECT" --tag "$image" --quiet

if [ "${1:-}" = "--build" ]; then
  echo "Built $image (not deployed)."
  exit 0
fi

gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" --image "$image" \
  --allow-unauthenticated --port 8080 --min-instances 0 --max-instances 5 \
  --cpu 1 --memory 256Mi --concurrency 200 --quiet

url="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
served="$(curl -fsS "$url/version.json")"
case "$served" in
  *"$commit"*) echo "Deployed $image; $url serves commit $commit." ;;
  *) echo "Deployed, but $url/version.json does not name $commit: $served" >&2; exit 1 ;;
esac
