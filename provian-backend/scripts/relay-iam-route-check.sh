#!/usr/bin/env bash
# prove, live, that every route from the relay's runtime account to ANOTHER identity is
# refused: impersonating or minting tokens/keys for any service account, running a Cloud Build,
# deploying a Cloud Run service/revision/job, creating a VM, creating a scheduler job, signing a
# daemon release, or planting build source. Each route: testIamPermissions first (the account holds
# none of the permissions), then a real call that must answer a 403 permission denial; a real call
# that could create something runs only after the first layer shows the permission absent.
#
# The one route that stays open BY DESIGN is Artifact Registry write on `cloud-run-source-deploy`
# (the relay's account is the project's Cloud Build account). It leads only to the runtime accounts
# of services whose images live there; this script prints them, and each must pass
# `relay-iam-refusal-check.sh <account>`.
#
# Needs an operator with Token Creator on the relay's account.
#   bash provian-backend/scripts/relay-iam-route-check.sh
set -euo pipefail

P=provian-ai
R=us-central1
SA=185909722463-compute@developer.gserviceaccount.com
T=$(gcloud auth print-access-token --impersonate-service-account="$SA" 2>/dev/null)
[ -n "$T" ] || { echo "cannot mint a token for $SA"; exit 2; }
WHO=$(curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$T" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("email",""))')
[ "$WHO" = "$SA" ] || { echo "FAIL token identity is '$WHO'"; exit 2; }
echo "== acting as $WHO"
H=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
fail=0
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT

PARSE='import json,sys
d=json.load(sys.stdin)
print("ERROR:"+json.dumps(d.get("error"))[:200] if "error" in d else (",".join(d.get("permissions",[])) or "none"))'
DENIAL='import json,sys
b=sys.stdin.read()
try: e=json.loads(b)
except Exception: e={"message":b}
e=e[0] if isinstance(e,list) and e else e
e=e.get("error",e) if isinstance(e,dict) else {"message":str(e)}
m=str(e.get("message","")) if isinstance(e,dict) else str(e)
ok=("ermission" in m or ("does not have" in m and "access" in m) or (isinstance(e,dict) and e.get("status")=="PERMISSION_DENIED")) and "SERVICE_DISABLED" not in b
print(m[:140].replace("\\n"," ") if ok else "NOT-A-PERMISSION-DENIAL (body withheld; keys: "+",".join(sorted(json.loads(b).keys()) if b.strip().startswith("{") else ["non-json"])+")")'
none_of() { # label url json-permissions
  local got; got=$(curl -s -X POST "${H[@]}" "$2" -d "{\"permissions\":$3}" | python3 -c "$PARSE")
  if [ "$got" = none ]; then echo "  holds none on $1"; else echo "FAIL holds $got on $1"; fail=1; fi
}
refused() { # label method url [body]
  local code
  if [ $# -ge 4 ]; then code=$(curl -s -o "$BODY" -w '%{http_code}' -X "$2" "${H[@]}" "$3" -d "$4")
  else code=$(curl -s -o "$BODY" -w '%{http_code}' -X "$2" "${H[@]}" "$3"); fi
  local why; why=$(python3 -c "$DENIAL" < "$BODY")
  if [ "$code" = 403 ] && [ "${why#NOT-A-PERMISSION-DENIAL}" = "$why" ]; then echo "  REFUSED 403  $1  ($why)"; else echo "FAIL $code  $1  ($why)"; fail=1; fi
}

echo "== project-level routes"
none_of "project $P" "https://cloudresourcemanager.googleapis.com/v1/projects/$P:testIamPermissions" '[
  "iam.serviceAccounts.actAs","iam.serviceAccounts.getAccessToken","iam.serviceAccounts.getOpenIdToken",
  "iam.serviceAccounts.signBlob","iam.serviceAccounts.signJwt","iam.serviceAccounts.implicitDelegation",
  "iam.serviceAccountKeys.create","iam.serviceAccounts.create","iam.serviceAccounts.setIamPolicy",
  "resourcemanager.projects.setIamPolicy","iam.roles.update","iam.roles.create",
  "cloudbuild.builds.create","cloudbuild.builds.update","cloudbuild.builds.approve",
  "run.services.create","run.services.update","run.services.setIamPolicy","run.jobs.create","run.jobs.update","run.jobs.run","run.jobs.runWithOverrides",
  "compute.instances.create","compute.instances.setServiceAccount","compute.instances.setMetadata",
  "cloudscheduler.jobs.create","cloudscheduler.jobs.update","pubsub.subscriptions.create","pubsub.topics.create",
  "deploymentmanager.deployments.create","bigquery.transfers.update","bigquery.connections.use",
  "firebase.projects.update","datastore.databases.import",
  "artifactregistry.repositories.setIamPolicy","artifactregistry.repositories.create","storage.buckets.create"]'
[ $fail = 0 ] || { echo "a route permission is present: real calls skipped"; exit 1; }

echo "== every service account in $P"
for A in $(gcloud iam service-accounts list --project "$P" --format='value(email)'); do
  none_of "$A" "https://iam.googleapis.com/v1/projects/$P/serviceAccounts/$A:testIamPermissions" \
    '["iam.serviceAccounts.actAs","iam.serviceAccounts.getAccessToken","iam.serviceAccounts.getOpenIdToken","iam.serviceAccounts.signBlob","iam.serviceAccounts.signJwt","iam.serviceAccounts.implicitDelegation","iam.serviceAccountKeys.create","iam.serviceAccounts.setIamPolicy"]'
  [ "$A" = "$SA" ] && continue
  refused "mint an access token as $A" POST "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$A:generateAccessToken" '{"scope":["https://www.googleapis.com/auth/cloud-platform"]}'
  refused "mint an ID token as $A" POST "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$A:generateIdToken" '{"audience":"https://api.provian.ai"}'
  refused "sign a blob as $A" POST "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$A:signBlob" '{"payload":"ZDU2MQ=="}'
  refused "create a key for $A" POST "https://iam.googleapis.com/v1/projects/$P/serviceAccounts/$A/keys" '{}'
done
[ $fail = 0 ] || { echo "an account route is open: build/deploy calls skipped"; exit 1; }

echo "== building, deploying, running as another identity"
for BSA in "$SA" "185909722463@cloudbuild.gserviceaccount.com" "provian-x402-facilitator@$P.iam.gserviceaccount.com"; do
  refused "run a Cloud Build as $BSA" POST "https://cloudbuild.googleapis.com/v1/projects/$P/builds" \
    "{\"steps\":[{\"name\":\"gcr.io/cloud-builders/gcloud\",\"args\":[\"version\"]}],\"serviceAccount\":\"projects/$P/serviceAccounts/$BSA\",\"options\":{\"logging\":\"CLOUD_LOGGING_ONLY\"}}"
done
refused "run a regional Cloud Build (default account)" POST "https://cloudbuild.googleapis.com/v1/projects/$P/locations/$R/builds" \
  '{"steps":[{"name":"gcr.io/cloud-builders/gcloud","args":["version"]}],"options":{"logging":"CLOUD_LOGGING_ONLY"}}'
refused "deploy a new Cloud Run service as provian-x402-facilitator" POST "https://run.googleapis.com/v2/projects/$P/locations/$R/services?serviceId=d561-route-probe" \
  "{\"template\":{\"serviceAccount\":\"provian-x402-facilitator@$P.iam.gserviceaccount.com\",\"containers\":[{\"image\":\"us-docker.pkg.dev/cloudrun/container/hello\"}]}}"
refused "deploy a revision of provian-api" PATCH "https://run.googleapis.com/v2/projects/$P/locations/$R/services/provian-api?validateOnly=true" \
  "{\"template\":{\"serviceAccount\":\"$SA\",\"containers\":[{\"image\":\"us-docker.pkg.dev/cloudrun/container/hello\"}]}}"
refused "create a Cloud Run job" POST "https://run.googleapis.com/v2/projects/$P/locations/$R/jobs?jobId=d561-route-probe" \
  "{\"template\":{\"template\":{\"serviceAccount\":\"$SA\",\"containers\":[{\"image\":\"us-docker.pkg.dev/cloudrun/container/job\"}]}}}"
refused "run a Cloud Run job (jobs.run)" POST "https://run.googleapis.com/v2/projects/$P/locations/$R/jobs/d561-route-probe:run" '{}'
refused "create a VM" POST "https://compute.googleapis.com/compute/v1/projects/$P/zones/$R-a/instances" \
  "{\"name\":\"d561-route-probe\",\"machineType\":\"zones/$R-a/machineTypes/e2-micro\",\"serviceAccounts\":[{\"email\":\"$SA\",\"scopes\":[\"https://www.googleapis.com/auth/cloud-platform\"]}],\"disks\":[{\"boot\":true,\"initializeParams\":{\"sourceImage\":\"projects/debian-cloud/global/images/family/debian-12\"}}],\"networkInterfaces\":[{\"network\":\"global/networks/default\"}]}"
refused "create a scheduler job" POST "https://cloudscheduler.googleapis.com/v1/projects/$P/locations/$R/jobs" \
  "{\"name\":\"projects/$P/locations/$R/jobs/d561-route-probe\",\"schedule\":\"0 0 1 1 *\",\"httpTarget\":{\"uri\":\"https://api.provian.ai/health\",\"oidcToken\":{\"serviceAccountEmail\":\"provian-scheduler@$P.iam.gserviceaccount.com\"}}}"
refused "read the daemon release-signing key" GET "https://secretmanager.googleapis.com/v1/projects/$P/secrets/release-signing-key/versions/latest:access"
refused "read the retired release-signing key" GET "https://secretmanager.googleapis.com/v1/projects/$P/secrets/harness-catalog-signing-key/versions/1:access"
for B in run-sources-provian-ai-us-central1 provian-ai_cloudbuild; do
  code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/octet-stream" \
    "https://storage.googleapis.com/upload/storage/v1/b/$B/o?uploadType=media&name=d561-route-probe.tgz" --data-binary 'probe')
  why=$(python3 -c "$DENIAL" < "$BODY")
  if [ "$code" = 403 ] && [ "${why#NOT-A-PERMISSION-DENIAL}" = "$why" ]; then echo "  REFUSED 403  plant build source in gs://$B  ($why)"; else echo "FAIL $code  plant build source in gs://$B  ($why)"; fail=1; fi
done

echo "== the Firestore export route : an export directed onto an existing export folder"
EXISTING=$(gcloud storage objects list "gs://provian-ai-relay-exports/relay/**" --format='value(name)' 2>/dev/null | grep -m1 '\.overall_export_metadata$' | sed -E 's#/[^/]+$##')
[ -n "$EXISTING" ] || { echo "FAIL no existing export folder found"; fail=1; }
code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "${H[@]}" "https://firestore.googleapis.com/v1/projects/$P/databases/relay:exportDocuments" \
  -d "{\"outputUriPrefix\":\"gs://provian-ai-relay-exports/$EXISTING\",\"collectionIds\":[\"d562_overwrite_probe\"]}")
msg=$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("error",{}).get("message","(no error: export STARTED)"))' < "$BODY")
if [ "$code" = 400 ] && [ "${msg#Path already exists}" != "$msg" ]; then echo "  REFUSED 400  export onto existing folder $EXISTING  ($msg)"; else echo "FAIL $code  export onto existing folder $EXISTING  ($msg)"; fail=1; fi
# Backstop for every principal that holds storage.objects.delete (the Firestore agent does): the
# bucket's 365-day retention policy refuses deleting or replacing any export younger than a year.
gcloud storage buckets describe gs://provian-ai-relay-exports --format='value(retention_policy.retentionPeriod)' | grep -qx 31536000 \
  && echo "  retention policy 365 days on gs://provian-ai-relay-exports (unlocked)" || { echo "FAIL export bucket retention policy is not 365 days"; fail=1; }

echo "== open by design: image write on cloud-run-source-deploy -> runtime accounts of services built there"
gcloud run services list --project "$P" --format='value(metadata.name,spec.template.spec.serviceAccountName,spec.template.spec.containers[0].image)' \
  | awk '$3 ~ /cloud-run-source-deploy/ {print $2}' | sort -u | sed 's/^/  must pass relay-iam-refusal-check.sh: /'

echo
[ $fail = 0 ] && echo "ALL ROUTES REFUSED" || { echo "ROUTE CHECK FAILED"; exit 1; }
