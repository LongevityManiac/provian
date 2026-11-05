#!/usr/bin/env bash
#
# One-command Base-mainnet fork harness for the agent sovereign-wallet signer.
#
# Starts an anvil fork of Base mainnet, builds the SDK, runs the SDK signer
# harness (which BROADCASTS real txs against the fork: native ETH, USDC, PVT,
# approve->postBond, renewBond, approve->topUpBond) and then the backend verifier harness (which
# points the /transfer/record + /bonds/post verifiers at the resulting REAL tx
# hashes and asserts FIX B / FIX C accept the genuine txs and reject mismatches).
# Tears the fork down on exit. No real money: the fork is local; tokens are
# dealt via anvil_setStorageAt.
#
# Requires: foundry (anvil, cast) on PATH or in ~/.foundry/bin; node; the SDK and
# backend node_modules installed.
#
# Usage:  bash provian-agent-sdk/test-harness/run.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
ANVIL="${ANVIL:-$FOUNDRY_BIN/anvil}"
CAST="${CAST:-$FOUNDRY_BIN/cast}"
FORK_URL="${FORK_URL:-https://mainnet.base.org}"
PORT="${PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
# The live PVT9 kernel, read from the repo config the SDK harness's preflight checks
# the SDK's own pin against (never a transcribed literal).
PVT_BASE="$(node -p "require('$ROOT/config/pvt9-base.json').assets.pvt9.address")"

echo "==> starting anvil fork of Base mainnet on :${PORT}"
"$ANVIL" --fork-url "$FORK_URL" --port "$PORT" --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT

echo "==> waiting for the fork to accept requests"
for _ in $(seq 1 30); do
  if "$CAST" chain-id --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> building the SDK"
npm --prefix "$ROOT/provian-agent-sdk" run build >/dev/null

echo "==> SDK signer harness (broadcasts real txs on the fork)"
FORK_RPC="$RPC" node "$ROOT/provian-agent-sdk/test-harness/fork-base.mjs"

echo
echo "==> backend verifier harness (validates the real tx hashes)"
BASE_RPC_URL="$RPC" \
ENABLE_PVT_PRINCIPAL=true PVT_PRINCIPAL_CHAINS=base \
PVT_CONTRACT_ADDRESS_BASE="$PVT_BASE" \
ESCROW_V4_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000001 \
PROMISE_V3_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000002 \
POOL_V3_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000003 \
"$ROOT/provian-backend/node_modules/.bin/tsx" "$ROOT/provian-backend/scripts/fork-verify.ts"

echo
echo "==> harness complete (stopping anvil)"
