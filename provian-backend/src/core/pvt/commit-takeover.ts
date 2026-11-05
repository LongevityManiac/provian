import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * Build B (unit 2) — the cross-witness commit BEST-VALUE TAKEOVER.
 *
 * A git commit may be witnessed by the local observer daemon (`coding_session`,
 * compute base 1.0×) AND by a forge webhook (`service:github_commit` / …, base
 * 3.0×). They share ONE `(user, commit_sha)` mint-once claim, so exactly one
 * mints. Arrival order used to decide the winner: whoever recorded first owned
 * the slot and the other became a `corroborated_duplicate` (0). That stranded the
 * forge's higher base weight whenever the daemon happened to land first.
 *
 * The takeover makes the WINNER the higher-base-weight witness INSIDE THE 72h
 * cross-witness window: when a strictly-higher-base witness arrives for a commit
 * whose incumbent is still `eligible` and NOT yet registered for settlement, it
 * CLAIMS the slot — it becomes the mintable owner and the incumbent is demoted.
 *
 * SCOPED THIS. The original wording was "regardless of order"; the decision
 * of record is now that the lift applies ONLY within the window, and a witness
 * arriving after it is REFUSED with the incumbent's sealed value standing. That is
 * the rule, not a shortfall against an unscoped ideal — past the window the
 * incumbent has registered and is committed to mint, and demoting it would strand
 * a settleable claim. Pinned by `constructsTheDeviation` + `sealedValueStands` in
 * `commit-takeover-settlement-order.test.ts`. This module owns the
 * two halves of that: the record-time PRE-CHECK (`evaluateCommitTakeover`, which
 * also decides `crossWitnessDuplicate` for the taker's own snapshot) and the
 * in-`writePEHistory`-transaction SPECIALIZED PATH (`inspect…` / `apply…`).
 *
 * WHY A SPECIALIZED TRANSACTION, NOT THE GENERIC ONE. The generic
 * `inspectPreparedMintOnceClaimInTransaction` treats an existing claim doc whose
 * owner differs from the plan as a RACE and throws — it can only CREATE a claim,
 * never re-own one. The takeover deliberately overwrites `owner_pe_id` and demotes
 * the loser, so it needs its own path. Its safety rests on reading, in the SAME
 * transaction as the taker's pe_history seal:
 * 1. the claim doc — still owned by the exact incumbent the pre-check saw;
 * 2. the incumbent's pe_history — still `mint_status === 'eligible'`;
 * 3. the incumbent's claim-ledger rows (every payout leg) — NONE registered.
 * Any of these failing means the incumbent moved (got settled, demoted, or
 * registered) between the pre-check and here, so the takeover throws
 * `MintOnceClaimRaceError`; `recordPEAccrual` retries the whole accrual, the
 * pre-check now sees the incumbent settled/registered, no takeover is chosen, and
 * the new witness records as an ordinary duplicate — the "already-settled
 * fallback". The demotion WRITES `pe_history[incumbent].mint_status` and reads the
 * ledger; the settlement inlet's registration READS that mint_status and WRITES
 * the ledger (the re-check in `durable-settlement-store.ts::registerClaim`),
 * so the two mutually conflict and Firestore serializes them — no arrival order of
 * takeover-vs-settlement can double-mint one commit.
 *
 * ONLY the MUTABLE `mint_status` is demoted. The incumbent's sealed
 * `economic_snapshot` is never touched — immutability holds.
 */

import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import type { MeterActKeyDoc } from '../meter/meter-act-key';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  readActRow, readActRowInTransaction, updateActRowInTransaction, type ActRowHandle,
} from '../meter/act-row-store';
import { recordMeterIncumbentCorroboration } from '../meter/meter-corroboration';
import { meterActUnregistered } from '../meter/act-claims';
import stableStringify from 'json-stable-stringify';
import {
  MINT_ONCE_EVIDENCE_SCHEMA_VERSION,
  MintOnceClaimRaceError,
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
// the 72h TAKEOVER window is now its own constant (bound to the legacy window,
// never a third literal) and DECOUPLED from the corroboration horizon: the horizon is
// 30 days for post-cut-line PEs and the value it admits after registration is carried
// by the additive attestation top-up, so registration is deferred only for the 72h a
// higher-base witness could still take the slot. `attestationEnhancementWindowMsFor`
// bounds the OTHER decision here — whether a late cross-witness may still corroborate
// a registered/minted incumbent (it may, inside the incumbent's own horizon).
import { CROSS_WITNESS_TAKEOVER_WINDOW_MS, attestationEnhancementWindowMsFor } from './policy/monetary-accounting';
import { mutatePeHistoryRowWithAggregate } from './policy/economic-aggregate';
import type { InputOrigin } from '../provenance/input-origins';
import { normalizeInputOrigins } from '../provenance/input-origins';
import { mergeInputOrigins } from '../provenance/origin-capture';

/** The `mint_status` the settlement inlet selects on; must match the store's. */
const RELAY_STATUS_READY = 'eligible';
/** The terminal, non-minting status a demoted incumbent lands in. */
export const DEMOTED_INCUMBENT_MINT_STATUS = 'corroborated_duplicate';
/** The status the PVT9 settlement writeback leaves on a settled incumbent (reads it). */
const MINTED_INCUMBENT_MINT_STATUS = 'minted';

/**
 * The `corroboration_status` a cross-witnessed commit's WINNER carries. It is a
 * recognized member of the settlement-lift set (`corroborationLiftedRecordPointsAtomic`
 * and the legacy `resolveAttestationAtMintTime` both map it to the `corroborated`
 * tier), so it lifts the winner software 0.8× → corroborated 1.0× within the 72h
 * window. `service_grant_attested` is the same status the forge webhook already
 * uses for a Witness-3 cross-witness attestation.
 */
export const COMMIT_CROSS_WITNESS_CORROBORATION_STATUS = 'service_grant_attested';

const COMMIT_MINT_CLAIMS_COLLECTION = 'commit_mint_claims';

/**
 * The record-time cross-witness decision for a commit whose slot an incumbent
 * already owns. the operator’s invariant (scoped by): two real witnesses of
 * one commit are worth more than one, arrival-independent WITHIN the 72h
 * cross-witness window — so whichever witness ends up the settling WINNER carries
 * the cross-witness corroboration. Once the window has lapsed and the incumbent
 * has registered, this returns `'none'` and the sealed value stands.
 *
 * 'takeover' THIS witness out-weighs the incumbent and the
 * incumbent is still eligible + unregistered, so this
 * witness claims the slot; corroboration is sealed on
 * THIS row (the winner) and the incumbent is demoted.
 * 'corroborate_incumbent' THIS witness is a strictly LOWER-base cross-witness,
 * so the incumbent stays the winner and THIS witness
 * corroborates IT (the lift lands on the incumbent).
 * 'none' an equal-base duplicate (same-family, no cross-witness
 * lift), an unreadable/ineligible incumbent, or a
 * witness landing after the incumbent's own corroboration
 * horizon (`attestationEnhancementWindowMsFor`).
 *
 * ACROSS THE MINT BOUNDARY. Settlement runs weekly (daily under; weekly
 * again since ) and on demand through the payout, so the incumbent is
 * routinely REGISTERED or already MINTED when a second real witness of the same
 * commit lands. A higher-base witness can no longer take the slot then (demoting a
 * registered incumbent would strand a settleable claim — the guard that must not be
 * relaxed), but it IS still an independent second witness, and FC-003 says moving
 * only WHEN the witness lands must never lower total payout. So inside the
 * incumbent's own horizon a too-late higher-base witness — and a lower-base
 * cross-witness of an `eligible` OR `minted` incumbent — returns
 * `'corroborate_incumbent'` the corroboration is stamped on the incumbent, the
 * inline lift takes it if the incumbent is still unregistered, and the additive
 * attestation top-up (`wp4/attestation-topup-inlet-source.ts`) carries the delta
 * once it has registered or minted. The sealed row is never re-derived either way.
 */
export type CommitWitnessAction = 'takeover' | 'corroborate_incumbent' | 'none';

/**
 * BASE WEIGHT is compared, never final value: it is a pure function of the action
 * policy (forge `service:*` = 30000 > `coding_session` = 10000), so it is settled
 * before the taker's own snapshot — which it must be, since a `takeover` sets the
 * taker's `crossWitnessDuplicate`. A tie is `none` (same-family witnesses are not
 * an independent corroboration).
 *
 * Best-effort by design: this READ can go stale before the transaction. It only
 * gates what is ATTEMPTED; the in-transaction re-verification is the authority for
 * a takeover, and the incumbent corroboration is a best-effort status write.
 */
export async function evaluateCommitWitness(
  db: Firestore,
  input: { readonly incumbentPeId: string; readonly newBaseWeightBps: number; readonly nowMs?: number },
): Promise<CommitWitnessAction> {
  if (!Number.isFinite(input.newBaseWeightBps) || input.newBaseWeightBps <= 0) return 'none';
  const handle = await readActRow(db, input.incumbentPeId);
  if (handle === null) return 'none';
  const data: Record<string, unknown> | undefined = handle.row;
  // an incumbent that has already MINTED is still a corroborable winner (the
  // additive top-up carries the delta); any other status is not a winner at all.
  const incumbentSettleable = data?.mint_status === RELAY_STATUS_READY
    || data?.mint_status === MINTED_INCUMBENT_MINT_STATUS;
  if (!data || !incumbentSettleable) return 'none';
  const incumbentBase = incumbentBaseWeightBps(data);
  // Unknown incumbent base → fail closed. No takeover, no corroboration on an
  // unreadable comparison.
  if (incumbentBase === null) return 'none';
  // A MINTED incumbent is corroborable only inside its OWN corroboration horizon
  // (30 d post-cut-line / 72 h legacy): past it a witness can change nothing — late
  // evidence is a record, never value — so it stamps nothing. An unreadable record
  // time on a minted row is treated as expired (closed). An `eligible` incumbent is
  // NOT gated here: its value is gated where it always was, by `computeSettlement`'s
  // window at the inline lift (and by the same lift inside the top-up source), so the
  // best-effort stamp keeps its pre- behaviour exactly.
  const recordedAt = typeof data.timestamp === 'number' && Number.isFinite(data.timestamp)
    ? data.timestamp
    : null;
  const nowMs = input.nowMs ?? Date.now();
  const mintedInsideHorizon = data.mint_status !== MINTED_INCUMBENT_MINT_STATUS
    || (recordedAt !== null && nowMs < recordedAt + attestationEnhancementWindowMsFor(recordedAt));
  if (input.newBaseWeightBps > incumbentBase) {
    // Higher-base: take over IFF the incumbent has not already committed to
    // settle (any registered leg). Otherwise it is too late to take the slot — but
    // it is still a second real witness, so it corroborates the incumbent
    // instead of recording as a worthless duplicate (the top-up carries the delta).
    if (data.mint_status === RELAY_STATUS_READY
      && await isIncumbentUnregistered(db, input.incumbentPeId)) {
      return 'takeover';
    }
    return mintedInsideHorizon ? 'corroborate_incumbent' : 'none';
  }
  if (input.newBaseWeightBps < incumbentBase) {
    // Lower-base cross-witness: the incumbent is the winner; corroborate it.
    return mintedInsideHorizon ? 'corroborate_incumbent' : 'none';
  }
  return 'none';
}

function incumbentBaseWeightBps(history: Record<string, unknown>): number | null {
  const snapshot = history.economic_snapshot;
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const factors = (snapshot as Record<string, unknown>).recordTimeFactors;
  if (factors === null || typeof factors !== 'object') return null;
  const base = (factors as Record<string, unknown>).baseActionWeightBps;
  return typeof base === 'number' && Number.isFinite(base) && base >= 0 ? base : null;
}

/**
 * Best-effort: record THIS witness's corroboration onto the incumbent WINNER
 * (the forge-first case — a lower-base daemon confirming the forge). Sets only the
 * mutable corroboration fields the settlement lift reads; the winner's sealed
 * snapshot and mint_status are untouched.
 *
 * NEVER a gate: the lift is a value ENHANCEMENT, so a failed corroboration write
 * (or a lapsed window at settlement) leaves the winner at its record-tier
 * value — never unpaid, never double-minted.
 *
 * FIRST OBSERVATION WINS. An incumbent that already carries a recognized
 * corroboration keeps its ORIGINAL `corroboration_received_at` a repeat witness
 * must not be able to push the observation instant later (out of the horizon, or
 * merely later than the top-up already registered against). The `expect` below
 * turns the repeat into a `precondition_failed` no-op — the anti-farm shape.
 */
export async function recordIncumbentCommitCorroboration(
  db: Firestore,
  input: { readonly incumbentPeId: string; readonly corroboratingPeId: string; readonly nowMs: number },
): Promise<void> {
  try {
    // PE meter: a metered incumbent's row lives in its act key; its corroboration lift is paid
    // as an additive top-up claim (there is no pe_history row to re-read at settlement).
    const handle = await readActRow(db, input.incumbentPeId);
    if (handle?.home === 'meter') {
      await recordMeterIncumbentCorroboration(db, {
        incumbentPeId: input.incumbentPeId,
        corroboratingPeId: input.corroboratingPeId,
        nowMs: input.nowMs,
        status: COMMIT_CROSS_WITNESS_CORROBORATION_STATUS,
      });
      return;
    }
    // Prompt 2 — ORDER-INDEPENDENCE (forge-first): the corroborating device
    // witness arrived AFTER the forge incumbent sealed, so the incumbent's
    // (immutable) canonical origins could not include the device's rich origins.
    // Carry the UNION onto the winner's pe_history row in `corroborated_origins`
    // (an additive, unhashed economic-record field — NEVER the sealed canonical
    // doc, Security Invariant #5), so the device's origins are not stranded on
    // the demoted/duplicate witness. Best-effort; a read failure leaves the
    // corroboration write unchanged. (The device-first order is unioned into the
    // forge PE's own canonical origins at webhook time — github-webhook.ts.)
    const corroboratedOrigins = await unionPeInputOrigins(
      db, input.incumbentPeId, input.corroboratingPeId,
    );
    // Through the aggregate-aware mutation primitive (M5): a corroboration
    // inside the 72h window changes the incumbent's settlement input, and if
    // that row already sits below the frozen watermark the delta must land in
    // the same transaction as the write. (Past the window the input is
    // unchanged by construction — `computeSettlement` refuses the lift — so
    // the delta is zero and the write is the same write it always was.)
    await mutatePeHistoryRowWithAggregate(db, input.incumbentPeId, {
      corroboration_status: COMMIT_CROSS_WITNESS_CORROBORATION_STATUS,
      corroboration_source: input.corroboratingPeId,
      corroboration_received_at: input.nowMs,
      // Zero-mint-effect provenance union; omitted when neither witness carried origins.
      ...(corroboratedOrigins.length > 0 ? { corroborated_origins: corroboratedOrigins } : {}),
    }, {
      nowMs: input.nowMs,
      expect: (before) => !isRecognizedCorroborationStatus(before.corroboration_status),
    });
  } catch (err) {
    console.warn('[commit-takeover] incumbent corroboration write failed (non-blocking):', err);
  }
}

/** Read one PE's stored `input_origins` from the immutable envelope store. */
async function readPeInputOrigins(db: Firestore, peId: string): Promise<InputOrigin[] | null> {
  // PE METER: a commit-bearing metered act carries its origins on its act key.
  const key = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId).get();
  if (key.exists) return normalizeInputOrigins((key.data() as MeterActKeyDoc).side?.commitOrigins ?? null);
  const snap = await db.collection('provenance_envelopes').doc(peId).get();
  if (!snap.exists) return null;
  return normalizeInputOrigins((snap.data() as { input_origins?: unknown }).input_origins);
}

/** Union the `input_origins` of two PEs (the winner + the corroborating witness). */
async function unionPeInputOrigins(db: Firestore, aPeId: string, bPeId: string): Promise<InputOrigin[]> {
  const [a, b] = await Promise.all([readPeInputOrigins(db, aPeId), readPeInputOrigins(db, bPeId)]);
  return mergeInputOrigins(a, b);
}

/** The four recognized third-party corroboration statuses (`pe-history.ts` union minus 'none'). */
function isRecognizedCorroborationStatus(value: unknown): boolean {
  return value === 'on_chain_verified' || value === 'merchant_confirmed'
    || value === 'peer_verified' || value === 'service_grant_attested';
}

/**
 * Is a commit's cross-witness window still open — i.e. could a higher-base witness
 * of this same commit still legitimately take the slot?
 *
 * ── THE INTERLEAVING THIS CLOSES (as scoped by) ─────────────────
 * 's invariant is "one commit, one mint, at BEST value, arrival-independent
 * WITHIN the 72h cross-witness window" the window scope is 's amendment.
 * It held in both RECORD-time orders and failed in one SETTLEMENT-interleaved
 * order INSIDE the window, which is what this gate closes: if the settlement inlet REGISTERED the daemon incumbent (`coding_session`,
 * base 1.0×) before the forge webhook (base 3.0×) arrived, then `evaluateCommitWitness`
 * saw a registered incumbent, returned `'none'`, and the forge recorded as a plain
 * duplicate worth 0 — while the incumbent's ledger row had already been frozen at its
 * UNCORROBORATED value. One mint, correct; at 0.8× instead of 3.0×, wrong.
 *
 * The takeover could not fix it from its own side: once an incumbent holds a
 * `claim_ledger` leg it is committed to mint on chain, and demoting it would strand a
 * settleable claim — which is why `inspectPreparedCommitTakeoverInTransaction` throws
 * on any registered leg, and why that guard must NOT be relaxed.
 *
 * So the fix is on the OTHER side of the race: the inlet does not register a
 * commit-bearing PE while this window is open. The deviating interleaving then cannot
 * be constructed — a witness arriving inside the window always finds an UNREGISTERED
 * incumbent and can take over; a witness arriving after it is genuinely too late,
 * which is already the documented and intended behaviour.
 *
 * ── WHY THIS WINDOW, AND NO NEW NUMBER ──────────────────────────────────────
 * `CROSS_WITNESS_TAKEOVER_WINDOW_MS` is the legacy 72h window, bound (not copied) in
 * `monetary-accounting.ts`. DECOUPLED it from the corroboration horizon: the
 * horizon is now 30 days for post-cut-line PEs, and a 30-day registration deferral
 * would defeat the settlement cadence. After these 72h a higher-base witness can no longer
 * take the slot, but it CAN still corroborate the registered/minted incumbent inside
 * the horizon, and the additive attestation top-up carries that value — so deferring
 * past 72h buys nothing. No economic literal is chosen here.
 *
 * ── FAIL-SAFE DIRECTION, DELIBERATELY ───────────────────────────────────────
 * Unreadable or absent `commit_sha`/`timestamp` returns FALSE (do not defer). The
 * opposite choice is the dangerous one: a NaN timestamp would make `now < ts + 72h`
 * never become true and strand the claim forever. Not deferring is exactly today's
 * behaviour, so the bad-data path is the unchanged path.
 *
 * The delay is BOUNDED and small in practice: the standard lane settles on a weekly
 * cron (`0 12 * * *`, ), so a ≤72h deferral costs at most one run and never
 * strands anything — the row is simply re-read on the next run, the same way every
 * other skipped row is.
 */
export function commitTakeoverWindowOpen(
  history: Record<string, unknown>,
  nowMs: number,
): boolean {
  const sha = history.commit_sha;
  if (typeof sha !== 'string' || sha.trim().length === 0) return false;
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
 * Build the takeover PLAN — a `PreparedMintOnceClaim` whose evidence names the NEW
 * owner (relation `owner`) and whose `commit_takeover` marker carries the incumbent
 * it displaces. It rides `mint_once_claim_plans` like any other, so its evidence
 * flows into the taker's evidence hash and `assertMintOnceClaimEvidence` sees the
 * taker as the owner; only its in-transaction handling branches on the marker.
 *
 * The claim id is byte-identical to the incumbent's (it hashes `subject:event` =
 * `user:commit`, independent of `owner_pe_id`), so this re-owns the SAME doc. The
 * incumbent's `owner_user_id` must equal the taker's user — it always does when the
 * claim ids collide (both hash the same subject) — and this asserts it rather than
 * trust it.
 */
export function prepareCommitTakeoverPlan(input: {
  readonly incumbentClaim: MintOnceClaimDocument;
  readonly newOwnerPeId: string;
  readonly newOwnerUserId: string;
  readonly nowMs: number;
}): PreparedMintOnceClaim {
  const { incumbentClaim, newOwnerPeId, newOwnerUserId, nowMs } = input;
  if (incumbentClaim.claim_kind !== 'commit') {
    throw new Error('commit_takeover_wrong_kind');
  }
  if (incumbentClaim.owner_pe_id === newOwnerPeId) {
    throw new Error('commit_takeover_self');
  }
  // The commit claim keys on `subject_id === owner_user_id`, so a claim-id
  // collision guarantees the incumbent's user equals the taker's. A mismatch
  // means these are NOT the same claim and the takeover is a construction error.
  if (incumbentClaim.owner_user_id !== newOwnerUserId) {
    throw new Error('commit_takeover_user_mismatch');
  }
  const newOwnerClaim = parseClaim(
    { ...incumbentClaim, owner_pe_id: newOwnerPeId, owner_user_id: newOwnerUserId, created_at_ms: nowMs },
    incumbentClaim.claim_id,
  );
  return {
    claim_collection: COMMIT_MINT_CLAIMS_COLLECTION,
    current_pe_id: newOwnerPeId,
    current_user_id: newOwnerUserId,
    evidence: {
      schema_version: MINT_ONCE_EVIDENCE_SCHEMA_VERSION,
      relation: 'owner',
      claim: newOwnerClaim,
    },
    commit_takeover: {
      incumbent_pe_id: incumbentClaim.owner_pe_id,
      incumbent_claim: incumbentClaim,
    },
  };
}

export interface CommitTakeoverDecision {
  readonly claimCollection: string;
  readonly claimId: string;
  readonly newOwnerClaim: MintOnceClaimDocument;
  readonly incumbentPeId: string;
  /**
   * The incumbent's pe_history row AS READ inside this transaction — the
   * "before" state the accrual-time aggregate needs to apply the demotion's
   * delta (M5: `EconomicAggregateWriter.applyMutation`) in the SAME seal
   * transaction that demotes it.
   */
  readonly incumbentBefore: Record<string, unknown>;
  /** Where the incumbent's row lives (meter act key or legacy pe_history). */
  readonly incumbentHandle: ActRowHandle;
}

/**
 * The in-transaction takeover verification. Reads (all BEFORE any write, so the
 * conflict set is real): the claim doc, the incumbent's pe_history, and every
 * payout-leg ledger row for the incumbent. Any drift throws `MintOnceClaimRaceError`
 * so the accrual retries into the duplicate fallback. Returns the overwrite +
 * demotion the caller applies.
 */
export async function inspectPreparedCommitTakeoverInTransaction(
  db: Firestore,
  txn: Transaction,
  plan: PreparedMintOnceClaim,
): Promise<CommitTakeoverDecision> {
  const takeover = plan.commit_takeover;
  if (takeover === undefined || plan.evidence.relation !== 'owner') {
    throw new Error('commit_takeover_plan_invalid');
  }
  const newOwnerClaim = plan.evidence.claim;
  const claimId = newOwnerClaim.claim_id;
  if (plan.claim_collection !== COMMIT_MINT_CLAIMS_COLLECTION
    || newOwnerClaim.claim_kind !== 'commit'
    || newOwnerClaim.owner_pe_id !== plan.current_pe_id
    || takeover.incumbent_pe_id === plan.current_pe_id
    || takeover.incumbent_claim.claim_id !== claimId
    || takeover.incumbent_claim.owner_pe_id !== takeover.incumbent_pe_id) {
    throw new Error('commit_takeover_plan_invalid');
  }

  // (1) The claim doc must STILL be exactly the incumbent's — unchanged since the
  // pre-check read it. A byte-diff means someone else re-owned or mutated it.
  const claimRef = db.collection(COMMIT_MINT_CLAIMS_COLLECTION).doc(claimId);
  const claimSnap = await txn.get(claimRef);
  if (!claimSnap.exists
    || stableStringify(parseClaim(claimSnap.data(), claimId)) !== stableStringify(takeover.incumbent_claim)) {
    throw new MintOnceClaimRaceError();
  }

  // (2) The incumbent must STILL be settleable-eligible. A demotion or a settlement
  // writeback that already flipped it means the slot is spoken for.
  const incumbentHandle = await readActRowInTransaction(db, txn, takeover.incumbent_pe_id);
  const incumbentData = incumbentHandle?.row;
  if (!incumbentHandle || !incumbentData
    || incumbentData.peId !== takeover.incumbent_pe_id
    || incumbentData.mint_status !== RELAY_STATUS_READY) {
    throw new MintOnceClaimRaceError();
  }

  // (3) The incumbent must NOT be registered for settlement on ANY leg. Once a
  // ledger row exists the incumbent is committed to mint on chain and demoting it
  // here would strand a settleable claim.
  for (const leg of PAYOUT_LEG_ROLES) {
    const legSnap = await txn.get(db.collection(CLAIM_LEDGER_COLLECTION).doc(
      claimKeyOf(takeover.incumbent_pe_id, leg),
    ));
    if (legSnap.exists) throw new MintOnceClaimRaceError();
  }

  return {
    claimCollection: COMMIT_MINT_CLAIMS_COLLECTION,
    claimId,
    newOwnerClaim,
    incumbentPeId: takeover.incumbent_pe_id,
    incumbentBefore: incumbentData,
    incumbentHandle,
  };
}

/** The demoted incumbent's row state — what `applyCommitTakeoverDecision` writes, as a row. */
export function demotedIncumbentRow(decision: CommitTakeoverDecision, nowMs: number): Record<string, unknown> {
  return {
    ...decision.incumbentBefore,
    mint_status: DEMOTED_INCUMBENT_MINT_STATUS,
    commit_takeover_demoted_by_pe_id: decision.newOwnerClaim.owner_pe_id,
    commit_takeover_demoted_at_ms: nowMs,
  };
}

/**
 * Apply the takeover: OVERWRITE the claim doc's owner and DEMOTE the incumbent's
 * mutable `mint_status` (never its sealed snapshot). The taker's own pe_history
 * row is written by `writePEHistory` as an ordinary eligible owner.
 */
export function applyCommitTakeoverDecision(
  db: Firestore,
  txn: Transaction,
  decision: CommitTakeoverDecision,
  nowMs: number,
): void {
  txn.set(
    db.collection(decision.claimCollection).doc(decision.claimId),
    decision.newOwnerClaim as unknown as FirebaseFirestore.DocumentData,
  );
  updateActRowInTransaction(txn, decision.incumbentHandle, {
    mint_status: DEMOTED_INCUMBENT_MINT_STATUS,
    // Audit trail on the MUTABLE fields only; the sealed economic_snapshot and
    // its mintDisposition are untouched, so this row's own record stays honest
    // about what it was priced as while never being settleable again.
    commit_takeover_demoted_by_pe_id: decision.newOwnerClaim.owner_pe_id,
    commit_takeover_demoted_at_ms: nowMs,
  });
}
