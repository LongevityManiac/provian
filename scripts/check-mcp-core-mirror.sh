#!/usr/bin/env bash
#
# check-mcp-core-mirror.sh — verify provian-backend/src/mcp/core/ is in sync
# with the canonical provian-mcp/src/core/ (non-test files, byte-identical).
#
# Re-sync with:  scripts/sync-mcp-core.sh
#
# Exit codes: 0 = in sync, 1 = drift / missing.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="provian-mcp/src/core"
DST="provian-backend/src/mcp/core"

if [ ! -d "$DST" ]; then
  echo "check-mcp-core-mirror: $DST is missing — create it with:  scripts/sync-mcp-core.sh"
  exit 1
fi

drift=0

for f in "$SRC"/*.ts; do
  base="$(basename "$f")"
  case "$base" in
    *.test.ts|*.spec.ts) continue ;;
  esac
  if [ ! -f "$DST/$base" ]; then
    echo "check-mcp-core-mirror: MISSING $DST/$base"
    drift=1
  elif ! diff -q "$f" "$DST/$base" >/dev/null; then
    echo "check-mcp-core-mirror: DRIFT in $base"
    diff "$f" "$DST/$base" || true
    drift=1
  fi
done

for f in "$DST"/*.ts; do
  base="$(basename "$f")"
  if [ ! -f "$SRC/$base" ]; then
    echo "check-mcp-core-mirror: STALE $DST/$base (no canonical counterpart)"
    drift=1
  fi
done

if [ "$drift" -eq 0 ]; then
  echo "check-mcp-core-mirror: OK — mirror is byte-identical to $SRC"
  exit 0
fi

echo "check-mcp-core-mirror: re-sync with:  scripts/sync-mcp-core.sh"
exit 1
