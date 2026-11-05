/**
 * work package — the SHARED burn-consumption ledger (GLOBAL single-use).
 *
 * the standing rule : one PVT burn = one benefit, system-wide. Every
 * burn-consuming product — O8 name registry, O4 vouch, O5 pledge, O6 subscription,
 * O9 standing-export — records its consumption of a burn in ONE shared ledger,
 * `burn_consumptions/{burn_id}`, checked-and-written ATOMICALLY inside the same
 * Firestore transaction that grants the benefit. The marker is `create()`d, so a
 * burn already spent by ANY product fails ALREADY_EXISTS: a burn can buy exactly
 * one benefit across the whole system, never one-per-product.
 *
 * This is the burn-side mirror of parity: the benefit equals the destroyed value,
 * one-for-one. FLAT per action — no amount-TIERING (a larger burn buys the SAME
 * single benefit as a smaller one, never a bigger one) and no per-product
 * markers. Amount-tiering stays the deferred later pass.
 *
 * MINIMUM-BURN FLOOR (Part 1,): single-use is not the whole
 * cost model. Each product also enforces a schedulable per-action FLOOR — a burn
 * below the floor for that product is refused before the benefit is created. The
 * launch floors are 15 PVT on name/vouch/pledge (the live BondPool
 * `claimFilingFee` filing-fee family) and 0 on standing-export/subscription
 * (routine actions, no scarcity to price). This is a floor, NOT a tier: at or
 * above the floor, one burn still buys exactly one benefit regardless of size.
 * The floor is settable within a bounded range (`BURN_FLOOR_MAX_ATOMIC`) without
 * a redeploy — see `resolveBurnFloorAtomic` / `scheduleBurnFloor` below.
 *
 * NOT A PE, and it touches NO action-type literal, so it does not move the
 * -pinned action-policy matrix digest (the monetary signature
 * `ba8c060c` is unaffected). The burn itself is already provenance-anchored by
 * its on-chain tx (recorded in `pvt_burn_records` by the burn substrate); this
 * ledger records only WHICH benefit consumed it.
 *
 * MONEY-PATH (the operator: "burning is spending; the consumption gate is money-path").
 * `burn-consumption.ts` is in the money-path tripwire manifest; every change here
 * runs the full backend suite and ships a RED control proving a second
 * spend of the same burn_id is refused.
 *
 * USAGE (every product follows this exact shape, inside ONE runTransaction, all
 * gets before any create):
 *
 * const burnRef = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
 * const consumptionRef = deps.db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(burnId);
 * const [burnSnap, consumptionSnap,...productSnaps] = await Promise.all([...]);
 * assertBurnRowUsable(burnSnap.exists ? burnSnap.data() : undefined, walletId);
 * if (consumptionSnap.exists) throw new BurnConsumptionError(409, BURN_ALREADY_CONSUMED);
 * //...product-specific benefit create(s)...
 * txn.create(consumptionRef, buildBurnConsumptionMarker({ burnId, product, walletId, ref, nowMs }));
 */

import type { Firestore } from 'firebase-admin/firestore';

/** The one shared ledger every burn-consuming product checks-and-writes. */
export const BURN_CONSUMPTIONS_COLLECTION = 'burn_consumptions';

/** The verified-burn substrate the products bind to via `burn_id`. */
export const PVT_BURN_RECORDS_COLLECTION = 'pvt_burn_records';

/** A 64-char lowercase-hex burn identifier (`sha256(chain:txHash)`). */
export const BURN_ID_RE = /^[a-f0-9]{64}$/;

/**
 * The set of products that may consume a burn. A closed union so a new product
 * is a deliberate one-line addition here, not a free-form string, and so the
 * ledger's `product` field is auditable.
 */
export type BurnProduct =
  | 'name_registry'
  | 'vouch'
  | 'standing_export'
  | 'pledge'
  | 'subscription'
  | 'presentation'
  // (Commons communication + burn): a forum challenge's STAKE. Reserved on this ledger
  // when the challenge is filed; stays consumed when the author's presentation proves the
  // predicate true, and is RELEASED (marker removed, the burn buys one future benefit) when the
  // predicate is false or no presentation lands inside the window.
  | 'challenge_stake'
  // a featured-placement BID on the wants board or either job board — a scarce good like
  // a name claim: one burn = one bid, ranked by the burn's verified on-chain amount, never refunded.
  | 'featured_placement';

/** The runtime enumeration of {@link BurnProduct} (the type is erased). */
export const BURN_PRODUCTS: readonly BurnProduct[] = Object.freeze([
  'name_registry',
  'vouch',
  'standing_export',
  'pledge',
  'subscription',
  'presentation',
  'challenge_stake',
  'featured_placement',
]);

/** Runtime guard for a caller-supplied product string. */
export function isBurnProduct(x: unknown): x is BurnProduct {
  return typeof x === 'string' && (BURN_PRODUCTS as readonly string[]).includes(x);
}

/** The shared error the products' catch blocks map to an HTTP status + message. */
export class BurnConsumptionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'BurnConsumptionError';
  }
}

export const BURN_ALREADY_CONSUMED = 'this burn has already been consumed';

/** the consume-path error for a burn revoked at finality (`burn_revoked`). */
export const BURN_REVOKED = 'this burn did not reach Base finality and was revoked (burn_revoked)';

/** The consume-path error for a burn below its product's minimum floor. */
export const INSUFFICIENT_BURN_AMOUNT = 'insufficient burn amount for this action';

/** Validate a submitted burn_id's shape. */
export function isBurnId(raw: unknown): raw is string {
  return typeof raw === 'string' && BURN_ID_RE.test(raw);
}

// ─── work package per-action minimum-burn FLOOR (Part 1,) ──────────────────────

/** 1 PVT in atomic 18-decimal units. */
const ONE_PVT_ATOMIC = 1_000_000_000_000_000_000n;

/** The Firestore collection holding scheduled floor overrides, one doc per product. */
export const BURN_FLOOR_POLICY_COLLECTION = 'burn_floor_policy';

/**
 * Per-action minimum-burn FLOOR launch literals, in atomic PVT units.
 *
 * name/vouch/pledge = 15 PVT — the SAME filing-fee family already burning live
 * on BondPool (`claimFilingFee = 15e18`, `ProvianBondPool.sol:147`): a scarce,
 * contestable claim priced to deter cheap abuse. standing-export/subscription =
 * 0 — routine actions with no scarcity to price and no forfeited commitment to
 * destroy (the operator’s work package test), so no floor.
 *
 * These are DEFAULTS. The effective floor is the scheduled override at
 * `burn_floor_policy/{product}` when one is set, else the literal here — so the
 * values ratchet on live data without a redeploy (`resolveBurnFloorAtomic`).
 */
export const BURN_FLOOR_LAUNCH_LITERALS: Readonly<Record<BurnProduct, bigint>> = Object.freeze({
  name_registry: 15n * ONE_PVT_ATOMIC,
  vouch: 15n * ONE_PVT_ATOMIC,
  pledge: 15n * ONE_PVT_ATOMIC,
  standing_export: 0n,
  subscription: 0n,
  // A burn-backed PRESENTATION (burn-to-present cryptographic core): producing a
  // signed, requester-bound, single-use disclosure of PE-fact or reputation
  // claims. The floor is now PER-TIER (reconciled 2026-09-04) — see
  // PRESENTATION_FLOOR_BY_TIER / resolvePresentationFloorAtomic below. This
  // product literal is the reputation-tier default (15 PVT), kept as the
  // fail-safe fallback for any tier-agnostic caller; the standing export routes
  // THROUGH this product at the reputation tier (still 15 PVT), and a cheaper
  // pe_fact presentation is 5 PVT. Both are config-driven, not hardcoded.
  presentation: 15n * ONE_PVT_ATOMIC,
  // the challenge stake and the featured bid are both the 15-PVT filing-fee / name-claim
  // family — a scarce, contestable claim priced to deter cheap abuse (the BondPool
  // `claimFilingFee` literal ratified, not a new number). Schedulable like every other floor.
  challenge_stake: 15n * ONE_PVT_ATOMIC,
  featured_placement: 15n * ONE_PVT_ATOMIC,
});

/**
 * PER-TIER minimum-burn floor for a burn-backed PRESENTATION (burn-to-present).
 * Reconciled pricing : a STANDALONE presentation is a fixed
 * fee per tier — pe_fact 5 PVT, reputation 15 PVT. Config-driven (overridable at
 * `burn_floor_policy/{presentation_pe_fact|presentation_reputation}` without a
 * redeploy), no arming gate. These are the launch DEFAULTS. The reputation floor
 * equals the BondPool filing-fee family literal (15e18) it always used; the
 * pe_fact floor is the cheaper, affordable-for-a-Genesis-newcomer tier (a 75-PVT
 * Genesis grant funds 15 pe_fact handshakes / 5 reputation handshakes).
 *
 * FLOOR, not exact: at or above the floor one burn still buys exactly one benefit
 * (this is what lets a RAIL-CONSUMED handshake fold onto whatever the presenter
 * burned). Standalone clients present exactly the tier fee (no over-burn UX).
 */
export const PRESENTATION_FLOOR_BY_TIER: Readonly<Record<'pe_fact' | 'reputation', bigint>> = Object.freeze({
  pe_fact: 5n * ONE_PVT_ATOMIC,
  reputation: 15n * ONE_PVT_ATOMIC,
});

/** The per-tier `burn_floor_policy` doc ids (one override doc per tier). */
export const PRESENTATION_FLOOR_POLICY_DOC: Readonly<Record<'pe_fact' | 'reputation', string>> = Object.freeze({
  pe_fact: 'presentation_pe_fact',
  reputation: 'presentation_reputation',
});

/**
 * Bounded max a scheduled floor may never exceed — the BondPool filing-fee
 * ceiling family (`MAX_FILING_FEE = 500e18`, `ProvianBondPool.sol:166`). Mirrors
 * the institution fee-bps bound: the value is settable live, but only within a
 * fixed, auditable range, so a misconfiguration cannot set an absurd floor.
 */
export const BURN_FLOOR_MAX_ATOMIC = 500n * ONE_PVT_ATOMIC;

/**
 * Parse a burn row's `amount_atomic` (stored as an integer string by
 * `recordAgentBurn`) into a BigInt. A missing/malformed amount parses to 0n, so
 * it fails any positive floor — fail-closed, never a floor bypass.
 */
export function parseAmountAtomic(raw: unknown): bigint {
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) return BigInt(raw);
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return BigInt(raw);
  if (typeof raw === 'bigint' && raw >= 0n) return raw;
  return 0n;
}

/** A schedulable floor is valid iff it is an integer in [0, BURN_FLOOR_MAX_ATOMIC]. */
export function isValidScheduledFloor(amountAtomic: bigint): boolean {
  return amountAtomic >= 0n && amountAtomic <= BURN_FLOOR_MAX_ATOMIC;
}

/**
 * Resolve the effective minimum-burn floor for a product: the scheduled override
 * at `burn_floor_policy/{product}.floor_atomic` if present and within bound, else
 * the launch literal. Read OUTSIDE the consume transaction — it is policy, not
 * the burn row; a floor change racing a consume lands on old-or-new, both valid.
 * Any read error or out-of-bound stored value falls back to the literal.
 */
export async function resolveBurnFloorAtomic(
  db: Pick<Firestore, 'collection'>,
  product: BurnProduct,
): Promise<bigint> {
  let raw: unknown;
  try {
    const snap = await db.collection(BURN_FLOOR_POLICY_COLLECTION).doc(product).get();
    raw = snap.exists ? (snap.data() as Record<string, unknown> | undefined)?.floor_atomic : undefined;
  } catch {
    raw = undefined;
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const v = BigInt(raw);
    if (isValidScheduledFloor(v)) return v;
  }
  return BURN_FLOOR_LAUNCH_LITERALS[product];
}

/**
 * Resolve the effective PER-TIER presentation floor (burn-to-present). Reads the
 * scheduled override at `burn_floor_policy/{presentation_pe_fact|presentation_
 * reputation}.floor_atomic` if present and within bound, else the per-tier launch
 * literal ({@link PRESENTATION_FLOOR_BY_TIER}). Same fail-safe fallback as
 * {@link resolveBurnFloorAtomic}: any read error or out-of-bound value → the
 * literal. The consumed ledger product stays `'presentation'` (tier-independent
 * single-use); only the FLOOR is per-tier.
 */
export async function resolvePresentationFloorAtomic(
  db: Pick<Firestore, 'collection'>,
  tier: 'pe_fact' | 'reputation',
): Promise<bigint> {
  const docId = PRESENTATION_FLOOR_POLICY_DOC[tier];
  let raw: unknown;
  try {
    const snap = await db.collection(BURN_FLOOR_POLICY_COLLECTION).doc(docId).get();
    raw = snap.exists ? (snap.data() as Record<string, unknown> | undefined)?.floor_atomic : undefined;
  } catch {
    raw = undefined;
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const v = BigInt(raw);
    if (isValidScheduledFloor(v)) return v;
  }
  return PRESENTATION_FLOOR_BY_TIER[tier];
}

/**
 * Schedule a new minimum-burn floor for one product (admin/operator action).
 * Bounded to [0, BURN_FLOOR_MAX_ATOMIC]; a value outside the range is refused
 * rather than clamped, so a caller can never believe a floor took when it did
 * not. Writes `burn_floor_policy/{product}` — one doc per product, no deep-merge.
 */
export async function scheduleBurnFloor(
  db: Pick<Firestore, 'collection'>,
  product: BurnProduct,
  amountAtomic: bigint,
  actor: string,
  nowMs: number,
): Promise<void> {
  if (!isValidScheduledFloor(amountAtomic)) {
    throw new BurnConsumptionError(
      400,
      `floor must be an integer in [0, ${BURN_FLOOR_MAX_ATOMIC.toString()}] atomic PVT units`,
    );
  }
  await db
    .collection(BURN_FLOOR_POLICY_COLLECTION)
    .doc(product)
    .set(
      { floor_atomic: amountAtomic.toString(), updated_at: nowMs, updated_by: actor },
      { merge: true },
    );
}

/**
 * Assert a burn row is usable by `walletId`: it must exist, be a fully recorded
 * + on-chain-verified burn (`status:'recorded'`, `verified:true`), and belong to
 * the caller (`wallet_id === walletId`). Throws `BurnConsumptionError` otherwise.
 * A `'pending'` row (in-flight/crashed record attempt) or a foreign burn can
 * never fund a benefit. This is the SAME fence O8 enforced inline; centralizing
 * it means every product applies it identically.
 */
export function assertBurnRowUsable(
  burn: Record<string, unknown> | undefined,
  walletId: string,
  minAmountAtomic: bigint,
): asserts burn is Record<string, unknown> {
  if (!burn) throw new BurnConsumptionError(404, 'burn not found');
  // a burn accepted at inclusion that then failed finality. Named, so a client that
  // saved it forgets it instead of offering it again.
  if (burn.status === 'revoked') {
    throw new BurnConsumptionError(409, BURN_REVOKED);
  }
  if (burn.status !== 'recorded' || burn.verified !== true) {
    throw new BurnConsumptionError(409, 'burn is not a verified, recorded burn');
  }
  if (burn.wallet_id !== walletId) {
    throw new BurnConsumptionError(403, 'burn belongs to a different wallet');
  }
  // work package per-action minimum-burn FLOOR (Part 1). The amount comes from the
  // on-chain-verified burn row (`amount_atomic`, set by `recordAgentBurn` from
  // the verified Transfer→0x0). minAmountAtomic===0n (export/subscription) makes
  // this inert; a positive floor refuses a sub-floor burn before its benefit.
  if (parseAmountAtomic(burn.amount_atomic) < minAmountAtomic) {
    throw new BurnConsumptionError(400, INSUFFICIENT_BURN_AMOUNT);
  }
}

export interface BurnConsumptionMarker {
  readonly burn_id: string;
  readonly product: BurnProduct;
  readonly wallet_id: string;
  /** A product-specific back-pointer to the benefit this burn bought
   *  (the claimed name, the vouch target, the pledge id, …). */
  readonly ref: string;
  readonly consumed_at: number;
}

/**
 * Build the shared consumption marker. The document id is ALWAYS the `burn_id`
 * (the caller `create()`s it at `burn_consumptions/{burn_id}`), which is what
 * makes consumption global-single-use; the fields below are the audit trail.
 */
export function buildBurnConsumptionMarker(params: {
  burnId: string;
  product: BurnProduct;
  walletId: string;
  ref: string;
  nowMs: number;
}): BurnConsumptionMarker {
  return {
    burn_id: params.burnId,
    product: params.product,
    wallet_id: params.walletId,
    ref: params.ref,
    consumed_at: params.nowMs,
  };
}
