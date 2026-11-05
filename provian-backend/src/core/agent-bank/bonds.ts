/**
 * Agent Bank - Insurance Bonds Business Logic (Phase 5)
 *
 * Handles performance bond lifecycle: posting, renewal, withdrawal, claims,
 * and abandonment. All PVT movements happen on-chain via the ProvianBondPool
 * contract. This module manages Firestore metadata and PE generation.
 *
 * CRITICAL INVARIANTS:
 *  - Trust discount computed server-side only (Theme 10)
 *  - On-chain verification before Firestore state updates (Theme 3)
 *  - All state transitions in Firestore transactions (Theme 8)
 *  - Self-claims blocked (agent cannot file against own bond)
 *  - Default-deny: bond check failure = Level 1 (Theme 9)
 */

import { v4 as uuidv4 } from 'uuid';
import {
  SAFETY_LIMITS,
  type AgentBankDeps,
  type BondDocument,
  type BondClaimDocument,
  type BondClaimVerdict,
  type BondClaimFeeOutcome,
  type BondSlashBasis,
  type GeneralDisputeResolution,
  type BondRenewalDocument,
  type PostBondRequest,
  type RenewBondRequest,
  type WithdrawBondRequest,
  type TopUpBondRequest,
  type FileClaimRequest,
} from './types';
import {
  evaluateInstitutionTransition,
  receiptFromVerification,
  INITIAL,
  type InstitutionKind,
  type ReceiptEvidence,
} from './institution-state-machine';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { ValidationError, NotFoundError, ForbiddenError, RateLimitError } from './errors';
import { generatePE } from './pe-utils';
import { countVisibleAgentPEs } from '../agent-wallet/agent-pe-activity';
import { invalidateHandshakes } from '../rail/invalidation';
import {
  awardBadgeFromOutbox,
  badgeAwardOutboxRef,
  createPendingBadgeAward,
  reconcileBadgeAwards,
} from '../agent-wallet/badge-provenance';
import {
  verifyEvmClaimFiled,
  verifyEvmBondClaimResolved,
  verifyEvmBondPosted,
  verifyEvmBondRenewed,
  verifyEvmBondToppedUp,
  verifyEvmBondWithdrawn,
  readOnchainBaseBond,
  recoverEvmBondClaimResolution,
} from '../onchain/tx-verifier';

// =========================================================================
// Helpers
// =========================================================================

async function updateWalletStats(
  deps: AgentBankDeps,
  walletId: string,
): Promise<void> {
  // The stored `pe_count` tally is gone : PE counts are read live from
  // pe_history / actor_stats. Only the wallet's updated_at is touched here.
  await deps.db.collection('agent_wallets').doc(walletId).update({
    updated_at: Date.now(),
  });
}

async function getWallet(
  deps: AgentBankDeps,
  walletId: string,
): Promise<AgentWalletDocument> {
  const doc = await deps.db.collection('agent_wallets').doc(walletId).get();
  if (!doc.exists) throw new NotFoundError(`Wallet not found: ${walletId}`);
  return doc.data() as AgentWalletDocument;
}

export function chainIdForChain(chain: string): number {
  const chains: Record<string, number> = {
    base: 8453,
    'base-sepolia': 84532,
    arbitrum: 42161,
    optimism: 10,
  };
  return chains[chain] || 8453;
}

/**
 * Resolve the BondPool contract address for a given chain. Mirrors the
 * per-chain address pattern used by foundation-membership/client.ts and
 * pvt-principal-config.ts.
 *
 * Falls back to the legacy single-chain BOND_POOL_CONTRACT_ADDRESS when no
 * per-chain env var is set, so deployments that have not yet adopted
 * per-chain configuration keep working (Base-only behaviour).
 */
export function bondPoolAddressForChain(chain: string): string | undefined {
  const perChain: Record<string, string | undefined> = {
    base: process.env.BOND_POOL_CONTRACT_ADDRESS_BASE,
    arbitrum: process.env.BOND_POOL_CONTRACT_ADDRESS_ARBITRUM,
    optimism: process.env.BOND_POOL_CONTRACT_ADDRESS_OPTIMISM,
  };
  return perChain[chain] ?? process.env.BOND_POOL_CONTRACT_ADDRESS;
}

// =========================================================================
// Trust Discount Computation (server-side only - Theme 10)
// =========================================================================

/** Whole-PVT threshold for the PVT-held trust factor. */
export const PVT_HELD_DISCOUNT_THRESHOLD = 1_000n * 10n ** 18n;
/** Whole-PVT threshold for the lifetime-burned trust factor. */
export const PVT_BURNED_DISCOUNT_THRESHOLD = 100n * 10n ** 18n;

/**
 * Parse a BigInt-as-string field that may be absent on legacy docs. Returns
 * 0n for undefined, empty string, or malformed input so computeTrustDiscount
 * remains total.
 */
function safeBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Compute trust discount in basis points from wallet stats.
 * NEVER accept trust discount from the client. Always compute server-side.
 *
 * Scoring:
 * +1000 if live PE count >= 5000
 * +1000 if economic_activity_usd >= $50K
 * +1000 if pvt_held_cached >= 1000 PVT (PVT-aware factor)
 * +500 if pvt_burned_attributable >= 100 PVT (PVT-aware factor)
 * Cap at MAX_TRUST_DISCOUNT_BPS (5000 = 50%)
 *
 * the "+1500 if governance_score >= 90" term is REMOVED — governance_score
 * is deleted as a dead signal, and the term was already unreachable (nothing
 * computed a score of 90 post-), so removing it does not change the live
 * reachable discount. The PE-count term now reads the LIVE visible-PE count
 * (countVisibleAgentPEs / pe_history), not a stored per-wallet tally, at the same
 * 5000 threshold. This is why the function is async and takes the db.
 *
 * bond lifecycle: the legacy "+500 per qualifying badge (max 3)" factor is REMOVED.
 * Badges are record-only under Gate 1 economics (they mint zero PVT and carry
 * no economic effect), and Gate 1 never approved a badge-based bond discount —
 * so badge state reducing required collateral was a record-only artifact moving
 * economic value. Do NOT reintroduce a badge term here without an explicit approval.
 *
 * The PVT factors come last so their presence cannot push the score above
 * the cap more aggressively than the other factors do. The cap still
 * dominates. Legacy docs without PVT fields get the pre-PVT score unchanged.
 */
export async function computeTrustDiscount(
  db: import('firebase-admin/firestore').Firestore,
  wallet: AgentWalletDocument,
): Promise<number> {
  let score = 0;

  // live visible-PE count, not a stored per-wallet tally.
  const livePeCount = await countVisibleAgentPEs(db, wallet.agent_id);
  if (livePeCount >= 5000) score += 1000;
  if (wallet.economic_activity_usd >= 50_000) score += 1000;

  // PVT metrics. Both sub-factors use BigInt thresholds so overflow is not
  // possible regardless of wallet scale.
  const pvtHeld = safeBigInt(wallet.pvt_held_cached);
  if (pvtHeld >= PVT_HELD_DISCOUNT_THRESHOLD) score += 1000;
  const pvtBurned = safeBigInt(wallet.pvt_burned_attributable);
  if (pvtBurned >= PVT_BURNED_DISCOUNT_THRESHOLD) score += 500;

  return Math.min(score, SAFETY_LIMITS.MAX_TRUST_DISCOUNT_BPS);
}

// =========================================================================
// bond lifecycle — the ONE institution-machine gate for bond / bond-claim transitions
// =========================================================================

/**
 * Evaluate an agent-initiated bond/claim transition INTENT through the ONE
 * machine BEFORE any I/O — suspension check FIRST (the relay's agent-suspension
 * state for the ACTING wallet; a missing/non-'active' status blocks, Unknown =
 * Block). For an ECONOMIC edge the receipt does not exist yet at intent time,
 * so the guard's `receipt_required` outcome is the expected pass-through: it
 * proves the suspension check is clear AND the (kind, from, to) edge is declared.
 * The authoritative receipt-gated evaluation then runs INSIDE the Firestore
 * transaction on the FRESH doc state via `assertEconomicTransition`.
 *
 * The intent uses the NOMINAL source state; when the live doc turns out to be
 * in a different (still-declared) source — e.g. a late renewal finding the
 * bond 'expired' rather than 'active' — the in-transaction evaluation on the
 * fresh status is the one that decides.
 */
function assertTransitionIntent(
  actingWallet: AgentWalletDocument,
  kind: InstitutionKind,
  from: string,
  to: string,
  illegalEdgeMessage: string,
): void {
  const decision = evaluateInstitutionTransition({
    kind,
    from,
    to,
    killSwitchActive: actingWallet.status !== 'active',
  });
  if (decision.allowed) return; // declared record_only edge
  if (decision.reason === 'kill_switch_active') {
    throw new ForbiddenError('Agent wallet is not active');
  }
  if (decision.reason === 'receipt_required') return; // declared economic edge; receipt is gated later
  throw new ValidationError(illegalEdgeMessage);
}

/**
 * The receipt-gated evaluation for an ECONOMIC transition, run at the
 * settlement point (inside the Firestore transaction, on the FRESH doc state).
 * Requires allowed + economic; any block throws (aborting the transaction).
 * Returns the guard's `idempotent` flag — though the deterministic per-tx
 * dedup markers created in the same transaction reject a replay before this
 * ever flags one, so a duplicate economic PE is doubly impossible.
 */
function assertEconomicTransition(input: {
  kind: InstitutionKind;
  from: string;
  to: string;
  receipt: ReceiptEvidence;
  priorEconomicTxHashes?: readonly string[];
  killSwitchActive: boolean;
}): { idempotent: boolean } {
  const decision = evaluateInstitutionTransition(input);
  if (!decision.allowed) {
    if (decision.reason === 'kill_switch_active') {
      throw new ForbiddenError('Agent wallet is not active');
    }
    throw new ValidationError(`Institution transition blocked: ${decision.reason}`);
  }
  if (!decision.economic) {
    // Defensive: every caller of this helper wires a declared economic edge.
    throw new ValidationError('Expected an economic institution transition');
  }
  return { idempotent: decision.idempotent };
}

/**
 * bond lifecycle: deterministic per-transaction dedup marker for bond economic receipts
 * (post / withdraw / top-up), op-namespaced in ONE collection. The marker doc
 * is read-then-created INSIDE the same Firestore transaction as the state
 * flip, so one on-chain receipt can drive at most one economic transition —
 * a replayed BondPosted/BondWithdrawn/BondToppedUp tx (including an OLD tx
 * from a previous bond of the same agent) is rejected before any write.
 * Renewals keep their existing `bond_renewal_dedup` collection (same shape).
 */
function bondTxDedupRef(
  db: AgentBankDeps['db'],
  op: 'post' | 'withdraw' | 'topup',
  txHash: string,
): FirebaseFirestore.DocumentReference {
  return db.collection('bond_tx_dedup').doc(`${op}:tx:${txHash.toLowerCase()}`);
}

// =========================================================================
// Bond Operations
// =========================================================================

/**
 * Post a new performance bond. Verifies the on-chain BondPosted event
 * before creating Firestore metadata.
 *
 * bond lifecycle: wired through the ONE institution machine — the INITIAL→active intent
 * (suspension check FIRST, before any I/O) gates entry, and the receipt-gated
 * economic evaluation runs inside the atomic transaction together with a
 * per-tx dedup marker (one BondPosted receipt ⇒ at most one Firestore bond).
 */
export async function postBond(
  deps: AgentBankDeps,
  walletId: string,
  actingWallet: AgentWalletDocument,
  body: PostBondRequest,
): Promise<BondDocument> {
  // bond lifecycle: the machine gate runs FIRST — before any validation, read, or write.
  assertTransitionIntent(actingWallet, 'bond', INITIAL, 'active', 'Bond posting is not a legal transition');

  // Validate autonomy level
  if (body.autonomy_level !== 2 && body.autonomy_level !== 3) {
    throw new ValidationError('autonomy_level must be 2 or 3');
  }

  // Rate limit: max 5 bond posts per wallet per 24h
  const windowStart = Date.now() - 24 * 60 * 60 * 1000;
  const existingSnap = await deps.db.collection('bonds')
    .where('agent_wallet_id', '==', walletId)
    .where('created_at', '>=', windowStart)
    .count()
    .get();
  if (existingSnap.data().count >= 5) {
    throw new RateLimitError('Rate limit exceeded: max 5 bond posts per 24 hours');
  }

  // Check no active bond already exists
  const activeSnap = await deps.db.collection('bonds')
    .where('agent_wallet_id', '==', walletId)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (!activeSnap.empty) {
    throw new ValidationError('Agent already has an active bond');
  }

  // Heal or validate an earlier lifetime badge cursor before accepting a new
  // bond. This lets an agent post a later bond after withdrawal without trying
  // to create a second one-time badge provenance graph.
  await reconcileBadgeAwards(deps, walletId, ['insured_agent']);
  const wallet = await getWallet(deps, walletId);
  const trustDiscountBps = await computeTrustDiscount(deps.db, wallet);

  // Server-computed required bond (whole PVT) for the Firestore record / PE.
  const requiredBond = getRequiredBondAmount(body.autonomy_level, trustDiscountBps);

  // Verify on-chain transaction
  const bondPoolAddress = bondPoolAddressForChain(body.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');

  // #26: derive the on-chain collateral FLOOR from the LIVE base bond, not the
  // static SAFETY_LIMITS constant. ProvianBondPool.level2/3BaseBond is bounded
  // policy-mutable (the operator-EOA-direct on live Base, not governance-gated); a base
  // REDUCTION leaves the static constant too high, so a correctly-
  // collateralized post would fail the floor (`bond_locked_amount_below_required`)
  // until a backend redeploy. Read the live base (short-TTL cached), apply the
  // SERVER-computed discount with the SAME integer math as the contract (Solidity
  // floor-division), and alert on drift. Fall back to the static floor ONLY when the
  // on-chain read is unavailable — that preserves the WS5 under-collateralization
  // guard in a degraded-RPC window (fail-closed: it can only over-require, never
  // under-require).
  const chainId = chainIdForChain(body.chain);
  const cappedDiscount = Math.min(trustDiscountBps, SAFETY_LIMITS.MAX_TRUST_DISCOUNT_BPS);
  const staticBaseAtomic =
    BigInt(body.autonomy_level === 2 ? SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT : SAFETY_LIMITS.BOND_LEVEL_3_BASE_PVT)
    * (10n ** 18n);

  let baseBondAtomic = staticBaseAtomic;
  const liveBase = await readOnchainBaseBond({ chainId, bondPoolAddress, autonomyLevel: body.autonomy_level });
  if (liveBase.ok && liveBase.baseBondAtomic !== undefined) {
    baseBondAtomic = liveBase.baseBondAtomic;
    if (baseBondAtomic !== staticBaseAtomic) {
      console.warn(
        `[Bonds] base-bond drift on ${body.chain}: live L${body.autonomy_level} base ${baseBondAtomic} != ` +
        `static ${staticBaseAtomic}. Floor now tracks the live value; update ` +
        `SAFETY_LIMITS.BOND_LEVEL_${body.autonomy_level}_BASE_PVT to match.`,
      );
    }
  } else {
    console.warn(
      `[Bonds] live base-bond read failed for L${body.autonomy_level} on ${body.chain} ` +
      `(${liveBase.reason}); falling back to the static collateral floor.`,
    );
  }

  // Floor = base * (10000 - discount) / 10000, integer division — byte-identical to
  // ProvianBondPool.getRequiredBond, so the floor equals the on-chain lock exactly
  // (no whole-PVT rounding false-negatives either).
  const expectedMinLockedAmount = (baseBondAtomic * BigInt(10000 - cappedDiscount)) / 10000n;

  // FIX C: decode the BondPosted event and confirm the bond was ACTUALLY posted,
  // by THIS agent (msg.sender), for THIS level - not merely that the tx touched the
  // pool. WS5 + #26: also assert the on-chain locked collateral >= the live-derived
  // floor. postBond honors a caller-supplied trustDiscountBps (≤50%), so without
  // this an agent could lock half the required amount while we recorded it as fully
  // collateralized. Absent event or sender/level/collateral mismatch => fail closed.
  const verification = await verifyEvmBondPosted({
    chainId,
    txHash: body.tx_hash,
    bondPoolAddress,
    expectedAgent: wallet.address,
    expectedAutonomyLevel: body.autonomy_level,
    expectedMinLockedAmount,
  });

  if (!verification.ok) {
    throw new ValidationError(`On-chain verification failed: ${verification.reason}`);
  }

  // Compute amounts for Firestore record
  const depositRemainingBps = 10000 - 200 - 100; // 97% after 2% burn + 1% fee
  const totalDeposit = Math.ceil((requiredBond * 10000) / depositRemainingBps);

  const now = Date.now();
  const bondId = `bond_${uuidv4()}`;
  const renewalDeadline = now + SAFETY_LIMITS.BOND_RENEWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  // bond lifecycle: the machine receipt for the INITIAL→active economic transition, plus
  // the per-tx dedup marker — one on-chain BondPosted can never mint a second
  // Firestore bond (e.g. replaying an old post tx after a withdrawal).
  const postReceipt = receiptFromVerification(verification, body.tx_hash);
  const postDedupRef = bondTxDedupRef(deps.db, 'post', body.tx_hash);

  const bondDoc: BondDocument = {
    bond_id: bondId,
    agent_wallet_id: walletId,
    agent_address: wallet.address,
    autonomy_level: body.autonomy_level,
    amount_pvt: requiredBond.toString(),
    total_deposited_pvt: totalDeposit.toString(),
    trust_discount_bps: trustDiscountBps,
    status: 'active',
    chain: body.chain,
    post_tx_hash: body.tx_hash,
    post_block_number: verification.blockNumber ?? null,
    renewal_deadline: renewalDeadline,
    last_renewal_at: now,
    pending_claims: 0,
    pe_ids: [],
    created_at: now,
    updated_at: now,
  };

  const bondRef = deps.db.collection('bonds').doc(bondId);
  const walletRef = deps.db.collection('agent_wallets').doc(walletId);
  const badgeOutboxRef = badgeAwardOutboxRef(deps.db, walletId, 'insured_agent');
  let createBadgeOutbox = false;

  // The verified bond entity, its canonical source PE, and the pending badge
  // award land atomically. A crash after this transaction can delay public
  // badge publication, but cannot lose the qualification event.
  const pe = await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address.toLowerCase(),
    actionType: 'bond_posted',
    timestampOverride: now,
    metadata: {
      bond_id: bondId,
      autonomy_level: body.autonomy_level,
      amount_pvt: requiredBond.toString(),
      trust_discount_bps: trustDiscountBps,
      chain: body.chain,
      tx_hash: body.tx_hash,
      // §2.12: on-chain-gated (verifyEvmBondPosted re-read the BondPosted event) → verified.
      verified: true,
      chain_id: chainId,
    },
    atomicEntityPrecondition: async (txn) => {
      const [bondSnap, outboxSnap, currentWalletSnap, postDedupSnap] = await Promise.all([
        txn.get(bondRef),
        txn.get(badgeOutboxRef),
        txn.get(walletRef),
        txn.get(postDedupRef),
      ]);
      if (bondSnap.exists) throw new ValidationError('Bond record already exists');
      if (postDedupSnap.exists) {
        throw new ValidationError('Bond already recorded for this post transaction');
      }
      const currentWallet = currentWalletSnap.data() as AgentWalletDocument | undefined;
      if (!currentWalletSnap.exists
        || !currentWallet
        || currentWallet.id !== walletId
        || currentWallet.agent_id !== wallet.agent_id
        || currentWallet.address.toLowerCase() !== wallet.address.toLowerCase()
        || currentWallet.status !== 'active'
        || !Array.isArray(currentWallet.badges)) {
        throw new ValidationError('Agent wallet state changed before bond commit');
      }
      // bond lifecycle: the authoritative receipt-gated machine evaluation on FRESH state
      // (suspension check from the fresh wallet status re-read under this txn).
      assertEconomicTransition({
        kind: 'bond',
        from: INITIAL,
        to: 'active',
        receipt: postReceipt,
        killSwitchActive: currentWallet.status !== 'active',
      });
      const alreadyEarned = currentWallet.badges.some((badge) => badge.id === 'insured_agent');
      if (alreadyEarned !== outboxSnap.exists) {
        throw new ValidationError('Insured-agent badge provenance state is inconsistent');
      }
      createBadgeOutbox = !alreadyEarned;
    },
    atomicEntityWrite: (txn, peId, context) => {
      if (!context) throw new Error('bond_posted_pe_context_missing');
      txn.create(bondRef, { ...bondDoc, pe_ids: [peId] });
      txn.create(postDedupRef, {
        bond_id: bondId,
        agent_wallet_id: walletId,
        tx_hash: body.tx_hash.toLowerCase(),
        op: 'post',
        created_at: now,
      });
      txn.update(walletRef, { updated_at: now });
      if (createBadgeOutbox) {
        txn.create(badgeOutboxRef, createPendingBadgeAward({
          walletId,
          agentId: wallet.agent_id,
          actorAddress: wallet.address,
          badgeId: 'insured_agent',
          trigger: 'agent_bank_event',
          earnedAtMs: now,
          sourcePeId: peId,
          sourcePeHash: context.newHash,
        }));
      }
    },
  });

  bondDoc.pe_ids = [pe.peId];

  if (createBadgeOutbox) {
    try {
      await awardBadgeFromOutbox(deps, walletId, 'insured_agent');
    } catch (error) {
      // The primary bond + PE + pending outbox are already atomic. Leave the
      // cursor pending for reconciliation rather than rolling back verified
      // on-chain truth or exposing an unproven public badge.
      console.warn('[Bonds] Insured-agent badge award remains pending:', error);
    }
  }

  return bondDoc;
}

/**
 * Renew a bond. Verifies on-chain BondRenewed event.
 *
 * bond lifecycle: wired through the ONE machine. Renewal is the economic active→active
 * self-edge; a bond the scheduler already marked 'expired' (the OFF-CHAIN
 * autonomy drop — the chain kept it Active and renewable until the abandonment
 * burn) is reinstated via the economic expired→active edge, so the backend
 * record follows chain truth instead of refusing to record a real renewal.
 */
export async function renewBond(
  deps: AgentBankDeps,
  walletId: string,
  actingWallet: AgentWalletDocument,
  body: RenewBondRequest,
): Promise<BondDocument> {
  // bond lifecycle: machine gate FIRST — suspension check before any I/O. Nominal edge; the
  // authoritative fresh-status evaluation runs inside the transaction below.
  assertTransitionIntent(actingWallet, 'bond', 'active', 'active', 'Bond renewal is not a legal transition');

  // Pass-3 #44: validate bond_id BEFORE .doc(). Firestore's
  // CollectionReference.doc(undefined/non-string) throws synchronously
  // ('documentPath is not a valid resource path'), which handleError masks as
  // an opaque 500 for what is really a client field error (and an SDK that
  // retries on 5xx would loop against a permanently-invalid request).
  if (!body.bond_id || typeof body.bond_id !== 'string') {
    throw new ValidationError('bond_id is required');
  }
  const bondRef = deps.db.collection('bonds').doc(body.bond_id);
  const bondSnap = await bondRef.get();
  if (!bondSnap.exists) throw new NotFoundError(`Bond not found: ${body.bond_id}`);

  const bond = bondSnap.data() as BondDocument;
  if (bond.agent_wallet_id !== walletId) throw new ForbiddenError('Not bond owner');
  if (bond.status !== 'active' && bond.status !== 'expired') {
    throw new ValidationError(`Bond is not renewable (status: ${bond.status})`);
  }

  // Verify on-chain
  const bondPoolAddress = bondPoolAddressForChain(bond.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');

  // FIX C: confirm a BondRenewed event was emitted for THIS agent (the bond's
  // owner / msg.sender), not merely that the tx touched the pool.
  const verification = await verifyEvmBondRenewed({
    chainId: chainIdForChain(bond.chain),
    txHash: body.tx_hash,
    bondPoolAddress,
    expectedAgent: bond.agent_address,
  });
  if (!verification.ok) {
    throw new ValidationError(`On-chain verification failed: ${verification.reason}`);
  }

  const now = Date.now();
  // #25: persist the on-chain renewal deadline (BondRenewed.newDeadline, unix
  // seconds → ms) rather than re-deriving now+180d. ProvianBondPool.renewalPeriod is
  // governance-mutable, so the event is the source of truth; a hardcoded period would
  // drift from the actual on-chain deadline whenever governance retunes the period.
  // Fall back to the policy default only if the verifier could not recover it.
  const newDeadline =
    verification.newDeadlineSeconds !== undefined
      ? verification.newDeadlineSeconds * 1000
      : now + SAFETY_LIMITS.BOND_RENEWAL_PERIOD_DAYS * 24 * 60 * 60 * 1000;

  // #9: dedup the renewal by tx_hash. The ONLY prior guard was status === 'active',
  // which a renewal never trips (the bond stays active across renewals), so one
  // on-chain BondRenewed tx could be REPLAYED to extend the deadline unlimited
  // times (and stack bond_renewals docs + bond_renewed PEs). Mirror the WS1
  // fileClaim marker-doc pattern: a deterministic `tx:<hash>` marker created-then-
  // checked inside the SAME transaction rejects a replay before the deadline moves.
  const renewalTxHash = body.tx_hash.toLowerCase();
  const renewalDedupRef = deps.db.collection('bond_renewal_dedup').doc(`tx:${renewalTxHash}`);
  const renewalReceipt = receiptFromVerification(verification, body.tx_hash);

  // Update bond atomically (dedup + machine gate + extend in one transaction)
  let reinstated = false;
  await deps.db.runTransaction(async (txn) => {
    // Reads first (Firestore requires all reads before writes).
    const fresh = await txn.get(bondRef);
    const existingMarker = await txn.get(renewalDedupRef);
    if (!fresh.exists) throw new NotFoundError('Bond not found');
    const freshBond = fresh.data() as BondDocument;
    if (freshBond.status !== 'active' && freshBond.status !== 'expired') {
      throw new ValidationError(`Bond is not renewable (status: ${freshBond.status})`);
    }
    if (existingMarker.exists) {
      throw new ValidationError('Renewal already processed for this transaction');
    }

    // bond lifecycle: the authoritative receipt-gated machine evaluation on the FRESH
    // status — active→active (renewal) or expired→active (late reinstatement).
    assertEconomicTransition({
      kind: 'bond',
      from: freshBond.status,
      to: 'active',
      receipt: renewalReceipt,
      killSwitchActive: actingWallet.status !== 'active',
    });
    reinstated = freshBond.status === 'expired';

    txn.set(renewalDedupRef, {
      bond_id: body.bond_id,
      renewal_tx_hash: renewalTxHash,
      created_at: now,
    });
    txn.update(bondRef, {
      status: 'active',
      last_renewal_at: now,
      renewal_deadline: newDeadline,
      updated_at: now,
    });
  });

  const wallet = await getWallet(deps, walletId);

  // Generate PE
  const pe = await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'bond_renewed',
    metadata: {
      bond_id: body.bond_id,
      new_deadline: newDeadline,
      tx_hash: body.tx_hash,
      // §2.12: on-chain-gated (verifyEvmBondRenewed) → verified.
      verified: true,
      chain_id: chainIdForChain(bond.chain),
      // bond lifecycle: true when this renewal reinstated an 'expired' backend record
      // (chain truth: the on-chain bond had stayed Active and renewable).
      reinstated,
    },
  });

  // Save renewal record
  const renewalId = `renewal_${uuidv4()}`;
  const renewal: BondRenewalDocument = {
    renewal_id: renewalId,
    bond_id: body.bond_id,
    agent_wallet_id: walletId,
    tx_hash: body.tx_hash,
    block_number: verification.blockNumber ?? null,
    new_deadline: newDeadline,
    pe_id: pe.peId,
    renewed_at: now,
  };
  await deps.db.collection('bond_renewals').doc(renewalId).set(renewal);

  const { FieldValue } = await import('firebase-admin/firestore');
  await bondRef.update({ pe_ids: FieldValue.arrayUnion(pe.peId) });
  await updateWalletStats(deps, walletId);

  return { ...bond, status: 'active', last_renewal_at: now, renewal_deadline: newDeadline, updated_at: now };
}

/**
 * Withdraw a bond. Blocked if claims are pending.
 * Verifies on-chain BondWithdrawn event.
 *
 * bond lifecycle: wired through the ONE machine. Withdrawal is economic (active→withdrawn
 * or, for a backend-'expired' record whose on-chain bond stayed Active until
 * the abandonment burn, expired→withdrawn), receipt-gated inside the
 * transaction with a per-tx dedup marker so an OLD BondWithdrawn tx from a
 * previous bond can never flip a later bond.
 */
export async function withdrawBond(
  deps: AgentBankDeps,
  walletId: string,
  actingWallet: AgentWalletDocument,
  body: WithdrawBondRequest,
): Promise<BondDocument> {
  // bond lifecycle: machine gate FIRST — suspension check before any I/O (nominal edge; the
  // fresh-status evaluation runs inside the transaction).
  assertTransitionIntent(actingWallet, 'bond', 'active', 'withdrawn', 'Bond withdrawal is not a legal transition');

  // Pass-3 #44: validate bond_id BEFORE .doc() (see renewBond) so a missing /
  // non-string bond_id is a clean 400, not a synchronous .doc() crash → 500.
  if (!body.bond_id || typeof body.bond_id !== 'string') {
    throw new ValidationError('bond_id is required');
  }
  const bondRef = deps.db.collection('bonds').doc(body.bond_id);
  const bondSnap = await bondRef.get();
  if (!bondSnap.exists) throw new NotFoundError(`Bond not found: ${body.bond_id}`);

  const bond = bondSnap.data() as BondDocument;
  if (bond.agent_wallet_id !== walletId) throw new ForbiddenError('Not bond owner');
  if (bond.status !== 'active' && bond.status !== 'expired') {
    throw new ValidationError(`Bond is not withdrawable (status: ${bond.status})`);
  }
  if (bond.pending_claims > 0) throw new ValidationError('Cannot withdraw with pending claims');

  // Verify on-chain
  const bondPoolAddress = bondPoolAddressForChain(bond.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');

  // FIX C symmetry: confirm a BondWithdrawn event was emitted for THIS agent
  // (the bond's owner / msg.sender), not merely that the tx touched the pool.
  // The status flip below is the same-bond idempotency guard; the bond lifecycle per-tx
  // dedup marker additionally kills a cross-bond replay of an old withdraw tx.
  const verification = await verifyEvmBondWithdrawn({
    chainId: chainIdForChain(bond.chain),
    txHash: body.tx_hash,
    bondPoolAddress,
    expectedAgent: bond.agent_address,
  });
  if (!verification.ok) {
    throw new ValidationError(`On-chain verification failed: ${verification.reason}`);
  }

  const now = Date.now();
  const withdrawReceipt = receiptFromVerification(verification, body.tx_hash);
  const withdrawDedupRef = bondTxDedupRef(deps.db, 'withdraw', body.tx_hash);

  await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(bondRef);
    const existingMarker = await txn.get(withdrawDedupRef);
    if (!fresh.exists) throw new NotFoundError('Bond not found');
    const freshBond = fresh.data() as BondDocument;
    if (freshBond.status !== 'active' && freshBond.status !== 'expired') {
      throw new ValidationError(`Bond is not withdrawable (status: ${freshBond.status})`);
    }
    if (freshBond.pending_claims > 0) throw new ValidationError('Cannot withdraw with pending claims');
    if (existingMarker.exists) {
      throw new ValidationError('Withdrawal already processed for this transaction');
    }

    // bond lifecycle: authoritative receipt-gated machine evaluation on the FRESH status
    // (active→withdrawn or expired→withdrawn).
    assertEconomicTransition({
      kind: 'bond',
      from: freshBond.status,
      to: 'withdrawn',
      receipt: withdrawReceipt,
      killSwitchActive: actingWallet.status !== 'active',
    });

    txn.create(withdrawDedupRef, {
      bond_id: body.bond_id,
      agent_wallet_id: walletId,
      tx_hash: body.tx_hash.toLowerCase(),
      op: 'withdraw',
      created_at: now,
    });
    txn.update(bondRef, {
      status: 'withdrawn',
      updated_at: now,
    });
  });

  const wallet = await getWallet(deps, walletId);

  await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'bond_withdrawn',
    metadata: {
      bond_id: body.bond_id,
      tx_hash: body.tx_hash,
      // §2.12: on-chain-gated (verifyEvmBondWithdrawn) → verified.
      verified: true,
      chain_id: chainIdForChain(bond.chain),
    },
  });

  await updateWalletStats(deps, walletId);

  return { ...bond, status: 'withdrawn', updated_at: now };
}

/**
 * bond lifecycle: record a verified collateral top-up (ProvianBondPool.topUpBond).
 *
 * The on-chain function is the shortfall-restore path from the frozen cost
 * catalog's `bond.top_up_collateral_shortfall` row: NO burn, NO fee — 100% of
 * the transferred PVT becomes slashable collateral — bounded on-chain by the
 * level's undiscounted base lock. The backend mirrors chain truth off the
 * BondToppedUp event (exact amount + resulting collateral), through the ONE
 * machine's economic active→active edge, idempotent by a per-tx dedup marker.
 * Top-up does NOT touch the renewal deadline and does NOT reinstate an
 * 'expired' record — reinstatement is renewBond's edge.
 */
export async function topUpBond(
  deps: AgentBankDeps,
  walletId: string,
  actingWallet: AgentWalletDocument,
  body: TopUpBondRequest,
): Promise<BondDocument> {
  // bond lifecycle: machine gate FIRST — suspension check before any I/O.
  assertTransitionIntent(actingWallet, 'bond', 'active', 'active', 'Bond top-up is not a legal transition');

  // Pass-3 #44 pattern: clean 400 on a missing/non-string bond_id.
  if (!body.bond_id || typeof body.bond_id !== 'string') {
    throw new ValidationError('bond_id is required');
  }
  const bondRef = deps.db.collection('bonds').doc(body.bond_id);
  const bondSnap = await bondRef.get();
  if (!bondSnap.exists) throw new NotFoundError(`Bond not found: ${body.bond_id}`);

  const bond = bondSnap.data() as BondDocument;
  if (bond.agent_wallet_id !== walletId) throw new ForbiddenError('Not bond owner');
  if (bond.status !== 'active') throw new ValidationError('Bond is not active');

  const bondPoolAddress = bondPoolAddressForChain(bond.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');

  // Verify the BondToppedUp event for THIS agent and recover the exact
  // on-chain amounts (never trust a caller-asserted amount).
  const verification = await verifyEvmBondToppedUp({
    chainId: chainIdForChain(bond.chain),
    txHash: body.tx_hash,
    bondPoolAddress,
    expectedAgent: bond.agent_address,
  });
  if (!verification.ok || !verification.newBondAmountAtomic) {
    throw new ValidationError(`On-chain verification failed: ${verification.reason ?? 'no_topup_amount'}`);
  }

  const now = Date.now();
  const topUpReceipt = receiptFromVerification(verification, body.tx_hash);
  const topUpDedupRef = bondTxDedupRef(deps.db, 'topup', body.tx_hash);
  const newCollateralAtomic = verification.newBondAmountAtomic;

  await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(bondRef);
    const existingMarker = await txn.get(topUpDedupRef);
    if (!fresh.exists) throw new NotFoundError('Bond not found');
    const freshBond = fresh.data() as BondDocument;
    if (freshBond.status !== 'active') throw new ValidationError('Bond is not active');
    if (existingMarker.exists) {
      throw new ValidationError('Top-up already processed for this transaction');
    }

    // bond lifecycle: authoritative receipt-gated machine evaluation on the FRESH status.
    assertEconomicTransition({
      kind: 'bond',
      from: freshBond.status,
      to: 'active',
      receipt: topUpReceipt,
      killSwitchActive: actingWallet.status !== 'active',
    });

    txn.create(topUpDedupRef, {
      bond_id: body.bond_id,
      agent_wallet_id: walletId,
      tx_hash: body.tx_hash.toLowerCase(),
      op: 'topup',
      created_at: now,
    });
    txn.update(bondRef, {
      collateral_atomic: newCollateralAtomic,
      last_topup_at: now,
      updated_at: now,
    });
  });

  const wallet = await getWallet(deps, walletId);
  const pe = await generatePE(deps, {
    walletId,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'bond_topped_up',
    metadata: {
      bond_id: body.bond_id,
      tx_hash: body.tx_hash,
      // §2.12: on-chain-gated (verifyEvmBondToppedUp) → verified.
      verified: true,
      chain_id: chainIdForChain(bond.chain),
      amount_topped_atomic: verification.toppedAmountAtomic ?? null,
      new_collateral_atomic: newCollateralAtomic,
    },
  });

  const { FieldValue } = await import('firebase-admin/firestore');
  await bondRef.update({ pe_ids: FieldValue.arrayUnion(pe.peId) });
  await updateWalletStats(deps, walletId);

  return {
    ...bond,
    collateral_atomic: newCollateralAtomic,
    last_topup_at: now,
    updated_at: now,
  };
}

// =========================================================================
// Claims
// =========================================================================

/**
 * File a claim against an agent's bond.
 * Self-claims are blocked. Verifies on-chain ClaimFiled event.
 */
export async function fileClaim(
  deps: AgentBankDeps,
  claimantWalletId: string,
  actingWallet: AgentWalletDocument,
  body: FileClaimRequest,
): Promise<BondClaimDocument> {
  // bond lifecycle: machine gate FIRST — the CLAIMANT is the acting wallet; suspension check
  // before any I/O; INITIAL→filed is the claim's economic entry edge.
  assertTransitionIntent(actingWallet, 'bond_claim', INITIAL, 'filed', 'Claim filing is not a legal transition');

  // Validate evidence PE references.
  // Pass-3 #45: require an ARRAY. The prior truthiness + .length guard let a
  // non-empty string masquerade as an array (a string is truthy and has
  // .length), so `req.body as FileClaimRequest` (no runtime schema) could
  // persist the raw string into a field typed string[] and write the string's
  // CHARACTER count as evidence_pe_count into the on-chain-backed claim PE. The
  // sibling agent-court.ts:292 already uses Array.isArray — match it.
  if (!Array.isArray(body.evidence_pe_ids) || body.evidence_pe_ids.length === 0) {
    throw new ValidationError('At least one evidence PE is required (evidence_pe_ids must be an array)');
  }
  if (body.evidence_pe_ids.length > SAFETY_LIMITS.MAX_EVIDENCE_PE_IDS_CLAIM) {
    throw new ValidationError(`Max ${SAFETY_LIMITS.MAX_EVIDENCE_PE_IDS_CLAIM} evidence PE IDs`);
  }
  if (!body.description || body.description.length < 20) {
    throw new ValidationError('Description must be at least 20 characters');
  }

  // Block self-claims
  if (claimantWalletId === body.respondent_wallet_id) {
    throw new ForbiddenError('Cannot file a claim against your own bond');
  }

  // Find the respondent's bond. bond lifecycle: a backend-'expired' bond is an OFF-CHAIN
  // autonomy drop — the on-chain bond stays Active (and claimable) until the
  // abandonment burn, and verifyEvmClaimFiled below proves the on-chain
  // ClaimFiled actually happened — so claims bind to 'active' OR 'expired'
  // records rather than diverging from chain truth.
  let bondSnap = await deps.db.collection('bonds')
    .where('agent_wallet_id', '==', body.respondent_wallet_id)
    .where('status', '==', 'active')
    .limit(1)
    .get();
  if (bondSnap.empty) {
    bondSnap = await deps.db.collection('bonds')
      .where('agent_wallet_id', '==', body.respondent_wallet_id)
      .where('status', '==', 'expired')
      .limit(1)
      .get();
  }
  if (bondSnap.empty) {
    throw new NotFoundError('No active bond found for respondent');
  }
  const bond = bondSnap.docs[0].data() as BondDocument;
  const bondRef = bondSnap.docs[0].ref;

  // Check pending claims limit
  if (bond.pending_claims >= SAFETY_LIMITS.MAX_PENDING_CLAIMS_PER_BOND) {
    throw new ValidationError('Maximum pending claims reached for this bond');
  }

  const claimant = await getWallet(deps, claimantWalletId);
  const respondent = await getWallet(deps, body.respondent_wallet_id);

  // Verify on-chain
  const bondPoolAddress = bondPoolAddressForChain(body.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');

  // WS Pass-2 (#10): bind the backend claim to the on-chain claim. Decode the
  // ClaimFiled event (recovering the bytes32 claimId + the on-chain agent/
  // claimant) instead of the generic to==BondPool verifier. This fails closed
  // if the on-chain `agent` is not the respondent's bond owner (an attacker
  // cannot point a claim at a respondent who was not named on-chain) or if the
  // on-chain `claimant` is not the authenticated filer (cannot replay someone
  // else's ClaimFiled tx). The recovered claimId is the dedup key below.
  const verification = await verifyEvmClaimFiled({
    chainId: chainIdForChain(body.chain),
    txHash: body.tx_hash,
    bondPoolAddress,
    expectedAgent: bond.agent_address,
    expectedClaimant: claimant.address,
  });
  if (!verification.ok || !verification.onchainClaimId) {
    throw new ValidationError(`On-chain verification failed: ${verification.reason ?? 'no_claim_id'}`);
  }
  const onchainClaimId = verification.onchainClaimId;
  const filingTxHash = body.tx_hash.toLowerCase();

  const now = Date.now();
  const claimId = `claim_${uuidv4()}`;

  const claimDoc: BondClaimDocument = {
    claim_id: claimId,
    bond_id: bond.bond_id,
    claimant_wallet_id: claimantWalletId,
    claimant_address: claimant.address,
    respondent_wallet_id: body.respondent_wallet_id,
    respondent_address: respondent.address,
    description: body.description,
    evidence_pe_ids: body.evidence_pe_ids,
    filing_fee_pvt: SAFETY_LIMITS.BOND_CLAIM_FILING_FEE_PVT.toString(),
    status: 'filed',
    chain: body.chain,
    filing_tx_hash: filingTxHash,
    filing_block_number: verification.blockNumber ?? null,
    onchain_claim_id: onchainClaimId,
    pe_ids: [],
    created_at: now,
    updated_at: now,
  };

  // Atomic: dedup by on-chain claimId AND filing_tx_hash, then create claim +
  // increment pending_claims. The two dedup markers are deterministic-id docs
  // created inside the same transaction (mirrors the withdraw/post status-flip
  // idempotency guard): a replay of the same on-chain filing - same claimId OR
  // same tx_hash - is rejected before pending_claims is bumped, so one on-chain
  // ClaimFiled can never stack multiple pending claims (#10).
  const dedupCol = deps.db.collection('bond_claim_dedup');
  const claimIdMarkerRef = dedupCol.doc(`claimid:${onchainClaimId}`);
  const txMarkerRef = dedupCol.doc(`tx:${filingTxHash}`);

  const claimReceipt = receiptFromVerification(verification, body.tx_hash);

  await deps.db.runTransaction(async (txn) => {
    // Reads first (Firestore requires all reads before writes).
    const freshBond = await txn.get(bondRef);
    const existingClaimIdMarker = await txn.get(claimIdMarkerRef);
    const existingTxMarker = await txn.get(txMarkerRef);

    if (!freshBond.exists) throw new NotFoundError('Bond not found');
    const fb = freshBond.data() as BondDocument;
    if (fb.status !== 'active' && fb.status !== 'expired') {
      throw new ValidationError(`Bond is not claimable (status: ${fb.status})`);
    }
    if (fb.pending_claims >= SAFETY_LIMITS.MAX_PENDING_CLAIMS_PER_BOND) {
      throw new ValidationError('Maximum pending claims reached');
    }
    if (existingClaimIdMarker.exists) {
      throw new ValidationError('Claim already filed for this on-chain claimId');
    }
    if (existingTxMarker.exists) {
      throw new ValidationError('Claim already filed for this filing transaction');
    }

    // bond lifecycle: authoritative receipt-gated machine evaluation for the claim's
    // INITIAL→filed economic entry (suspension check = the CLAIMANT's suspension).
    assertEconomicTransition({
      kind: 'bond_claim',
      from: INITIAL,
      to: 'filed',
      receipt: claimReceipt,
      killSwitchActive: actingWallet.status !== 'active',
    });

    const claimRef = deps.db.collection('bond_claims').doc(claimId);
    txn.set(claimIdMarkerRef, { claim_id: claimId, onchain_claim_id: onchainClaimId, created_at: now });
    txn.set(txMarkerRef, { claim_id: claimId, filing_tx_hash: filingTxHash, created_at: now });
    txn.set(claimRef, claimDoc);
    txn.update(bondRef, {
      pending_claims: fb.pending_claims + 1,
      updated_at: now,
    });
  });

  // Generate PE for claimant
  const pe = await generatePE(deps, {
    walletId: claimantWalletId,
    agentId: claimant.agent_id,
    actorAddress: claimant.address,
    actionType: 'bond_claim_filed',
    metadata: {
      claim_id: claimId,
      bond_id: bond.bond_id,
      respondent_wallet_id: body.respondent_wallet_id,
      evidence_pe_count: body.evidence_pe_ids.length,
      // §2.12: on-chain-gated (verifyEvmClaimFiled recovered the ClaimFiled event) → verified.
      verified: true,
      tx_hash: filingTxHash,
      onchain_claim_id: onchainClaimId,
      chain_id: chainIdForChain(body.chain),
    },
    counterpartyAddress: respondent.address,
  });

  await deps.db.collection('bond_claims').doc(claimId).update({ pe_ids: [pe.peId] });

  return claimDoc;
}

/**
 * Resolve a filed bond claim with a terminal Court verdict.
 *
 * This is the missing resolution leg (#1): fileClaim writes a 'filed' claim and
 * increments the bond's pending_claims, but NOTHING ever transitioned it out -
 * so respondent collateral was locked forever (withdrawBond blocks on
 * pending_claims), the claimant's fee/payout never returned, and the
 * bond_claim_resolved PE was emitted by nothing. This transitions the claim to
 * upheld/dismissed, decrements pending_claims transactionally (unblocking
 * withdrawal), records the filing-fee routing, and emits the
 * bond_claim_resolved PE.
 *
 * Verdict-only by design: the caller passes upheld|dismissed, NOT an arbitrary
 * slash amount. The on-chain slash split (80/20, ≥50% victim floor) and amount
 * are fixed by the BondPool contract / Court panel, never an admin free-pick
 * here (invariant #14 / Court bounds).
 *
 * Partial vs full slash basis: a Court `partial` verdict collapses to `upheld`
 * for FEE routing (claim has merit → fee returned), but the slash MAGNITUDE
 * differs. The persisted claim + the bond_claim_resolved PE carry both the
 * `slash_basis` CATEGORY ('full' | 'partial') and, as of the WS1 (Pass-2)
 * redeploy, the CONCRETE `slash_amount_pvt` it resolves to: full → the whole
 * bond, partial → BOND_MIN_SLASH_PAYOUT_BPS (50%) of it — exactly the amount the
 * on-chain Court bridges to BondPool.slashBond. Settlement is therefore
 * re-derivable from the claim record alone. Direct (non-Court) resolutions
 * default to 'full'. See [[BondSlashBasis]].
 *
 * On-chain settlement: with the Court→BondPool slash bridge redeployed, the slash
 * (BondPool.slashBond / dismissClaim, which moves the bonded PVT and decrements
 * on-chain pendingClaims) is driven by a 2-of-3 panel vote landing ON-CHAIN — the
 * backend NEVER signs it. This resolution records onchain_settlement:'pending' by
 * default; when the caller passes a verified settlement tx (the on-chain
 * BondSlashed/ClaimDismissed), it is checked against this claim's bound
 * onchain_claim_id + respondent and recorded as 'confirmed' with the
 * resolution_tx_hash. The off-chain resolution still decrements the Firestore
 * pending_claims so the backend withdrawal flow unblocks; the on-chain BondPool
 * remains the final gate on actual fund movement (withdrawBond reverts on-chain
 * while pendingClaims > 0).
 */
export async function resolveBondClaim(
  deps: AgentBankDeps,
  params: {
    claimId: string;
    /**
     * agent directory: REQUIRED. The on-chain Court settlement this resolution records —
     * the tx carrying the BondSlashed (a 2-of-3 panel slash landing via
     * ProvianCourtV2.castBondClaimVote) or ClaimDismissed (panel Dismiss /
     * 1-1-1 deadlock / permissionless finalizeBondClaim) event for THIS
     * claim's bound on-chain claimId + respondent. The claim cannot leave
     * 'filed' without it: the filed→upheld|dismissed edge is ECONOMIC in the
     * ONE machine, and the backend NEVER drives a slash — it follows one.
     */
    settlement: { txHash: string; chain: string };
    /**
     * Optional caller expectation. The on-chain EVENT is the verdict
     * authority; when provided, a contradiction (e.g. a Firestore tally said
     * upheld but the chain dismissed) fails closed.
     */
    expectedVerdict?: BondClaimVerdict;
    /**
     * Slash magnitude CATEGORY for an upheld verdict ('full' vs 'partial'),
     * from the Court finding. Falls back to the claim's recorded
     * court_finding, else 'full'. Ignored for dismissed. The concrete slashed
     * amounts are recovered from the BondSlashed event, never from this.
     */
    slashBasis?: BondSlashBasis;
    resolutionSummary?: string;
    resolvedByDisputeId?: string;
  },
): Promise<BondClaimDocument> {
  const { claimId, expectedVerdict, slashBasis, resolutionSummary, resolvedByDisputeId, settlement } = params;
  if (!settlement || typeof settlement.txHash !== 'string' || typeof settlement.chain !== 'string') {
    throw new ValidationError('settlement { txHash, chain } is required');
  }
  if (expectedVerdict !== undefined && expectedVerdict !== 'upheld' && expectedVerdict !== 'dismissed') {
    throw new ValidationError('expectedVerdict must be upheld or dismissed when provided');
  }

  const claimRef = deps.db.collection('bond_claims').doc(claimId);
  const claimSnap = await claimRef.get();
  if (!claimSnap.exists) throw new NotFoundError(`Claim not found: ${claimId}`);
  const claim = claimSnap.data() as BondClaimDocument;
  const resolutionTxHash = settlement.txHash.toLowerCase();

  // Idempotent replay of an already-recorded settlement: return the resolved
  // claim unchanged, record NO second economic PE. A DIFFERENT tx against an
  // already-resolved claim is an error (one on-chain settlement per claim).
  if (claim.status !== 'filed') {
    if (claim.resolution_tx_hash === resolutionTxHash) return claim;
    throw new ValidationError(`Claim is not in filed state (status: ${claim.status})`);
  }
  if (!claim.onchain_claim_id) {
    throw new ValidationError('Claim has no on-chain claimId to bind the settlement to');
  }

  // Verify the settlement receipt at Base finality BEFORE the Firestore
  // transaction (no RPC under an open txn). The event decides the verdict.
  const bondPoolAddress = bondPoolAddressForChain(settlement.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');
  const ver = await verifyEvmBondClaimResolved({
    chainId: chainIdForChain(settlement.chain),
    txHash: settlement.txHash,
    bondPoolAddress,
    expectedAgent: claim.respondent_address,
    expectedClaimId: claim.onchain_claim_id,
    ...(expectedVerdict !== undefined ? { expectedVerdict } : {}),
  });
  if (!ver.ok || !ver.verdict) {
    throw new ValidationError(`On-chain settlement verification failed: ${ver.reason ?? 'no_verdict'}`);
  }
  const verdict: BondClaimVerdict = ver.verdict;

  const feeOutcome: BondClaimFeeOutcome =
    verdict === 'upheld' ? 'returned_to_claimant' : 'burned';
  const slashOutcome = verdict === 'upheld' ? 'bond_slashed' : 'none';
  // Slash magnitude CATEGORY (full vs partial): caller > recorded Court
  // finding > 'full'. Only meaningful for upheld; null for dismissed.
  const effectiveSlashBasis: BondSlashBasis | null =
    verdict === 'upheld' ? (slashBasis ?? claim.court_finding?.slash_basis ?? 'full') : null;

  // Concrete slashed total (whole PVT) — CHAIN TRUTH, from the BondSlashed
  // event's claimantAmount + burnedAmount, floor-divided to the whole-PVT
  // scale the claim record uses. Null for dismissed (no slash).
  let slashAmountPvt: string | null = null;
  if (verdict === 'upheld' && ver.slashClaimantAmountWei && ver.slashBurnedAmountWei) {
    try {
      const totalWei = BigInt(ver.slashClaimantAmountWei) + BigInt(ver.slashBurnedAmountWei);
      slashAmountPvt = (totalWei / 10n ** 18n).toString();
    } catch {
      slashAmountPvt = null; // malformed event decode → leave unset rather than guess
    }
  }

  const now = Date.now();
  const bondRef = deps.db.collection('bonds').doc(claim.bond_id);
  const settlementReceipt = receiptFromVerification(ver, settlement.txHash);

  // Atomic: flip the claim out of 'filed' exactly once and decrement the bond's
  // pending_claims — mirroring the on-chain pendingClaims decrement that the
  // verified slashBond/dismissClaim already performed. Re-reading the claim
  // under the txn makes the transition race-safe; the machine evaluation on the
  // FRESH status is the authoritative economic gate.
  let flipped = false;
  await deps.db.runTransaction(async (txn) => {
    const freshClaim = await txn.get(claimRef);
    const freshBond = await txn.get(bondRef);

    if (!freshClaim.exists) throw new NotFoundError('Claim not found');
    const fc = freshClaim.data() as BondClaimDocument;
    if (fc.status !== 'filed') {
      // A concurrent caller recorded the same settlement: idempotent no-op.
      if (fc.resolution_tx_hash === resolutionTxHash) return;
      throw new ValidationError(`Claim is not in filed state (status: ${fc.status})`);
    }

    // agent directory: the authoritative receipt-gated machine evaluation on FRESH state.
    // killSwitchActive is false — this is a system mirror of an on-chain fact
    // (the Court settlement), not an agent-initiated action.
    assertEconomicTransition({
      kind: 'bond_claim',
      from: fc.status,
      to: verdict,
      receipt: settlementReceipt,
      priorEconomicTxHashes: fc.resolution_tx_hash ? [fc.resolution_tx_hash] : [],
      killSwitchActive: false,
    });

    txn.update(claimRef, {
      status: verdict,
      fee_outcome: feeOutcome,
      ...(effectiveSlashBasis ? { slash_basis: effectiveSlashBasis } : {}),
      ...(slashAmountPvt ? { slash_amount_pvt: slashAmountPvt } : {}),
      ...(ver.slashClaimantAmountWei ? { slash_claimant_amount_wei: ver.slashClaimantAmountWei } : {}),
      ...(ver.slashBurnedAmountWei ? { slash_burned_amount_wei: ver.slashBurnedAmountWei } : {}),
      onchain_settlement: 'confirmed',
      resolution_tx_hash: resolutionTxHash,
      resolution_summary: resolutionSummary ?? `Court verdict: ${verdict}`,
      ...(resolvedByDisputeId ? { resolved_by_dispute_id: resolvedByDisputeId } : {}),
      resolved_at: now,
      updated_at: now,
    });

    // Decrement the bond's pending_claims (floor at 0) so the respondent's
    // withdrawal unblocks. Skip if the bond doc is gone (defensive - bonds are
    // not deleted in normal operation).
    if (freshBond.exists) {
      const fb = freshBond.data() as BondDocument;
      txn.update(bondRef, {
        pending_claims: Math.max(0, fb.pending_claims - 1),
        updated_at: now,
      });
    }
    flipped = true;
  });

  // A concurrent caller already recorded this settlement — no second PE.
  if (!flipped) {
    return (await claimRef.get()).data() as BondClaimDocument;
  }

  // Part C2 (rail handshake event-based invalidation): an UPHELD claim slashed /
  // forfeited the respondent's bond — a discrete adverse presenter-side standing
  // event. Close every live rail handshake the respondent backs so the next
  // commitment re-presents. Best-effort, POST-commit: the settlement already
  // durably landed; the advisory floor write must never roll it back.
  if (slashOutcome === 'bond_slashed' && claim.respondent_wallet_id) {
    try {
      await invalidateHandshakes(deps.db, claim.respondent_wallet_id, 'bond_slashed', Date.now(), {
        eventId: claimId,
      });
    } catch {
      /* advisory-only; invalidateHandshakes swallows its own errors */
    }
  }

  // Emit the bond_claim_resolved PE in the claimant's chain (respondent as
  // counterparty) — once per claim: the transactional status flip above is the
  // single-winner guard, so a settlement replay never emits a second PE. The
  // PE records the CHAIN-verified settlement (verdict from the event, actual
  // slashed amounts, resolution tx).
  const claimant = await getWallet(deps, claim.claimant_wallet_id);
  const pe = await generatePE(deps, {
    walletId: claim.claimant_wallet_id,
    agentId: claimant.agent_id,
    actorAddress: claim.claimant_address,
    actionType: 'bond_claim_resolved',
    metadata: {
      claim_id: claimId,
      bond_id: claim.bond_id,
      respondent_wallet_id: claim.respondent_wallet_id,
      verdict,
      fee_outcome: feeOutcome,
      slash_outcome: slashOutcome,
      // Court-finding category carried losslessly (full vs partial); null = no slash.
      slash_basis: effectiveSlashBasis,
      // Concrete slashed total (whole PVT), derived from the BondSlashed
      // event's actual amounts; null = no slash (dismissed).
      slash_amount_pvt: slashAmountPvt,
      // Separate party/burn accounting recovered from the event (wei).
      slash_claimant_amount_wei: ver.slashClaimantAmountWei ?? null,
      slash_burned_amount_wei: ver.slashBurnedAmountWei ?? null,
      onchain_settlement: 'confirmed',
      resolution_tx_hash: resolutionTxHash,
      // §2.12: the verdict is read from the Base-final BondClaimResolved/BondSlashed
      // events (receipt-gated resolveBondClaim) → verified, keyed on the settlement tx.
      verified: true,
      tx_hash: resolutionTxHash,
      chain_id: chainIdForChain(claim.chain),
      ...(resolvedByDisputeId ? { resolved_by_dispute_id: resolvedByDisputeId } : {}),
    },
    counterpartyAddress: claim.respondent_address,
  });

  // Terminal append (once per claim, status-flip guarded above) - read the prior
  // ids and write the concat rather than FieldValue.arrayUnion so the value is
  // deterministic and the PE filing id is preserved.
  const newPeIds = [...(claim.pe_ids ?? []), pe.peId];
  await claimRef.update({ pe_ids: newPeIds });

  return {
    ...claim,
    status: verdict,
    fee_outcome: feeOutcome,
    ...(effectiveSlashBasis ? { slash_basis: effectiveSlashBasis } : {}),
    ...(slashAmountPvt ? { slash_amount_pvt: slashAmountPvt } : {}),
    ...(ver.slashClaimantAmountWei ? { slash_claimant_amount_wei: ver.slashClaimantAmountWei } : {}),
    ...(ver.slashBurnedAmountWei ? { slash_burned_amount_wei: ver.slashBurnedAmountWei } : {}),
    onchain_settlement: 'confirmed',
    resolution_tx_hash: resolutionTxHash,
    resolution_summary: resolutionSummary ?? `Court verdict: ${verdict}`,
    resolved_by_dispute_id: resolvedByDisputeId ?? claim.resolved_by_dispute_id,
    resolved_at: now,
    pe_ids: newPeIds,
    updated_at: now,
  };
}

/**
 * agent directory: record the Court panel's FINDING on a filed claim — RECORD-ONLY. The
 * finding preserves what the panel decided (verdict + slash-magnitude
 * category) on the claim doc without flipping its status or touching
 * pending_claims: the economic filed→upheld|dismissed transition fires ONLY
 * through the receipt-gated resolveBondClaim above, on a verified Base-final
 * BondSlashed/ClaimDismissed receipt. Idempotent: a finding is recorded once
 * (first dispute wins); a finding on an already-resolved claim is a no-op
 * (chain truth already landed).
 */
export async function recordBondClaimCourtFinding(
  deps: AgentBankDeps,
  params: {
    claimId: string;
    verdict: GeneralDisputeResolution;
    slashBasis: BondSlashBasis | null;
    disputeId: string;
  },
): Promise<void> {
  const claimRef = deps.db.collection('bond_claims').doc(params.claimId);
  const now = Date.now();
  await deps.db.runTransaction(async (txn) => {
    const fresh = await txn.get(claimRef);
    if (!fresh.exists) throw new NotFoundError(`Claim not found: ${params.claimId}`);
    const fc = fresh.data() as BondClaimDocument;
    if (fc.status !== 'filed') return; // already settled on-chain — chain truth stands
    if (fc.court_finding) return; // first finding wins (one escalation per claim)
    txn.update(claimRef, {
      court_finding: {
        verdict: params.verdict,
        slash_basis: params.slashBasis,
        dispute_id: params.disputeId,
        found_at: now,
      },
      updated_at: now,
    });
  });
}

/**
 * agent directory: observe the on-chain Court settlement of a filed claim and drive the
 * receipt-gated resolveBondClaim bridge with it. Two entry shapes:
 * - an agent posts the resolving tx hash (the majority-landing on-chain
 * castBondClaimVote / finalizeBondClaim tx) — verified directly;
 * - no tx hash: the settlement is RECOVERED from the BondPool's own
 * BondSlashed/ClaimDismissed logs, bounded from the filing block (the
 * escrow-release recovery pattern; also the scheduler mirror's path).
 * Either way the EVENT decides the verdict and the machine's economic
 * filed→upheld|dismissed gate runs inside the resolution transaction. An
 * already-resolved claim returns as-is (idempotent view, no second PE).
 * Fails closed when no Base-final settlement exists.
 */
export async function observeBondClaimSettlement(
  deps: AgentBankDeps,
  params: {
    claimId: string;
    txHash?: string;
    /**
     * The acting wallet when agent-initiated (the observation route): the
     * suspension-check-first intent gate runs BEFORE any I/O. System callers (the
     * scheduler mirror) omit it — a settlement mirror of an on-chain fact
     *.
     */
    actingWallet?: AgentWalletDocument;
  },
): Promise<BondClaimDocument> {
  // agent directory: machine gate FIRST for agent-initiated observation — suspension check
  // before any I/O (nominal economic edge; the event decides the real verdict
  // and the in-txn evaluation gates the flip).
  if (params.actingWallet) {
    assertTransitionIntent(params.actingWallet, 'bond_claim', 'filed', 'upheld', 'Bond claim resolution is not a legal transition');
  }

  if (!params.claimId || typeof params.claimId !== 'string') {
    throw new ValidationError('claimId is required');
  }
  const claim = await getClaimDetails(deps, params.claimId);
  if (claim.status !== 'filed') return claim; // already terminal — idempotent view
  if (!claim.onchain_claim_id) {
    throw new ValidationError('Claim has no on-chain claimId to observe a settlement for');
  }

  if (params.txHash) {
    return resolveBondClaim(deps, {
      claimId: params.claimId,
      settlement: { txHash: params.txHash, chain: claim.chain },
    });
  }

  const bondPoolAddress = bondPoolAddressForChain(claim.chain);
  if (!bondPoolAddress) throw new ValidationError('Bond pool contract not configured');
  const recovered = await recoverEvmBondClaimResolution({
    chainId: chainIdForChain(claim.chain),
    bondPoolAddress,
    onchainClaimId: claim.onchain_claim_id,
    expectedAgent: claim.respondent_address,
    fromBlock: claim.filing_block_number ?? 0,
  });
  if (!recovered.ok || !recovered.txHash) {
    throw new ValidationError(
      `No Base-final on-chain settlement found for this claim (${recovered.reason ?? 'unknown'})`,
    );
  }
  return resolveBondClaim(deps, {
    claimId: params.claimId,
    settlement: { txHash: recovered.txHash, chain: claim.chain },
  });
}

// =========================================================================
// Queries
// =========================================================================

/**
 * Get required bond amount for an autonomy level.
 * If walletId is provided, computes trust discount server-side.
 */
export async function getRequiredBond(
  deps: AgentBankDeps,
  autonomyLevel: 2 | 3,
  walletId?: string,
): Promise<{ base_pvt: number; trust_discount_bps: number; required_pvt: number }> {
  const basePvt = autonomyLevel === 2
    ? SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT
    : SAFETY_LIMITS.BOND_LEVEL_3_BASE_PVT;

  let trustDiscountBps = 0;
  if (walletId) {
    const wallet = await getWallet(deps, walletId);
    trustDiscountBps = await computeTrustDiscount(deps.db, wallet);
  }

  const requiredPvt = getRequiredBondAmount(autonomyLevel, trustDiscountBps);

  return { base_pvt: basePvt, trust_discount_bps: trustDiscountBps, required_pvt: requiredPvt };
}

function getRequiredBondAmount(autonomyLevel: 2 | 3, trustDiscountBps: number): number {
  const basePvt = autonomyLevel === 2
    ? SAFETY_LIMITS.BOND_LEVEL_2_BASE_PVT
    : SAFETY_LIMITS.BOND_LEVEL_3_BASE_PVT;

  const cappedDiscount = Math.min(trustDiscountBps, SAFETY_LIMITS.MAX_TRUST_DISCOUNT_BPS);
  return Math.ceil(basePvt * (10000 - cappedDiscount) / 10000);
}

/**
 * Check bond status for an agent. Used by FrictionRouter integration.
 */
export async function checkBondStatus(
  deps: AgentBankDeps,
  walletId: string,
): Promise<{
  has_bond: boolean;
  bond_active: boolean;
  bond_healthy: boolean;
  autonomy_level: 2 | 3 | null;
  bond_id: string | null;
  amount_pvt: string | null;
  renewal_deadline: number | null;
}> {
  const snap = await deps.db.collection('bonds')
    .where('agent_wallet_id', '==', walletId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snap.empty) {
    return {
      has_bond: false,
      bond_active: false,
      bond_healthy: false,
      autonomy_level: null,
      bond_id: null,
      amount_pvt: null,
      renewal_deadline: null,
    };
  }

  const bond = snap.docs[0].data() as BondDocument;
  const now = Date.now();

  return {
    has_bond: true,
    bond_active: true,
    bond_healthy: now <= bond.renewal_deadline,
    autonomy_level: bond.autonomy_level,
    bond_id: bond.bond_id,
    amount_pvt: bond.amount_pvt,
    renewal_deadline: bond.renewal_deadline,
  };
}

/**
 * Get full bond details including associated claims.
 */
export async function getBondDetails(
  deps: AgentBankDeps,
  bondId: string,
): Promise<{ bond: BondDocument; claims: BondClaimDocument[]; renewals: BondRenewalDocument[] }> {
  const bondSnap = await deps.db.collection('bonds').doc(bondId).get();
  if (!bondSnap.exists) throw new NotFoundError(`Bond not found: ${bondId}`);
  const bond = bondSnap.data() as BondDocument;

  const claimsSnap = await deps.db.collection('bond_claims')
    .where('bond_id', '==', bondId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .get();
  const claims = claimsSnap.docs.map(d => d.data() as BondClaimDocument);

  const renewalsSnap = await deps.db.collection('bond_renewals')
    .where('bond_id', '==', bondId)
    .orderBy('renewed_at', 'desc')
    .limit(20)
    .get();
  const renewals = renewalsSnap.docs.map(d => d.data() as BondRenewalDocument);

  return { bond, claims, renewals };
}

/**
 * Get bond details by agent wallet ID (convenience for agent views).
 */
export async function getBondByAgent(
  deps: AgentBankDeps,
  agentWalletId: string,
): Promise<BondDocument | null> {
  const snap = await deps.db.collection('bonds')
    .where('agent_wallet_id', '==', agentWalletId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snap.empty) return null;
  return snap.docs[0].data() as BondDocument;
}

/**
 * Get claim details by claim ID.
 */
export async function getClaimDetails(
  deps: AgentBankDeps,
  claimId: string,
): Promise<BondClaimDocument> {
  const snap = await deps.db.collection('bond_claims').doc(claimId).get();
  if (!snap.exists) throw new NotFoundError(`Claim not found: ${claimId}`);
  return snap.data() as BondClaimDocument;
}
