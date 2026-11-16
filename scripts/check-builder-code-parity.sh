#!/usr/bin/env bash
#
# check-builder-code-parity.sh — the Base Builder Code (ERC-8021) attribution module is ONE file kept
# byte-identical in the relay, the agent SDK, the x402 facilitator and the app. Drift would let one
# sender attribute differently, or one reader fail to recognize another's suffix.
#
# Exit codes: 0 = identical, 1 = drift / missing.
set -euo pipefail
cd "$(dirname "$0")/.."

CANON="provian-backend/src/core/onchain/builder-code.ts"
drift=0
count=0
for copy in "provian-agent-sdk/src/builder-code.ts" "provian-facilitator/src/base/builder-code.ts" "src/core/protocol/builder-code.ts"; do
  count=$((count + 1))
  if [ ! -f "$copy" ]; then
    echo "check-builder-code-parity: MISSING $copy"
    drift=1
  elif ! cmp -s "$CANON" "$copy"; then
    echo "check-builder-code-parity: DRIFT $copy differs from $CANON"
    drift=1
  fi
done
if [ "$count" -eq 0 ]; then echo "check-builder-code-parity: no copies evaluated"; exit 1; fi
if grep -q "bc_PLACEHOLDER" "$CANON"; then
  echo "check-builder-code-parity: $CANON still carries the placeholder Builder Code"
  drift=1
fi
if [ "$drift" -ne 0 ]; then exit 1; fi
echo "check-builder-code-parity: ok ($count copies byte-identical to $CANON)"
