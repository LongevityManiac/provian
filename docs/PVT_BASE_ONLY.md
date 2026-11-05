# PVT lives on Base

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

PVT minting and burning use Base. The live PVT9 kernel is
`0x8811441914381143b9408c5C32247367F86F173A`. Legacy kernels and token
contracts confer no current mint authority and are excluded by the runtime's
forbidden-address controls. Arbitrum and Optimism institution transactions do
not create separate native PVT supplies.

## Why Base only

PVT is a standard ERC-20 on Base: the wallet holds and sends it, and a
raw transfer is never gated. Provian runs no liquidity pool and no
cross-chain bridge, and there is no "your PVT on Arbitrum" to
distinguish. A PE submitted from any chain mints to a single contract,
by design.

If a market for PVT forms, a single deep liquidity
pool defends a unified price better than three shallow pools split
across L2s. Liquidity fragmentation is the failure mode that turned
multi-chain stablecoins into orphaned native variants and forced
bridge-and-burn protocols. The labor-receipt phase is the right
moment to make this commitment irreversible - before any market signal
exists to distort the decision.

The Wallet and Commons institutions stay multi-chain. Users transact in USDC on
the L2 of their choice. Provenance Envelopes carry a `chain_id`. The
single-chain constraint applies only to the PVT mint and burn surface.

## Empirical state (post-renouncement, 2026-05-12)

`totalSupply` and `admin` reads on Chunk II PVTv4:

| Chain    | PVTv4 address                                | totalSupply | admin                                    |
|----------|----------------------------------------------|-------------|------------------------------------------|
| Base     | `0x23D126600BA4f606240b5F60dB4B27BD0f8EC2aD` | 5.6 PVT     | Foundation Safe ✓ (kept)                |
| Arbitrum | `0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3` | 0 PVT       | `0x000…dEaD` (renounced 2026-05-12)     |
| Optimism | `0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3` | 0 PVT       | `0x000…dEaD` (renounced 2026-05-12)     |

Foundation Safe is `0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936` on all
three chains (now admin only on Base). Minter is
`0xF0Ea014CAa37C34aF5D0a7F646ad7d7A79C09dF7` (the Cloud-Run-mounted
`pvt-minter-key` Secret Manager secret) on all three chains, but is
operationally dead on Arb/Op - no admin can ever rotate it there. The
5.6 PVT on Base is from the Chunk II end-to-end test mint (commit
`f6a62f1`); Arb and Op have never been minted to and now never can be.

## Backend posture

- Settlement: PVT9 mints through `POST /v1/internal/settlement/pvt9-run`
  (`routes/pvt9-operations.ts` → `core/pvt/wp4/operator-runtime.ts`, the
  one module that builds a settlement signer), through the daily Cloud
  Scheduler job `provian-pvt9-settlement`. Each payee is due on its own last
  standard settlement UTC date plus the operator-set interval
  (`PVT9_STANDARD_SETTLEMENT_INTERVAL_DAYS`, currently 30). Earnings settle on
  a schedule Provian sets, currently every 30 days per payee, with on-demand payout available
  at any time for $1 USDC. Genesis stays daily. Settlement uses the Base kernel
  named in `config/pvt9-base.json`. No chain loop. The legacy
  `/v1/internal/scheduler/pvt-mint` route is retired and answers `503`.
- All other PVT reads (commons, leaderboard, balances, burn verification)
  point at the Base PVT9 kernel. None of them touch the Arb or Op PVTv4.

Your agent’s work reaches your phone once a day. A presentation or an on-demand
payout sends it immediately.

`grep` for the Arb/Op PVTv4 address `0x9193BD19...` against the
backend source returns:

- `provian-backend/src/core/pvt/wp11/legacy-mint-contract-registry.ts` -
  a frozen, read-only legacy mint-contract table.
- `provian-backend/scripts/smoke-verify-evm-contract-call.ts` - a manual
  per-chain tx-verifier smoke.

No active backend code path writes to or reads from the Arb/Op PVTv4.

## Retirement state (2026-05-12, complete)

Renouncement executed via Foundation Safe Tx Builder:

- **Arbitrum** - `transferAdmin(0x000…dEaD)` against
  `0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3`. Safe execution at
  9:25:54 PM 2026-05-11 (UI clock). 2/2 confirmations. Admin now
  `0x000…dEaD`, verified on-chain.
- **Optimism** - same call against the same address. Safe execution
  at 9:29:13 PM 2026-05-11. 2/2 confirmations. Admin now `0x000…dEaD`,
  verified on-chain.

We kept admin on Base intact so the Foundation can still:
- Reset the circuit breaker if it trips during the Cloud Run mint loop.
- Rotate the minter key (`proposeMinter` / `finalizeMinter`) without a
  contract redeploy.
- Register new protocol-burn contracts via `setProtocolContract`.

> **LEGACY-PVT ONLY:** the `setProtocolContract` registration step above
> exists only on legacy PVT contracts (v3–v8). PVT9 implements no
> `setProtocolContract` — its `IPVTBurnable.burn` is an ungated self-burn —
> so this runbook must never be pointed at the PVT9 kernel.

On Arb/Op none of those operations are possible - but none are needed
because no PVT ever flows through them.

### Note on the no-op Safe transactions earlier the same evening

Two earlier Foundation Safe transactions called `transferAdmin(0x…dEaD)`
against addresses that don't exist on chain and don't appear anywhere in
this repo: `0xeec8430478B96f6b9CDC1A36193c4053C7Be1FD9` (Arbitrum,
proposed) and `0x39f54e5872875d3CB91A5D5d59f33eF40c4A86c4` (Optimism,
proposed). Both addresses have zero bytecode on every chain. Safe
executes calls to empty addresses as no-op successes (it doesn't
simulate the call effect), so the Safe UI reported "Success" but
nothing was actually transferred and nothing on the canonical Chunk II
PVTv4 contracts changed. Source of those addresses unknown - they did
artifact. Possible vector: Safe Tx Builder address autocomplete, or
external paste from outside the repo. Both transactions cost a small
amount of ETH/gas on Arb/Op and had zero state effect. Logged here in
case anyone reviewing the Foundation Safe transaction history wonders.

## Functions that became unreachable on Arb/Op after renouncement

For full clarity on what got locked:

- `resetCircuitBreaker` - cannot reset the breaker on Arb/Op. Moot:
  no minting on those chains, breaker can never trip.
- `setGovernanceContract(addr)` - one-time setter, already burned
  during Chunk II deploy. Cannot be called twice regardless of admin.
- `setCourtContract(addr)` - same one-time pattern, already burned.
- `setVoiceContract(addr)` - voice is dormant by the operator decision; never
  set, will never be set.
- `setHumanGovernance(addr)` - one-time setter, already burned.
- `setProtocolContract(addr, bool)` - register/unregister contracts
  for `protocolBurn`. Cannot register new ones on Arb/Op after
  renounce. Moot: dead-letter contracts have no protocol traffic.
  (LEGACY-PVT ONLY: this setter exists only on legacy PVT contracts
  v3–v8. PVT9 implements no `setProtocolContract` — its
  `IPVTBurnable.burn` is an ungated self-burn — so no registration
  step exists or is needed against the PVT9 kernel.)
- `seedInitialBalance(addresses[], amounts[])` - one-time migration
  helper, never called on any chain.
- `proposeMinter(addr)` / `finalizeMinter` - minter rotation. Cannot
  rotate on Arb/Op after renounce. Moot: minter never signs anything
  on those chains.
- `transferAdmin(addr)` - the renounce itself.

Everything in that list is either single-shot-already-spent or
operationally moot on a contract with zero traffic.

---

## How the renouncement was done (historical record)

Two Foundation Safe transactions executed via Safe Tx Builder on
2026-05-12 (UI clock showed 9:25/9:29 PM 2026-05-11 local), both with
2/2 signer confirmations:

**Common parameters:**
- From: Foundation Safe `0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936`
- To: `0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3` (PVTv4 Chunk II,
  same address on both Arb and Op via deployer-nonce alignment)
- Function: `transferAdmin(address newAdmin)`
- Argument: `0x000000000000000000000000000000000000dEaD`

ABI snippet:
```json
[
  {
    "inputs": [{"internalType":"address","name":"newAdmin","type":"address"}],
    "name": "transferAdmin",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
]
```

**Verification (2026-05-12):** `cast call 0x9193BD…0bd3 "admin(address)"`
returns `0x000000000000000000000000000000000000dEaD` on both Arbitrum
and Optimism mainnet at the latest block. Etherscan equivalents:

- https://arbiscan.io/address/0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3#readContract
- https://optimistic.etherscan.io/address/0x9193BD1958773DAe4f2212E281DeBCb3BEa50bd3#readContract

### Base authority

The live PVT9 kernel is `0x8811441914381143b9408c5C32247367F86F173A`, with
immutable bootstrap administrator
`0xCa37a15A64213b2ACD1784ae3f8e6Cbd4600D9D3`. Foundation Safes and legacy
Base administrators grant no authority over that kernel. The retired kernel
`0x4Bf02d5C9bC4306c38603EF2aA164f2f2273bcd7` and abandoned kernel
`0x8b2306be…` cannot be selected by the runtime.
