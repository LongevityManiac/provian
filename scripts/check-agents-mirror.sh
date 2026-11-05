#!/usr/bin/env bash
#
# check-agents-mirror.sh — verify AGENTS.md is in sync with CLAUDE.md.
#
# AGENTS.md is a gitignored LOCAL mirror of CLAUDE.md (a copy for other agent
# tools, e.g. Codex). CLAUDE.md is the single source of truth. Because AGENTS.md
# is untracked, it silently re-drifts whenever CLAUDE.md changes and nobody
# re-mirrors. This script flags that drift.
#
# Re-sync with:  cp CLAUDE.md AGENTS.md
#
# Exit codes: 0 = in sync, 1 = drift / missing.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f AGENTS.md ]; then
  echo "check-agents-mirror: AGENTS.md is missing — create it with:  cp CLAUDE.md AGENTS.md"
  exit 1
fi

if diff -q CLAUDE.md AGENTS.md >/dev/null; then
  echo "check-agents-mirror: OK — AGENTS.md is byte-identical to CLAUDE.md"
  exit 0
fi

echo "check-agents-mirror: DRIFT — AGENTS.md differs from CLAUDE.md. Re-sync with:  cp CLAUDE.md AGENTS.md"
echo "--- diff (CLAUDE.md < > AGENTS.md) ---"
diff CLAUDE.md AGENTS.md || true
exit 1
