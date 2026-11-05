# API Proxy Endpoints

A **Provenance Envelope (PE)** is signed, hash-chained proof owned by its contributor. **PVT** is the currency on Base minted from witnessed work. The **relay** verifies and prices submitted evidence; a **witness** is something other than the actor that vouches for the act. **Basis points (bps)** express factors in ten-thousandths: 10,000 bps is 1.0×.

This document describes the API proxy endpoints the Provian relay serves so third-party API keys never ship in the mobile app. The RPC, explorer and price-feed routes live in `provian-backend/src/server.ts` (the "API PROXY ROUTES (G-1 Security Fix)" block), and the swap routes live in `provian-backend/src/routes/swap-proxy.ts`. The client side is `src/services/ProxyConfig.ts`.

## Overview

**Security Fix: G-1** - API keys for blockchain services were previously embedded in the mobile app binary, making them extractable. Every third-party API request now routes through the relay, which:

1. Authenticates the client with wallet auth
2. Adds the API key for the external service server-side
3. Forwards the request (10 s timeout) and returns the response
4. Rate-limits per user per service

## Architecture

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Mobile App    │         │  Relay Backend  │         │ External API    │
│                 │         │                 │         │ (Alchemy, etc)  │
│ Bearer Token ───┼────────▶│ Add API Key ────┼────────▶│                 │
│                 │◀────────┼─────────────────┼◀────────│                 │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

## Base URL

All proxy endpoints are relative to:
```
{RELAY_BACKEND_URL}/api/proxy
```

Example: `https://api.provian.ai/api/proxy/alchemy/rpc/base-mainnet`

## Authentication

Every proxy route runs the relay's `authenticate` middleware, the same wallet auth as other wallet endpoints:

```http
Authorization: Bearer {payloadB64}.{signatureHex}
```

The token is the v2 request-bound wallet-auth token: it is bound to the method, path, and body hash, expires in about 90 s, and is single-use. So the client mints a fresh token for each proxied request with the exact method, URL path, and body it will send (`ProxyConfig.getProxyHeaders(method, path, body, service)`, or `ProxyConfig.proxyFetch`, which does this for you).

---

## Alchemy Endpoints

**External Service:** Alchemy (EVM + Solana JSON-RPC)
**API Key Required:** `ALCHEMY_API_KEY`
**Dashboard:** https://dashboard.alchemy.com

### RPC API

**Proxy Path:** `POST /api/proxy/alchemy/rpc/{network}`

**Networks** (`ALCHEMY_NETWORKS`): `eth-mainnet`, `base-mainnet`, `arb-mainnet`, `opt-mainnet`, `eth-sepolia`, `base-sepolia`, `arb-sepolia`, `opt-sepolia`, `solana-mainnet`, `solana-devnet`. Any other value answers 400 `INVALID_NETWORK`. The wallet's Solana balances, history, and sends ride this same route.

**Example:**
```http
POST /api/proxy/alchemy/rpc/base-mainnet
Authorization: Bearer {token}
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "eth_getBalance",
  "params": ["0x123...", "latest"],
  "id": 1
}
```

**Forwards to:** `https://{network}.g.alchemy.com/v2/{ALCHEMY_API_KEY}` (the JSON-RPC body verbatim).

There is no NFT route (`/api/proxy/alchemy/nft/...`) and no `getAlchemyNFTUrl` helper. NFT data is fetched with standard JSON-RPC through `rpc/{network}` (e.g., `eth_call` against the NFT contract).

---

## Coinbase Onramp Endpoints

**External Service:** Coinbase Developer Platform (Onramp)
**Credentials:** `COINBASE_CDP_API_KEY_ID` + `COINBASE_CDP_API_PRIVATE_KEY`

- **`POST /api/proxy/coinbase/session-token`** — mints a single-use onramp session token server-side, so the wallet address never travels as a query parameter. Returns `{ token }`; the app puts it in the onramp URL and opens it in the system browser. 503 if CDP credentials are not provisioned, 502 on upstream failure.
- **`POST /api/proxy/coinbase/verify-buy`** — confirms a pending on-ramp deposit against the CDP Transaction Status API and, on a settled success matching the device's wallet, records a relay-verified `onramp` PE (deduped by Coinbase transaction id). Returns `{ verified, status, ..., pe_id? }`.

**Onramper is retired (P4-14).** The `/api/proxy/onramper/*` handler, the `getOnramperUrl` client helper, and `ONRAMPER_API_KEY` were removed in the Pass-4 reachability remediation (2026-07-03).

---

## Block Explorer Endpoints

**External Service:** Etherscan-family block explorers
**API Keys Required:** `ETHERSCAN_API_KEY`, `BASESCAN_API_KEY`, `ARBISCAN_API_KEY`, `OPTIMISM_ETHERSCAN_API_KEY`

**Proxy Path:** `GET /api/proxy/explorer/{network}`

**Networks** (`EXPLORER_NETWORKS`):
- `ethereum` - `https://api.etherscan.io/api`
- `base` - `https://api.basescan.org/api`
- `arbitrum` - `https://api.arbiscan.io/api`
- `optimism` - `https://api-optimistic.etherscan.io/api`

**Example - Get Token Balance:**
```http
GET /api/proxy/explorer/base?module=account&action=tokenbalance&contractaddress=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&address=0x123...&tag=latest
Authorization: Bearer {token}
```

**Forwards to:** the network's base URL with the caller's query string, and the key injected as the `apikey` query parameter (not a header).

---

## Price Feed Endpoint

**External Services:** CoinGecko, then Alchemy's Prices API
**API Keys:** `COINGECKO_API_KEY` (optional demo key, sent as `x-cg-demo-api-key`), `ALCHEMY_API_KEY`

**Proxy Path:** `GET /api/proxy/prices`

The wallet's USD price feed. The app never calls a price source itself; `src/core/prices/PriceService.ts` reads this route. The relay fetches server-side — CoinGecko `simple/price` first, then Alchemy's `prices/v1/.../tokens/by-symbol` for any symbol CoinGecko did not answer — holds each answer 60 s, and keeps a durable per-symbol last-known copy (Firestore `price_feed/latest`), so a down source is answered with last-known prices and their ages, never $0.00. Implementation: `provian-backend/src/core/prices/price-feed.ts`.

**Symbols:** `ETH`, `WETH`, `SOL`, `USDC`, `USDT`, `DAI`, `ARB`, `OP`, `BONK`, `JUP`, `WIF`, `PYUSD`. PVT has no market and is deliberately absent; a symbol never priced is absent (the app renders "—").

**Response** (`Cache-Control: no-store`): `{ prices: { <SYMBOL>: { usd, usd_24h_change, as_of_ms, source } }, refreshed_at_ms, upstream_down, served_at_ms }`. `usd_24h_change` is null for an Alchemy-priced symbol; `upstream_down` is true when the last refresh failed and the prices are last-known. A relay-side failure answers 503 `PRICE_FEED_UNAVAILABLE`.

---

## Swap Endpoints (the relay sets the 0.25% fee)

Every swap through Provian charges 0.25% (25 bps), and the fee is applied **on the relay**: each
swap route rebuilds the upstream request from an allowlist of the client's routing fields and sets
the fee parameters itself. A fee field the client sends is dropped or overwritten, never honoured.
Before returning an upstream answer, the relay verifies that it carries the 25 bps fee to the named
recipient, and refuses it (fail closed, `502`) if it does not. Implementation:
`provian-backend/src/routes/swap-proxy.ts` + `src/core/swap/swap-fees.ts`. Agent swaps use the
separate agent route `POST /v1/agent/wallet/:wallet_id/swap`, which runs the same 0x fee builder
and verifier.

| Route | Aggregator | Fee mechanism | Fee recipient |
|-------|-----------|---------------|---------------|
| Same-chain EVM | 0x v2 | `swapFeeRecipient` / `swapFeeBps=25` / `swapFeeToken=<buy token>` | EVM treasury `0x086e0F377af1245B8888540f39e99A42a7daF1dA` (`SWAP_FEE_RECIPIENT`, must equal the pinned treasury) |
| Same-chain Solana (any SPL or Token-2022 pair) | Jupiter | `platformFeeBps=25` + `feeAccount` | The Solana treasury `5PHJDHYveHA1LhqiWpCDRVEgSezDgPBMyL1rwAoMBTco`'s token account for the fee mint: `E8WkRWFrrpJH2nvVDB3jTnLrRJQqpCT8qftV4vU7QQkB` for USDC, `Fs42KbAkah3agwXi57LTEeNL1FncDZg3JEce4yJ9eAjd` for SOL, otherwise its associated token account for the input (or output) mint |
| Cross-chain | LI.FI | `integrator=provian`, `fee=0.0025` | The fee wallets registered for `provian` at portal.li.fi: EVM treasury on an EVM source, Solana treasury on a Solana source |

The aggregator's or bridge's own fee is separate from Provian's and shown under its own name on
the swap screen: 0x's fee, LI.FI's fixed fee (charged whether or not an integrator fee is set, so
it takes nothing from Provian's 25 bps), and bridge/solver fees. Jupiter charges no protocol fee.

### 0x — `GET /api/proxy/zerox/allowance-holder/quote`

**API Key Required:** `ZEROX_API_KEY` (dashboard: https://dashboard.0x.org)

Client fields kept: `chainId` (8453 / 42161 / 10), `sellToken`, `buyToken`, `sellAmount`, `taker`,
`slippageBps`. The relay adds the fee triple and forwards to
`https://api.0x.org/swap/allowance-holder/quote` with `0x-api-key` + `0x-version: v2`. The answer
must carry exactly one `fees.integratorFee` in the buy token at 25 bps of the gross buy amount, and
its calldata must name the treasury; the response adds
`provian_fee: { bps, amount, token }`. `buyAmount` is already net of every fee.

Every other `/api/proxy/zerox/*` path or method (price, permit2, arbitrary) answers
`404 ZEROX_PATH_REFUSED`. Until 2026-09-25 this proxy was a transparent pass-through that added no fee.

### LI.FI — `GET /api/proxy/lifi/quote`

**API Key Required:** `LIFI_API_KEY` (Secret Manager `lifi-api-key`)

Client fields kept: `fromChain`, `toChain` (8453 / 42161 / 10 / 1151111081099710), `fromToken`,
`toToken`, `fromAmount`, `fromAddress`, `toAddress`, `slippage`. Same-chain requests are refused
(`400 same_chain_not_lifi`); same-chain EVM is 0x and same-chain Solana is Jupiter. The relay adds
`integrator=provian&fee=0.0025` and forwards to `https://li.quest/v1/quote` with `x-lifi-api-key`.
The answer's fee split must pay `provian` exactly 25 bps of `fromAmount` and pay nobody but
`provian` and `lifi`. The executable transaction must itself move exactly that fee to the
treasury. On an EVM source, the calldata must carry the FeeForwarder recipient pair (treasury
address, fee amount). On a Solana source, one instruction must transfer exactly the fee: a
System transfer to the Solana treasury for SOL, or an SPL transfer to the treasury's USDC account
for USDC. The destination must be a writable static key. Solana source tokens other than SOL/USDC
are refused. The user must pay for the transaction (`lifi_tx_wrong_payer` otherwise). While the
Solana treasury holds no SOL, a transfer smaller than the chain's rent-exempt minimum cannot land
in it, so LI.FI raises a SOL fee transfer to exactly that minimum; the relay accepts that one case
(treasury balance 0, amount equal to the minimum read from chain) and reports the difference as
the user's treasury deposit. The response adds
`provian_fee`, `lifi_fee`, and on a Solana source `solana_costs` (below). LI.FI forwards the fee to the registered wallet at execution time
(EVM: its FeeForwarder; Solana: a direct transfer). Nothing has to be claimed.

### Jupiter — `POST /api/proxy/jupiter/order`

**Body:** `{ inputMint, outputMint, amount, slippageBps, userPublicKey }`: any two different
Solana mints (native SOL as the wrapped-SOL mint). The app offers SOL, USDC, BONK, JUP, WIF and
PYUSD; the route itself charges every pair. Client fee fields (`platformFeeBps`, `feeAccount`, ...)
are ignored.

1. **Fee mint.** The relay reads each mint from chain. The fee is taken in USDC if the pair has it,
   else in SOL, else in the input mint, else in the output mint — classic SPL Token and Token-2022
   alike. A Token-2022 mint's own transfer fee reduces what reaches the
   treasury on that fee; that is accepted. A mint whose new accounts start frozen
   (`defaultAccountState`) is skipped while the treasury has no account for it, since a frozen
   account cannot receive. A mint no token program owns, or one carrying a Token-2022 extension
   the relay does not know, is refused (`400 unsupported_mint`); a pair with no side that can take
   the fee is refused (`400 unsupported_pair`) — never swapped fee-free.
2. **Fee account.** It is the treasury's associated token account for the fee mint under that
   mint's token program, derived on the relay (for USDC it must equal the pinned `E8WkRW…`). If it
   exists, it must be a token account of that program owned by `5PHJDHY…` for that mint and not
   frozen (`503 swap_fee_wrong_recipient` / `solana_fee_account_frozen` otherwise). An unreadable
   chain answers `503 solana_rpc_unavailable`. Each case refuses before any Jupiter call.
3. **Quote + swap.** `ExactIn` with `platformFeeBps=25` (plus `instructionVersion=V2` when the
   fee mint is Token-2022, which Jupiter needs to pay a Token-2022 fee account), then `/swap` with
   that `feeAccount`. On
   the output side the fee is `platformFee.amount`; on the input side it is
   `floor(amount × 25 / 10000)`. The relay decodes the returned transaction. It refuses it unless
   the user pays for it and the fee account is a writable static key of the Jupiter instruction.
4. **First fee in a new mint.** Jupiter only pays into an existing account; with a missing one it
   fails the whole swap on-chain (custom error 6025). When the treasury has no account for the
   fee mint yet, the relay puts an idempotent `CreateAssociatedTokenAccount` for it (owner
   `5PHJDHY…`, rent paid by the user) at the front of the same transaction. The account is created
   and the fee lands in it atomically. The relay resolves the transaction's lookup tables from
   chain so no key is loaded twice. If the route Jupiter chose leaves no room under the 1232-byte
   cap for the create, the relay asks again for a route with fewer accounts (`maxAccounts` 40,
   then 24) and uses the first that fits; if none fits, the order is refused
   (`503 jupiter_tx_too_large`), never sent without the fee. An address that only holds lamports (someone sent SOL to it)
   still counts as not created, because the create tops it up, so pre-funding cannot block a fee
   mint. The response then carries `fee_account_created: { account, rent_lamports }`: the user's
   deposit, the chain's rent-exempt minimum for the account's size (165 bytes for a classic mint;
   for Token-2022, 170 plus the account extensions the mint implies — 187 for PYUSD — read at
   request time) less any lamports already there. The user pays it; Provian does not. This happens
   once per fee mint, ever.
5. **SOL costs.** Every order (and every LI.FI quote from a Solana source) carries
   `solana_costs`, the SOL the user's own transaction needs, each by name:
   `network_fee_lamports` (signatures + compute-budget priority), `receiving_account_lamports`
   (opening the user's account for the token received), `treasury_fee_account_lamports` (step 4),
   `temporary_account_lamports` (opened and closed in the same swap, refunded — e.g. wrapped SOL),
   `other_accounts_lamports` (anything else the route opens, e.g. a bridge's order account), and
   `sol_swapped_lamports`; then `spend_lamports`, `required_lamports`, `balance_lamports`,
   `rent_exempt_minimum_lamports`, `sufficient`, `shortfall_lamports`, `measured`. The relay
   simulates the user's transaction (with inner instructions, so accounts a program opens by CPI
   count). If that fails — typically because the wallet lacks the SOL — it simulates a copy in
   which a funded account (`SOLANA_SIMULATION_FUNDER`, else a fixed public account) pays the fee
   and credits the user, when that copy still fits 1232 bytes; otherwise it falls back to the
   figures readable from the top-level instructions (`measured: false`). Those cannot see accounts
   a program opens inside the swap, so the app never offers a `measured: false` answer as
   affordable; it still shows an unmeasured shortfall. The app also recomputes `sufficient` from
   the figures and refuses an answer where they disagree. `sufficient` uses the
   send screen's rule: the wallet must cover spend + temporary accounts and end at 0 or at least
   the rent-exempt minimum; `shortfall_lamports` is what the wallet must add.

Upstream: `https://lite-api.jup.ag/swap/v1`, or `https://api.jup.ag/swap/v1` with `x-api-key` when
`JUPITER_API_KEY` is set. Response: `{ quote, swapTransaction, lastValidBlockHeight,
prioritizationFeeLamports, provian_fee: { bps, amount, mint, side, account, token_program },
solana_costs, fee_account_created? }`.

---

## Error Handling

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `INVALID_NETWORK` | Unknown Alchemy or explorer network |
| 401 | — | Wallet-auth token missing, invalid, expired, or replayed |
| 429 | `RATE_LIMITED` | Per-user service limit exceeded |
| 4xx | `UPSTREAM_4XX` | Upstream rejected the request; its status is passed through with `upstream_status` and a sanitized `upstream_body` (e.g., 0x "insufficient liquidity") |
| 502 | `EXTERNAL_ERROR` | Upstream 5xx, reported opaquely with `external_status` |
| 503 | `SERVICE_UNAVAILABLE` | The service's API key is not configured on the relay |
| 504 | `UPSTREAM_TIMEOUT` | Upstream did not answer within 10 s |
| 500 | `PROXY_ERROR` | Relay-side failure |

Error bodies are JSON: `{ "error": "...", "code": "...", ... }`. `forwardUpstreamResponse` and `sanitizeUpstreamBody` in `server.ts` implement the passthrough.

---

## Rate Limiting

Per user, per service, over a 60-second window (`checkProxyRateLimit`, Redis-backed; `PROXY_CONFIG` in `server.ts`):

| Service | Limit |
|---------|-------|
| Alchemy RPC | 100 req/min |
| Explorer | 10 req/min |
| Prices | 30 req/min |
| 0x Swap | 10 req/min |
| LI.FI | 10 req/min |
| Jupiter | 10 req/min |

---

## Logging

Each proxied request logs the service, network or path, method, and user id (`[Proxy] ...`), and upstream failures and timeouts are logged with their status or URL.

---

## Client Implementation

`src/services/ProxyConfig.ts` builds proxy URLs and request-bound headers. The simplest form is `proxyFetch`, which mints the token for the exact request:

```typescript
import ProxyConfig from '../services/ProxyConfig';

const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: ['0x123...', 'latest'], id: 1 });
const response = await ProxyConfig.proxyFetch('alchemy', 'rpc/base-mainnet', { method: 'POST', body });
```

Building the request by hand, bind the token to the same method, path, and body:

```typescript
const url = await ProxyConfig.getAlchemyRpcUrl('base-mainnet');
const headers = await ProxyConfig.getProxyHeaders('POST', new URL(url).pathname, body, 'alchemy');
const response = await fetch(url, { method: 'POST', headers, body });
```

`getProxyHeaders` fails closed (`ProxyAuthRequiredError`) when no auth token is available. Other helpers: `getSolanaRpcUrl`, `getZeroXUrl`, `getExplorerUrl`.
