#!/usr/bin/env bash
#
# check-pe-export-wire-parity.sh — the PE export format (`provian.pe-export.v1`: its lines, the
# running hash, and the offline + on-chain verification rules) is ONE file kept byte-identical in
# the SDK and the app. Drift would make an app export the SDK verifier refuses, or the reverse.
#
# Exit codes: 0 = identical, 1 = drift / missing.
set -euo pipefail
cd "$(dirname "$0")/.."

CANON="provian-agent-sdk/src/pe-export-wire.ts"
drift=0
if [ ! -f "$CANON" ]; then
  echo "check-pe-export-wire-parity: MISSING $CANON"
  exit 1
fi
for copy in src/core/meter/pe-export-wire.ts; do
  if [ ! -f "$copy" ]; then
    echo "check-pe-export-wire-parity: MISSING $copy"
    drift=1
  elif ! cmp -s "$CANON" "$copy"; then
    echo "check-pe-export-wire-parity: DRIFT $copy differs from $CANON"
    drift=1
  fi
done
# Each package's keccak adapter must exist beside its copy, and be identical.
if ! cmp -s provian-agent-sdk/src/export-hash.ts src/core/meter/export-hash.ts; then
  echo "check-pe-export-wire-parity: DRIFT export-hash.ts adapters differ (or one is missing)"
  drift=1
fi
if [ "$drift" -ne 0 ]; then exit 1; fi
echo "check-pe-export-wire-parity: ok (2 copies byte-identical)"
