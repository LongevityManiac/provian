#!/usr/bin/env bash
#
# check-meter-wire-parity.sh — the PE meter wire format (PE v2, act record, batch, fingerprints)
# and the output signature are each ONE file kept byte-identical in the relay, the SDK and the app. Any drift between the three
# would make a batch the relay refuses, or a fingerprint a verifier cannot reproduce.
#
# Exit codes: 0 = identical, 1 = drift / missing.
set -euo pipefail
cd "$(dirname "$0")/.."

drift=0
# The wire format itself, and the output signature (: a citation counts toward the
# producer's consumption only when it carries the producer's signature over the output's hash).
for name in meter-wire output-signature; do
  CANON="provian-backend/src/core/meter/$name.ts"
  for copy in "provian-agent-sdk/src/$name.ts" "src/core/meter/$name.ts" "provian-mcp/src/core/$name.ts" "provian-backend/src/mcp/core/$name.ts"; do
    if [ ! -f "$copy" ]; then
      echo "check-meter-wire-parity: MISSING $copy"
      drift=1
    elif ! cmp -s "$CANON" "$copy"; then
      echo "check-meter-wire-parity: DRIFT $copy differs from $CANON"
      drift=1
    fi
  done
done
if [ "$drift" -ne 0 ]; then exit 1; fi
echo "check-meter-wire-parity: ok (meter-wire + output-signature, 5 copies each byte-identical)"
