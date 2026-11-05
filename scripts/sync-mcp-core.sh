#!/usr/bin/env bash
#
# sync-mcp-core.sh — mirror the shared MCP tool core into the relay.
#
# provian-mcp/src/core/ is the CANONICAL home of the Provian MCP tool core
# (tool definitions, PoP crypto, server assembly). The relay serves the SAME
# core at its remote /mcp endpoint, but the backend Docker build context is
# provian-backend/ alone — it cannot reach a sibling package. So the core is
# mirrored, byte-identical, into provian-backend/src/mcp/core/ (committed).
#
# NEVER edit provian-backend/src/mcp/core/ directly — edit
# provian-mcp/src/core/ and re-run this script. CI/precommit can verify with
# scripts/check-mcp-core-mirror.sh.
#
# Test files are not mirrored: the core's tests are Vitest and run in
# provian-mcp; the backend's Jest suite covers the /mcp mount instead.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="provian-mcp/src/core"
DST="provian-backend/src/mcp/core"

if [ ! -d "$SRC" ]; then
  echo "sync-mcp-core: $SRC not found" >&2
  exit 1
fi

mkdir -p "$DST"

# Remove stale mirrored files (a file deleted from the canonical core must
# disappear from the mirror too), then copy the current non-test set.
find "$DST" -maxdepth 1 -name '*.ts' -delete

count=0
for f in "$SRC"/*.ts; do
  base="$(basename "$f")"
  case "$base" in
    *.test.ts|*.spec.ts) continue ;;
  esac
  cp "$f" "$DST/$base"
  count=$((count + 1))
done

echo "sync-mcp-core: mirrored $count files $SRC -> $DST"
