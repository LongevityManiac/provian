#!/usr/bin/env bash
set -euo pipefail

# Dev/admin smoke test for relay -> phone push (2026-07-06).
#
# Sends a REAL test push to a wallet's registered tokens via the deployed
# POST /v1/internal/admin/test-push endpoint, so you can confirm delivery on a
# physical device (Expo AND native FCM) before the C4/#1 device gates run.
#
# Usage:
#   ./scripts/send-test-push.sh <user_id | 0xWalletAddress> [title] [body]
#
# Auth: the endpoint is gated by scheduler auth. This script uses the
# `x-scheduler-secret` shared-secret path. The secret is resolved from
# $SCHEDULER_SECRET if set, else pulled from Secret Manager (no console needed):
#   gcloud secrets versions access latest --secret=scheduler-secret
# F43: the secret is handed to curl via a stdin config file (`-K -`), NEVER on the argv —
# a `-H "x-scheduler-secret: <v>"` on the command line is visible to any other user via the
# process list (ps) and lands in shell history.
#
# Env overrides: PROVIAN_API_URL (default https://api.provian.ai),
# PROJECT (default provian-ai), SCHEDULER_SECRET_NAME (default scheduler-secret).

TARGET="${1:?Usage: send-test-push.sh <user_id|0xWalletAddress> [title] [body]}"
TITLE="${2:-Provian test push}"
BODY="${3:-If you can read this, relay -> phone push works.}"

BASE_URL="${PROVIAN_API_URL:-https://api.provian.ai}"
PROJECT="${PROJECT:-provian-ai}"
SECRET_NAME="${SCHEDULER_SECRET_NAME:-scheduler-secret}"

SECRET="${SCHEDULER_SECRET:-}"
if [ -z "$SECRET" ]; then
  SECRET="$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT")"
fi

# 0x-prefixed target = wallet address; otherwise treat as a relay user id.
# NOTE: the user-id field is `target_user_id`, NOT `user_id` - the backend's
# anti-spoofing middleware strips `user_id` from every request body.
if [[ "$TARGET" == 0x* ]]; then
  FIELD="wallet_address"
else
  FIELD="target_user_id"
fi

BODY_JSON="$(FIELD="$FIELD" TARGET="$TARGET" TITLE="$TITLE" BODY="$BODY" python3 - <<'PY'
import json, os
print(json.dumps({
    os.environ["FIELD"]: os.environ["TARGET"],
    "title": os.environ["TITLE"],
    "body": os.environ["BODY"],
}))
PY
)"

echo "POST $BASE_URL/v1/internal/admin/test-push  ($FIELD=$TARGET)"
# The scheduler secret goes in via a stdin curl config (`-K -`), so it never appears on the
# process argv (F43). The body is not secret and stays on `-d`.
printf 'header = "x-scheduler-secret: %s"\n' "$SECRET" | curl -sS -X POST "$BASE_URL/v1/internal/admin/test-push" \
  -H "Content-Type: application/json" \
  -d "$BODY_JSON" \
  -K -
echo
