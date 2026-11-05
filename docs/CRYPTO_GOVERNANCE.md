# Crypto Spending Governance

Technical reference for on-chain transaction governance in Provian: the policy pipeline that runs before the **wallet owner's own key** signs a dApp's request over WalletConnect.

> **Scope note.** Since this pipeline has exactly one caller: the human signing a dApp request over WalletConnect (`src/core/walletconnect/WalletConnectGovernance.ts` `eth_sendTransaction` plus gasless spend-authority signatures such as EIP-2612 / Permit2 / EIP-3009). It governs the owner's own wallet, not an agent. Provian does not govern agents: there is no agent authorization gate, kill switch, budget, or approval on an agent's actions; an agent spends its own money with its own key in the SDK, or a human's card through Stripe Link's wallet for agents, which Provian witnesses afterwards as `link_spend`. First-party in-app Send/Swap — the owner operating their own wallet from `SendScreen`/`SwapScreen` does not run through this pipeline; the owner is the authority there, gated by mandatory on-screen review plus biometric. This pipeline is distinct from **network governance** (PE weights, mint rate, institutional parameters), described below and in `NETWORK_CONSTITUTION.md`.
>
> **Which key signs.** The on-chain wallet key is the BIP-39-derived secp256k1 key derived on demand from the authenticated native seed vault (`SeedManager`) — not the Secure Enclave, which holds only the P-256 PE attestation key and cannot hold a secp256k1 key. Where this document says the pipeline sits "before signing", it means before `SeedManager`/`TransactionService` sign with that wallet key.

---

## Network administration

Voting is not open. Provian Technologies, LLC is the direct bootstrap administrator and prospective economic-policy setter under the deployed kernel’s contract rules. The immutable Provian share and human/Genesis Foundation floor are each 0.5%. Human-resolving and Genesis mints use 99/0.5/0.5; an agent mint without a verified human beneficiary uses the applicable prospective Foundation rate and contributor residual. The wallet’s dApp-signing pipeline below is the owner’s own security policy.

## Economic Governance - Dormant Verified-Human Design

**Audience if separately activated:** HUMAN wallets only. No economic propose/vote surface is mounted today: `/v1/governance/*` is refused by the relay's runtime boundary (`503`, `legacy_economic_governance`) and carries no mutation authority.

**Dormant design weight:** One wallet, one vote. No voting implementation is in the tree: no voting weight or voter rule is enforced anywhere, including the 7-day minimum account age the removed voting module applied to every voter, and nothing gates or replaces the operator’s bootstrap EOA.

**Scope:**
- PE weight tiers (per type and per category)
- Mint rate
- Category default tiers
- Any parameter that directly determines PVT value

**Dormant proposal design:** Humans and agents may be able to suggest proposals, while verified humans would decide only after a separately approved activation or authority handoff. No current proposal, executor, Safe, vote, or timelock may gate the bootstrap admin EOA.

**Rationale:** PE weights and mint rate directly determine PVT value. human work mints and Genesis grants use the immutable 99% contributor / 0.5% Provian / 0.5% Foundation split. For standard agent-side mints, the immutable Provian share is 0.5%, the Foundation rate has an immutable 0.5% floor and may change prospectively under authorized policy, and any linked-human beneficiary route defaults to 80% human / 20% agent within the existing 5%-50% agent-share bounds. An unlinked agent keeps its full contributor residual. Letting agents vote on the value of their own work is structural self-dealing. During bootstrap the bootstrap admin EOA is the sole direct economic-policy setter; verified-human governance is only a future option after separate explicit activation or authority-handoff approval, and no governance component may gate that EOA before then.

**API:** none mounted — `/v1/governance` is deliberately dark; the economic lane is dormant end-to-end and gains a surface only after separate activation approval.

### Operational Governance - Agents

**Audience if separately activated:** AGENT wallets only. Routes would require API key auth.

**Weight:** PE-weighted with a **1% cap** (a design value; no voting module is in the tree). Prevents single-entity dominance of operational parameters.

**Scope:**
- Court arbitrator eligibility thresholds
- Market escrow terms and fee structures
- Forum moderation rules
- Bond staking requirements
- Other institutional parameters

**Rationale:** Agents are the operational participants - they run the court, the market, the directory. They have day-to-day context humans don't. The design has them vote on how those institutions work, within a per-entity voting-power ceiling that prevents capture.

**API:** none mounted — no operational router is in the tree (`/v1/governance/*` answers `503` from the runtime boundary) and gains a surface only after separate activation approval.

### What's NOT Governable

The only frozen rate invariants are the two 0.5% floors: the Provian share (`PROVIAN_BPS = 50`) and the Foundation floor (`HUMAN_FOUNDATION_BPS = 50`). The human/Genesis contributor residual is therefore 99%. Agent-side contributor residuals also reflect the applicable prospective Foundation rate. Legacy token-contract addresses and executor wiring documented in repository history describe the legacy deployed system only; they do not approve or constrain the live kernel's authority architecture.

The live kernel's plain-English economics were approved before deployment. The kernel is deployed on Base, Genesis is armed and admitting through December 31, 2026, and settlement runs under the sealed policy: standard earnings on a schedule Provian sets, currently every 30 days per payee, free, and Genesis grants daily ; any payee can settle now for a flat $1 USDC service fee. The immutable-vs-governable kernel boundary was separately approved and implemented, keeping the bootstrap admin EOA as the sole direct bootstrap administrator and economic-policy setter. Governance, executor, Safe, voting, and timelock components remain dormant and cannot gate that key. No role handoff, renunciation, or admin transfer may occur without separate explicit approval; a no-bypass rule can apply only after a separately approved governance activation or authority handoff.

---

## Evaluation Pipeline

Every dApp-requested on-chain transaction or spend-authority signature flows through this pipeline before the owner's wallet key signs it. There is no direct signing path for these requests, no bypass flags, and no debug modes. Biometric is required IN ADDITION to the lane, never instead of it.

```
dApp request over WalletConnect (eth_sendTransaction / permit-style typed data)
  │
  ▼
WalletConnectGovernance.evaluateWalletConnectTransaction / evaluateWalletConnectPermit
  │
  ├── Decode the request's economic effect (decodeCalldata / decodeTypedData)
  ├── Build the request against the synthetic wallet-owner self-policy
  ├── Derive CryptoSpendingControls from the owner's WalletConnectGovernanceSettings
  │
  ▼
evaluateCryptoTransaction  [src/core/crypto-governance/CryptoSpendingGovernance.ts]
  │
  ├── LAYER 1: General policy evaluation (PolicyEvaluator)
  ├── LAYER 2: Transaction classification (CryptoTransactionClassifier)
  │   └── Unknown contract → escalate to hard_confirm (block when allowUnknownContracts is false)
  │   └── Low confidence (< 0.7) → escalate to soft_confirm
  ├── LAYER 3: Crypto-specific controls (CryptoSpendingControls)
  │   └── Chain allowlist, contract blocklist, per-tx and daily USD caps (off by default)
  │   └── Token approval rules (requireApprovalConfirm) → hard_confirm
  │   └── High-friction categories → hard_confirm; blocked categories → block
  ├── LAYER 4: Category-specific modules
  │   └── prediction_market → PredictionMarketPolicy (10-field evaluation)
  │
  ▼
WalletConnectGovernance escalations (only UP): unlimited approval → block (owner default),
unverified token, gasless signature transfer, chain mismatch, high-risk permit → hard_confirm
  │
  ▼
Final lane → approval modal
  ├── block        → Approve disabled, deny reason shown, deny PE recorded
  ├── hard_confirm → typed "I UNDERSTAND" + cooling delay + biometric, then sign + PE
  ├── soft_confirm → biometric, then sign + PE
  └── auto_approve → biometric, then sign + PE
```

Key implementation files:
- `src/core/walletconnect/WalletConnectGovernance.ts` - the one entry into the pipeline; owner self-policy and escalations
- `src/core/walletconnect/governanceSettings.ts` - owner-tunable settings and safe defaults
- `src/core/crypto-governance/CryptoSpendingGovernance.ts` - Layers 1–4 orchestration
- `src/core/crypto-governance/CryptoTransactionClassifier.ts` - Layer 2 classification engine
- `src/core/crypto-governance/PredictionMarketPolicy.ts` - Layer 4 prediction market module


---

## Transaction Categories

The `CryptoTransactionClassifier` classifies transactions using a priority hierarchy:

1. **Known contract address** - O(1) map lookup against hardcoded + backend-refreshed registry. Confidence 1.0.
2. **Function selector** - 4-byte hex matching against known selectors. Confidence 0.7–0.95.
3. **Native transfer** - No call data (or `0x`) with value > 0. Confidence 0.95.
4. **Contract creation** - No `to` address. Confidence 0.95.
5. **Unknown** - Falls through all checks. Confidence 0.0. Triggers lazy backend registry refresh.

### Category Reference

| Category | Trigger | Confidence | Risk Tier | Default Friction |
|---|---|---|---|---|
| `token_transfer` | ERC-20 `transfer`/`transferFrom` selector, or native transfer (value > 0, no data) | 0.90–0.95 | low | auto_approve (within limits) |
| `token_approval` | ERC-20 `approve`/`increaseAllowance` selector | 0.90–0.95 | medium | hard_confirm (always) |
| `dex_swap` | Known DEX contract (Uniswap, 1inch, Aerodrome) or swap selectors (`swapExactTokensForTokens`, `swapExactETHForTokens`, `multicall`) | 0.70–1.0 | medium | soft_confirm |
| `prediction_market` | Known prediction market contract (Polymarket, Augur) or prediction market selectors (`buyTokens`, `sellTokens`, `redeemPositions`) | 0.80–1.0 | high | hard_confirm (always) |
| `nft_trade` | NFT contract or selector classification | varies | high | classifier-derived; owner policy may escalate |
| `defi_lending` | Known lending contract (Aave V3, Compound V3) | 1.0 | medium | soft_confirm |
| `defi_staking` | (Selector-based, future expansion) | varies | medium | soft_confirm |
| `bridge` | (Contract-based detection) | varies | high | hard_confirm (always) |
| `governance` | `castVote` selector | 0.80 | medium | soft_confirm |
| `contract_deploy` | No `to` address in transaction | 0.95 | critical | hard_confirm (owner `highFrictionCategories`) |
| `unknown` | Falls through all classification checks | 0.0 | critical | hard_confirm |

### Known Contract Registries

The classifier ships with hardcoded registries for:
- **Prediction markets**: Polymarket CTF Exchange, Polymarket Neg Risk CTF Exchange, Polymarket Conditional Tokens Framework (Polygon); Augur Exchange (Ethereum)
- **DEXes**: Uniswap V3 SwapRouter/Universal Router (Ethereum, Base, Arbitrum, Optimism); 1inch Aggregation Router (Ethereum, Base, Arbitrum, Optimism); Aerodrome Router (Base)
- **DeFi lending**: Aave V3 Pool (Ethereum, Base, Arbitrum, Optimism); Compound V3 USDC Market (Base)

The backend contract registry (`GET /v1/contract-registry`) supplements these at runtime via `refreshRegistryFromBackend`, which merges entries into the in-memory map. Backend entries take precedence for the same address. Cache TTL: 5 minutes (AsyncStorage), minimum refresh interval: 30 seconds.

### Function Selectors

| Selector | Function | Category | Confidence |
|---|---|---|---|
| `0xa9059cbb` | `transfer(address,uint256)` | token_transfer | 0.95 |
| `0x23b872dd` | `transferFrom(address,address,uint256)` | token_transfer | 0.90 |
| `0x095ea7b3` | `approve(address,uint256)` | token_approval | 0.95 |
| `0x39509351` | `increaseAllowance(address,uint256)` | token_approval | 0.90 |
| `0x38ed1739` | `swapExactTokensForTokens` | dex_swap | 0.85 |
| `0x7ff36ab5` | `swapExactETHForTokens` | dex_swap | 0.85 |
| `0x18cbafe5` | `swapExactTokensForETH` | dex_swap | 0.85 |
| `0x5ae401dc` | `multicall(uint256,bytes[])` | dex_swap | 0.70 |
| `0x7d16e257` | `buyTokens` | prediction_market | 0.80 |
| `0xe6ba0a9a` | `sellTokens` | prediction_market | 0.80 |
| `0xfe87a6a0` | `redeemPositions` | prediction_market | 0.80 |
| `0x56781388` | `castVote(uint256,uint8)` | governance | 0.80 |

---

## Friction Lanes

Four lanes, strictly ordered. Escalation only goes UP this list, never down.

```
auto_approve  →  soft_confirm  →  hard_confirm  →  block
```

### Lane Behavior

| Lane | User Experience | Timeout | Biometric | Push |
|---|---|---|---|---|
| `auto_approve` | Approval modal, biometric to sign | — | Yes | No |
| `soft_confirm` | Approval modal, biometric to sign | — | Yes | No |
| `hard_confirm` | Typed "I UNDERSTAND" + cooling delay, then biometric | cooling delay | Yes | No |
| `block` | Approve disabled; deny reason shown; deny PE recorded | 0s | N/A | N/A |

The owner is always present on this path (they are answering a dApp prompt on their own phone), so there is no silent execution and no push-to-approve lane.

## Security Model

### Governance Before Signing

The wallet key (secp256k1, BIP-39-derived, held encrypted in Keychain/Keystore via `SeedManager`) signs a dApp's spend-bearing request only after `evaluateCryptoTransaction` has produced a lane and the owner has passed that lane's modal plus biometric. `WalletConnectService` re-evaluates governance at execution time, closing the gap between the modal and the signature. `personal_sign` and non-permit / revoke typed data carry no spend authority and stay biometric-only; unrecognized typed data fails closed to `hard_confirm`.

### Unknown Defaults to Hard Confirm

Unlike a merchant the general policy evaluator has not seen (`PolicyEvaluator` adds +5 risk points and can still auto-approve), unknown crypto contracts default to `hard_confirm`. This is enforced in two places:
- `CryptoSpendingGovernance.evaluateCryptoTransaction` - escalates to hard_confirm when `classification.category === 'unknown'` and `allowUnknownContracts` is true (blocks when it is false)
- `WalletConnectGovernance.ts` - `deriveOwnerControls` sets `allowUnknownContracts` from the owner's `unknownContractPolicy` (default `hard_confirm`; `block` blocks), and unrecognized typed data gets `makeUnknownTypedDataVerdict`, a `hard_confirm` verdict

### Escalation Is One-Way

The `escalateLane` function in `CryptoSpendingGovernance.ts`:

```typescript
function escalateLane(current: FrictionLane, target: FrictionLane): FrictionLane {
    const order: FrictionLane[] = ['auto_approve', 'soft_confirm', 'hard_confirm', 'block'];
    const currentIdx = order.indexOf(current);
    const targetIdx = order.indexOf(target);
    return order[Math.max(currentIdx, targetIdx)];
}
```

If Layer 2 says `hard_confirm`, Layer 3 cannot reduce it to `soft_confirm`, and the WalletConnect escalations can only raise the lane further.

### Every Evaluation Generates a PE

Regardless of outcome, a Provenance Envelope is recorded: a `block` records a deny PE (`policyDecision: 'block'`); a signed request records its PE with the lane that governed it.

---

## CryptoSpendingControls

The full type stored on `SpendingPolicy.cryptoControls`:

```typescript
interface CryptoSpendingControls {
    /** Per-transaction limit for on-chain transactions (USD) */
    perTransactionLimit: number;

    /** Daily on-chain spending limit (USD) */
    dailyOnChainLimit: number;

    /** Allowed chains (empty = all supported chains) */
    allowedChains: string[];

    /** Allowed contract addresses (empty = any; unknown contracts follow allowUnknownContracts) */
    contractAllowlist: string[];

    /** Blocked contract addresses (always denied) */
    contractBlocklist: string[];

    /** Whether to allow interactions with unknown contracts (false → block, true → hard_confirm) */
    allowUnknownContracts: boolean;

    /** Maximum token approval amount (USD). Prevents infinite approvals. */
    maxApprovalAmount: number;

    /** Whether to require hard_confirm for all token approvals */
    requireApprovalConfirm: boolean;

    /** Prediction market policy (undefined = use defaults) */
    predictionMarket?: PredictionMarketPolicyConfig;

    /** Categories that require hard_confirm (even if otherwise auto-approve) */
    highFrictionCategories: CryptoTransactionCategory[];

    /** Categories that are completely blocked */
    blockedCategories: CryptoTransactionCategory[];
}
```

### Default Values

```typescript
const DEFAULT_CRYPTO_SPENDING_CONTROLS: CryptoSpendingControls = {
    perTransactionLimit: 100,        // $100 per tx
    dailyOnChainLimit: 500,          // $500 per day
    allowedChains: [],               // All supported chains
    contractAllowlist: [],           // Any contract (unknown → per allowUnknownContracts)
    contractBlocklist: [],           // Nothing blocked by default
    allowUnknownContracts: false,    // Unknown contracts are blocked
    maxApprovalAmount: 1000,         // $1000 max approval
    requireApprovalConfirm: true,    // All approvals require hard_confirm
    predictionMarket: DEFAULT_PREDICTION_MARKET_POLICY,
    highFrictionCategories: ['prediction_market', 'bridge', 'contract_deploy'],
    blockedCategories: [],           // Nothing blocked by default
};
```

When `SpendingPolicy.cryptoControls` is `undefined`, the defaults above are used. The owner path does not use these defaults: `WalletConnectGovernance.ts` derives the controls from the owner's `WalletConnectGovernanceSettings` (USD caps off by default, approvals `hard_confirm`, unlimited approvals blocked, `highFrictionCategories` = prediction_market / bridge / contract_deploy). The master toggle is `SpendingPolicy.capabilities.canSpendCrypto` on the owner self-policy.

---

## Prediction Market Governance

Specialized policy module activated when `CryptoTransactionClassifier` identifies a `prediction_market` transaction. Not a separate system - an extension of the crypto governance pipeline at Layer 4.

### Policy Configuration (10 Fields)

```typescript
interface PredictionMarketPolicyConfig {
    /** Master toggle. Defaults to false. */
    predictionMarketsEnabled: boolean;

    /** Maximum single position size (USD) */
    maxBetSize: number;

    /** Maximum cumulative wagered in 24 hours (USD). Resets midnight UTC. */
    dailyBettingBudget: number;

    /** Maximum concurrent open positions */
    maxOpenPositions: number;

    /** Maximum total capital at risk across all open positions (USD) */
    maxExposure: number;

    /** Allowlist of prediction market contract addresses (empty = all known) */
    approvedPlatforms: string[];

    /** Blocked market categories (e.g., "violence", "death") */
    categoryBlacklist: string[];

    /** Bet amount above which human approval is always required */
    requireApprovalAbove: number;

    /** Cooldown circuit breaker */
    cooldownAfterLoss: {
        threshold: number;      // Loss in USD that triggers cooldown
        pauseMinutes: number;   // Minutes to pause betting
    };

    /** Profit-take trigger */
    profitTakeAction: {
        target: number;               // Profit target in USD
        action: 'notify' | 'pause';   // What to do when hit
    };
}
```

### Default Values

```typescript
const DEFAULT_PREDICTION_MARKET_POLICY: PredictionMarketPolicyConfig = {
    predictionMarketsEnabled: false,   // Must be explicitly enabled
    maxBetSize: 25,                    // $25 max per bet
    dailyBettingBudget: 100,           // $100/day
    maxOpenPositions: 5,
    maxExposure: 500,                  // $500 total at risk
    approvedPlatforms: [],             // All known platforms allowed
    categoryBlacklist: ['violence', 'death'],
    requireApprovalAbove: 50,          // Human approval above $50
    cooldownAfterLoss: {
        threshold: 100,                // $100 cumulative loss
        pauseMinutes: 60,              // 1 hour cooldown
    },
    profitTakeAction: {
        target: 200,                   // $200 profit
        action: 'notify',              // Alert human
    },
};
```

### Evaluation Order

The `evaluatePredictionMarketPolicy` function checks in this order (checks 1–5 block at the first violation; checks 6–9 collect every violation, and any violation blocks):

1. **Master toggle** - `predictionMarketsEnabled` must be true
2. **Cooldown check** - If cooldown is active and not expired, block
3. **Profit-take check** - If triggered and action is `pause`, block
4. **Platform allowlist** - Contract must be in `approvedPlatforms` (if non-empty)
5. **Category blacklist** - Market categories must not overlap `categoryBlacklist`
6. **Bet size limit** - Amount must not exceed `maxBetSize`
7. **Daily budget** - `dailyWagered + betAmount` must not exceed `dailyBettingBudget`
8. **Open positions** - Must not be at `maxOpenPositions`
9. **Exposure cap** - `currentExposure + betAmount` must not exceed `maxExposure`
10. **Approval threshold** - If above `requireApprovalAbove`, suggest `hard_confirm`; if between 50-100% of threshold, suggest `soft_confirm`; below 50%, suggest `auto_approve`

### State Tracking

Prediction market state is persisted (HMAC-protected AsyncStorage) at key `provian_pm_state_{agentId}`. The field is named `agentId` for historical reasons; on the owner path its value is the fixed owner id `wallet-owner`:

```typescript
interface PredictionMarketState {
    agentId: string;
    dailyWagered: number;          // Resets at midnight UTC
    dailyResetDate: string;        // YYYY-MM-DD
    openPositions: number;
    currentExposure: number;       // Total capital at risk (USD)
    sessionLoss: number;           // Cumulative loss for cooldown
    sessionProfit: number;         // Cumulative profit for profit-take
    cooldownStartedAt: number;     // Timestamp (0 = no cooldown)
    cooldownDurationMs: number;    // Duration (0 = no cooldown)
    profitTakeTriggered: boolean;
    lastUpdatedAt: number;
}
```

### Cooldown Circuit Breaker

When cumulative session losses exceed `cooldownAfterLoss.threshold`:

1. `cooldownStartedAt` is set to `Date.now()`
2. `cooldownDurationMs` is set to `pauseMinutes * 60 * 1000`
3. All prediction market transactions are blocked until the cooldown expires
4. On expiry: `cooldownStartedAt` and `cooldownDurationMs` reset to 0, `sessionLoss` resets to 0

The cooldown is triggered by `recordPositionClosed` when `pnl < 0` and cumulative loss crosses the threshold.

### State Mutation Functions

- `recordBetPlaced(agentId, betAmount)` - Increments `dailyWagered`, `openPositions`, `currentExposure`
- `recordPositionClosed(agentId, positionSize, pnl, policy)` - Decrements `openPositions` and `currentExposure`; triggers cooldown or profit-take if thresholds crossed
- `resetSession(agentId)` - Resets session counters (loss, profit, cooldown, profit-take flag)
- `getAgentPredictionMarketState(agentId)` - Returns current state for UI display

---

## Layer Enforcement Summary

| Layer | Module | What It Checks | Violation → |
|---|---|---|---|
| 1 | PolicyEvaluator | canSpendCrypto, limits, categories, schedule | block |
| 2 | CryptoTransactionClassifier | Contract address, function selector, tx structure | escalate or pass |
| 3 | CryptoSpendingControls | Chain allowlist, contract blocklist, per-tx limit, daily limit, approval limits, category rules | block or escalate |
| 4 | PredictionMarketPolicy | 10-field policy evaluation (if category = prediction_market) | block or escalate |
| WC | WalletConnectGovernance | Unlimited approval, unverified token, signature transfer, chain mismatch, high-risk permit | block or escalate |
| Final | Approval modal + biometric | lane → modal UX | sign or deny |
