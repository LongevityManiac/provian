#!/usr/bin/env bash
#
# setup-settlement-alarm-policy.sh —  Phase 3 (Alert 7a).
#
# Installs the Cloud Monitoring log-match policy for the PVT9 settlement alarm line:
#
#   [pvt9-settlement-run] SCHEDULED ALARM — settlement STOPPED (...); eligible backlog left unsettled
#
# emitted at console.error by settlementRunNeedsAlarm (routes/pvt9-operations.ts). Until now that
# ALARM returned 200 to Cloud Scheduler and matched no policy, so a stuck scheduled settlement that
# left eligible backlog unsettled reached nobody. This is the INDEPENDENT production incident path;
# The private operations service provides the independent scheduler alarm path.
#
# PRECONDITIONS. Run AFTER the primary on-call notification channel exists + is verified.
# Idempotent: an already-created policy is left untouched. Both operations are production mutations.
#
#   bash provian-backend/scripts/setup-settlement-alarm-policy.sh
set -euo pipefail

PROJECT="${PROVIAN_GCP_PROJECT:-provian-ai}"
POLICY_NAME="Provian - PVT9 settlement stopped"
# The LIVE channel's display name carries an EM DASH — "Provian — primary on-call"
# (DECISIONS 2970; channel 14912284764910458476). Match dash-AGNOSTICALLY on the
# distinguishing tail so either separator resolves; the keeper channel does not
# contain this tail, so the match stays unique. (Same fix as Alert 6.)
# landing fix: ':' (contains), NOT '~'. The Monitoring channels-list filter
# grammar rejects '~' in the deployed gcloud and the $( … || true ) swallowed the
# parse error to an empty channel → silent skip. ':' parses and stays unique.
CHANNEL_FILTER='displayName:"primary on-call"'

CHANNEL="$(gcloud beta monitoring channels list \
  --project="$PROJECT" \
  --filter="$CHANNEL_FILTER" \
  --format='value(name)' 2>/dev/null | head -1 || true)"
if [ -z "$CHANNEL" ]; then
  echo "WARN: primary on-call notification channel not found — create + verify it first" >&2
  echo "      (see docs/ops/ALERTING_SETUP.md). Skipping the settlement-alarm policy." >&2
  exit 0
fi

EXISTING_POLICY="$(gcloud alpha monitoring policies list \
  --project="$PROJECT" \
  --filter="displayName=\"$POLICY_NAME\"" \
  --format='value(name)' 2>/dev/null | head -1 || true)"
if [ -n "$EXISTING_POLICY" ]; then
  echo "ok: monitoring policy \"$POLICY_NAME\" already exists ($EXISTING_POLICY)"
  exit 0
fi

TMP_POLICY="$(mktemp)"
trap 'rm -f "$TMP_POLICY"' EXIT
cat > "$TMP_POLICY" <<JSON
{
  "displayName": "$POLICY_NAME",
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "pvt9 settlement run stopped with backlog (ALARM)",
      "conditionMatchedLog": {
        "filter": "resource.type=\"cloud_run_revision\" resource.labels.service_name=\"provian-api\" severity=\"ERROR\" textPayload:\"[pvt9-settlement-run] SCHEDULED ALARM\""
      }
    }
  ],
  "alertStrategy": {
    "notificationRateLimit": { "period": "300s" },
    "notificationPrompts": ["OPENED"]
  },
  "notificationChannels": ["$CHANNEL"],
  "documentation": {
    "mimeType": "text/markdown",
    "content": "The scheduled PVT9 settlement run STOPPED for a non-benign reason and left eligible backlog unsettled (settlementRunNeedsAlarm). Inspect the run summary in the log line, check pvt9-operations settlement state, and re-run /v1/internal/settlement/pvt9-run once the stop cause is resolved. The kernel enforces mint-once independently; waiting settles nothing. Never mint the backlog by hand."
  }
}
JSON

echo "creating monitoring policy \"$POLICY_NAME\"..."
gcloud alpha monitoring policies create --project="$PROJECT" --policy-from-file="$TMP_POLICY"
echo "ok: monitoring policy created."
