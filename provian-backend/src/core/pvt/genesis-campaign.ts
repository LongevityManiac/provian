/**
 * RETIRED PVTv8 Genesis campaign compatibility surface.
 *
 * The unarmed PVT9 75/75/25 Genesis proposal and reservation state machine live
 * in genesis-award-state-machine.ts and proposed-genesis-policy.ts. No active
 * issuance path may call the pool/source metering functions below. The module
 * remains temporarily for read-only legacy status, kill-switch compatibility,
 * and old regression tests; the admin route cannot arm it or change economics.
 *
 * Historical design follows:
 *
 * The agent-wallet genesis campaign deliberately tolerates some farming to
 * seed the economy from zero. That only works if the reward path can be
 * throttled or cut DEAD at runtime, independent of the general PVT mint -
 * which today it cannot be (general minting has only ONE global circuit
 * breaker and the `pvt-mint` scheduler; both halt ALL minting). This module
 * is the missing genesis-scoped control surface:
 *
 * 1. KILL SWITCH - a runtime master flag (`enabled`) that stops genesis
 * issuance without touching general minting. Default
 * OFF: with no config doc the campaign is closed.
 * 2. GLOBAL POOL CAP - a campaign-wide PVT budget. Every grant is metered
 * against it transactionally; when the pool is
 * exhausted the campaign closes itself.
 * 3. PER-WALLET CAP - a ceiling on genesis PVT any one wallet can earn.
 * 4. PER-SOURCE CAP - a ceiling keyed on the FUNDING-SOURCE address, the
 * anti-farming replacement for the device anchor that
 * genesis funding rewards route around (Pitfall #47).
 * 5. WINDOW - issuance only inside [window_start, window_end].
 * 6. DECAY - REMOVED. The wallet-age taper went with; the
 * pool-depletion multiplier went with (a later
 * signup earning less than an earlier one for
 * identical work is early-earner advantage — the
 * halving shape deleted in March 2026). The pool CAP
 * hard stop (#2) is unchanged by.
 *
 * EVERY value lives in Firestore `pvt_config/genesis_campaign` (60s cache,
 * mirroring loadWeightConfig) and is tunable live via the admin-genesis route
 * with NO redeploy. A deploy-level break-glass (`GENESIS_CAMPAIGN_FORCE_OFF`)
 * forces the campaign off regardless of Firestore, in case the admin secret
 * is ever in doubt.
 *
 * SCOPE (Phase 0): this module provides the metering GATE only. It is wired
 * to no issuance path yet. The issuance path (inbound-USDC detection ->
 * funding PE -> accrual) calls `reserveGenesisIssuance` and only issues the
 * amount it returns. The hybrid reward model (base bounty x runtime
 * tier/attestation multipliers) is realized by passing the effective
 * tier x attestation multiplier as `externalMultiplier` a tier-0 or
 * attestation-0 Foundation override (pe-weight-framework) collapses it to 0,
 * giving a SECOND independent runtime kill surface on top of `enabled`.
 *
 * Metering bias: the reserve increments the pool atomically BEFORE downstream
 * accrual runs. If accrual later fails the pool is briefly over-counted, which
 * makes the campaign close slightly EARLY - the safe direction for a cap (it
 * can never over-issue). `rollbackGenesisIssuance` lets the caller reverse a
 * reservation when downstream genuinely fails, keeping the accounting exact.
 *
 * Reputation is never touched here. Genesis credits PVT issuance accounting
 * only; governance_score / staked reputation are separate and non-transferable.
 */

import { relayDb } from '../../firestore-db';
import { isGenesisForcedOff } from './genesis-force-off';
import type { Firestore, DocumentReference } from 'firebase-admin/firestore';
import {
  admitMonotonicPoolCounterWrite,
  POOL_COUNTER_REVERSAL_REFUSED,
} from './genesis-pool-counter';

// =============================================================================
// COLLECTIONS / DOCS
// =============================================================================

const CONFIG_COLLECTION = 'pvt_config';
const CONFIG_DOC = 'genesis_campaign';

/** Running campaign-wide counter (uncached, read transactionally). */
const STATE_COLLECTION = 'genesis_campaign_state';
const GLOBAL_STATE_DOC = 'global';

/** Per-wallet genesis ledger (uncached, read transactionally). */
const WALLET_LEDGER_COLLECTION = 'genesis_wallet_ledger';

/** Per-funding-source ledger (anti-farming, read transactionally). */
const SOURCE_LEDGER_COLLECTION = 'genesis_source_ledger';

/** Per-contract-epoch mint pacing ledger (prevents Genesis bursts). */
const EPOCH_MINT_LEDGER_COLLECTION = 'genesis_epoch_mint_ledger';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Base bounty per genesis event, in whole PVT, before the
 * external tier/attestation multiplier. Sized against the lowest primitive
 * floor (a low-impact PE earns ~0.5-1.0 weight units at BASE_RATE 1.0), so
 * genesis never out-pays real work. Tune live via the admin route.
 */
export interface GenesisBountyLadder {
  /** Wallet birth certificate. Near-zero - existence alone is cheap. */
  agent_wallet_created: number;
  /**
   * SIGNUP bonus: create a Provian wallet + prove control of an external address.
   * One-time per agent, paid on the external-address proof. This is what Genesis
   * pays after the 2026-07 decoupling - ongoing activity earns via the standard
   * mint path, not Genesis. Kept on the Genesis pool / kill-switch.
   *
   * HISTORICAL AS WRITTEN - SUPERSEDED BY. This whole module is
   * the RETIRED PVTv8 surface (see the file docblock); the live PVT9 agent leg
   * qualifies on AGENT WALLET CREATION ALONE, emitted from `routes/agent-wallet.ts`,
   * never from the external-address proof. Proving an address still binds it, holds
   * one-address-one-agent, sets the `H+1` no-retro fence and a read-only reputation
   * tier - it simply no longer pays. See `policy/proposed-genesis-policy.ts`.
   */
  genesis_signup: number;
  /**
   * HUMAN wallet-creation welcome bonus (2026-07). One-time per human user, paid
   * on `POST /v1/wallet/human/register` ON TOP of the separate standard ~10 PVT
   * `wallet_created` birth certificate. This is the human-side counterpart to `genesis_signup` (which is
   * agent-only, on external-address proof). Elevated during Genesis; after
   * Genesis it reverts to nothing standalone (config flip / window close) and
   * the human keeps earning from native Provian activity via the standard mint
   * path. Kept on the Genesis pool / per-wallet cap / kill-switch.
   */
  genesis_human_signup: number;
  /**
   * DEVICE-LINK bonus (2026-07). One-time per registered device (human- OR
   * agent-owned), paid on `POST /v1/devices/register` for the link ACT itself -
   * no compute-gating, no forced work. Rewards connecting a compute source to
   * the network during the launch window. Deduped by the device's registration
   * id (one claim per device); the per-wallet cap is the aggregate anti-farm
   * backstop. Elevated during Genesis; after Genesis linking a device pays
   * nothing standalone - the device simply begins minting from its real verified
   * compute via the standard mint path (pure ignition). Kept on the Genesis pool
   * / per-wallet cap / kill-switch.
   */
  genesis_device_link: number;
  /** First REAL inbound USDC >= funding_min_usd. RETIRED (funded now maps to `receive`). */
  agent_wallet_funded: number;
  /** First outbound/economic transaction from the funded wallet. RETIRED (mapped activity). */
  agent_first_transaction: number;
  /** Sustained-activity marker. RETIRED (mapped activity). */
  agent_sustained_activity: number;
}

export type GenesisEventType = keyof GenesisBountyLadder;

/**
 * Identity-neutral event types for the HUMAN wallet path. Genesis is
 * identity-agnostic: a human who funds a wallet, makes a first transaction, and
 * sustains real work earns the same way an agent does - gated on ACTIVITY, not
 * on wallet type. These resolve to the SAME single-sourced bounty config as
 * their agent counterparts (one admin knob tunes both), so no parallel config
 * or anti-farm machinery is added - only the PE `action_type` differs, so a
 * human's chain reads honestly (`wallet_funded`, never `agent_wallet_funded`).
 */
export type GenesisWalletEventType =
  | 'wallet_funded'
  | 'wallet_first_transaction'
  | 'wallet_sustained_activity';

/** Any genesis event - agent-native or identity-neutral (human). */
export type GenesisAnyEventType = GenesisEventType | GenesisWalletEventType;

const NEUTRAL_TO_CANONICAL: Record<GenesisWalletEventType, GenesisEventType> = {
  wallet_funded: 'agent_wallet_funded',
  wallet_first_transaction: 'agent_first_transaction',
  wallet_sustained_activity: 'agent_sustained_activity',
};

/**
 * The bounty-ladder slot an event draws from. The identity-neutral human events
 * share the agent slots so the ladder (and the admin config / arm guard) stays
 * single-sourced - tuning `agent_wallet_funded` tunes the human funded bounty too.
 */
export function canonicalBountyKey(eventType: GenesisAnyEventType): GenesisEventType {
  return (NEUTRAL_TO_CANONICAL as Record<string, GenesisEventType | undefined>)[eventType]
    ?? (eventType as GenesisEventType);
}

/** True for either the agent or the human "funded" event (drives the deposit gate). */
export function isFundedEvent(eventType: GenesisAnyEventType): boolean {
  return canonicalBountyKey(eventType) === 'agent_wallet_funded';
}

/**
 * Bounty slots that are unpayable IN CODE, whatever the Firestore ladder says.
 *
 * `agent_sustained_activity` is the slot that paid the only oversized grant this
 * campaign ever made: **200 PVT to a dev wallet on 2026-06-24T00:42:42.275Z**,
 * booked through the identity-neutral alias `wallet_sustained_activity`, with
 * `fixed_estimated_pvt_override: true`, `is_genesis_grant: true`,
 * `mint_status: eligible`, and **no claim marker** — which is why the campaign
 * shows five markers against six ledger rows. It landed 162 seconds BEFORE the
 * campaign window's current `window_start_ms`, in the first Genesis write ever
 * made. **That grant record is preserved and untouched. What is closed is the
 * path that produced it.**
 *
 * Until now "retired" meant a `0` in the ladder — a value an admin edit puts
 * back. A retired slot now resolves to 0 before the config is even read, and
 * denies under its own named verdict. Restoring one is a source change and a
 * review, not an admin edit.
 *
 * SCOPE, stated rather than assumed: `agent_wallet_funded` and
 * `agent_first_transaction` are also retired per the protocol docs, but only by
 * config (both sit at `0`). They are deliberately NOT closed here — they still
 * carry the deposit gate and ~21 live test fixtures, so closing them is a
 * separate change with its own review, and this one is scoped to the slot that
 * actually granted. Adding them is a one-line extension of this set.
 */
export const RETIRED_GENESIS_BOUNTY_SLOTS: ReadonlySet<GenesisEventType> = new Set<GenesisEventType>([
  'agent_sustained_activity',
]);

/**
 * True when this event draws from a retired slot — including via its
 * identity-neutral human alias, which is how the 200-PVT grant was booked
 * (`wallet_sustained_activity` canonicalizes to `agent_sustained_activity`).
 * Checking the CANONICAL key is what makes the alias unable to slip past.
 */
export function isRetiredGenesisBounty(eventType: GenesisAnyEventType): boolean {
  return RETIRED_GENESIS_BOUNTY_SLOTS.has(canonicalBountyKey(eventType));
}

/**
 * `wallet_age` and `both` are REMOVED — no time-based reduction mode
 * can be selected. `pool_depletion` is REMOVED — a multiplier that
 * shrinks a grant as the pool fills pays a later signup less than an earlier
 * one for identical work, which is early-earner advantage (the halving shape
 * deleted in March 2026). No decay mode is left to select, so neither taper
 * can be restored by flipping config; the pool CAP hard stop is separate and
 * unchanged. Reintroduction is caught behaviourally by FC-005
 * (src/core/decisions/forbidden-constructs.ts).
 */
export type GenesisDecayMode = 'none';

export interface GenesisDecayConfig {
  mode: GenesisDecayMode;
}

export interface GenesisCampaignConfig {
  /** Master kill switch. False => all genesis issuance denied. */
  enabled: boolean;
  /** Issuance allowed only within [window_start_ms, window_end_ms] inclusive. */
  window_start_ms: number;
  window_end_ms: number;
  /** Campaign-wide PVT budget. Grants are metered against it. */
  pool_cap_pvt: number;
  /**
   * Maximum Genesis-grant PVT allowed into the shared minting path per on-chain
   * epoch. This is distinct from pool_cap_pvt: the pool says "how much total";
   * this says "how quickly" so Genesis cannot burst the global breaker.
   */
  per_epoch_mint_cap_pvt: number;
  /** Ceiling on genesis PVT per wallet. */
  per_wallet_cap_pvt: number;
  /** Ceiling on genesis PVT per funding-source address (anti-farming). */
  per_source_cap_pvt: number;
  /** Real-deposit gate: agent_wallet_funded requires inbound >= this many USD. */
  funding_min_usd: number;
  bounties: GenesisBountyLadder;
  decay: GenesisDecayConfig;
  /** Thresholds the sustained-activity detector uses to fire the marker. */
  sustained: GenesisSustainedConfig;
  updated_at?: number;
}

export interface GenesisSustainedConfig {
  /** Minimum lifetime PE count to qualify as sustained. */
  min_pe_count: number;
  /** Minimum active-day streak to qualify as sustained. */
  min_streak_days: number;
}

export interface GenesisReserveParams {
  walletId: string;
  eventType: GenesisAnyEventType;
  /** Funding-source address for the per-source cap. Required for funded events
   *  to enforce anti-farming; optional otherwise. */
  fundingSourceAddress?: string | null;
  /** Wallet creation time (ms). Retained as an audit fact only —
   * removed the wallet-age decay it once fed; nothing prices from it. */
  walletCreatedAtMs: number;
  /** Inbound USD for the real-deposit gate (agent_wallet_funded only). */
  fundingUsd?: number;
  /** Hybrid kill/throttle surface (Foundation tier override on the event type).
   *  Default 1. Clamped to [0,1] - a value of 0 (tier-0 override) collapses the
   *  grant; values in (0,1) throttle it. Cannot amplify above the base bounty. */
  externalMultiplier?: number;
  /** Injectable clock for tests. Defaults to Date.now(). */
  now?: number;
}

export type GenesisDenyReason =
  | 'force_off'
  | 'genesis_disabled'
  | 'window_not_open'
  | 'window_closed'
  | 'below_funding_min'
  | 'zero_base_bounty'
  | 'retired_bounty'
  | 'throttled_to_zero'
  | 'pool_exhausted'
  | 'wallet_cap_reached'
  | 'source_cap_reached';

export interface GenesisReserveResult {
  allowed: boolean;
  granted_pvt: number;
  base_pvt: number;
  /** Constant 1 since (pool-depletion multiplier removed; wallet-age
   * removed by). Field retained for result-shape compatibility. */
  decay_multiplier: number;
  reason: 'ok' | GenesisDenyReason;
  caps: {
    pool_remaining_pvt: number;
    wallet_remaining_pvt: number;
    /** Infinity when no funding source was supplied. */
    source_remaining_pvt: number;
  };
}

export interface GenesisCampaignState {
  pool_minted_pvt: number;
  pool_remaining_pvt: number;
  updated_at: number;
}

export interface GenesisEpochMintState {
  epoch: number;
  minted_pvt: number;
  remaining_pvt: number;
  updated_at: number;
}

interface GlobalStateDoc {
  pool_minted_pvt: number;
  updated_at: number;
}

interface LedgerDoc {
  issued_pvt: number;
  updated_at: number;
}

interface EpochMintLedgerDoc {
  epoch: number;
  minted_pvt: number;
  updated_at: number;
}

// =============================================================================
// DEFAULTS (fail-closed)
// =============================================================================

/**
 * On-chain per-epoch supply ceiling. PVTv4 through PVTv8 GENESIS_EPOCH_HARD_CAP trips the
 * GLOBAL circuit breaker (halting ALL minting for every contributor) if a
 * single epoch mints >= 10,000,000 PVT in the low-epoch-history launch window.
 * Mirrors `GENESIS_EPOCH_HARD_CAP` in the production PVT contracts.
 */
export const GENESIS_EPOCH_HARD_CAP_PVT = 10_000_000;

/**
 * Conservative ceiling on Genesis PVT entering the shared minting path in one
 * epoch. This protects the global breaker while the campaign's total pool can
 * be sized separately and paced over time.
 */
export const GENESIS_POOL_CAP_SOFT_LIMIT_PVT = 8_000_000;

/**
 * Default config when no Firestore doc exists: the campaign is CLOSED. Kill
 * switch off, window closed, zero pool - nothing can issue until an admin
 * explicitly arms it. The bounty ladder below is the recommended STARTING
 * shape; tune all of it via the admin route before arming.
 *
 * Ladder sizing (recalibrated 2026-06-20, anchored to 1 PE = 1 PVT): PVT is
 * EARNED from provenance, not airdropped - so genesis is a small WELCOME NUDGE,
 * not a windfall. The whole ladder (funded + first_tx + sustained = 300 PVT)
 * sums to roughly ONE MONTH of a typical active agent's organic earn (~300
 * PVT/month raw at the v5/clean-mint rate; see pe-weight-framework.ts). It sits
 * intentionally BELOW the recalibrated 750 PVT Level-2 bond floor
 * (`types.ts:BOND_LEVEL_2_BASE_PVT`) so genesis can never out-pay real work or
 * pre-fund a bond for free. `wallet_created` stays near-zero. pool_cap_pvt
 * controls total exposure and per_epoch_mint_cap_pvt paces grants into the
 * shared minting path so Genesis cannot trip the general-mint breaker.
 *
 * funding_min_usd is the BOUNTY spam-floor only ($1, below x402 micro-top-up
 * patterns); the inbound watcher still emits the funding PE for any non-dust
 * deposit, so legitimate sub-$1 funding is recorded, just not bounty-paid.
 */
export const DEFAULT_GENESIS_CONFIG: GenesisCampaignConfig = {
  enabled: false,
  window_start_ms: 0,
  window_end_ms: 0,
  pool_cap_pvt: 0,
  per_epoch_mint_cap_pvt: 0,
  per_wallet_cap_pvt: 0,
  per_source_cap_pvt: 0,
  funding_min_usd: 0,
  bounties: {
    // Zero by design: wallet creation emits an `agent_wallet_created` PE that
    // accrues under `wallet_created`, which is device-rate-limited to 0 for
    // anchorless self-signup (Security Invariant #9). Paying a creation bounty
    // here would contradict that; keep it 0 so the ladder math matches intent
    // and no future rate-limit change can silently turn on a creation handout.
    agent_wallet_created: 0,
    // SIGNUP bonus (2026-07): a modest one-time welcome for create + prove. Well
    // below the 750 PVT bond floor; ongoing earning is via the standard mint path,
    // not Genesis. The former activity bounties (funded/first-tx/sustained) are
    // RETIRED to 0 - that earning now flows through mapped Financial PEs.
    genesis_signup: 0,
    // Human welcome + device-link bounties default to 0: the mechanism is wired
    // (triggers + one-time claim markers + reserve/decay/caps), but nothing pays
    // until an admin explicitly arms a value via the admin-genesis route. This
    // keeps the campaign fail-closed even against an already-enabled Firestore
    // doc (mergeConfig backfills these from here), so a deploy alone can never
    // start a handout - the amount is a deliberate arming decision, and it
    // reverts to 0 at Genesis end by config flip with no code change.
    genesis_human_signup: 0,
    genesis_device_link: 0,
    agent_wallet_funded: 0,
    agent_first_transaction: 0,
    agent_sustained_activity: 0,
  },
  decay: {
    // removed the wallet-age component; removed pool depletion.
    // 'none' is the only mode the type admits — a grant is base × external
    // multiplier, clamped by the caps, never tapered.
    mode: 'none',
  },
  sustained: {
    min_pe_count: 20,
    min_streak_days: 7,
  },
};

// =============================================================================
// CONFIG LOADER (Firestore-backed, 60s cache - mirrors loadWeightConfig)
// =============================================================================

let configCache: GenesisCampaignConfig | null = null;
let configCacheTime = 0;
const CONFIG_TTL = 60_000;

// Single source: `genesis-force-off.ts`. This used to be a local copy of the predicate, and the
// duplication is how the switch came to gate only this module while the armed origination path
// ignored it entirely.
const isForcedOff = isGenesisForcedOff;

function mergeConfig(stored: Partial<GenesisCampaignConfig> | undefined): GenesisCampaignConfig {
  const base = DEFAULT_GENESIS_CONFIG;
  if (!stored) return { ...base, bounties: { ...base.bounties }, decay: { ...base.decay }, sustained: { ...base.sustained } };
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : base.enabled,
    window_start_ms: numOr(stored.window_start_ms, base.window_start_ms),
    window_end_ms: numOr(stored.window_end_ms, base.window_end_ms),
    pool_cap_pvt: numOr(stored.pool_cap_pvt, base.pool_cap_pvt),
    per_epoch_mint_cap_pvt: numOr(stored.per_epoch_mint_cap_pvt, base.per_epoch_mint_cap_pvt),
    per_wallet_cap_pvt: numOr(stored.per_wallet_cap_pvt, base.per_wallet_cap_pvt),
    per_source_cap_pvt: numOr(stored.per_source_cap_pvt, base.per_source_cap_pvt),
    funding_min_usd: numOr(stored.funding_min_usd, base.funding_min_usd),
    bounties: {
      agent_wallet_created: numOr(stored.bounties?.agent_wallet_created, base.bounties.agent_wallet_created),
      genesis_signup: numOr(stored.bounties?.genesis_signup, base.bounties.genesis_signup),
      genesis_human_signup: numOr(stored.bounties?.genesis_human_signup, base.bounties.genesis_human_signup),
      genesis_device_link: numOr(stored.bounties?.genesis_device_link, base.bounties.genesis_device_link),
      agent_wallet_funded: numOr(stored.bounties?.agent_wallet_funded, base.bounties.agent_wallet_funded),
      agent_first_transaction: numOr(stored.bounties?.agent_first_transaction, base.bounties.agent_first_transaction),
      agent_sustained_activity: numOr(stored.bounties?.agent_sustained_activity, base.bounties.agent_sustained_activity),
    },
    // a stored config can no longer select a decay mode at all — any
    // legacy 'pool_depletion' / 'wallet_age' / 'both' value in Firestore is
    // ignored, exactly as made the taper unrestorable by config flip.
    decay: { mode: 'none' },
    sustained: {
      min_pe_count: numOr(stored.sustained?.min_pe_count, base.sustained.min_pe_count),
      min_streak_days: numOr(stored.sustained?.min_streak_days, base.sustained.min_streak_days),
    },
    updated_at: stored.updated_at,
  };
}

/**
 * Load the campaign config (60s cache). When no doc exists returns the
 * fail-closed default. `GENESIS_CAMPAIGN_FORCE_OFF` forces `enabled:false`
 * regardless of Firestore - a deploy-level kill that no admin-secret holder
 * can re-enable.
 */
export async function loadGenesisCampaignConfig(db?: Firestore): Promise<GenesisCampaignConfig> {
  const now = Date.now();
  if (configCache && now - configCacheTime < CONFIG_TTL) {
    return forceOffIfNeeded(configCache);
  }
  try {
    const firestore = db ?? relayDb();
    const doc = await firestore.collection(CONFIG_COLLECTION).doc(CONFIG_DOC).get();
    const merged = mergeConfig(doc.exists ? (doc.data() as Partial<GenesisCampaignConfig>) : undefined);
    configCache = merged;
    configCacheTime = now;
    return forceOffIfNeeded(merged);
  } catch {
    // Fail closed on any read error.
    return { ...DEFAULT_GENESIS_CONFIG, bounties: { ...DEFAULT_GENESIS_CONFIG.bounties }, decay: { ...DEFAULT_GENESIS_CONFIG.decay } };
  }
}

function forceOffIfNeeded(config: GenesisCampaignConfig): GenesisCampaignConfig {
  if (isForcedOff() && config.enabled) {
    return { ...config, enabled: false };
  }
  return config;
}

/** Invalidate the config cache (call after an admin write). */
export function invalidateGenesisConfigCache(): void {
  configCache = null;
  configCacheTime = 0;
}

// =============================================================================
// PURE HELPERS
// =============================================================================

function clamp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Base bounty (pre-multiplier) for an event type. Identity-neutral
 *  human events resolve to their shared canonical ladder slot. */
export function resolveGenesisBaseBounty(config: GenesisCampaignConfig, eventType: GenesisAnyEventType): number {
  // A retired slot resolves to 0 whatever the ladder says. This is deliberately
  // BEFORE the config read, so a non-zero value cannot be observed at all.
  if (isRetiredGenesisBounty(eventType)) return 0;
  return Math.max(0, numOr(config.bounties?.[canonicalBountyKey(eventType)], 0));
}

/**
 * Read-only "is there anything to pay for this event right now?" predicate:
 * campaign enabled (force-off already folded into `enabled` by the loader),
 * inside the window, and the event's base bounty is armed (>0). Callers use it
 * to SKIP the one-time claim marker + PE emission entirely when nothing would
 * pay - so a bounty that defaults to 0 leaves the trigger path fully inert (no
 * claim burned, no 0-PVT PE) until an admin arms a value, and reverts to inert
 * the moment it is set back to 0 or the campaign is disabled. This is an
 * optimisation/hygiene gate only: `reserveGenesisIssuance` remains the
 * authoritative meter (pool/wallet/source caps + transactional races).
 */
export function isGenesisBountyPayable(
  config: GenesisCampaignConfig,
  eventType: GenesisAnyEventType,
  now: number,
): boolean {
  if (!config.enabled) return false;
  if (now < config.window_start_ms) return false;
  if (config.window_end_ms > 0 && now > config.window_end_ms) return false;
  return resolveGenesisBaseBounty(config, eventType) > 0;
}

/**
 * REMOVED : the pool-depletion multiplier — linear from 1
 * (empty pool) toward a floor as the pool filled — is gone. It paid a later
 * signup less than an earlier one for identical work: early-earner advantage,
 * the halving shape deleted in March 2026 under a third name. had
 * already removed its wallet-age component. A grant is base × external
 * multiplier; the pool CAP hard stop and the per-wallet/per-source caps are
 * unchanged (they deny or clamp at the boundary, they do not reprice by fill
 * fraction). Reintroduction is caught behaviourally by FC-005: moving ONLY
 * the pool-consumed fraction must never change a grant.
 */

function sourceKey(addr: string): string {
  return addr.trim().toLowerCase();
}

function deny(reason: GenesisDenyReason, base: number, decay: number, caps: GenesisReserveResult['caps']): GenesisReserveResult {
  return { allowed: false, granted_pvt: 0, base_pvt: base, decay_multiplier: decay, reason, caps };
}

// =============================================================================
// METERING GATE
// =============================================================================

/**
 * Atomically check every genesis control and, if allowed, RESERVE the granted
 * amount against the global pool, the per-wallet ledger, and the per-source
 * ledger. The caller issues exactly `granted_pvt` and nothing if `!allowed`.
 *
 * Order of checks (cheap, fail-closed gates first, then the transactional
 * cap meter):
 * kill switch -> window -> funding gate -> base bounty -> external
 * multiplier -> [txn] pool/wallet/source caps -> reserve.
 *
 * The grant is min(base x externalMultiplier, pool/wallet/source
 * remaining). A binding cap of 0 denies with the specific reason. (* there is no decay factor — the caps bound the grant, nothing tapers it.)
 */
export async function reserveGenesisIssuance(
  db: Firestore,
  config: GenesisCampaignConfig,
  params: GenesisReserveParams,
): Promise<GenesisReserveResult> {
  const now = params.now ?? Date.now();
  const base = resolveGenesisBaseBounty(config, params.eventType);
  // Clamp to [0,1]: the external multiplier is a THROTTLE/KILL surface only -
  // it can zero or reduce a bounty (tier-0 override -> 0) but must NEVER
  // amplify it above the configured base (a tier 3/4/5 override would otherwise
  // multiply by 2/3/5x and drain the pool). Throttle-only, never distort up.
  const externalMultiplier = clamp(numOr(params.externalMultiplier, 1), 0, 1);

  // Caps are filled in once known; start permissive for the early denials.
  const openCaps: GenesisReserveResult['caps'] = {
    pool_remaining_pvt: Math.max(0, config.pool_cap_pvt),
    wallet_remaining_pvt: Math.max(0, config.per_wallet_cap_pvt),
    source_remaining_pvt: params.fundingSourceAddress ? Math.max(0, config.per_source_cap_pvt) : Infinity,
  };

  // 0. Retired slot. Checked FIRST so the verdict is attributable to retirement
  //    rather than to whichever kill switch happens to be engaged today — a
  //    refusal that only holds while another gate is closed is not a closure.
  if (isRetiredGenesisBounty(params.eventType)) return deny('retired_bounty', base, 1, openCaps);

  // 1. Kill switch (Firestore enabled flag + deploy-level force-off).
  if (isForcedOff()) return deny('force_off', base, 1, openCaps);
  if (!config.enabled) return deny('genesis_disabled', base, 1, openCaps);

  // 2. Window.
  if (now < config.window_start_ms) return deny('window_not_open', base, 1, openCaps);
  if (config.window_end_ms > 0 && now > config.window_end_ms) return deny('window_closed', base, 1, openCaps);

  // 3. Real-deposit gate (funded events only - agent or human).
  if (isFundedEvent(params.eventType)) {
    if (numOr(params.fundingUsd, 0) < config.funding_min_usd) {
      return deny('below_funding_min', base, 1, openCaps);
    }
  }

  // 4. A zero base bounty or a zeroing external multiplier short-circuits before
  //    touching state (tier-0 / attestation-0 override is a hard kill).
  if (base <= 0) return deny('zero_base_bounty', base, 1, openCaps);
  if (externalMultiplier <= 0) return deny('throttled_to_zero', base, 1, openCaps);

  const globalRef = db.collection(STATE_COLLECTION).doc(GLOBAL_STATE_DOC);
  const walletRef = db.collection(WALLET_LEDGER_COLLECTION).doc(params.walletId);
  const srcAddr = params.fundingSourceAddress ? sourceKey(params.fundingSourceAddress) : null;
  const sourceRef = srcAddr ? db.collection(SOURCE_LEDGER_COLLECTION).doc(srcAddr) : null;

  return db.runTransaction(async (txn) => {
    const [globalSnap, walletSnap, sourceSnap] = await Promise.all([
      txn.get(globalRef),
      txn.get(walletRef),
      sourceRef ? txn.get(sourceRef) : Promise.resolve(null),
    ]);

    const poolMinted = globalSnap.exists ? numOr((globalSnap.data() as GlobalStateDoc).pool_minted_pvt, 0) : 0;
    const walletIssued = walletSnap.exists ? numOr((walletSnap.data() as LedgerDoc).issued_pvt, 0) : 0;
    const sourceIssued = sourceSnap && sourceSnap.exists ? numOr((sourceSnap.data() as LedgerDoc).issued_pvt, 0) : 0;

    const poolRemaining = Math.max(0, config.pool_cap_pvt - poolMinted);
    const walletRemaining = Math.max(0, config.per_wallet_cap_pvt - walletIssued);
    const sourceRemaining = sourceRef ? Math.max(0, config.per_source_cap_pvt - sourceIssued) : Infinity;

    // no decay of any kind. The grant does not depend on how much of
    // the pool has been issued — only the CAPS below bound it.
    const decay = 1;

    const caps: GenesisReserveResult['caps'] = {
      pool_remaining_pvt: poolRemaining,
      wallet_remaining_pvt: walletRemaining,
      source_remaining_pvt: sourceRemaining,
    };

    const desired = base * externalMultiplier;
    const granted = Math.min(desired, poolRemaining, walletRemaining, sourceRemaining);

    if (!(granted > 0)) {
      // Report the binding constraint.
      let reason: GenesisDenyReason = 'pool_exhausted';
      if (walletRemaining <= 0) reason = 'wallet_cap_reached';
      else if (sourceRemaining <= 0) reason = 'source_cap_reached';
      else if (poolRemaining <= 0) reason = 'pool_exhausted';
      else reason = 'throttled_to_zero';
      return { allowed: false, granted_pvt: 0, base_pvt: base, decay_multiplier: decay, reason, caps };
    }

    // Q3/C6 monotonic chokepoint. Throws inside the transaction, so a refused
    // counter move aborts the whole reservation rather than half-applying it.
    admitMonotonicPoolCounterWrite(poolMinted, poolMinted + granted, 'reserveGenesisIssuance');
    txn.set(globalRef, { pool_minted_pvt: poolMinted + granted, updated_at: now }, { merge: true });
    txn.set(walletRef, { issued_pvt: walletIssued + granted, updated_at: now }, { merge: true });
    if (sourceRef) {
      txn.set(sourceRef, { issued_pvt: sourceIssued + granted, updated_at: now }, { merge: true });
    }

    return {
      allowed: true,
      granted_pvt: granted,
      base_pvt: base,
      decay_multiplier: decay,
      reason: 'ok',
      caps: {
        pool_remaining_pvt: Math.max(0, poolRemaining - granted),
        wallet_remaining_pvt: Math.max(0, walletRemaining - granted),
        source_remaining_pvt: sourceRef ? Math.max(0, sourceRemaining - granted) : Infinity,
      },
    };
  });
}

/**
 * Reverse a prior reservation — REFUSED. The Genesis pool counter is monotonic
 * (Q3/C6, `genesis-pool-counter.ts`), and a reversal is a decrease.
 *
 * This used to decrement the global pool, the wallet ledger, and the source
 * ledger, each clamped independently at zero. Two problems, both now closed:
 * the clamps let the three counters diverge, and a counter that goes down is a
 * cap that can be re-opened.
 *
 * WHAT HAPPENS INSTEAD: nothing is written, and the caller is told so. A
 * reservation that produced no PVT stays consumed. That is deliberately the
 * conservative direction — the pool binds EARLIER than it strictly needs to,
 * never later, and it can never over-grant. It also keeps
 * `C6_genesis_pool_ledger_exact` true by construction: all three counters move
 * together, upward, by the same granted amount, or none of them moves.
 *
 * Returns the refusal so callers can log it rather than assume a reversal took.
 * The signature stays `Promise<void>`-compatible for existing callers.
 */
export async function rollbackGenesisIssuance(
  db: Firestore,
  params: { walletId: string; fundingSourceAddress?: string | null; amountPvt: number; now?: number },
): Promise<{ reversed: false; reason: string }> {
  const amount = numOr(params.amountPvt, 0);
  // Deliberately unused beyond this log: no read, no transaction, no write.
  void db;
  void params.now;
  if (amount > 0) {
    console.warn('[genesis-campaign] reservation reversal refused (counter is monotonic)', {
      walletId: params.walletId,
      amountPvt: amount,
      reason: POOL_COUNTER_REVERSAL_REFUSED,
    });
  }
  return { reversed: false, reason: POOL_COUNTER_REVERSAL_REFUSED };
}

/**
 * #27 (Capability-Truthfulness Pass-2): release a genesis reservation whose
 * downstream accrual was SUPPRESSED.
 *
 * `reserveGenesisIssuance` debits the pool / per-wallet / per-source caps up
 * front and the granted amount becomes the PE's authoritative PVT. But accrual
 * can still zero it AFTER the reservation lands — historically a per-user rate
 * limit ('ineligible', terminal; those volume caps were removed by) or a
 * Redis outage ('pending_cache', reclassified to the genesis FALLBACK PVT,
 * never the reserved bounty) recorded the PE with
 * 0 genesis PVT. When that happens the reservation must be reversed, or it
 * permanently over-consumes the caps (closing the campaign early for everyone)
 * AND overstates `genesis_pvt_earned` (which reads the reservation ledger).
 *
 * Anti-inflationary by construction: this only ever RELEASES a reservation that
 * produced no PVT — it never mints. No-op unless this is a suppressed genesis
 * grant with a positive reserved amount and a wallet to credit it back to. The
 * release amount is the reserved `granted_pvt` (passed back as `reservedPvt`),
 * so it reverses exactly what `reserveGenesisIssuance` debited.
 *
 * [Q3/C6, 2026-07-26] THE RELEASE NO LONGER TAKES. `rollbackGenesisIssuance`
 * refuses every reversal because the pool counter is monotonic, so the caps stay
 * consumed and `genesis_pvt_earned` stays at the reserved figure. The trade is
 * deliberate and one-directional: the campaign under-grants (it closes earlier
 * than the true spend would require) rather than leaving a path that can move
 * the counter down. This function returns **false** now — no release is ever
 * performed — and the reasons above describe the behaviour it USED to have.
 *
 * Returns true iff a release was performed. It never is.
 */
export async function releaseSuppressedGenesisReservation(
  db: Firestore,
  params: {
    suppressed: boolean;
    isGenesisGrant?: boolean;
    reservedPvt: number | null;
    walletId?: string | null;
    fundingSourceAddress?: string | null;
    now?: number;
  },
): Promise<boolean> {
  if (!params.suppressed) return false;
  if (params.isGenesisGrant !== true) return false;
  if (!params.walletId) return false;
  const reserved = numOr(params.reservedPvt, 0);
  if (!(reserved > 0)) return false;
  const outcome = await rollbackGenesisIssuance(db, {
    walletId: params.walletId,
    fundingSourceAddress: params.fundingSourceAddress ?? null,
    amountPvt: reserved,
    now: params.now,
  });
  // `reversed` is statically false — the counter is monotonic. Reported rather
  // than asserted so this reads as "no release happened", never as a success.
  return outcome.reversed;
}

export type GenesisReReserveOutcome = 'confirmed' | 'ineligible' | 'already_handled' | 'invalid';

/**
 * #27 backfill follow-up (WS-Genesis-Backfill): re-confirm a genesis grant that
 * landed during a Redis outage (`mint_status='pending_cache'`) and whose
 * reservation was RELEASED by the suppression rollback ([[releaseSuppressedGenesisReservation]]).
 * Atomically, in one transaction:
 * 1. guard on the pe_history doc still being `pending_cache` (exactly-once —
 * a concurrent/re-run backfill that already reclassified it is a no-op, so
 * the ledger is never double-debited);
 * 2. re-debit the caps by the PREVIOUSLY-RESERVED amount, clamped to what is
 * still available (another wallet may have consumed the freed pool);
 * 3. flip the pe_history doc to `eligible` (estimatedPVT = the re-debited
 * grant) or `ineligible` (0) if nothing fits / the campaign is off.
 *
 * ANTI-INFLATIONARY: it re-debits `min(reservedAmount, remaining)` NEVER more
 * than the original reservation. It deliberately does NOT re-run
 * `reserveGenesisIssuance` when the retired pool-depletion multiplier existed
 * (removed by), a recompute against the release-lowered `pool_minted`
 * would have seen a less-depleted pool → less decay → a LARGER grant than
 * originally reserved. Re-debiting the exact prior amount is the only way to
 * honor "never pay more than the original reservation". Emergency stops
 * (`GENESIS_CAMPAIGN_FORCE_OFF` / `enabled:false`) halt even in-flight
 * confirmations → terminal ineligible (Unknown=Block), rather than paying the
 * generic fallback rate.
 *
 * [Q3/C6, 2026-07-26] THE RE-DEBIT IS REFUSED, and the reason is the premise in
 * the first line: this function exists to re-debit caps *that the suppression
 * rollback released*. The pool counter is now monotonic
 * (`genesis-pool-counter.ts`), so `rollbackGenesisIssuance` releases nothing and
 * the original reservation is **still standing**. Re-debiting on top of a
 * standing reservation counts the same grant twice, and it would do so silently
 * `poolRemaining` is computed from a pool that already includes it. So a
 * `pending_cache` PE now resolves TERMINAL INELIGIBLE with no ledger write, the
 * same shape as the `killed` branch. The reservation it already holds is
 * untouched; nothing is refunded and nothing is double-counted.
 *
 * This can only ever under-grant. To restore re-debiting, the reversal path has
 * to come back first — the two are one mechanism, and re-enabling either alone
 * is the double-count.
 */
export async function confirmGenesisPendingCacheReReserve(
  db: Firestore,
  config: GenesisCampaignConfig,
  params: {
    peHistoryRef: DocumentReference;
    walletId: string;
    fundingSourceAddress?: string | null;
    amountPvt: number;
    now?: number;
  },
): Promise<{ outcome: GenesisReReserveOutcome; granted_pvt: number }> {
  const amount = numOr(params.amountPvt, 0);
  if (!params.walletId || !(amount > 0)) return { outcome: 'invalid', granted_pvt: 0 };
  const now = params.now ?? Date.now();
  // Emergency stops halt even in-flight confirmations (deploy force-off OR the
  // Firestore master enabled flag). The campaign simply ending by window is NOT
  // re-checked — the grant was validly reserved in-window; only the hard kills
  // confiscate an already-earned, in-flight grant.
  const killed = isForcedOff() || !config.enabled;
  void config.pool_cap_pvt; // caps are no longer consulted — see the note above

  return db.runTransaction(async (txn) => {
    // Idempotency guard FIRST (all reads before any write). Re-reading the PE
    // doc inside the txn is what makes the re-debit exactly-once: once flipped
    // to eligible/ineligible it no longer matches `pending_cache`, so a retry
    // or overlapping run returns here without touching the ledger.
    const peSnap = await txn.get(params.peHistoryRef);
    if (!peSnap.exists) return { outcome: 'already_handled' as const, granted_pvt: 0 };
    const peData = (peSnap.data() ?? {}) as { mint_status?: string };
    if (peData.mint_status !== 'pending_cache') {
      return { outcome: 'already_handled' as const, granted_pvt: 0 };
    }

    if (killed) {
      txn.update(params.peHistoryRef, {
        mint_status: 'ineligible',
        estimatedPVT: 0,
        pending_cache_reclassified_at: now,
        pending_cache_outcome: 'genesis_campaign_off',
      });
      return { outcome: 'ineligible' as const, granted_pvt: 0 };
    }

    // Q3/C6. The re-debit's premise — that the suppression rollback released
    // these caps — is false now that the pool counter is monotonic. The
    // reservation is still standing, so re-debiting would count the same grant
    // TWICE, silently: `poolRemaining` would be computed from a pool that
    // already includes it. Terminal ineligible is the only outcome that cannot
    // over-grant, and it writes nothing to any ledger.
    txn.update(params.peHistoryRef, {
      mint_status: 'ineligible',
      estimatedPVT: 0,
      pending_cache_reclassified_at: now,
      pending_cache_outcome: 'genesis_reservation_never_released',
    });
    return { outcome: 'ineligible' as const, granted_pvt: 0 };
  });
}

/**
 * Reserve a slice of the Genesis per-epoch mint pacing budget. This governs
 * how much already-issued Genesis grant PVT can enter the shared mint batch in
 * a single on-chain epoch. It does not change the campaign pool ledger.
 */
export async function reserveGenesisEpochMintBudget(
  db: Firestore,
  config: GenesisCampaignConfig,
  params: { epoch: number; requestedPvt: number; now?: number },
): Promise<{ reserved_pvt: number; remaining_pvt: number; reason: 'ok' | 'no_genesis' | 'epoch_cap_reached' }> {
  const requested = numOr(params.requestedPvt, 0);
  if (requested <= 0) {
    return {
      reserved_pvt: 0,
      remaining_pvt: Math.max(0, config.per_epoch_mint_cap_pvt),
      reason: 'no_genesis',
    };
  }
  const cap = Math.max(0, config.per_epoch_mint_cap_pvt);
  if (cap <= 0) {
    return { reserved_pvt: 0, remaining_pvt: 0, reason: 'epoch_cap_reached' };
  }
  const now = params.now ?? Date.now();
  const epoch = Math.max(0, Math.floor(params.epoch));
  const ref = db.collection(EPOCH_MINT_LEDGER_COLLECTION).doc(String(epoch));

  return db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const minted = snap.exists ? numOr((snap.data() as EpochMintLedgerDoc).minted_pvt, 0) : 0;
    const remaining = Math.max(0, cap - minted);
    const reserved = Math.min(requested, remaining);
    if (!(reserved > 0)) {
      return { reserved_pvt: 0, remaining_pvt: remaining, reason: 'epoch_cap_reached' as const };
    }
    txn.set(ref, { epoch, minted_pvt: minted + reserved, updated_at: now }, { merge: true });
    return {
      reserved_pvt: reserved,
      remaining_pvt: Math.max(0, remaining - reserved),
      reason: 'ok' as const,
    };
  });
}

/** Roll back a prior per-epoch mint-budget reservation before on-chain mint. */
export async function rollbackGenesisEpochMintBudget(
  db: Firestore,
  params: { epoch: number; amountPvt: number; now?: number },
): Promise<void> {
  const amount = numOr(params.amountPvt, 0);
  if (amount <= 0) return;
  const now = params.now ?? Date.now();
  const epoch = Math.max(0, Math.floor(params.epoch));
  const ref = db.collection(EPOCH_MINT_LEDGER_COLLECTION).doc(String(epoch));

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    const minted = snap.exists ? numOr((snap.data() as EpochMintLedgerDoc).minted_pvt, 0) : 0;
    txn.set(ref, { epoch, minted_pvt: Math.max(0, minted - amount), updated_at: now }, { merge: true });
  });
}

/** Read the per-epoch Genesis mint pacing state. */
export async function getGenesisEpochMintState(
  db: Firestore,
  config: GenesisCampaignConfig,
  epoch: number,
): Promise<GenesisEpochMintState> {
  const safeEpoch = Math.max(0, Math.floor(epoch));
  const snap = await db.collection(EPOCH_MINT_LEDGER_COLLECTION).doc(String(safeEpoch)).get();
  const minted = snap.exists ? numOr((snap.data() as EpochMintLedgerDoc).minted_pvt, 0) : 0;
  return {
    epoch: safeEpoch,
    minted_pvt: minted,
    remaining_pvt: Math.max(0, config.per_epoch_mint_cap_pvt - minted),
    updated_at: snap.exists ? numOr((snap.data() as EpochMintLedgerDoc).updated_at, 0) : 0,
  };
}

/** Read the live campaign-wide pool state (uncached) for admin + feedback. */
export async function getGenesisCampaignState(
  db: Firestore,
  config: GenesisCampaignConfig,
): Promise<GenesisCampaignState> {
  const snap = await db.collection(STATE_COLLECTION).doc(GLOBAL_STATE_DOC).get();
  const poolMinted = snap.exists ? numOr((snap.data() as GlobalStateDoc).pool_minted_pvt, 0) : 0;
  return {
    pool_minted_pvt: poolMinted,
    pool_remaining_pvt: Math.max(0, config.pool_cap_pvt - poolMinted),
    updated_at: snap.exists ? numOr((snap.data() as GlobalStateDoc).updated_at, 0) : 0,
  };
}

/**
 * Cheap "is a milestone scan worth running" gate. When the campaign is closed -
 * killed/force-off (config.enabled already reflects it), outside its window, or
 * pool-exhausted - the scheduled scanners should early-return instead of doing
 * the full wallet enumeration + RPC for nothing. This is what makes the cron
 * cost effectively stop the moment genesis ends: each firing becomes one cheap
 * config + state read, then return. Pure; caller supplies the cached config +
 * live pool state.
 */
export function isGenesisScanActive(
  config: GenesisCampaignConfig,
  state: GenesisCampaignState,
  now: number,
): boolean {
  if (!config.enabled) return false;                                          // killed / force-off
  if (now < config.window_start_ms) return false;                             // not opened yet
  if (config.window_end_ms > 0 && now > config.window_end_ms) return false;   // window closed = genesis ended
  if (state.pool_remaining_pvt <= 0) return false;                            // pool exhausted = genesis ended
  return true;
}

/** Test-only: reset the module cache. */
export function _resetGenesisCampaignCacheForTests(): void {
  invalidateGenesisConfigCache();
}
