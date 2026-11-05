#!/usr/bin/env bash
set -euo pipefail

# Guardrail (relay->phone push, 2026-07-06): the ONLY module allowed to send via
# Firebase Admin FCM is the push dispatcher
# (src/core/notifications/pushDispatcher.ts). Every other send site must route
# through `sendPush` / `sendPushToUser`, which inspect each token and deliver
# Expo tokens (ExponentPushToken[...]) via the Expo push service instead of FCM.
#
# A direct FCM send anywhere else silently drops delivery to every Expo-token
# device (the format the mobile app registers). This check fails the build if a
# direct Admin-SDK FCM send reappears outside the dispatcher. It matches not just
# `sendEachForMulticast` but the sibling send methods too (`sendMulticast`,
# `sendEach`, `messaging().send`, and the dynamic `getMessaging()` import) —
# because the fix that motivated this guard removed exactly those
# `getMessaging().send(...)` single-sends, and a narrow grep would let them back.

cd "$(dirname "$0")/.."

# The one file permitted to call Firebase Admin FCM directly.
ALLOWED='src/core/notifications/pushDispatcher.ts'

# Direct Admin FCM send patterns. Anchored on `messaging`/`getMessaging`/the
# FCM-unique method names so ordinary `.send()` calls (res.send, ws.send,
# resend emails.send, supertest .send) do NOT trip it. Verified zero
# false-positives across the backend src. dist/ is generated so it is skipped.
# Test files are included on purpose: tests must inject fake transports.
PATTERN='(sendEachForMulticast|sendMulticast|\.sendEach\b|getMessaging[[:space:]]*\(|messaging[[:space:]]*\([[:space:]]*\)[[:space:]]*\.send|\bmessaging\.send[[:space:]]*\()'

matches="$(grep -rnE --include='*.ts' "$PATTERN" src \
  | grep -v "^${ALLOWED}:" || true)"

if [ -n "$matches" ]; then
  echo "::error::Direct Firebase Admin FCM send found outside the push dispatcher." >&2
  echo "Route push through sendPush/sendPushToUser in ${ALLOWED} so Expo tokens are delivered." >&2
  echo "Offending references:" >&2
  echo "$matches" >&2
  exit 1
fi

echo "OK: no direct Admin FCM sends outside ${ALLOWED}."
