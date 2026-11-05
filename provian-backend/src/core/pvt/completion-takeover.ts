/**
 * the cross-witness COMPLETION BEST-SUPPORTED-VALUE TAKEOVER. The exact
 * mirror of `commit-takeover.ts` (, as scoped by) for the completion
 * claim kind; read that module's header first — the discipline is reproduced
 * here verbatim, only the ranking rule differs.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * One job completion may be witnessed by the OFF-CHAIN counterparty
 * confirmation (the resolver-promoted `human_job_delivered`, witness
 * `counterparty_confirmation`) AND by the ON-CHAIN escrow release (the watcher's
 * verified `escrow_completed` / `escrow_resolved`, witness `onchain_release`).
 * They share ONE (beneficiary, canonical completion id) claim, so exactly one
 * mints. the standing rule: when both exist the value is the BEST-SUPPORTED one —
 * the on-chain release — never the sum. So the ranking is by EVIDENCE CLASS, not
 * by base weight as the commit takeover ranks: an on-chain witness out-ranks an
 * off-chain one, and the reverse never takes over (the resolver refuses by name
 * when the on-chain witness already owns the slot —
 * `refused_canonical_event_already_minted`).
 *
 * ── SCOPING APPLIES VERBATIM ───────────────────────────────────────────
 * The takeover applies ONLY while the incumbent is still `eligible` and NOT yet
 * registered for settlement. Past the 72h takeover window (`CROSS_WITNESS_
 * TAKEOVER_WINDOW_MS`, bound in the kernel, never copied; decoupled it from
 * the 30-day corroboration horizon) the settlement inlet stops
 * deferring the off-chain row (`completionTakeoverWindowOpen`, the sibling of
 * `commitTakeoverWindowOpen`), registers it, and a later on-chain witness is
 * REFUSED with the incumbent's sealed/registered value standing. A registered
 * incumbent is never demoted — demoting it would strand a settleable claim,
 * which `inspectPreparedCompletionTakeoverInTransaction` refuses by design.
 * Mint-once holds in every order regardless.
 *
 * ── WHY A SPECIALIZED TRANSACTION ────────────────────────────────────────────
 * Identical to the commit case: the generic `inspectPreparedMintOnceClaimInTransaction`
 * treats an existing claim doc with a different owner as a RACE and throws — it
 * can only CREATE a claim, never re-own one. The takeover deliberately
 * overwrites `owner_pe_id` and demotes the loser, so it re-verifies, in the SAME
 * transaction as the taker's pe_history seal:
 * 1. the claim doc — still owned by the exact incumbent the pre-check saw;
 * 2. the incumbent's pe_history — still `mint_status === 'eligible'` and still
 * the OFF-CHAIN witness;
 * 3. the incumbent's claim-ledger rows (every payout leg) — NONE registered.
 * Any drift throws `MintOnceClaimRaceError`; `recordPEAccrual` retries the whole
 * accrual, the pre-check now sees the incumbent moved, no takeover is chosen,
 * and the on-chain witness records as an ordinary duplicate (mints 0). The
 * demotion WRITES `pe_history[incumbent].mint_status` and reads the ledger; the
 * inlet's registration READS that mint_status and WRITES the ledger (the
 * re-check in `durable-settlement-store.ts::registerClaim`), so the two
 * mutually conflict and Firestore serializes them.
 *
 * ONLY the MUTABLE `mint_status` is demoted. The incumbent's sealed
 * `economic_snapshot` is never touched.
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  readActRow, readActRowInTransaction, updateActRowInTransaction, type ActRowHandle,
} from '../meter/act-row-store';
import stableStringify from 'json-stable-stringify';
import {
  MINT_ONCE_EVIDENCE_SCHEMA_VERSION,
  MintOnceClaimRaceError,
  mintOnceClaimCollectionFor,
  parseClaim,
  type MintOnceClaimDocument,
  type PreparedMintOnceClaim,
} from './mint-once-claim';
import {
  CLAIM_LEDGER_COLLECTION,
  PE_HISTORY_COLLECTION,
  claimKeyOf,
} from './wp4/durable-settlement-store';
import { PAYOUT_LEG_ROLES } from './wp-ev/payout-legs';
import { meterActUnregistered } from '../meter/act-claims';
// The 72h cross-witness TAKEOVER window — bound in the kernel module, never copied.
// decoupled it from the 30-day corroboration horizon (see commit-takeover.ts).
import { CROSS_WITNESS_TAKEOVER_WINDOW_MS } from './policy/monetary-accounting';
import type { CompletionWitness } from './completion-claim';

/** The `mint_status` the settlement inlet selects on; must match the store's. */
const RELAY_STATUS_READY = 'eligible';
/** The terminal, non-minting status a demoted incumbent lands in. */
export const DEMOTED_COMPLETION_INCUMBENT_MINT_STATUS = 'corroborated_duplicate';

/** The claim collection, read from the ONE kind→collection table (never a literal). */
const COMPLETION_MINT_CLAIMS_COLLECTION = mintOnceClaimCollectionFor('completion');

/**
 * The record-time cross-witness decision for a completion whose slot an
 * incumbent already owns.
 *
 * 'takeover' THIS witness is the ON-CHAIN release and the incumbent is the
 * OFF-CHAIN confirmation, still eligible + unregistered: this
 * witness claims the slot and the incumbent is demoted.
 * 'none' every other case: this witness is itself off-chain (the
 * resolver never takes over — it refuses by name), the incumbent
 * is on-chain (never displaced), the incumbent is no longer
 * eligible, its witness is unreadable, or it has registered for
 * settlement (too late —).
 *
 * Best-effort by design: this READ can go stale before the transaction. It only
 * gates what is ATTEMPTED; the in-transaction re-verification is the authority.
 */
export type CompletionWitnessAction = 'takeover' | 'none';

export async function evaluateCompletionWitness(
  db: Firestore,
  input: { readonly incumbentPeId: string; readonly newWitness: CompletionWitness },
): Promise<CompletionWitnessAction> {
  if (input.newWitness !== 'onchain_release') return 'none';
  const handle = await readActRow(db, input.incumbentPeId);
  if (handle === null) return 'none';
  const data: Record<string, unknown> | undefined = handle.row;
  if (!data || data.mint_status !== RELAY_STATUS_READY) return 'none';
  // Unknown incumbent witness → fail closed. An on-chain incumbent is never
  // displaced; an unreadable one is treated as if it were.
  if (data.completion_witness !== 'counterparty_confirmation') return 'none';
  return (await isIncumbentUnregistered(db, input.incumbentPeId)) ? 'takeover' : 'none';
}

/**
 * Is an off-chain-witnessed completion row's takeover window still open — i.e.
 * could the on-chain release of the same job still legitimately take the slot?
 *
 * The sibling of `commitTakeoverWindowOpen`, and the same closure of the same
 * interleaving: if the settlement inlet registered the resolver-promoted
 * off-chain row before the escrow release landed, the on-chain witness would
 * find a registered incumbent and be refused at its off-chain value. The inlet
 * therefore does not register an off-chain completion row while this window is
 * open. Bounded by the 72h takeover window (`CROSS_WITNESS_TAKEOVER_WINDOW_MS`);
 * measured from the row's own record time (`timestamp`), exactly as the commit
 * case measures it.
 *
 * FAIL-SAFE DIRECTION: an unreadable marker or timestamp returns FALSE (do not
 * defer) — deferring on NaN would never become false and strand the claim.
 * ONLY the off-chain witness is deferred: an on-chain row can never be taken
 * over, so deferring it would buy nothing.
 */
export function completionTakeoverWindowOpen(
  history: Record<string, unknown>,
  nowMs: number,
): boolean {
  if (history.completion_witness !== 'counterparty_confirmation') return false;
  const canonicalId = history.completion_canonical_id;
  if (typeof canonicalId !== 'string' || canonicalId.trim().length === 0) return false;
  const recordedAt = history.timestamp;
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return false;
  if (!Number.isFinite(nowMs)) return false;
  return nowMs < recordedAt + CROSS_WITNESS_TAKEOVER_WINDOW_MS;
}

async function isIncumbentUnregistered(db: Firestore, incumbentPeId: string): Promise<boolean> {
  // A METERED incumbent registers through its pending claims, never under the legacy ledger key
  // probed below : it is unregistered only while every claim carrying it is still
  // `pending` — once one has been taken into a payout it is committed to settle.
  const metered = await meterActUnregistered(db, incumbentPeId);
  if (metered !== null) return metered;
  for (const leg of PAYOUT_LEG_ROLES) {
    const row = await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(incumbentPeId, leg)).get();
    if (row.exists) return false;
  }
  return true;
}

/**
 * Build the takeover PLAN — a `PreparedMintOnceClaim` whose evidence names the
 * NEW owner (relation `owner`) and whose `completion_takeover` marker carries
 * the incumbent it displaces. The claim id is byte-identical to the incumbent's
 * (it hashes `subject:event`, independent of `owner_pe_id`), so this re-owns the
 * SAME document. The incumbent's `owner_user_id` must equal the taker's user —
 * it always does when the claim ids collide — and this asserts it.
 */
export function prepareCompletionTakeoverPlan(input: {
  readonly incumbentClaim: MintOnceClaimDocument;
  readonly newOwnerPeId: string;
  readonly newOwnerUserId: string;
  readonly nowMs: number;
}): PreparedMintOnceClaim {
  const { incumbentClaim, newOwnerPeId, newOwnerUserId, nowMs } = input;
  if (incumbentClaim.claim_kind !== 'completion') {
    throw new Error('completion_takeover_wrong_kind');
  }
  if (incumbentClaim.owner_pe_id === newOwnerPeId) {
    throw new Error('completion_takeover_self');
  }
  if (incumbentClaim.owner_user_id !== newOwnerUserId) {
    throw new Error('completion_takeover_user_mismatch');
  }
  const newOwnerClaim = parseClaim(
    { ...incumbentClaim, owner_pe_id: newOwnerPeId, owner_user_id: newOwnerUserId, created_at_ms: nowMs },
    incumbentClaim.claim_id,
  );
  return {
    claim_collection: COMPLETION_MINT_CLAIMS_COLLECTION,
    current_pe_id: newOwnerPeId,
    current_user_id: newOwnerUserId,
    evidence: {
      schema_version: MINT_ONCE_EVIDENCE_SCHEMA_VERSION,
      relation: 'owner',
      claim: newOwnerClaim,
    },
    completion_takeover: {
      incumbent_pe_id: incumbentClaim.owner_pe_id,
      incumbent_claim: incumbentClaim,
    },
  };
}

export interface CompletionTakeoverDecision {
  readonly claimCollection: string;
  readonly claimId: string;
  readonly newOwnerClaim: MintOnceClaimDocument;
  readonly incumbentPeId: string;
  /**
   * The incumbent's pe_history row AS READ inside this transaction — the
   * "before" state the accrual-time aggregate needs to apply the demotion's
   * delta (M5: `EconomicAggregateWriter.applyMutation`) in the SAME seal
   * transaction that demotes it. The exact mirror of the commit takeover's
   * `incumbentBefore` a demoted row projects ZERO settlement input
   * (`projectCurrentSettlementInputAtomic` returns zero for any non-`eligible`
   * row), so its contribution must LEAVE the aggregate when it is demoted.
   */
  readonly incumbentBefore: Record<string, unknown>;
  /** Where the incumbent's row lives (meter act key or legacy pe_history). */
  readonly incumbentHandle: ActRowHandle;
}

/**
 * The in-transaction takeover verification. Reads (all BEFORE any write, so the
 * conflict set is real): the claim doc, the incumbent's pe_history, and every
 * payout-leg ledger row for the incumbent. Any drift throws
 * `MintOnceClaimRaceError` so the accrual retries into the duplicate fallback.
 */
export async function inspectPreparedCompletionTakeoverInTransaction(
  db: Firestore,
  txn: Transaction,
  plan: PreparedMintOnceClaim,
): Promise<CompletionTakeoverDecision> {
  const takeover = plan.completion_takeover;
  if (takeover === undefined || plan.evidence.relation !== 'owner') {
    throw new Error('completion_takeover_plan_invalid');
  }
  const newOwnerClaim = plan.evidence.claim;
  const claimId = newOwnerClaim.claim_id;
  if (plan.claim_collection !== COMPLETION_MINT_CLAIMS_COLLECTION
    || newOwnerClaim.claim_kind !== 'completion'
    || newOwnerClaim.owner_pe_id !== plan.current_pe_id
    || takeover.incumbent_pe_id === plan.current_pe_id
    || takeover.incumbent_claim.claim_id !== claimId
    || takeover.incumbent_claim.owner_pe_id !== takeover.incumbent_pe_id) {
    throw new Error('completion_takeover_plan_invalid');
  }

  // (1) The claim doc must STILL be exactly the incumbent's.
  const claimRef = db.collection(COMPLETION_MINT_CLAIMS_COLLECTION).doc(claimId);
  const claimSnap = await txn.get(claimRef);
  if (!claimSnap.exists
    || stableStringify(parseClaim(claimSnap.data(), claimId)) !== stableStringify(takeover.incumbent_claim)) {
    throw new MintOnceClaimRaceError();
  }

  // (2) The incumbent must STILL be settleable-eligible AND still the OFF-CHAIN
  // witness. An on-chain incumbent is never displaced, whatever the plan says.
  const incumbentHandle = await readActRowInTransaction(db, txn, takeover.incumbent_pe_id);
  const incumbentData = incumbentHandle?.row;
  if (!incumbentHandle || !incumbentData
    || incumbentData.peId !== takeover.incumbent_pe_id
    || incumbentData.mint_status !== RELAY_STATUS_READY
    || incumbentData.completion_witness !== 'counterparty_confirmation') {
    throw new MintOnceClaimRaceError();
  }

  // (3) The incumbent must NOT be registered for settlement on ANY leg. Once a
  // ledger row exists it is committed to mint on chain; demoting it would
  // strand a settleable claim (the never-strand rule,).
  for (const leg of PAYOUT_LEG_ROLES) {
    const legSnap = await txn.get(db.collection(CLAIM_LEDGER_COLLECTION).doc(
      claimKeyOf(takeover.incumbent_pe_id, leg),
    ));
    if (legSnap.exists) throw new MintOnceClaimRaceError();
  }

  return {
    claimCollection: COMPLETION_MINT_CLAIMS_COLLECTION,
    claimId,
    newOwnerClaim,
    incumbentPeId: takeover.incumbent_pe_id,
    incumbentBefore: incumbentData,
    incumbentHandle,
  };
}

/**
 * The demoted incumbent's row state — what `applyCompletionTakeoverDecision`
 * writes, as a row. The "after" side of the aggregate delta; the mirror of
 * `demotedIncumbentRow` in `commit-takeover.ts`.
 */
export function demotedCompletionIncumbentRow(
  decision: CompletionTakeoverDecision,
  nowMs: number,
): Record<string, unknown> {
  return {
    ...decision.incumbentBefore,
    ...demotedCompletionIncumbentPatch(decision, nowMs),
  };
}

/** The exact mutable-field patch the demotion writes. ONE source for both the write and the delta. */
function demotedCompletionIncumbentPatch(
  decision: CompletionTakeoverDecision,
  nowMs: number,
): Record<string, unknown> {
  return {
    mint_status: DEMOTED_COMPLETION_INCUMBENT_MINT_STATUS,
    // Audit trail on the MUTABLE fields only; the sealed economic_snapshot and
    // its mintDisposition are untouched.
    completion_takeover_demoted_by_pe_id: decision.newOwnerClaim.owner_pe_id,
    completion_takeover_demoted_at_ms: nowMs,
  };
}

/**
 * Apply the takeover: OVERWRITE the claim doc's owner and DEMOTE the incumbent's
 * mutable `mint_status` (never its sealed snapshot). The taker's own pe_history
 * row is written by `writePEHistory` as an ordinary eligible owner — and
 * `writePEHistory` applies the demotion's aggregate delta
 * (`incumbentBefore` → `demotedCompletionIncumbentRow`) in that same
 * transaction; this function writes the row, it does not own the delta.
 */
export function applyCompletionTakeoverDecision(
  db: Firestore,
  txn: Transaction,
  decision: CompletionTakeoverDecision,
  nowMs: number,
): void {
  txn.set(
    db.collection(decision.claimCollection).doc(decision.claimId),
    decision.newOwnerClaim as unknown as FirebaseFirestore.DocumentData,
  );
  updateActRowInTransaction(
    txn,
    decision.incumbentHandle,
    demotedCompletionIncumbentPatch(decision, nowMs),
  );
}
