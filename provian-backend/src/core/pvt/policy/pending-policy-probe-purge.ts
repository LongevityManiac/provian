/**
 * Purge a LIVE-PROOF probe type from the pending-policy queue.
 *
 * A never-seen-type live proof (/ / style: a fresh test agent
 * sends an action type nothing has ever named) necessarily creates a
 * pending-policy queue row. That row is test residue, not a proposal: REJECTING
 * it would publish it on /proposals as a declined proposal, and leaving it makes
 * the queue re-alert the operator every day forever. So a probe row is PURGED —
 * the queue row, its per-PE observation rows, and any operator ruling sidecar
 * are deleted. Nothing here touches a sealed PE, an accrual, a claim, or any
 * pricing state; the queue never carried mint authority.
 *
 * Every never-seen-type live proof wraps its probe in `withPendingPolicyProbe`
 * (or calls `purgePendingPolicyProbe` in its own `finally`), so it leaves
 * nothing in production. `scripts/purge-pending-policy-probe.ts` is the
 * operator CLI for residue a proof already left behind.
 *
 * Refusals (a probe purge is never a way to erase a real type's record):
 * - the type is a NAMED row of the matrix (`probe_is_named_matrix_type`);
 * - the type has a prospective action-policy pointer (`probe_has_policy_pointer`);
 * - the queue row is not `pending_policy` (`probe_queue_row_not_pending`) — a
 * rejected row carries the gate's rejection pointer.
 */

import type { Firestore } from 'firebase-admin/firestore';
import {
  ACTION_POLICY_COLLECTION,
  PENDING_POLICY_COLLECTION,
  PENDING_POLICY_OBSERVATION_COLLECTION,
  actionPolicyDocumentId,
  isValidPolicyActionType,
  type PendingPolicyQueueDocument,
} from './pending-policy-queue';
import { POLICY_RULINGS_COLLECTION } from './policy-rulings';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';

const NAMED_MATRIX_TYPES: ReadonlySet<string> = new Set(
  PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type),
);

/** Firestore caps a batch at 500 writes; observation rows are deleted in chunks. */
const DELETE_CHUNK = 400;

export interface ProbePurgeResult {
  readonly action_type: string;
  readonly queue_row_deleted: boolean;
  readonly observations_deleted: number;
  readonly ruling_deleted: boolean;
}

export async function purgePendingPolicyProbe(
  db: Firestore,
  actionType: string,
  options: { dryRun?: boolean } = {},
): Promise<ProbePurgeResult> {
  if (!actionType.trim() || !isValidPolicyActionType(actionType)) {
    throw new Error('action_type_invalid');
  }
  if (NAMED_MATRIX_TYPES.has(actionType)) throw new Error('probe_is_named_matrix_type');
  const id = actionPolicyDocumentId(actionType);
  const queueRef = db.collection(PENDING_POLICY_COLLECTION).doc(id);
  const rulingRef = db.collection(POLICY_RULINGS_COLLECTION).doc(id);
  const [queueSnap, pointerSnap, rulingSnap, observations] = await Promise.all([
    queueRef.get(),
    db.collection(ACTION_POLICY_COLLECTION).doc(id).get(),
    rulingRef.get(),
    db.collection(PENDING_POLICY_OBSERVATION_COLLECTION)
      .where('action_type', '==', actionType)
      .get(),
  ]);
  if (pointerSnap.exists) throw new Error('probe_has_policy_pointer');
  if (queueSnap.exists) {
    const row = queueSnap.data() as PendingPolicyQueueDocument;
    if (row.action_type !== actionType) throw new Error('probe_queue_row_mismatch');
    if (row.policy_review_state !== 'pending_policy') throw new Error('probe_queue_row_not_pending');
  }
  const result: ProbePurgeResult = {
    action_type: actionType,
    queue_row_deleted: queueSnap.exists,
    observations_deleted: observations.size,
    ruling_deleted: rulingSnap.exists,
  };
  if (options.dryRun) return result;

  // Queue row FIRST, re-checked in a transaction (state AND pointer): a type a
  // classifier closed or pointed in the meantime throws here, before any
  // observation row is touched. Observations go only after this commits.
  const pointerRef = db.collection(ACTION_POLICY_COLLECTION).doc(id);
  await db.runTransaction(async (txn) => {
    const [fresh, freshPointer] = await Promise.all([txn.get(queueRef), txn.get(pointerRef)]);
    if (freshPointer.exists) throw new Error('probe_has_policy_pointer');
    if (fresh.exists) {
      const row = fresh.data() as PendingPolicyQueueDocument;
      if (row.policy_review_state !== 'pending_policy') throw new Error('probe_queue_row_not_pending');
      txn.delete(queueRef);
    }
    if (rulingSnap.exists) txn.delete(rulingRef);
  });
  for (let i = 0; i < observations.docs.length; i += DELETE_CHUNK) {
    const batch = db.batch();
    for (const doc of observations.docs.slice(i, i + DELETE_CHUNK)) batch.delete(doc.ref);
    await batch.commit();
  }
  return result;
}

/**
 * Run a never-seen-type live proof and purge its probe row however the proof
 * ends. The proof's own result (or error) is returned (or rethrown) unchanged;
 * a purge failure after a successful proof is thrown, so residue is never silent.
 */
export async function withPendingPolicyProbe<T>(
  db: Firestore,
  actionType: string,
  proof: () => Promise<T>,
): Promise<T> {
  if (NAMED_MATRIX_TYPES.has(actionType)) throw new Error('probe_is_named_matrix_type');
  let proofError: unknown = null;
  let value: T | undefined;
  try {
    value = await proof();
  } catch (error) {
    proofError = error;
  }
  try {
    await purgePendingPolicyProbe(db, actionType);
  } catch (purgeError) {
    if (proofError === null) throw purgeError;
    console.error(`[probe-purge] ${actionType} purge failed after a failed proof:`, purgeError);
  }
  if (proofError !== null) throw proofError;
  return value as T;
}
