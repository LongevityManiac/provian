/**
 * (PENDING-POLICY QUEUE run,):
 * - a type's pending-policy queue row resolves when the type lands in the signed matrix
 * (served code + `system_status/monetary_activation.digest_match`);
 * - a live-proof probe row is PURGED (never rejected) and the proof purges its own row.
 *
 * Every positive path carries its RED control: digest mismatch resolves nothing, an unnamed
 * type still alerts, a named / rejected / pointer-backed type refuses to purge.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  ACTION_POLICY_AUDIT_COLLECTION,
  ACTION_POLICY_COLLECTION,
  PENDING_POLICY_COLLECTION,
  PENDING_POLICY_OBSERVATION_COLLECTION,
  PENDING_POLICY_OVERDUE_MS,
  actionPolicyDocumentId,
  getPendingPolicyAction,
  observePendingPolicyAction,
  rejectPendingPolicyAction,
  resolvePendingPolicyActionBySignedMatrix,
  type PendingPolicyAlertMessage,
} from './pending-policy-queue';
import {
  landedRowResolver,
  resolveQueueRowsLandedInSignedMatrix,
  signedMatrixNamedRows,
} from './action-type-reconciler';
import { purgePendingPolicyProbe, withPendingPolicyProbe } from './pending-policy-probe-purge';
import { POLICY_RULINGS_COLLECTION } from './policy-rulings';
import { MONETARY_STATUS_COLLECTION, MONETARY_STATUS_DOCUMENT } from './monetary-activation-status';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './proposed-action-policy';

const NAMED = 'human_job_payment_released';
const NAMED_TWO = 'commons_post_replied';
const PROBE = 'd543_never_seen_probe_1791000000000';

function makeDb(): Firestore {
  return createFakeFirestore() as unknown as Firestore;
}

async function setDigestMatch(db: Firestore, value: boolean): Promise<void> {
  await db.collection(MONETARY_STATUS_COLLECTION).doc(MONETARY_STATUS_DOCUMENT).set({ digest_match: value });
}

function recordingSender(): {
  sent: PendingPolicyAlertMessage[];
  sender: (m: PendingPolicyAlertMessage) => Promise<{ delivered: boolean }>;
} {
  const sent: PendingPolicyAlertMessage[] = [];
  return { sent, sender: async (m) => { sent.push(m); return { delivered: true }; } };
}

async function queue(db: Firestore, actionType: string, peId: string, now = 0): Promise<void> {
  await observePendingPolicyAction(
    db,
    { actionType, peId, integrationSource: 'device_pe_submit', now },
    async () => ({ delivered: true }),
  );
}

describe('the named types this run closes are named rows of the signed matrix', () => {
  it('human_job_payment_released, human_approval and commons_post_replied are matrix rows; the probe is not', () => {
    const named = new Set(PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type));
    for (const t of [NAMED, NAMED_TWO, 'human_approval']) expect(named.has(t)).toBe(true);
    expect(named.has(PROBE)).toBe(false);
  });
});

describe('resolveQueueRowsLandedInSignedMatrix (hourly sweep)', () => {
  it('resolves every pending row whose type is a named matrix row, and nothing else', async () => {
    const db = makeDb();
    await queue(db, NAMED, 'pe_1');
    await queue(db, NAMED_TWO, 'pe_2');
    await queue(db, PROBE, 'pe_3');
    await setDigestMatch(db, true);

    const result = await resolveQueueRowsLandedInSignedMatrix(db, 5_000);
    expect(result.digest_match).toBe(true);
    expect([...result.resolved].sort()).toEqual([NAMED_TWO, NAMED].sort());

    const row = await getPendingPolicyAction(db, NAMED);
    expect(row).toMatchObject({
      policy_review_state: 'resolved_signed_matrix',
      resolved_at: 5_000,
      resolved_by: 'signed_matrix',
      resolved_matrix_mint_disposition: 'record_only',
      resolved_matrix_reason_code: 'SETTLEMENT_SIGNAL_APPLIES_TO_TARGET',
    });
    expect((await getPendingPolicyAction(db, PROBE))?.policy_review_state).toBe('pending_policy');
    const audit = await db.collection(ACTION_POLICY_AUDIT_COLLECTION)
      .where('event', '==', 'action_policy_resolved_by_signed_matrix').get();
    expect(audit.size).toBe(2);

    // Idempotent: a second sweep moves nothing.
    expect((await resolveQueueRowsLandedInSignedMatrix(db, 6_000)).resolved).toEqual([]);
  });

  it('RED: while served code and signed activation disagree, nothing has landed', async () => {
    const db = makeDb();
    await queue(db, NAMED, 'pe_1');
    await setDigestMatch(db, false);
    const result = await resolveQueueRowsLandedInSignedMatrix(db, 5_000);
    expect(result).toEqual({ digest_match: false, examined: 0, resolved: [] });
    expect((await getPendingPolicyAction(db, NAMED))?.policy_review_state).toBe('pending_policy');
    expect(await signedMatrixNamedRows(db)).toBeNull();
  });

  it('RED: a missing status document is not a match', async () => {
    const db = makeDb();
    await queue(db, NAMED, 'pe_1');
    expect((await resolveQueueRowsLandedInSignedMatrix(db, 5_000)).digest_match).toBe(false);
  });

  it('never reopens or overwrites a rejected row', async () => {
    const db = makeDb();
    await queue(db, NAMED, 'pe_1', 1_000);
    await rejectPendingPolicyAction(db, {
      actionType: NAMED,
      reasonCode: 'duplicate_of_existing_type',
      effectivePolicyVersion: 'v-test',
      effectiveAt: 3_000,
      operatorId: 'operator:test',
      now: 2_000,
    });
    expect(await resolvePendingPolicyActionBySignedMatrix(db, {
      actionType: NAMED, matrixMintDisposition: 'record_only', matrixReasonCode: 'X', now: 4_000,
    })).toBe(false);
    expect((await getPendingPolicyAction(db, NAMED))?.policy_review_state).toBe('rejected');
  });
});

describe('purgePendingPolicyProbe / withPendingPolicyProbe', () => {
  it('deletes the probe queue row, every observation row and its ruling — nothing else', async () => {
    const db = makeDb();
    await queue(db, PROBE, 'pe_a');
    await queue(db, PROBE, 'pe_b');
    await queue(db, NAMED, 'pe_c');
    await db.collection(POLICY_RULINGS_COLLECTION).doc(actionPolicyDocumentId(PROBE))
      .set({ action_type: PROBE, ruling: 'declined' });

    const dry = await purgePendingPolicyProbe(db, PROBE, { dryRun: true });
    expect(dry).toEqual({ action_type: PROBE, queue_row_deleted: true, observations_deleted: 2, ruling_deleted: true });
    expect(await getPendingPolicyAction(db, PROBE)).not.toBeNull();

    const done = await purgePendingPolicyProbe(db, PROBE);
    expect(done.observations_deleted).toBe(2);
    expect(await getPendingPolicyAction(db, PROBE)).toBeNull();
    const obs = await db.collection(PENDING_POLICY_OBSERVATION_COLLECTION).where('action_type', '==', PROBE).get();
    expect(obs.size).toBe(0);
    expect((await db.collection(POLICY_RULINGS_COLLECTION).doc(actionPolicyDocumentId(PROBE)).get()).exists).toBe(false);
    // The other type's row and observation are untouched.
    expect(await getPendingPolicyAction(db, NAMED)).not.toBeNull();
    const other = await db.collection(PENDING_POLICY_OBSERVATION_COLLECTION).where('action_type', '==', NAMED).get();
    expect(other.size).toBe(1);
  });

  it('RED: refuses a named matrix type', async () => {
    const db = makeDb();
    await queue(db, NAMED, 'pe_1');
    await expect(purgePendingPolicyProbe(db, NAMED)).rejects.toThrow('probe_is_named_matrix_type');
    expect(await getPendingPolicyAction(db, NAMED)).not.toBeNull();
  });

  it('RED: refuses a rejected row (it carries the gate\'s rejection pointer)', async () => {
    const db = makeDb();
    await queue(db, PROBE, 'pe_1', 1_000);
    await rejectPendingPolicyAction(db, {
      actionType: PROBE,
      reasonCode: 'duplicate_of_existing_type',
      effectivePolicyVersion: 'v-test',
      effectiveAt: 3_000,
      operatorId: 'operator:test',
      now: 2_000,
    });
    await expect(purgePendingPolicyProbe(db, PROBE)).rejects.toThrow('probe_queue_row_not_pending');
    expect(await getPendingPolicyAction(db, PROBE)).not.toBeNull();
  });

  it('RED: refuses a type with a prospective policy pointer', async () => {
    const db = makeDb();
    await queue(db, PROBE, 'pe_1');
    await db.collection(ACTION_POLICY_COLLECTION).doc(actionPolicyDocumentId(PROBE)).set({ action_type: PROBE });
    await expect(purgePendingPolicyProbe(db, PROBE)).rejects.toThrow('probe_has_policy_pointer');
    expect((await db.collection(PENDING_POLICY_COLLECTION).doc(actionPolicyDocumentId(PROBE)).get()).exists).toBe(true);
  });

  it('RED: a pointer written after the first read refuses the purge with every observation row kept', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    await queue(db, PROBE, 'pe_1');
    await queue(db, PROBE, 'pe_2');
    // Simulate a classifier committing between the purge's initial reads and its transaction.
    const realRunTransaction = db.runTransaction.bind(db);
    (db as unknown as { runTransaction: typeof db.runTransaction }).runTransaction = (async (fn: Parameters<typeof db.runTransaction>[0]) => {
      await db.collection(ACTION_POLICY_COLLECTION).doc(actionPolicyDocumentId(PROBE)).set({ action_type: PROBE });
      return realRunTransaction(fn);
    }) as typeof db.runTransaction;
    await expect(purgePendingPolicyProbe(db, PROBE)).rejects.toThrow('probe_has_policy_pointer');
    const obs = await db.collection(PENDING_POLICY_OBSERVATION_COLLECTION).where('action_type', '==', PROBE).get();
    expect(obs.size).toBe(2);
    expect(await getPendingPolicyAction(db, PROBE)).not.toBeNull();
  });

  it('a proof wrapped in withPendingPolicyProbe leaves no row, whether it succeeds or fails', async () => {
    const db = makeDb();
    const value = await withPendingPolicyProbe(db, PROBE, async () => {
      await queue(db, PROBE, 'pe_ok');
      return 'proved';
    });
    expect(value).toBe('proved');
    expect(await getPendingPolicyAction(db, PROBE)).toBeNull();

    await expect(withPendingPolicyProbe(db, PROBE, async () => {
      await queue(db, PROBE, 'pe_fail');
      throw new Error('proof_failed');
    })).rejects.toThrow('proof_failed');
    expect(await getPendingPolicyAction(db, PROBE)).toBeNull();
  });

  it('RED: withPendingPolicyProbe refuses to wrap a named matrix type', async () => {
    const db = makeDb();
    let ran = false;
    await expect(withPendingPolicyProbe(db, NAMED, async () => { ran = true; })).rejects.toThrow('probe_is_named_matrix_type');
    expect(ran).toBe(false);
  });
});
