#!/usr/bin/env bash
#
# settlement runtime — run the end-to-end settlement proof against a Base fork.
#
# Starts anvil forking Base mainnet, repoints the two operator roles to anvil's OWN published
# test accounts, starts the Firestore emulator, and runs `scripts/wp4-fork-e2e.ts`.
#
# WHY IT REPOINTS THE ROLES RATHER THAN USING THE REAL KEYS
#
# The production minter and approver keys live in Secret Manager, and a harness that loaded
# them would be one wrong RPC URL away from a mainnet transaction — and the chain-id guard
# CANNOT catch that, because an anvil fork of Base reports chain id 8453 exactly like Base
# does. Repointing means the harness holds no key mainnet would honour, so the mistake is not
# available to make.
#
# Nothing here touches production Firestore: the harness refuses to run without
# FIRESTORE_EMULATOR_HOST.
#
# Usage: BASE_RPC_URL=<archive rpc> scripts/wp4-fork-e2e.sh
set -euo pipefail

KERNEL=0x8b2306be03bA3ACAA81a891f9c3749df5eF66c61
VERIFIER=0xEfbC0651415EcA475438A87A18Bd2e4fD7e13e05
BOOTSTRAP_ADMIN=0x713E33CcaCDaA4c1a2B626eb92070056Ee4b84aB

# anvil's published accounts #0, #1. Public knowledge; they control nothing anywhere.
TEST_MINTER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
TEST_MINTER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
TEST_APPROVER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
TEST_APPROVER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

FORK_RPC=http://127.0.0.1:8545
EMULATOR=${FIRESTORE_EMULATOR_HOST:-127.0.0.1:8099}

if [ -z "${BASE_RPC_URL:-}" ]; then
  echo "BASE_RPC_URL must point at a Base mainnet archive endpoint to fork from." >&2
  exit 1
fi

echo "==> forking Base at ${KERNEL}"
anvil --fork-url "$BASE_RPC_URL" --port 8545 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
sleep 8

cast rpc anvil_impersonateAccount "$BOOTSTRAP_ADMIN" --rpc-url "$FORK_RPC" > /dev/null
for account in "$BOOTSTRAP_ADMIN" "$TEST_MINTER" "$TEST_APPROVER"; do
  cast rpc anvil_setBalance "$account" 0xDE0B6B3A7640000 --rpc-url "$FORK_RPC" > /dev/null
done

echo "==> repointing operationalMinter and batchApprover to throwaway test accounts"
cast send "$KERNEL" "appointOperationalMinter(address)" "$TEST_MINTER" \
  --from "$BOOTSTRAP_ADMIN" --unlocked --rpc-url "$FORK_RPC" > /dev/null
cast send "$VERIFIER" "appointBatchApprover(address)" "$TEST_APPROVER" \
  --from "$BOOTSTRAP_ADMIN" --unlocked --rpc-url "$FORK_RPC" > /dev/null

echo "==> running the end-to-end proof"
FIRESTORE_EMULATOR_HOST="$EMULATOR" \
GOOGLE_CLOUD_PROJECT=provian-ai \
GCLOUD_PROJECT=provian-ai \
BASE_RPC_URL="$FORK_RPC" \
PVT9_SETTLEMENT_ARMED=yes-settle-real-pvt \
PVT9_SETTLEMENT_MINTER_KEY="$TEST_MINTER_KEY" \
PVT9_SETTLEMENT_APPROVER_KEY="$TEST_APPROVER_KEY" \
  npx tsx "$(dirname "$0")/wp4-fork-e2e.ts"
