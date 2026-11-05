# Base-mainnet fork harness (agent sovereign-wallet signer)

Proves the agent EVM signer (slice 1) and bond origination (slice 2) on a **real
Base-mainnet fork** — real nonce, real gas estimate, real `eth_sendRawTransaction`,
txs mine, balances move, and the deployed BondPool / PVT / USDC contracts accept
the SDK's transactions.

The harness resolves every address the way the SDK signer does — PVT from the
SDK allowlist (`getToken('base', 'PVT')`, the PVT9 successor kernel) and the
BondPool from `bondPoolAddressForChain('base')` (the institution deployment/PVT9 BondPool in
`contracts/deployments/base-pvt9-institutions.json`) — and a preflight refuses to
broadcast unless the PVT pin equals `config/pvt9-base.json` `assets.pvt9.address`
and neither address is a retired Base address (`retiredBaseAddresses`: the
Pass-3 stack + PVTv8). `FORK_PREFLIGHT_ONLY=1` runs only that check (no RPC).
Then it points the backend `/transfer/record` and
`/bonds/post` **verifiers** (FIX B, FIX C) at the resulting real tx hashes to prove
they validate genuine on-chain txs — not mocked receipts.

No real money: the fork is local (anvil), ETH is anvil's funded dev account, and
PVT/USDC are dealt into the agent via `anvil_setStorageAt`.

## Run

```bash
bash provian-agent-sdk/test-harness/run.sh
```

That starts the fork, builds the SDK, runs both harnesses, and stops the fork.
To run the pieces by hand:

```bash
# 1. fork
anvil --fork-url https://mainnet.base.org --port 8545 --silent &

# 2. SDK signer harness -> broadcasts real txs, writes /tmp/fork-hashes.json
npm --prefix provian-agent-sdk run build
node provian-agent-sdk/test-harness/fork-base.mjs

# 3. backend verifier harness -> validates the real tx hashes
BASE_RPC_URL=http://127.0.0.1:8545 \
ENABLE_PVT_PRINCIPAL=true PVT_PRINCIPAL_CHAINS=base \
PVT_CONTRACT_ADDRESS_BASE="$(node -p "require('./config/pvt9-base.json').assets.pvt9.address")" \
ESCROW_V4_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000001 \
PROMISE_V3_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000002 \
POOL_V3_CONTRACT_ADDRESS=0x0000000000000000000000000000000000000003 \
provian-backend/node_modules/.bin/tsx provian-backend/scripts/fork-verify.ts
```

## What it proves (fork-proven, no live mainnet / no real funds)

- `transferToken(PVT)` + `transferToken(USDC)` — accepted, mined, recipient balances move.
- `transferNative(ETH)` — accepted, mined; FIX B verifier confirms value + recipient.
- `postBond` — full approve → await receipt → postBond against the real BondPool;
  the grossed-up approval covers the contract's independently-derived deposit; bond
  posts; FIX C verifier confirms the `BondPosted` event + agent + level.
- `renewBond` — executes; FIX C verifier confirms the `BondRenewed` event + agent.
- `topUpBond` approve → topUpBond of exactly the renewal's shortfall; the bond
  returns to its `requiredAtPost` lock; the verifier confirms the `BondToppedUp` event,
  agent, and amount.
- Negative controls: FIX B/C reject the same real txs when amount / recipient /
  agent / level don't match (fail closed).

## Not covered here (still needs live mainnet + real funds)

- A real EIP-1559 fee market and L2 sequencer inclusion (anvil auto-mines instantly).
- Real PVT liquidity / real token balances (here PVT & USDC are storage-dealt into
  slots the harness discovers on the fork, and the PVT9 kernel's `totalSupply` is
  raised by exactly the dealt amount so the BondPool's `burn` keeps supply consistent).
- The full HTTP `/transfer/record` + `/bonds/post` routes (auth + Firestore PE
  write) — those are exercised by the hermetic jest suite; the fork harness exercises
  their on-chain verification core against real txs.
