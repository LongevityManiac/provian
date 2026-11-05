#!/usr/bin/env bash
# prove, live, that the relay's runtime account is REFUSED every destructive action on the
# relay database, the export and Archive buckets, and the Archive encryption secret.
#
# Two layers per resource: testIamPermissions (the account holds none of the named permissions),
# then the real calls, each of which must answer 403. The real calls run only after the first layer
# shows the permission absent, and the irreversible ones (secret destroy, object overwrite) only
# after a reversible call on the same permission path has already been refused.
#
# takes any service account (default: the relay's), so every account reachable from the
# relay is proven the same way. The token's own identity is checked first (tokeninfo) so a check can
# never pass as the wrong account; the relay-only positive controls run for the relay.
#
# Needs an operator who can mint the account's token (roles/iam.serviceAccountTokenCreator on it).
#   bash provian-backend/scripts/relay-iam-refusal-check.sh [service-account-email]
set -euo pipefail

P=provian-ai
RELAY_SA=185909722463-compute@developer.gserviceaccount.com
SA=${1:-$RELAY_SA}
DB=relay
SECRET=relay-signing-key
T=$(gcloud auth print-access-token --impersonate-service-account="$SA" 2>/dev/null)
[ -n "$T" ] || { echo "cannot mint a token for $SA (operator needs Token Creator on it)"; exit 2; }
H=(-H "Authorization: Bearer $T" -H "Content-Type: application/json")
fail=0
WHO=$(curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=$T" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("email",""))')
[ "$WHO" = "$SA" ] || { echo "FAIL token identity is '$WHO', not $SA"; exit 2; }
echo "== acting as $WHO"
is_relay() { [ "$SA" = "$RELAY_SA" ]; }

# Prints the permissions held (comma list) or 'none'; an error response is ERROR, never 'none'.
PARSE='import json,sys
d=json.load(sys.stdin)
print("ERROR:"+json.dumps(d.get("error"))[:200] if "error" in d else (",".join(d.get("permissions",[])) or "none"))'
held() { # url json-permissions
  curl -s -X POST "${H[@]}" "$1" -d "{\"permissions\":$2}" | python3 -c "$PARSE"
}
bucket_held() { # bucket perm...
  local b=$1; shift; local q=""; for p in "$@"; do q="$q&permissions=$p"; done
  curl -s "${H[@]}" "https://storage.googleapis.com/storage/v1/b/$b/iam/testPermissions?${q#&}" | python3 -c "$PARSE"
}
must_hold() { # label got expected  (positive control: the same token and endpoint DO report a held permission)
  if [ "$2" = "$3" ]; then echo "  control: holds $3 on $1"; else echo "FAIL control on $1: got $2, expected $3"; fail=1; fi
}
must_hold_none() { # label url json-permissions
  local got; got=$(held "$2" "$3")
  if [ "$got" = none ]; then echo "  holds none of $3 on $1"; else echo "FAIL holds $got on $1"; fail=1; fi
}
DENIAL='import json,sys
b=sys.stdin.read()
try: e=json.loads(b).get("error",{})
except Exception: e={"message":b}
m=e.get("message","") if isinstance(e,dict) else str(e)
print(m[:150].replace("\n"," ") if ("ermission" in m or ("does not have" in m and "access" in m) or e.get("status")=="PERMISSION_DENIED") and "SERVICE_DISABLED" not in b else "NOT-A-PERMISSION-DENIAL (body withheld; keys: "+",".join(sorted(json.loads(b).keys()) if b.strip().startswith("{") else ["non-json"])+")")'
judge() { # label code body-file
  local why; why=$(python3 -c "$DENIAL" < "$3")
  if [ "$2" = 403 ] && [ "${why#NOT-A-PERMISSION-DENIAL}" = "$why" ]; then echo "  REFUSED 403  $1  ($why)"; else echo "FAIL $2  $1  ($why)"; fail=1; fi
}
BODY=$(mktemp); trap 'rm -f "$BODY"' EXIT
refused() { # label method url [body] -> must be a 403 permission denial
  local code
  if [ $# -ge 4 ]; then code=$(curl -s -o "$BODY" -w '%{http_code}' -X "$2" "${H[@]}" "$3" -d "$4")
  else code=$(curl -s -o "$BODY" -w '%{http_code}' -X "$2" "${H[@]}" "$3"); fi
  judge "$1" "$code" "$BODY"
}

echo "== Firestore database $DB"
is_relay && must_hold "project $P" "$(held "https://cloudresourcemanager.googleapis.com/v1/projects/$P:testIamPermissions" '["datastore.entities.get"]')" datastore.entities.get
must_hold_none "project $P" "https://cloudresourcemanager.googleapis.com/v1/projects/$P:testIamPermissions" \
  '["datastore.databases.delete","datastore.databases.update","datastore.databases.import","resourcemanager.projects.setIamPolicy"]'
[ $fail = 0 ] || { echo "permission present: real calls skipped"; exit 1; }
FS="https://firestore.googleapis.com/v1/projects/$P/databases/$DB"
refused "turn off deletion protection" PATCH "$FS?updateMask=deleteProtectionState" '{"deleteProtectionState":"DELETE_PROTECTION_DISABLED"}'
refused "turn off point-in-time recovery" PATCH "$FS?updateMask=pointInTimeRecoveryEnablement" '{"pointInTimeRecoveryEnablement":"POINT_IN_TIME_RECOVERY_DISABLED"}'
refused "delete the database" DELETE "$FS"

for B in provian-ai-relay-exports provian-ai-pe-archive; do
  echo "== bucket $B"
  is_relay && must_hold "gs://$B" "$(bucket_held "$B" storage.objects.get)" storage.objects.get
  got=$(bucket_held "$B" storage.objects.delete storage.buckets.delete storage.buckets.update storage.buckets.setIamPolicy storage.objects.setRetention storage.buckets.enableObjectRetention)
  if [ "$got" = none ]; then echo "  holds none of objects.delete/buckets.delete/buckets.update/setIamPolicy/setRetention"; else echo "FAIL holds $got on gs://$B"; fail=1; continue; fi
  # An existing object, listed with the operator's own credentials (never the account's).
  OBJ=$(gcloud storage objects list "gs://$B/**" --limit=1 --format='value(name)' 2>/dev/null | head -1)
  [ -n "$OBJ" ] || { echo "FAIL no object found in gs://$B to test against"; fail=1; continue; }
  ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$OBJ")
  GB="https://storage.googleapis.com/storage/v1/b/$B"
  refused "turn off soft delete" PATCH "$GB" '{"softDeletePolicy":{"retentionDurationSeconds":"0"}}'
  refused "change retention policy" PATCH "$GB" '{"retentionPolicy":{"retentionPeriod":"1"}}'
  refused "remove retention policy" PATCH "$GB" '{"retentionPolicy":null}'
  refused "delete the bucket" DELETE "$GB"
  refused "delete object $OBJ" DELETE "$GB/o/$ENC"
  # Overwrite = an upload to an existing name with no precondition (needs objects.delete).
  code=$(curl -s -o "$BODY" -w '%{http_code}' -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/octet-stream" \
    "https://storage.googleapis.com/upload/storage/v1/b/$B/o?uploadType=media&name=$ENC" --data-binary 'd559-overwrite-probe')
  judge "overwrite object $OBJ" "$code" "$BODY"
done

echo "== secret $SECRET (Archive encryption key)"
SM="https://secretmanager.googleapis.com/v1/projects/$P/secrets/$SECRET"
is_relay && must_hold "secret $SECRET" "$(held "$SM:testIamPermissions" '["secretmanager.versions.access"]')" secretmanager.versions.access
must_hold_none "secret $SECRET" "$SM:testIamPermissions" \
  '["secretmanager.versions.destroy","secretmanager.versions.disable","secretmanager.versions.enable","secretmanager.secrets.delete","secretmanager.secrets.update","secretmanager.secrets.setIamPolicy"]'
[ $fail = 0 ] || { echo "permission present: real secret calls skipped"; exit 1; }
for V in $(gcloud secrets versions list "$SECRET" --project "$P" --filter='state!=DESTROYED' --format='value(name.basename())'); do
  refused "disable $SECRET version $V" POST "$SM/versions/$V:disable" '{}'
  refused "destroy $SECRET version $V" POST "$SM/versions/$V:destroy" '{}'
done
refused "delete secret $SECRET" DELETE "$SM"

echo
[ $fail = 0 ] && echo "ALL REFUSED" || { echo "REFUSAL CHECK FAILED"; exit 1; }
