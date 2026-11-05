/**
 * a PVT burn is ACCEPTED at one-block inclusion and FINALIZED
 * (or revoked) at Base economic finality.
 *
 * The recorder (`burn-record.ts`) accepts a burn once it is mined — both operator-bound legs agree on
 * the receipt and its canonical block (`verifyEvmPvtBurn({ acceptance: 'inclusion' })`) — and records
 * it `finality: 'provisional'`. From that moment the burn is consumable exactly once, like any
 * recorded burn: `burn_consumptions/{burn_id}` is untouched by anything here.
 *
 * This module runs the 12-block finality check (`verifyEvmPvtBurn`, default acceptance — the same
 * verifier every burn used before this ruling) on every provisional burn and moves it, once, to:
 *
 * final — the burn reached finality (in any block: a same-tx re-inclusion after a reorg keeps its
 * benefit). Terminal.
 * revoked — the burn is proven not to have finalized. Terminal. `status` becomes `'revoked'`, so
 * every consume path (`assertBurnRowUsable`) and every burn-row reader refuses it from
 * then on, and EVERY relay-held benefit the burn backs is revoked
 * (`revokeBurnBenefits`).
 *
 * A burn is revoked ONLY on positive evidence that it did not happen (: "an
 * RPC error is never evidence that a burn isn't final; a real burn is never revoked because an RPC
 * was down"). Positive evidence is exactly:
 * - the agreed finality receipt REVERTED (`tx_failed`) or carries no matching burn log
 * (`no_matching_pvt_burn_log`); or
 * - the finality read finds no receipt (`tx_not_found`) at least {@link BURN_NOT_FOUND_REVOKE_AFTER_MS}
 * after acceptance AND `proveBurnDropped` proves the drop on both legs: the block the burn was
 * accepted in is no longer canonical at its height, read at the watchers' safe depth, and neither
 * leg has a receipt for the tx or knows it at all. A row without `included_block_hash` can never
 * carry that proof, so `tx_not_found` alone never revokes it.
 * Every other verdict — an RPC error, a missing provider, an unconfigured chain, an unverifiable row,
 * not-yet-12 confirmations — leaves the burn provisional and retried on every sweep, forever. Past
 * {@link BURN_FINALITY_DEADLINE_MS} such a burn is marked STALLED (`finality_stalled: true`, reversible
 * cleared the moment the burn finalizes) and raises the `system_status/burn_finality` alarm. A
 * stalled burn KEEPS every benefit: it is still `finality: 'provisional'`, so every consume path and
 * every reader treats it exactly as before, and speech it backs is only held from settlement until
 * the burn is final (`speechPeWindowBurnFinal`), never dropped.
 *
 * Where it runs: in-process right after acceptance (`scheduleBurnFinalization`, best effort), and on
 * the existing 5-minute durable-outbox job (`sweepBurnFinality`, the guarantee). No new service,
 * scheduler, or index.
 *
 * The one ratified residual : an OUTSIDE-GATE presentation a gate already verified
 * before its burn failed. Relay verify stays stateless, so nothing here can reach it.
 */

import { FieldPath, type Firestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import type { ethers } from 'ethers';
import { matchPvtBurnLog, verifyEvmPvtBurn, type TxVerificationResult } from '../onchain/tx-verifier';
import {
  PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK,
  PREDECESSOR_PVT9_KERNEL_BASE,
} from '../agent-bank/pvt-principal-config';
import { PVT_BURN_RECORDS_COLLECTION } from '../commons/burn-consumption';
import { COMMONS_PRESENTATIONS_COLLECTION } from './types';
import { COMMONS_NAME_CLAIMS_COLLECTION } from '../commons/name-registry';
import { COMMONS_BURN_VOUCHES_COLLECTION } from '../commons/burn-vouch';
import { COMMONS_PLEDGES_COLLECTION } from '../commons/pledges';
import { COMMONS_SUBSCRIPTIONS_COLLECTION } from '../commons/subscriptions';
import { COMMONS_COLLECTIONS } from '../commons/types';
import { COMMONS_WANTS_COLLECTION } from '../commons/wants';
import { HIDDEN_REVOKED_BURN } from '../commons/public-visibility';
import { PRESENTATION_REQUESTS_COLLECTION } from '../pe/presentation-request';
import {
  SPEECH_WINDOW_BUDGETS_COLLECTION,
  SPEECH_WINDOW_RESERVATIONS_COLLECTION,
} from '../pvt/speech-window-budget';
import {
  BURN_FINALITY_STATUS_COLLECTION,
  BURN_FINALITY_STATUS_DOCUMENT,
  burnFinalityOf,
} from './burn-finality-state';
import { ORDINARY_ACCRUAL_INTAKE_COLLECTION } from '../pvt/wp11/ordinary-accrual-intake';
import {
  readSpeechWindowAct,
  SPEECH_WINDOW_ACTS_COLLECTION,
  type SpeechActRefs,
} from '../commons/speech-window-acts';

export {
  BURN_FINALITY_STATUS_COLLECTION,
  BURN_FINALITY_STATUS_DOCUMENT,
  burnFinalityOf,
  speechPeWindowBurnFinal,
  type BurnFinality,
} from './burn-finality-state';
import { waitForFinalityWindow, type FinalityProbe } from './burn-finality-wait';
import { proveBurnDropped, type BurnDropProof, type BurnDropProofInput } from './burn-drop-proof';
import { bumpOpsCounter } from '../observability/ops-counters';

/**
 * A `tx_not_found` finality read is checked for a PROVEN drop (`proveBurnDropped`) only this long
 * after acceptance. Before it, and whenever the drop is not proven, the burn simply waits.
 */
export const BURN_NOT_FOUND_REVOKE_AFTER_MS = 10 * 60_000;
/**
 * Still not provably final this long after acceptance → STALLED: alarmed, retried every sweep,
 * benefits kept. Never a revocation.
 */
export const BURN_FINALITY_DEADLINE_MS = 30 * 60_000;
/** Provisional burns finalized per sweep (verifier calls). */
export const BURN_FINALITY_SWEEP_LIMIT = 50;
/** Provisional rows the sweep reads per page, and at most per pass, to choose what to finalize. */
export const BURN_FINALITY_SCAN_PAGE = 200;
export const BURN_FINALITY_SCAN_LIMIT = 2_000;
export const BURN_FINALITY_STALLED_VERDICT = 'burn_finality_stalled';
/** The revoke-reason prefix for a burn proven dropped by a reorg (`proveBurnDropped`). */
export const BURN_DROPPED_REASON = 'tx_not_found_dropped_at_safe_depth';
/** The row fields a stall writes; all removed when the burn leaves `provisional`. */
const STALL_FIELDS = ['finality_stalled', 'finality_stalled_at', 'finality_stall_reason', 'finality_last_checked_at'] as const;
/**
 * A revoked burn's benefits are swept again for this long after revocation, so a folded benefit
 * written in the instant its handshake was being revoked is caught on the next pass.
 */
export const BURN_REVOCATION_RESWEEP_MS = 60 * 60_000;
/** The in-process finalizer waits at most this long for the 12th block before handing to the sweep. */
export const BURN_INPROCESS_FINALIZE_WAIT_MS = 90_000;

/** The audit record of one burn's revocation: `burn_revocations/{burn_id}` (+ `benefits/{key}`). */
export const BURN_REVOCATIONS_COLLECTION = 'burn_revocations';



export interface BurnFinalityDeps {
  readonly db: Firestore;
  readonly now?: () => number;
  /** Test seam; production is the shared burn verifier at its default (finality) acceptance. */
  readonly verify?: typeof verifyEvmPvtBurn;
  readonly probe?: FinalityProbe;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  /** Test seam; production is `proveBurnDropped` over the operator-bound Base legs. */
  readonly proveDropped?: (input: BurnDropProofInput) => Promise<BurnDropProof>;
}

/** `stalled` = not provably final past the deadline: alarmed, still provisional, retried. */
export type FinalizeOutcome = 'final' | 'revoked' | 'pending' | 'stalled' | 'skip';

const CHAIN_IDS: Record<string, number> = { base: 8453, arbitrum: 42161, optimism: 10 };

function numberField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * What a non-ok finality verdict says about the burn :
 * disproof — the agreed receipt reverted, or carries no matching burn log. Revoke.
 * not_found — no receipt. Revoke only with a PROVEN drop (`proveBurnDropped`).
 * unproven — everything else (an RPC error, no provider, an unconfigured chain, an unverifiable
 * row, not yet 12 confirmations). Never revokes, however old the burn.
 */
export type FinalityVerdictKind = 'disproof' | 'not_found' | 'unproven';

export function classifyFinalityVerdict(v: TxVerificationResult): FinalityVerdictKind {
  const reason = v.reason ?? '';
  if (reason === 'tx_failed' || reason === 'no_matching_pvt_burn_log') return 'disproof';
  if (reason === 'tx_not_found') return 'not_found';
  return 'unproven';
}

/**
 * Whether a finality verdict ALONE proves the burn did NOT finalize. Only the two receipt disproofs
 * do; `tx_not_found` also needs `proveBurnDropped` (see `finalizeBurn`), and every other reason, at
 * any age, never does.
 */
export function finalityVerdictRevokes(v: TxVerificationResult): boolean {
  return !v.ok && classifyFinalityVerdict(v) === 'disproof';
}

/** Drop the stall bookkeeping from a row that is leaving `provisional`. */
function withoutStall(row: Record<string, unknown>, nowMs: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const k of STALL_FIELDS) delete out[k];
  if (row.finality_stalled === true) out.finality_stall_cleared_at = nowMs;
  return out;
}

/** `proveBurnDropped` for a row; a thrown read is an RPC failure — never a proof. */
async function tryProveDropped(deps: BurnFinalityDeps, row: Record<string, unknown>): Promise<BurnDropProof> {
  if (row.chain !== 'base') return { dropped: false, reason: 'drop_proof_base_only' };
  if (typeof row.included_block_hash !== 'string' || typeof row.block_number !== 'number') {
    return { dropped: false, reason: 'drop_proof_row_incomplete' };
  }
  try {
    return await (deps.proveDropped ?? proveBurnDropped)({
      txHash: String(row.tx_hash),
      includedBlockNumber: row.block_number,
      includedBlockHash: row.included_block_hash,
    });
  } catch (err) {
    return { dropped: false, reason: `rpc_error: drop_proof: ${(err as Error).message}` };
  }
}

/**
 * Mark a still-provisional burn STALLED: not provably final past the deadline, for a reason that is
 * not evidence against it. Reversible (cleared when it finalizes) and benefit-preserving (`finality`
 * stays `'provisional'`). The first stall is counted and logged loudly; the sweep raises the alarm.
 */
export async function markBurnStalled(deps: BurnFinalityDeps, burnId: string, reason: string): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const ref = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const first = await deps.db.runTransaction(async (txn) => {
    const cur = (await txn.get(ref)).data() as Record<string, unknown> | undefined;
    if (burnFinalityOf(cur) !== 'provisional' || !cur) return null;
    const wasStalled = cur.finality_stalled === true;
    txn.set(ref, {
      ...cur,
      finality_stalled: true,
      finality_stalled_at: wasStalled && typeof cur.finality_stalled_at === 'number' ? cur.finality_stalled_at : now(),
      finality_stall_reason: reason,
      finality_last_checked_at: now(),
    });
    return !wasStalled;
  });
  if (first === null) return false;
  if (first) {
    deps.log?.(`[burn-finality] ALARM burn ${burnId} STALLED — not provably final ${BURN_FINALITY_DEADLINE_MS / 60_000} min after acceptance; benefits kept, retried every sweep: ${reason}`);
    bumpOpsCounter('burn.finality_stalled');
  }
  return true;
}

/**
 * Run the finality check on one provisional burn and move it to `final` or `revoked` — revoked only
 * on positive evidence — or leave it provisional (marked stalled past the deadline). Idempotent and
 * fenced: every write happens in a transaction that re-reads the row and acts only on a row that is
 * still `recorded` + `provisional`.
 */
export async function finalizeBurn(deps: BurnFinalityDeps, burnId: string): Promise<FinalizeOutcome> {
  const now = deps.now ?? Date.now;
  const verify = deps.verify ?? verifyEvmPvtBurn;
  const ref = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const row = (await ref.get()).data() as Record<string, unknown> | undefined;
  if (burnFinalityOf(row) !== 'provisional' || !row) return 'skip';
  const chainId = CHAIN_IDS[String(row.chain)];
  const amount = typeof row.amount_atomic === 'string' && /^[0-9]+$/.test(row.amount_atomic) ? BigInt(row.amount_atomic) : 0n;
  const acceptedAt = numberField(row.accepted_at) || numberField(row.recorded_at);
  let v: TxVerificationResult;
  if (!chainId || amount <= 0n || typeof row.tx_hash !== 'string' || typeof row.burner_address !== 'string') {
    // A provisional row the verifier cannot even be asked about can never be proven final — nor
    // proven NOT final. It stays provisional, and stalls (alarmed) past the deadline.
    v = { ok: false, reason: 'burn_row_unverifiable' };
  } else {
    try {
      v = await verify({ chainId, txHash: row.tx_hash, expectedFrom: row.burner_address, expectedAmountWei: amount });
    } catch (err) {
      v = { ok: false, reason: `rpc_error: ${(err as Error).message}` };
    }
  }
  if (v.ok) {
    const done = await deps.db.runTransaction(async (txn) => {
      const cur = (await txn.get(ref)).data() as Record<string, unknown> | undefined;
      if (burnFinalityOf(cur) !== 'provisional' || !cur) return false;
      txn.set(ref, {
        ...withoutStall(cur, now()),
        finality: 'final',
        final_block_number: v.blockNumber ?? null,
        final_block_hash: v.blockHash ?? null,
        final_token_address: v.tokenAddress ?? null,
        finalized_at: now(),
      });
      return true;
    });
    return done ? 'final' : 'skip';
  }

  const ageMs = now() - acceptedAt;
  const kind = classifyFinalityVerdict(v);
  if (kind === 'disproof') {
    return (await revokeBurn(deps, burnId, v.reason ?? 'not_final')) ? 'revoked' : 'skip';
  }
  let unproven = v.reason ?? 'not_final';
  if (kind === 'not_found' && ageMs >= BURN_NOT_FOUND_REVOKE_AFTER_MS) {
    const proof = await tryProveDropped(deps, row);
    if (proof.dropped) {
      const reason = `${BURN_DROPPED_REASON}: block ${String(row.block_number)} is ${proof.canonicalHashAtHeight} at safe head ${proof.safeHeadNumber}`;
      return (await revokeBurn(deps, burnId, reason)) ? 'revoked' : 'skip';
    }
    unproven = `tx_not_found; ${proof.reason}`;
  }
  // Not evidence against the burn: it stands, and is retried on every sweep.
  if (ageMs < BURN_FINALITY_DEADLINE_MS) return 'pending';
  return (await markBurnStalled(deps, burnId, unproven)) ? 'stalled' : 'skip';
}

/**
 * Revoke one PROVISIONAL burn: the row becomes `status: 'revoked'` (so it can never be consumed or
 * read as a burn again), then every relay-held benefit it backs is revoked. Refuses a final burn.
 * Re-running on an already-revoked burn re-sweeps its benefits (idempotent).
 */
export async function revokeBurn(deps: BurnFinalityDeps, burnId: string, reason: string): Promise<boolean> {
  const now = deps.now ?? Date.now;
  const ref = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const state = await deps.db.runTransaction(async (txn) => {
    const cur = (await txn.get(ref)).data() as Record<string, unknown> | undefined;
    if (cur?.status === 'revoked') return 'already' as const;
    if (burnFinalityOf(cur) !== 'provisional' || !cur) return 'refused' as const;
    txn.set(ref, {
      ...withoutStall(cur, now()),
      status: 'revoked',
      verified: false,
      finality: 'failed',
      revoked_at: now(),
      revoke_reason: reason,
    });
    return 'revoked' as const;
  });
  if (state === 'refused') return false;
  if (state === 'revoked') {
    deps.log?.(`[burn-finality] revoked burn ${burnId}: ${reason}`);
    // Ops observability: a revocation is rare (a sequencer reorg, or an unprovable burn) — count it.
    bumpOpsCounter('burn.revoked');
  }
  await revokeBurnBenefits(deps, burnId);
  return true;
}

/** The revoke reason writes on a predecessor burn mined after the migration snapshot. */
export const POST_SNAPSHOT_PREDECESSOR_BURN_REASON = 'predecessor_burn_after_d486_snapshot';

export type PostSnapshotRevokeOutcome = 'revoked' | 'already_revoked' | 'not_applicable';

/**
 * The pure decision, shared by the revocation and the reconcile script's dry run: the block of a
 * predecessor-kernel burn mined strictly after `cutoffBlock` that matches this burn row exactly, or
 * `null` when the row is not one (any other chain, tx, status, token, block, burner or amount).
 */
export function postSnapshotPredecessorBurnBlock(
  row: Record<string, unknown> | undefined,
  receipt: ethers.TransactionReceipt,
  cutoffBlock: number = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK,
): number | null {
  if (!row || row.chain !== 'base') return null;
  if (typeof row.tx_hash !== 'string' || typeof row.burner_address !== 'string') return null;
  if (row.tx_hash.toLowerCase() !== String(receipt.hash).toLowerCase() || receipt.status !== 1) return null;
  const amount = typeof row.amount_atomic === 'string' && /^[0-9]+$/.test(row.amount_atomic) ? BigInt(row.amount_atomic) : 0n;
  const block = Number(receipt.blockNumber);
  if (amount <= 0n || !Number.isSafeInteger(block) || block <= cutoffBlock) return null;
  const onPredecessor = matchPvtBurnLog(
    receipt,
    [{ address: PREDECESSOR_PVT9_KERNEL_BASE, maxBlock: null }],
    row.burner_address,
    amount,
    { blockNumber: block, confirmations: 0 },
  );
  return onPredecessor.ok ? block : null;
}

/**
 * revoke a burn mined on the RETIRED kernel AFTER the migration snapshot, whether it is
 * provisional or FINAL. Every predecessor balance at the snapshot block was carried 1:1 to the
 * successor, so a later burn on the predecessor spent PVT its burner still holds on the successor: a
 * benefit it bought would be counted twice. The relay refuses such a burn at acceptance
 * (`getAcceptedPvtBurnTokensForChain`); this closes the window between the snapshot and that relay's
 * deploy, while the relay still accepted them.
 *
 * It is narrow by construction. The caller supplies the burn's receipt and this re-checks it: the
 * row's own tx, a successful receipt, a block STRICTLY after `cutoffBlock`, and a
 * `Transfer(burner, 0x0, amount)` log ON THE PREDECESSOR KERNEL for the row's burner and amount. A
 * burn on the successor, at or before the cutoff, or not matching its row is `not_applicable` and is
 * never touched. A revoked row stays consumed (its `burn_consumptions` marker is never removed), and
 * every relay-held benefit it backs is revoked through the same `revokeBurnBenefits` as.
 */
export async function revokePostSnapshotPredecessorBurn(
  deps: BurnFinalityDeps,
  burnId: string,
  receipt: ethers.TransactionReceipt,
  cutoffBlock: number = PREDECESSOR_PVT9_BURN_CUTOFF_BLOCK,
): Promise<PostSnapshotRevokeOutcome> {
  const now = deps.now ?? Date.now;
  const ref = deps.db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const row = (await ref.get()).data() as Record<string, unknown> | undefined;
  const block = postSnapshotPredecessorBurnBlock(row, receipt, cutoffBlock);
  if (block === null || !row) return 'not_applicable';

  const state = await deps.db.runTransaction(async (txn) => {
    const cur = (await txn.get(ref)).data() as Record<string, unknown> | undefined;
    if (!cur || cur.tx_hash !== row.tx_hash) return 'gone' as const;
    if (cur.status === 'revoked') return 'already' as const;
    if (cur.status !== 'recorded') return 'gone' as const;
    txn.set(ref, {
      ...withoutStall(cur, now()),
      status: 'revoked',
      verified: false,
      finality: 'failed',
      revoked_at: now(),
      revoke_reason: POST_SNAPSHOT_PREDECESSOR_BURN_REASON,
      revoked_predecessor_block: block,
    });
    return 'revoked' as const;
  });
  if (state === 'gone') return 'not_applicable';
  if (state === 'revoked') {
    deps.log?.(`[burn-finality] revoked burn ${burnId}: ${POST_SNAPSHOT_PREDECESSOR_BURN_REASON} (block ${block})`);
    bumpOpsCounter('burn.revoked');
  }
  await revokeBurnBenefits(deps, burnId);
  return state === 'revoked' ? 'revoked' : 'already_revoked';
}

interface RevokedBenefit {
  readonly collection: string;
  readonly id: string;
  readonly action: 'deleted' | 'hidden' | 'revoked' | 'reversed' | 'reopened' | 'marked';
}

/** Copy a benefit document into the revocation audit, then delete it (both idempotent). */
async function auditAndDelete(
  deps: BurnFinalityDeps,
  burnId: string,
  collection: string,
  id: string,
  out: RevokedBenefit[],
): Promise<void> {
  const ref = deps.db.collection(collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return;
  await deps.db.collection(BURN_REVOCATIONS_COLLECTION).doc(burnId)
    .collection('benefits').doc(`${collection}__${id}`)
    .set({ collection, id, action: 'deleted', data: snap.data() ?? null, revoked_at: (deps.now ?? Date.now)() });
  await ref.delete();
  out.push({ collection, id, action: 'deleted' });
}

async function recordAudit(deps: BurnFinalityDeps, burnId: string, b: RevokedBenefit, data: unknown): Promise<void> {
  await deps.db.collection(BURN_REVOCATIONS_COLLECTION).doc(burnId)
    .collection('benefits').doc(`${b.collection}__${b.id}`)
    .set({ ...b, data: data ?? null, revoked_at: (deps.now ?? Date.now)() });
}

async function idsWhere(deps: BurnFinalityDeps, collection: string, field: string, burnId: string): Promise<string[]> {
  const snap = await deps.db.collection(collection).where(field, '==', burnId).get();
  return snap.docs.map((d) => d.id);
}

/** Recompute a forum post's flag from what still stands: any flag doc, or any upheld challenge. */
async function recomputePostFlag(deps: BurnFinalityDeps, postId: string): Promise<void> {
  const postRef = deps.db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId);
  const [flags, challenges] = await Promise.all([
    postRef.collection('flags').limit(1).get(),
    deps.db.collection(COMMONS_COLLECTIONS.CHALLENGES).where('post_id', '==', postId).get(),
  ]);
  const upheld = challenges.docs.some((d) => (d.data() as { status?: unknown }).status === 'upheld');
  const post = await postRef.get();
  if (post.exists) await postRef.set({ is_flagged: !flags.empty || upheld }, { merge: true });
}

/**
 * Revoke EVERY relay-held benefit backed by `burnId`. Each step is idempotent, so a re-sweep only
 * catches what an earlier pass could not see. Every removed or changed document is copied to
 * `burn_revocations/{burn_id}/benefits` first. The burn's `burn_consumptions` marker is never
 * removed: a revoked burn stays consumed.
 */
export async function revokeBurnBenefits(deps: BurnFinalityDeps, burnId: string): Promise<RevokedBenefit[]> {
  const now = deps.now ?? Date.now;
  const out: RevokedBenefit[] = [];
  const db = deps.db;

  // 1. The benefit the burn bought directly — by its consumption marker, and by the documents keyed on it.
  //    Presentations (rail handshakes, talking passes, standing exports, thread gates), featured bids.
  await auditAndDelete(deps, burnId, COMMONS_PRESENTATIONS_COLLECTION, burnId, out);
  await auditAndDelete(deps, burnId, COMMONS_COLLECTIONS.FEATURED_PLACEMENTS, burnId, out);
  //    Name claims (the name becomes claimable again).
  for (const id of await idsWhere(deps, COMMONS_NAME_CLAIMS_COLLECTION, 'burn_id', burnId)) {
    await auditAndDelete(deps, burnId, COMMONS_NAME_CLAIMS_COLLECTION, id, out);
  }

  // 2. Benefits folded onto a handshake that burn backed: vouches, pledges, subscriptions.
  for (const collection of [COMMONS_BURN_VOUCHES_COLLECTION, COMMONS_PLEDGES_COLLECTION, COMMONS_SUBSCRIPTIONS_COLLECTION]) {
    for (const id of await idsWhere(deps, collection, 'backing_burn_id', burnId)) {
      await auditAndDelete(deps, burnId, collection, id, out);
    }
  }

  // 3. Challenge stakes: the challenge is withdrawn (its post's count and flag recomputed).
  for (const id of await idsWhere(deps, COMMONS_COLLECTIONS.CHALLENGES, 'stake_burn_id', burnId)) {
    const snap = await db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(id).get();
    if (!snap.exists) continue;
    const c = snap.data() as { post_id?: unknown };
    await auditAndDelete(deps, burnId, COMMONS_COLLECTIONS.CHALLENGES, id, out);
    if (typeof c.post_id === 'string') {
      const postRef = db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(c.post_id);
      await db.runTransaction(async (txn) => {
        const post = (await txn.get(postRef)).data() as { challenge_count?: unknown } | undefined;
        if (!post) return;
        txn.set(postRef, { challenge_count: Math.max(0, numberField(post.challenge_count) - 1) }, { merge: true });
      });
      await recomputePostFlag(deps, c.post_id);
    }
  }
  //    A challenge ANSWERED with this burn's presentation: the answer is withdrawn and the challenge
  //    is open again (its stake stays reserved), so it resolves on a presentation that stands.
  for (const id of await idsWhere(deps, COMMONS_COLLECTIONS.CHALLENGES, 'answer_burn_id', burnId)) {
    const ref = db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(id);
    const before = await db.runTransaction(async (txn) => {
      const cur = (await txn.get(ref)).data() as Record<string, unknown> | undefined;
      if (!cur || cur.status !== 'answered' || cur.answer_burn_id !== burnId) return null;
      const reopened: Record<string, unknown> = { ...cur, status: 'open', stake_status: 'reserved' };
      for (const k of ['resolution', 'resolved_at', 'resolution_summary', 'answer_pe_id', 'answer_burn_id', 'answer_claim', 'resolution_pe_id']) {
        delete reopened[k];
      }
      txn.set(ref, reopened);
      return cur;
    });
    if (before) {
      const b: RevokedBenefit = { collection: COMMONS_COLLECTIONS.CHALLENGES, id, action: 'reopened' };
      await recordAudit(deps, burnId, b, before);
      out.push(b);
    }
  }
  //    A challenge whose answer SEALED on this burn but has not settled yet (the answering request
  //    died after the seal): the burn sits only on the claim. The claim is withdrawn, so the challenge
  //    can never settle as answered on a revoked burn; the author may answer again inside the window,
  //    or it lapses. The sealed answer PE is never rewritten.
  for (const id of await idsWhere(deps, COMMONS_COLLECTIONS.CHALLENGES, 'answer_claim.answer_burn_id', burnId)) {
    const ref = db.collection(COMMONS_COLLECTIONS.CHALLENGES).doc(id);
    const before = await db.runTransaction(async (txn) => {
      const cur = (await txn.get(ref)).data() as Record<string, unknown> | undefined;
      const claim = cur?.answer_claim as { answer_burn_id?: unknown } | null | undefined;
      if (!cur || cur.status !== 'open' || !claim || claim.answer_burn_id !== burnId) return null;
      txn.update(ref, { answer_claim: null });
      return cur;
    });
    if (before) {
      const b: RevokedBenefit = { collection: COMMONS_COLLECTIONS.CHALLENGES, id, action: 'reopened' };
      await recordAudit(deps, burnId, b, before);
      out.push(b);
    }
  }

  // 4. Presentation requests answered with this burn: the requester sees the burn was revoked.
  for (const id of await idsWhere(deps, PRESENTATION_REQUESTS_COLLECTION, 'burn_id', burnId)) {
    const ref = db.collection(PRESENTATION_REQUESTS_COLLECTION).doc(id);
    const snap = await ref.get();
    const cur = snap.data() as Record<string, unknown> | undefined;
    if (!cur || cur.burn_revoked === true) continue;
    await ref.set({ burn_revoked: true, burn_revoked_at: now(), verdict: 'invalid' }, { merge: true });
    const b: RevokedBenefit = { collection: PRESENTATION_REQUESTS_COLLECTION, id, action: 'marked' };
    await recordAudit(deps, burnId, b, cur);
    out.push(b);
  }

  // 5. Threads opened cold on this burn alone: no longer a relationship.
  for (const id of await idsWhere(deps, COMMONS_COLLECTIONS.THREADS, 'opened_under_burn_id', burnId)) {
    const ref = db.collection(COMMONS_COLLECTIONS.THREADS).doc(id);
    const cur = (await ref.get()).data() as Record<string, unknown> | undefined;
    if (!cur || cur.revoked === true) continue;
    await ref.set({ revoked: true, revoked_at: now() }, { merge: true });
    const b: RevokedBenefit = { collection: COMMONS_COLLECTIONS.THREADS, id, action: 'revoked' };
    await recordAudit(deps, burnId, b, { opened_under_burn_id: burnId });
    out.push(b);
  }

  // 6. The talking pass: its budget ledger is closed, and the speech made under it is revoked. Its
  //    PEs are sealed and never rewritten; they mint nothing (the claim inlet registers a speech PE
  //    only under a FINAL window burn — `speechPeWindowBurnFinal`).
  const budgetRef = db.collection(SPEECH_WINDOW_BUDGETS_COLLECTION).doc(burnId);
  if ((await budgetRef.get()).exists) await budgetRef.set({ revoked: true, revoked_at: now() }, { merge: true });
  //    PE METER: every speech act made under the pass is found through the speech-window record
  //    `generatePE` wrote with it (`speech_window_acts_v1`, whatever the act later sealed as —
  //    record_only included), which also carries the entity ids its revocation needs. The relay
  //    keeps no PE to read them from. The budget reservation (a mintable act) and the ordinary-accrual
  //    intake (a pre-meter act still in flight) still name acts under the pass; such an act with no
  //    speech-window record has no entity ids the relay can read — it mints nothing (the claim inlet
  //    requires a FINAL window burn) and is counted as `unresolved` on the revocation record.
  const [speechActs, reservations, intakes] = await Promise.all([
    db.collection(SPEECH_WINDOW_ACTS_COLLECTION).where('burn_id', '==', burnId).get(),
    db.collection(SPEECH_WINDOW_RESERVATIONS_COLLECTION).where('burn_id', '==', burnId).get(),
    db.collection(ORDINARY_ACCRUAL_INTAKE_COLLECTION).where('accrual_params.speechWindow.burnId', '==', burnId).get(),
  ]);
  const speech = new Map<string, { actionType: string | null; refs: SpeechActRefs | null }>();
  for (const r of speechActs.docs) {
    const act = readSpeechWindowAct(r.data() as Record<string, unknown>);
    if (act !== null && act.burn_id === burnId) speech.set(act.pe_id, { actionType: act.action_type, refs: act.refs });
  }
  const noteOnly = (peId: unknown, fallbackId: string, actionType: unknown) => {
    const id = typeof peId === 'string' ? peId : fallbackId;
    if (!speech.has(id)) speech.set(id, { actionType: typeof actionType === 'string' ? actionType : null, refs: null });
  };
  for (const r of reservations.docs) {
    const res = r.data() as { pe_id?: unknown; action_type?: unknown };
    noteOnly(res.pe_id, r.id, res.action_type);
  }
  for (const r of intakes.docs) {
    const row = r.data() as { pe_id?: unknown; action_type?: unknown };
    noteOnly(row.pe_id, r.id, row.action_type);
  }
  let unresolved = 0;
  for (const [peId, act] of speech) {
    if (act.refs === null || act.actionType === null) {
      unresolved += 1;
      continue;
    }
    await revokeSpeechAct(deps, burnId, peId, act.actionType, { ...act.refs }, out);
  }

  await db.collection(BURN_REVOCATIONS_COLLECTION).doc(burnId).set({
    burn_id: burnId,
    last_swept_at: now(),
    benefit_count: out.length,
    speech_acts_unresolved: unresolved,
  }, { merge: true });
  // The burn's `burn_consumptions` marker is left in place: a revoked burn stays consumed.
  return out;
}

/** Revoke one speech act made under a revoked talking pass. */
async function revokeSpeechAct(
  deps: BurnFinalityDeps,
  burnId: string,
  peId: string,
  actionType: string,
  meta: Record<string, unknown>,
  out: RevokedBenefit[],
): Promise<void> {
  const db = deps.db;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const hide = async (collection: string, id: string | null, onlyIfStatus?: string): Promise<void> => {
    if (!id) return;
    const ref = db.collection(collection).doc(id);
    const cur = (await ref.get()).data() as Record<string, unknown> | undefined;
    if (!cur || cur.public_visibility === HIDDEN_REVOKED_BURN) return;
    if (onlyIfStatus && cur.status !== onlyIfStatus) return;
    await ref.set({ public_visibility: HIDDEN_REVOKED_BURN }, { merge: true });
    const b: RevokedBenefit = { collection, id, action: 'hidden' };
    await recordAudit(deps, burnId, b, { public_visibility: cur.public_visibility ?? null });
    out.push(b);
  };

  switch (actionType) {
    case 'commons_post_created':
    case 'commons_post_replied':
      await hide(COMMONS_COLLECTIONS.FORUM_POSTS, str(meta.post_id));
      return;
    case 'want_posted':
      await hide(COMMONS_WANTS_COLLECTION, str(meta.want_id), 'open');
      return;
    case 'human_job_posted':
      await hide(COMMONS_COLLECTIONS.HUMAN_JOBS, str(meta.job_id), 'open');
      return;
    case 'commons_vote_cast': {
      const voteId = str(meta.vote_id);
      const postId = str(meta.post_id);
      if (!voteId || !postId) return;
      const voteRef = db.collection(COMMONS_COLLECTIONS.VOTES).doc(voteId);
      const postRef = db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId);
      // Reverse the vote exactly once: the counters move only in the transaction that deletes it.
      const vote = await db.runTransaction(async (txn) => {
        const [v, p] = await Promise.all([txn.get(voteRef), txn.get(postRef)]);
        const cur = v.data() as { vote_type?: unknown; pe_id?: unknown } | undefined;
        // Only the vote THIS PE cast: the id is deterministic per (post, voter), so a later vote under
        // another pass sits at the same id and must never be reversed by this burn's re-sweep.
        if (!cur || cur.pe_id !== peId) return null;
        txn.delete(voteRef);
        const post = p.data() as Record<string, unknown> | undefined;
        if (post) {
          const up = cur.vote_type === 'upvote';
          txn.set(postRef, {
            ...(up
              ? { upvotes: Math.max(0, numberField(post.upvotes) - 1) }
              : { downvotes: Math.max(0, numberField(post.downvotes) - 1) }),
            score: numberField(post.score) + (up ? -1 : 1),
          }, { merge: true });
        }
        return { vote: cur, author: post?.author_wallet_id };
      });
      if (!vote) return;
      if (vote.vote.vote_type === 'upvote' && typeof vote.author === 'string') {
        const profileRef = db.collection(COMMONS_COLLECTIONS.PROFILES).doc(vote.author);
        await db.runTransaction(async (txn) => {
          const prof = (await txn.get(profileRef)).data() as { forum_upvotes_received?: unknown } | undefined;
          if (!prof) return;
          txn.set(profileRef, { forum_upvotes_received: Math.max(0, numberField(prof.forum_upvotes_received) - 1) }, { merge: true });
        });
      }
      const b: RevokedBenefit = { collection: COMMONS_COLLECTIONS.VOTES, id: voteId, action: 'reversed' };
      await recordAudit(deps, burnId, b, vote.vote);
      out.push(b);
      return;
    }
    case 'commons_post_flagged': {
      const postId = str(meta.post_id);
      if (!postId) return;
      // The flag this PE wrote (one per wallet per post, carrying its pe_id).
      const flagsSnap = await db.collection(COMMONS_COLLECTIONS.FORUM_POSTS).doc(postId).collection('flags').get();
      const flag = flagsSnap.docs.find((d) => (d.data() as { pe_id?: unknown }).pe_id === peId);
      if (!flag) return;
      await recordAudit(deps, burnId, { collection: `${COMMONS_COLLECTIONS.FORUM_POSTS}/${postId}/flags`, id: flag.id, action: 'deleted' }, flag.data());
      await flag.ref.delete();
      out.push({ collection: `${COMMONS_COLLECTIONS.FORUM_POSTS}/${postId}/flags`, id: flag.id, action: 'deleted' });
      await recomputePostFlag(deps, postId);
      return;
    }
    default:
      // commons_thread_message: end-to-end ciphertext already delivered to the counterparty — the
      // message stays (and mints nothing). commons_claim_challenged: the challenge is its stake's
      // benefit, withdrawn when THAT burn is revoked (and its PE mints only when both the pass and the
      // stake are final — `speechPeWindowBurnFinal`). commons_challenge_answered: the answer rides its
      // own presentation burn. Anything else carries no standing state.
      return;
  }
}

export interface BurnFinalitySweepResult {
  finalized: number;
  revoked: number;
  pending: number;
  /** Burns this pass left stalled (checked and still unproven past the deadline, or not reached). */
  stalled: number;
  reswept: number;
  errors: number;
  /** `system_status/burn_finality.alarm`: at least one provisional burn is stalled. */
  alarm: boolean;
}

interface ScannedBurn {
  readonly id: string;
  readonly stalled: boolean;
  readonly lastCheckedAt: number;
  readonly acceptedAt: number;
}

/**
 * Every provisional burn, in document-id pages (equality + `__name__` order: the single-field index,
 * no composite). Bounded by {@link BURN_FINALITY_SCAN_LIMIT}; `capped` says the bound was hit.
 */
async function scanProvisionalBurns(db: Firestore): Promise<{ rows: ScannedBurn[]; capped: boolean }> {
  const rows: ScannedBurn[] = [];
  let after: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection(PVT_BURN_RECORDS_COLLECTION)
      .where('finality', '==', 'provisional')
      .orderBy(FieldPath.documentId())
      .limit(BURN_FINALITY_SCAN_PAGE);
    if (after) q = q.startAfter(after);
    const page = await q.get();
    for (const doc of page.docs) {
      const d = doc.data() as Record<string, unknown>;
      rows.push({
        id: doc.id,
        stalled: d.finality_stalled === true,
        lastCheckedAt: numberField(d.finality_last_checked_at),
        acceptedAt: numberField(d.accepted_at) || numberField(d.recorded_at),
      });
    }
    if (rows.length >= BURN_FINALITY_SCAN_LIMIT) return { rows, capped: true };
    if (page.docs.length < BURN_FINALITY_SCAN_PAGE) return { rows, capped: false };
    after = page.docs[page.docs.length - 1];
  }
}

/**
 * The guarantee: finalize provisional burns (bounded per pass), keep the burn-finality ops alarm, and
 * re-sweep the benefits of burns revoked within {@link BURN_REVOCATION_RESWEEP_MS}. Runs on the
 * existing 5-minute outbox job.
 *
 * Fresh burns are checked before stalled ones, and stalled ones least-recently-checked first, so a
 * set of burns that stay stalled through a long outage can never starve a new burn of its check.
 */
export async function sweepBurnFinality(
  deps: BurnFinalityDeps,
  opts: { limit?: number } = {},
): Promise<BurnFinalitySweepResult> {
  const now = deps.now ?? Date.now;
  const limit = opts.limit ?? BURN_FINALITY_SWEEP_LIMIT;
  const counts: BurnFinalitySweepResult = {
    finalized: 0, revoked: 0, pending: 0, stalled: 0, reswept: 0, errors: 0, alarm: false,
  };
  const { rows, capped } = await scanProvisionalBurns(deps.db);
  const order = [
    ...rows.filter((r) => !r.stalled),
    ...rows.filter((r) => r.stalled).sort((a, b) => a.lastCheckedAt - b.lastCheckedAt),
  ];
  const stalledAfter = new Map<string, number>(); // burn id → accepted_at, for the alarm
  for (const r of rows) if (r.stalled) stalledAfter.set(r.id, r.acceptedAt);
  for (const r of order.slice(0, limit)) {
    try {
      const outcome = await finalizeBurn(deps, r.id);
      if (outcome === 'final') counts.finalized += 1;
      else if (outcome === 'revoked') counts.revoked += 1;
      else if (outcome === 'pending') counts.pending += 1;
      // `skip` = no longer provisional (finalized or revoked elsewhere); `pending` = inside the deadline.
      if (outcome === 'stalled') stalledAfter.set(r.id, r.acceptedAt);
      else stalledAfter.delete(r.id);
    } catch (err) {
      counts.errors += 1;
      deps.log?.(`[burn-finality] finalize ${r.id} failed: ${(err as Error).message}`);
    }
  }
  counts.stalled = stalledAfter.size;
  counts.alarm = stalledAfter.size > 0;
  try {
    await writeBurnFinalityStatus(deps, stalledAfter, capped);
  } catch (err) {
    counts.errors += 1;
    deps.log?.(`[burn-finality] status write failed: ${(err as Error).message}`);
  }
  const recent = await deps.db.collection(PVT_BURN_RECORDS_COLLECTION)
    .where('revoked_at', '>=', now() - BURN_REVOCATION_RESWEEP_MS)
    .get();
  for (const doc of recent.docs) {
    try {
      await revokeBurnBenefits(deps, doc.id);
      counts.reswept += 1;
    } catch (err) {
      counts.errors += 1;
      deps.log?.(`[burn-finality] re-sweep ${doc.id} failed: ${(err as Error).message}`);
    }
  }
  return counts;
}

/**
 * `system_status/burn_finality` — the same `{alarm, verdict}` shape as the monetary-activation and
 * Genesis-persistence status docs, so `runSystemStatusAlarmCheck` emails + pushes the operator while
 * any provisional burn is stalled, and the alarm clears itself when none is.
 */
async function writeBurnFinalityStatus(
  deps: BurnFinalityDeps,
  stalled: ReadonlyMap<string, number>,
  scanCapped: boolean,
): Promise<void> {
  const now = deps.now ?? Date.now;
  const alarm = stalled.size > 0;
  const oldest = alarm ? Math.min(...stalled.values()) : null;
  await deps.db.collection(BURN_FINALITY_STATUS_COLLECTION).doc(BURN_FINALITY_STATUS_DOCUMENT).set({
    alarm,
    verdict: alarm ? BURN_FINALITY_STALLED_VERDICT : 'ok',
    stalled_count: stalled.size,
    oldest_stalled_accepted_at_ms: oldest,
    stalled_burn_ids: [...stalled.keys()].slice(0, 10),
    scan_capped: scanCapped,
    updated_at_ms: now(),
  });
}

/**
 * Best effort, right after a burn is accepted: wait for the 12th block, then finalize. Never awaited
 * by the request; never throws. The sweep is the guarantee when this does not complete.
 */
export function scheduleBurnFinalization(deps: BurnFinalityDeps, burnId: string, txHash: string): void {
  const now = deps.now ?? Date.now;
  void (async () => {
    try {
      await waitForFinalityWindow(txHash, {
        deadlineAtMs: now() + BURN_INPROCESS_FINALIZE_WAIT_MS,
        probe: deps.probe,
        sleep: deps.sleep,
        now,
      });
      await finalizeBurn(deps, burnId);
    } catch (err) {
      deps.log?.(`[burn-finality] in-process finalize ${burnId} deferred to the sweep: ${(err as Error).message}`);
    }
  })();
}
