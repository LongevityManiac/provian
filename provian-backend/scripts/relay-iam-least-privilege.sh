#!/usr/bin/env bash
# the relay's runtime account holds ONLY what the relay uses. Idempotent: re-running it
# re-applies the same bindings and removes the broad ones again. Run as a project owner.
#
# The relay (Cloud Run `provian-api`) runs as the project's default compute account, which is also
# the Cloud Build account every `gcloud run deploy --source` builds as. It keeps that identity
# for product runtime and builds. Operator services use separate identities.
#   project   roles/datastore.user                         product data
#   project   projects/provian-ai/roles/provianRelayRuntime  export + FCM send
#   project   roles/logging.logWriter                      build + runtime logs
#   secrets   roles/secretmanager.secretAccessor           ONLY mounted product secrets
#   archive   projects/provian-ai/roles/provianArchiveCreateOnly  create once + read
#   build     source buckets objectViewer, artifactregistry.writer
# It holds no Editor, no firebase.admin, no importExportAdmin, no project-wide secret access, so it
# cannot delete the database or change its deletion protection / PITR, cannot delete or overwrite
# exports or Archive objects or change either bucket, and cannot disable or destroy a secret version.
# The Firestore service agent writes exports through provianFirestoreExportWriter (no delete), so an
# export can never be written over an existing one either.
#
# A NEW secret mounted on provian-api needs its own accessor grant (re-run this script after the
# mount exists, or grant it first); Cloud Run refuses the revision until it has one.
#   bash provian-backend/scripts/relay-iam-least-privilege.sh
set -euo pipefail

P=provian-ai
SA=185909722463-compute@developer.gserviceaccount.com
C="serviceAccount:$SA"
FSA="serviceAccount:service-185909722463@gcp-sa-firestore.iam.gserviceaccount.com"

role() { # id title description permissions
  if gcloud iam roles describe "$1" --project "$P" >/dev/null 2>&1; then
    gcloud iam roles update "$1" --project "$P" --title "$2" --description "$3" --permissions "$4" --quiet --format=none
  else
    gcloud iam roles create "$1" --project "$P" --title "$2" --description "$3" --permissions "$4" --stage GA --format=none
  fi
}
role provianRelayRuntime "Provian relay runtime" \
  "Product runtime only : weekly Firestore export and FCM send. No operator collector APIs or database/bucket/secret administration." \
  datastore.databases.export,datastore.operations.get,datastore.operations.list,cloudmessaging.messages.create
role provianArchiveCreateOnly "Provian Archive create-only" \
  "Create an object once and read it; no delete, overwrite, compose, or bucket change." \
  storage.objects.create,storage.objects.get
role provianFirestoreExportWriter "Firestore export writer (no overwrite)" \
  "Firestore service agent on the export bucket: write new export files, list and read them for import; no delete, so an existing export cannot be overwritten." \
  storage.buckets.get,storage.objects.create,storage.objects.list,storage.objects.get

for r in roles/datastore.user "projects/$P/roles/provianRelayRuntime" roles/logging.logWriter; do
  gcloud projects add-iam-policy-binding "$P" --member "$C" --role "$r" --condition=None --format=none
done
MOUNTED=$(gcloud run services describe provian-api --region us-central1 --project "$P" \
    --format=json | python3 -c "import json,sys;c=json.load(sys.stdin)['spec']['template']['spec']['containers'][0];print('\n'.join(sorted({e['valueFrom']['secretKeyRef']['name'] for e in c.get('env',[]) if 'valueFrom' in e})))")
for s in $MOUNTED; do
  gcloud secrets add-iam-policy-binding "$s" --project "$P" --member "$C" --role roles/secretmanager.secretAccessor --format=none
done
# and NO other secret. A per-secret grant on a secret the relay does not mount is a route to
# another identity (harness-catalog-signing-key signs the daemon releases the agents run).
for s in $(gcloud secrets list --project "$P" --format='value(name.basename())'); do
  echo "$MOUNTED" | grep -qx "$s" && continue
  if gcloud secrets get-iam-policy "$s" --project "$P" --format=json | grep -q "\"$C\""; then
    gcloud secrets remove-iam-policy-binding "$s" --project "$P" --member "$C" --role roles/secretmanager.secretAccessor --format=none
  fi
done
gcloud storage buckets add-iam-policy-binding gs://provian-ai-pe-archive --member "$C" --role "projects/$P/roles/provianArchiveCreateOnly" --format=none
gcloud storage buckets remove-iam-policy-binding gs://provian-ai-relay-exports --member "$C" --role roles/storage.objectViewer --format=none 2>/dev/null || true
# The relay creates immutable multipart manifests; it cannot overwrite or delete them.
gcloud storage buckets add-iam-policy-binding gs://provian-ai-relay-exports --member "$C" --role roles/storage.objectCreator --format=none
gcloud storage buckets add-iam-policy-binding gs://provian-ai-relay-exports --member "$FSA" --role "projects/$P/roles/provianFirestoreExportWriter" --format=none
for b in run-sources-provian-ai-us-central1 provian-ai_cloudbuild; do
  gcloud storage buckets add-iam-policy-binding "gs://$b" --member "$C" --role roles/storage.objectViewer --format=none
done
gcloud artifacts repositories add-iam-policy-binding cloud-run-source-deploy --location us-central1 --project "$P" --member "$C" --role roles/artifactregistry.writer --format=none
# Remove the former operator billing-reader grant while preserving every other ACL.
tmp=$(mktemp)
bq show --format=prettyjson "$P:billing_export" | python3 -c "
import json,sys;d=json.load(sys.stdin);print(json.dumps({'access':[a for a in d['access'] if a.get('userByEmail')!='$SA']}))" > "$tmp"
bq update --source "$tmp" "$P:billing_export"; rm -f "$tmp"
# Firebase project `provian` requires its owner's credentials; remove the former
# relay rules-viewer binding there during cutover. This script grants none.

# The broad grants this replaces. remove-iam-policy-binding fails when the binding is already gone.
for r in roles/editor roles/firebase.admin roles/datastore.importExportAdmin roles/secretmanager.secretAccessor; do
  gcloud projects remove-iam-policy-binding "$P" --member "$C" --role "$r" --condition=None --format=none 2>/dev/null || true
done
gcloud storage buckets remove-iam-policy-binding gs://provian-ai-pe-archive --member "$C" --role roles/storage.objectAdmin --format=none 2>/dev/null || true
gcloud storage buckets remove-iam-policy-binding gs://provian-ai-relay-exports --member "$FSA" --role roles/storage.admin --format=none 2>/dev/null || true
# a 365-day UNLOCKED retention policy on the export bucket, matching its 365-day
# lifecycle and Archive-class minimum billing. No export younger than a year can be deleted or
# replaced by anyone, including the Firestore service agent (which holds storage.objects.delete).
# The Archive bucket deliberately has none: no export can produce a `.pea` object name.
gcloud storage buckets update gs://provian-ai-relay-exports --retention-period=31536000s --format=none
# the legacy default Cloud Build account runs no build here (every build runs as the account
# above) and holds no role, so it holds none of the powers above either.
gcloud projects remove-iam-policy-binding "$P" --member serviceAccount:185909722463@cloudbuild.gserviceaccount.com --role roles/cloudbuild.builds.builder --condition=None --format=none 2>/dev/null || true

echo "relay runtime account project roles:"
gcloud projects get-iam-policy "$P" --flatten='bindings[].members' --filter="bindings.members:$SA" --format='value(bindings.role)'
