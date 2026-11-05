#!/usr/bin/env bash
set -euo pipefail

PROJECT="${PROJECT:-provian-ai}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-provian-api}"

SERVICE_JSON="$(gcloud run services describe "$SERVICE" \
  --project="$PROJECT" \
  --region="$REGION" \
  --format=json)"

SERVICE_JSON="$SERVICE_JSON" python3 - <<'PY'
import json
import os
import sys

doc = json.loads(os.environ["SERVICE_JSON"])
containers = doc.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
env = {}
for container in containers:
    for entry in container.get("env", []):
        env[entry.get("name")] = entry

managed = {
    "SCHEDULER_SECRET": "scheduler-secret",
    "PVT_MINTER_KEY": "pvt-minter-key",
    "TOKEN_SIGNING_SECRET": "token-signing-secret",
    "SESSION_SECRET": "session-secret",
    "ADMIN_API_KEY": "admin-api-key",
    "RELAY_SIGNING_KEY": "relay-signing-key",
    "RESEND_API_KEY": "resend-api-key",
}

errors = []
for key, secret_name in managed.items():
    entry = env.get(key)
    if not entry:
        errors.append(f"missing managed env var: {key}")
        continue
    actual = entry.get("valueFrom", {}).get("secretKeyRef", {}).get("name")
    if actual != secret_name:
        if "value" in entry:
            errors.append(f"{key} is plaintext env; expected secretKeyRef {secret_name}")
        else:
            errors.append(f"{key} secretKeyRef={actual!r}; expected {secret_name!r}")

if "IOS_BUNDLE_ID" not in env:
    errors.append("missing required config env var: IOS_BUNDLE_ID")

if "IOS_TEAM_IDENTIFIER" not in env:
    print("WARN: IOS_TEAM_IDENTIFIER is not set yet; confirm Apple Team ID before next release deploy.")

if errors:
    print("Cloud Run secret wiring check FAILED:")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print("Cloud Run secret wiring check OK")
PY
