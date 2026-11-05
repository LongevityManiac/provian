#!/usr/bin/env bash
#
# check-pe-archive-wire-parity.sh — the PE Archive wire format (: an archived day's
# part header, its sealed payload, the build/seal/open/verify rules) is ONE file kept
# byte-identical in the relay, the SDK and the app. Drift would make a part the relay refuses, or a
# day an owner's other device (or their linked human's phone) cannot open.
#
# Exit codes: 0 = identical, 1 = drift / missing.
set -euo pipefail
cd "$(dirname "$0")/.."

CANON="provian-backend/src/core/meter/pe-archive-wire.ts"
drift=0
if [ ! -f "$CANON" ]; then
  echo "check-pe-archive-wire-parity: MISSING $CANON"
  exit 1
fi
for copy in provian-agent-sdk/src/pe-archive-wire.ts src/core/meter/pe-archive-wire.ts; do
  if [ ! -f "$copy" ]; then
    echo "check-pe-archive-wire-parity: MISSING $copy"
    drift=1
  elif ! cmp -s "$CANON" "$copy"; then
    echo "check-pe-archive-wire-parity: DRIFT $copy differs from $CANON"
    drift=1
  fi
done
# Each package's crypto adapter must exist beside its copy (the wire imports `./pe-archive-crypto`).
for adapter in provian-backend/src/core/meter/pe-archive-crypto.ts provian-agent-sdk/src/pe-archive-crypto.ts src/core/meter/pe-archive-crypto.ts; do
  if [ ! -f "$adapter" ]; then
    echo "check-pe-archive-wire-parity: MISSING $adapter"
    drift=1
  fi
done
if [ "$drift" -ne 0 ]; then exit 1; fi
echo "check-pe-archive-wire-parity: ok (3 copies byte-identical)"
