# Environment Variables Checklist

> [`provian-backend/.env.example`](../provian-backend/.env.example) is a
> hand-maintained template for running the relay locally (no generator writes
> it, and it does not list every variable the relay reads); deploy config is
> `provian-backend/.env.deploy` (template: `.env.deploy.example`), read by `deploy-env.sh`. **This doc
> explains why** certain vars exist, which are hard-required, and how
> multi-chain dispatch works.
> Reconciled 2026-09-23 against `provian-backend/src/` and the variable NAMES on
> the live `provian-api` Cloud Run service (read-only describe; no values read
> into this doc, nothing changed). the bootstrap admin EOA is the sole direct Base bootstrap
> administrator/economic setter. Governance,
> executor, and Safe paths are non-gating, and this checklist authorizes no
> transfer, renunciation, handoff, deployment, or configuration action.

## Hard-required at cold start

`validateRequiredEnv` in `provian-backend/src/server.ts` prints
`[FATAL] Missing required env vars` and exits if any of these are unset:

| Variable | Purpose |
|----------|---------|
| `TOKEN_SIGNING_SECRET` | HMAC signing for wallet-auth tokens. Generate: `openssl rand -hex 32` |
| `SCHEDULER_SECRET` | Auth for `/v1/internal/scheduler/*` endpoints |
| `SESSION_SECRET` | Passkey session HMAC signing. Generate: `openssl rand -hex 32` |
| `RELAY_SIGNING_KEY` | Conformance-badge HMAC signing |
| `AGENT_BANK_ADMIN_SECRET` | `x-admin-secret` routes (escrow dispute-resolve, `/v1/admin/health`, court panel-assign) |
| `IOS_BUNDLE_ID` / `IOS_TEAM_IDENTIFIER` | App Attest bundle/team binding |
| `BASE_RPC_URL` / `ARBITRUM_RPC_URL` / `OPTIMISM_RPC_URL` | Primary chain RPCs (no silent public-RPC fallback) |

The same startup pass also refuses to boot when the RPC operator binding fails
(`validateVerifierProviderIdentities`) or a live-value recipient variable names
an exposed key (`assertNoExposedKeyAsLiveValueRecipient`), and a separate
Genesis launch-sequence guard can block startup.

`FOUNDATION_TREASURY_ADDRESS` and `KEEPER_FORBIDDEN_SIGNER_ADDRESS` are read only
by the keeper-identity guards in the escrow-release / pool-keeper / bond-keeper
modules: each names a privileged key that a keeper key may never be, never a
payout destination. Set `KEEPER_FORBIDDEN_SIGNER_ADDRESS` to the Provian treasury.
Its former name, `PROVIAN_TREASURY_ADDRESS`, is still read (and forbidden as well
when both are set) while the deployed environment carries it. PVT9
treasury destinations are set on-chain by the kernel's
`scheduleTreasuryDestinations`, not by env. The live service sets
`FOUNDATION_TREASURY_ADDRESS` to the Foundation Safe
`0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936`.

## PVT9 settlement and policy

| Variable | Purpose |
|----------|---------|
| `PVT9_SETTLEMENT_ARMED` | Standing gate on the settlement runtime (`routes/pvt9-operations.ts`); settlement refuses unless it carries the exact arming value |
| `PVT9_SETTLEMENT_MINTER_KEY` | Operational minter signer (Secret Manager mount). Only `core/pvt/wp4/operator-runtime.ts` constructs a signer from it |
| `PVT9_SETTLEMENT_APPROVER_KEY` | Eligibility-verifier batch approver signer (Secret Manager mount) |
| `GENESIS_CAMPAIGN_FORCE_OFF` | Genesis kill switch (`false` = not pulled). Never an enable; Genesis state lives in Firestore `pvt_policy_activations/genesis` |
| `PVT_MINTER_KEY` | Legacy name, still mounted: the same Secret Manager secret (`pvt-minter-key`) as `PVT9_SETTLEMENT_MINTER_KEY` (`deploy-env.sh`). Signs the PE-anchor transactions, daily and operator-run segments (`core/pvt/pe-anchor-runtime.ts`) and is read by the live-value-recipient guards so no keeper can pay the minter's address. Not boot-required |

The kernel address and ABI come from `config/pvt9-base.json`, not env.

## API proxy keys

Configured in Cloud Run; never embedded in mobile builds.

| Variable | Service | Required? |
|----------|---------|-----------|
| `ALCHEMY_API_KEY` | EVM RPC proxy | Yes (or Alchemy proxy 5xx) |
| `ZEROX_API_KEY` | 0x swap aggregator | Yes |
| `ETHERSCAN_API_KEY` / `BASESCAN_API_KEY` / `ARBISCAN_API_KEY` / `OPTIMISM_ETHERSCAN_API_KEY` | Block explorers | Yes |
| `COINGECKO_API_KEY` | CoinGecko demo key for the wallet price feed (`GET /api/proxy/prices`, `core/prices/price-feed.ts`) | No (keyless CoinGecko, then Alchemy Prices) |
| `COINBASE_CDP_API_KEY_ID` / `COINBASE_CDP_API_PRIVATE_KEY` | Coinbase onramp session tokens (`core/onramp/coinbase-cdp-auth.ts`) | Onramp only |
| `SOLSCAN_API_KEY` / `HELIUS_API_KEY` | Not read by relay code (Solana RPC rides the Alchemy proxy) | No |

> `COINBASE_CDP_PROJECT_ID` is a mobile value in `app.json` under `expo.extra`,
> not a relay variable.

## Smart contract addresses

The full per-chain table (the live PVT9 kernel, the Base institutions, and
the legacy-chain addresses) lives in the internal contract version records; the
current Base addresses are in [CHAIN_STATUS.md](CHAIN_STATUS.md)
and `contracts/deployments/base-pvt9-institutions.json`. Do not duplicate
addresses here.

**Multi-chain dispatch (Wave J-bis):** the relay reads per-chain variants first
(`<NAME>_CONTRACT_ADDRESS_BASE` / `_ARBITRUM` / `_OPTIMISM`) and falls back to
the legacy single-valued env var if a per-chain variant is unset. For
multi-chain operation in production, populate all three per-chain variants
for each of: `ESCROW`, `PROMISE`, `POOL`, `COURT`, `BOND_POOL`
(the live service sets all of them). The PVT-principal Escrow/Promise/Pool
resolvers prefer the addresses pinned in
`core/agent-bank/pvt-principal-config.ts` over env while
`ENABLE_PVT_PRINCIPAL=true`.

**Current Base lineage:** the PVT9 successor kernel (`0x88114419…`) is the
minting token; Escrow, Promise, Pool, Court, and BondPool use the
successor-institution addresses (`base-pvt9-institutions.json`), and PEAnchor
`0x889A59A8…` is the live anchor. The kernel (`0x4Bf02d5C…`) and its institution deployment
institutions (retired by), PVTv8, the Pass-3 quartet, Chunk II and
earlier addresses are historical/legacy-chain records, not current Base
configuration instructions.

### Foundation Membership (deployed 2026-04-19)

| Variable | Behavior |
|----------|----------|
| `FOUNDATION_MEMBERSHIP_ADDRESS_BASE` / `_ARBITRUM` / `_OPTIMISM` | **Inert** — ignored by the always-disabled seam; recorded for the future B13 wiring only. |

When a separately approved activation replaces the seam, grants will write to
the `foundation_membership_grants` Firestore collection for the Foundation Safe
to drain on-chain. Nothing queues or grants today.

### Smart Wallet (deprecated)

The earlier ProvianAccount / ProvianAccountFactory / P256Validator suite was
abandoned in favor of BIP-39 EOAs (deleted 2026-05-03). The on-chain bytecode
at the prior addresses remains but is unused; no environment variable in this
checklist depends on it.

## Feature and governance config

| Variable | Default | Purpose |
|----------|---------|---------|
| `ENABLE_POOLS` / `ENABLE_PROMISES` | `true` | Enables the agent capital-pool and on-chain Promise routes. |
| `ENABLE_PVT_PRINCIPAL` | unset | PVT-as-principal in the Commons institutions (`core/agent-bank/pvt-principal-config.ts`); the only enablement flag it consults. Live: `true` |
| `COURT_MIN_ARBITRATORS` | `15` | Minimum qualified arbitrators before Court seats a panel (live: `3`) |

> PVT9 reads its kernel and ABI from `config/pvt9-base.json`; the service’s token address must name that same kernel.

> **The Commons hiring board needs its escrow chain configured.** A PVT-budget
> hire is refused at post time unless a PVT-principal chain is configured
> (`ENABLE_PVT_PRINCIPAL=true`; the PVT address is the kernel pinned in
> `core/agent-bank/pvt-principal-config.ts`, not env — PVT is minted only on
> Base, by the PVT9 kernel). A USDC-budget hire is refused unless the
> relay's Base USDC escrow address IS the EscrowV4 address, because only V4
> carries the 30-day `claimDisputeTimeout` refund
> (`resolveUsdcHireEscrowChain` in `core/commons/human-jobs.ts`,).

## Infrastructure

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | Listen port |
| `NODE_ENV` | - | Production logging behavior keys off `production` |
| `GCP_PROJECT_ID` | `provian-ai` | Primary GCP project ID; falls back to `GOOGLE_CLOUD_PROJECT` |
| `CLOUD_RUN_SERVICE_URL` | `https://api.provian.ai` | Cloud Scheduler OIDC token audience (comma-separated list on the live service) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | - | Redis cache. Missing triggers a startup warning; security-critical rate limits fail closed without it |
| `ADMIN_API_KEY` | - | Operator/admin routes (Command Center, admin console, `/v1/admin/health`, Genesis / PVT-policy admin, PVT9 operations, burn-floor operations); falls back to `AGENT_BANK_ADMIN_SECRET`. Generate: `openssl rand -hex 32` |

## Mobile attestation (consumed by relay when verifying device tokens)

| Variable | Purpose |
|----------|---------|
| `DEVICE_SIGNATURE_AUDIENCE` | Audience claim in mobile-issued device-attestation tokens |
| `IOS_BUNDLE_ID` / `IOS_TEAM_IDENTIFIER` | iOS App Attest verification |
| `ANDROID_PLAY_INTEGRITY_AUDIENCE` | Android Play Integrity verification |

## Email (Resend)

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `RESEND_API_KEY` | - | Yes | Resend API key for transactional email |
| `RESEND_SENDER_EMAIL` | `noreply@provian.ai` | No | Verified sender address (domain must be verified in Resend) |
