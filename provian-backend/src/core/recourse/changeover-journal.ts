import { randomUUID } from 'crypto';
import { Transaction, keccak256, sha256, toUtf8Bytes } from 'ethers';
import type { Firestore, DocumentSnapshot } from 'firebase-admin/firestore';
import {
  acquireSignerLease, releaseSignerLease, listAllUnresolvedBatches,
  SETTLEMENT_SIGNER_LEASES_COLLECTION, SETTLEMENT_CYCLES_COLLECTION, type SettlementDb,
} from '../pvt/wp4/durable-settlement-store';

export const CHANGEOVER_STAGES = 'recourse_changeover_stages_v1';
export const CHANGEOVER_ATTEMPTS = 'recourse_changeover_attempts_v1';
export interface ChangeoverStep {
  readonly from: string; readonly to?: string; readonly data: string; readonly value: '0';
  readonly nonce?: number; readonly address?: string;
}
export interface ChangeoverAttempt {
  readonly identity: string; readonly from: string; readonly nonce: number;
  readonly raw: string | null; readonly hash: string | null;
}
export interface ChangeoverJournal {
  readonly version: 1; readonly stageDigest: string;
  readonly attempts: Readonly<Record<string, ChangeoverAttempt>>; readonly completed: boolean;
}
export type ChangeoverFinality = (raw: string) => Promise<{ hash: string; status: number } | null>;
export interface DurableChangeoverJournal {
  readonly stageDigest: string;
  read(): ChangeoverJournal;
  assertLease(expectedDigest?: string): Promise<void>;
  persist(next: ChangeoverJournal): Promise<void>;
  complete(finalized: ChangeoverFinality): Promise<void>;
  release(): Promise<void>;
}
const hash = (value: unknown): string => sha256(toUtf8Bytes(JSON.stringify(value)));
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw Error(`changeover_journal_${code}`);
}
function identity(step: ChangeoverStep): string {
  return keccak256(Transaction.from({ type: 2, chainId: 8453, nonce: 0, to: step.to ?? null,
    value: 0, data: step.data, gasLimit: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 }).unsignedSerialized);
}
function validateAttempt(attempt: ChangeoverAttempt, step: ChangeoverStep): void {
  requireValue(attempt && attempt.from === step.from && attempt.identity === identity(step)
    && Number.isSafeInteger(attempt.nonce) && attempt.nonce >= 0
    && (step.nonce === undefined || attempt.nonce === step.nonce), 'attempt_binding');
  requireValue((attempt.raw === null) === (attempt.hash === null), 'attempt_binding');
  if (attempt.raw !== null) {
    const tx = Transaction.from(attempt.raw);
    requireValue(tx.signature && tx.hash === attempt.hash && tx.from?.toLowerCase() === step.from
      && tx.nonce === attempt.nonce && tx.chainId === 8453n && tx.type === 2 && tx.value === 0n
      && tx.data === step.data && (tx.to?.toLowerCase() ?? null) === (step.to ?? null)
      && tx.gasLimit > 0n && tx.maxFeePerGas !== null && tx.maxPriorityFeePerGas !== null
      && tx.maxFeePerGas >= tx.maxPriorityFeePerGas, 'signed_binding');
  }
  // The encrypted record and Firestore metadata also need room below the 1 MiB limit.
  requireValue(Buffer.byteLength(JSON.stringify(attempt)) < 700_000, 'attempt_too_large');
}

/** Durable adapter for the ordered changeover runner. Each transaction gets its
 * own encrypted document: a large balance/history import must never accumulate
 * signed bytes in one Firestore document. The shared settlement signer lease
 * remains reserved across crashes, process-lease expiry and lost RPC responses.
 * This adapter provides persistence, not approval to run a changeover. The caller
 * must independently validate the plan before acquiring it and before signing.
 */
export async function openChangeoverJournal(db: Firestore, input: {
  readonly planDigest: string; readonly steps: readonly ChangeoverStep[];
  readonly now?: () => number; readonly workerId?: string;
}): Promise<DurableChangeoverJournal> {
  // Freeze a private copy so a caller cannot change the plan after its digest is bound.
  const steps: readonly ChangeoverStep[] = structuredClone(input.steps);
  requireValue(/^0x[0-9a-f]{64}$/.test(input.planDigest) && steps.length > 0, 'plan_invalid');
  for (const step of steps) requireValue(/^0x[0-9a-f]{40}$/.test(step.from)
    && /^0x(?:[0-9a-f]{2})+$/.test(step.data) && step.value === '0'
    && (step.to === undefined || /^0x[0-9a-f]{40}$/.test(step.to)), 'plan_invalid');
  const stageDigest = hash({ planDigest: input.planDigest, steps });
  const reservation = `changeover:${stageDigest}`, workerId = input.workerId ?? `changeover-${randomUUID()}`;
  const now = input.now ?? Date.now, signers = [...new Set(steps.map(step => step.from))].sort();
  const settlementDb = db as unknown as SettlementDb;
  const headRef = db.collection(CHANGEOVER_STAGES).doc(stageDigest);
  const attemptRef = (index: number) => db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${index}`);
  const leaseRefs = signers.map(signer => db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer));
  const assertLeaseRows = (rows: readonly DocumentSnapshot[]): void => {
    for (const row of rows) requireValue(row.get('owner') === workerId
      && Number(row.get('expires_at_ms')) > now() && row.get('pending_operation') === reservation, 'lease_lost');
  };
  let revision = 0, state: ChangeoverJournal = { version: 1, stageDigest, attempts: {}, completed: false };
  let closed = false;
  const readTerminal = async (): Promise<DurableChangeoverJournal | null> => {
    const head = await headRef.get();
    if (head.get('completed') !== true) return null;
    requireValue(head.get('stageDigest') === stageDigest && head.get('planDigest') === input.planDigest
      && head.get('stepCount') === steps.length && head.get('attemptCount') === steps.length, 'stage_mismatch');
    const attempts: Record<string, ChangeoverAttempt> = {};
    for (let index = 0; index < steps.length; index++) {
      const row = await attemptRef(index).get();
      requireValue(row.exists && row.get('stageDigest') === stageDigest && row.get('index') === index, 'attempt_missing');
      const attempt = row.get('attempt') as ChangeoverAttempt;
      validateAttempt(attempt, steps[index]); requireValue(attempt.raw !== null, 'unsigned');
      attempts[String(index)] = attempt;
    }
    const terminal: ChangeoverJournal = { version: 1, stageDigest, attempts, completed: true };
    const refuse = async (): Promise<never> => { throw Error('changeover_journal_completed'); };
    return { stageDigest, read: () => structuredClone(terminal), assertLease: refuse, persist: refuse,
      complete: async finalized => {
        for (const attempt of Object.values(attempts)) {
          const receipt = await finalized(attempt.raw!);
          requireValue(receipt?.hash === attempt.hash && receipt?.status === 1, 'not_finalized');
        }
      }, release: async () => {} };
  };
  // Completion can have committed even if its response was lost. Reading that
  // terminal record must not reacquire or disturb a later settlement's lease.
  const terminal = await readTerminal();
  if (terminal) return terminal;
  const release = async (): Promise<void> => {
    closed = true;
    for (const signer of signers) await releaseSignerLease(settlementDb, { signer, workerId, nowMs: now() });
  };
  try {
    for (const signer of signers) {
      const lease = await acquireSignerLease(settlementDb, { signer, workerId, operationId: reservation,
        nowMs: now(), leaseTtlMs: 120_000 });
      requireValue(lease.kind === 'acquired', 'signer_busy');
    }
    for (const batch of await listAllUnresolvedBatches(settlementDb)) {
      const cycle = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
      const signer: unknown = cycle.get('signer');
      requireValue(typeof signer === 'string' && !signers.includes(signer.toLowerCase()), 'settlement_reserved');
    }
    const head = await db.runTransaction(async tx => {
      const [current, ...leases] = await Promise.all([tx.get(headRef), ...leaseRefs.map(ref => tx.get(ref))]);
      for (const lease of leases) requireValue(lease.get('owner') === workerId
        && Number(lease.get('expires_at_ms')) > now()
        && [undefined, null, reservation].includes(lease.get('pending_operation')), 'lease_lost');
      if (current.exists) requireValue(current.get('stageDigest') === stageDigest && current.get('planDigest') === input.planDigest
        && current.get('stepCount') === steps.length && current.get('completed') === false, 'stage_mismatch');
      else tx.set(headRef, { stageDigest, planDigest: input.planDigest, stepCount: steps.length,
        revision: 0, attemptCount: 0, completed: false });
      for (const ref of leaseRefs) tx.update(ref, { pending_operation: reservation });
      return current.exists ? current.data()! : { revision: 0, attemptCount: 0 };
    });
    requireValue(Number.isSafeInteger(head.revision) && Number(head.revision) >= 0
      && Number.isSafeInteger(head.attemptCount) && Number(head.attemptCount) >= 0
      && Number(head.attemptCount) <= steps.length, 'head_invalid');
    revision = Number(head.revision);
    const attempts: Record<string, ChangeoverAttempt> = {};
    for (let index = 0; index < Number(head.attemptCount); index++) {
      const row = await attemptRef(index).get();
      requireValue(row.exists && row.get('stageDigest') === stageDigest && row.get('index') === index, 'attempt_missing');
      const attempt = row.get('attempt') as ChangeoverAttempt;
      validateAttempt(attempt, steps[index]); attempts[String(index)] = attempt;
    }
    state = { ...state, attempts };
  } catch (error) {
    await release();
    const completedDuringAcquire = await readTerminal();
    if (completedDuringAcquire) return completedDuringAcquire;
    throw error;
  }

  const assertLease = async (expectedDigest = stageDigest): Promise<void> => {
    requireValue(!closed && !state.completed && expectedDigest === stageDigest, 'closed_or_changed');
    // Renewal may take over an expired lease only if no other worker acquired it.
    // Persist still checks the worker and head revision inside its transaction.
    for (const signer of signers) {
      const lease = await acquireSignerLease(settlementDb, { signer, workerId, operationId: reservation,
        nowMs: now(), leaseTtlMs: 120_000 });
      requireValue(lease.kind === 'acquired', 'lease_lost');
    }
    assertLeaseRows(await Promise.all(leaseRefs.map(ref => ref.get())));
    const head = await headRef.get();
    requireValue(head.get('revision') === revision && head.get('completed') === false, 'concurrent_write');
  };
  const persist = async (incoming: ChangeoverJournal): Promise<void> => {
    const next = structuredClone(incoming);
    requireValue(!closed && !state.completed && next.version === 1 && next.stageDigest === stageDigest
      && next.completed === false, 'state_invalid');
    const previousCount = Object.keys(state.attempts).length, count = Object.keys(next.attempts).length;
    requireValue(count >= previousCount && count <= previousCount + 1 && count <= steps.length, 'attempt_sequence');
    const changed: number[] = [];
    for (let index = 0; index < count; index++) {
      const after = next.attempts[String(index)], before = state.attempts[String(index)];
      validateAttempt(after, steps[index]);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      requireValue(!before || (before.raw === null && after.raw !== null
        && before.nonce === after.nonce && before.from === after.from && before.identity === after.identity), 'attempt_replaced');
      // A nonce reservation must be durable before signed bytes can be stored.
      if (!before) requireValue(after.raw === null && after.hash === null, 'unsigned_reservation_required');
      if (!before && index > 0) requireValue(next.attempts[String(index - 1)].raw !== null, 'prior_unsigned');
      const priorNonce = Object.values(state.attempts).filter(item => item.from === after.from);
      if (!before && priorNonce.length > 0) requireValue(after.nonce === priorNonce[priorNonce.length - 1].nonce + 1, 'nonce_sequence');
      changed.push(index);
    }
    requireValue(changed.length === 1 && Object.keys(next.attempts).every(key => /^(0|[1-9][0-9]*)$/.test(key)
      && Number(key) < count), 'attempt_sequence');
    const index = changed[0], expectedRevision = revision;
    await db.runTransaction(async tx => {
      const feeRef = db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${index}:fee`);
      const [head, old, fee, ...leases] = await Promise.all([tx.get(headRef), tx.get(attemptRef(index)), tx.get(feeRef), ...leaseRefs.map(ref => tx.get(ref))]);
      assertLeaseRows(leases);
      requireValue(head.get('revision') === expectedRevision && head.get('completed') === false
        && head.get('attemptCount') === previousCount, 'concurrent_write');
      requireValue(JSON.stringify(old.get('attempt')) === JSON.stringify(state.attempts[String(index)]), 'record_changed');
      const signed = next.attempts[String(index)].raw;
      if (signed !== null && head.get('feeBudgetWei') !== undefined) {
        requireValue(fee.exists && fee.get('stageDigest') === stageDigest && fee.get('index') === index
          && fee.get('from') === steps[index].from && fee.get('nonce') === next.attempts[String(index)].nonce
          && fee.get('unsignedHash') === keccak256(Transaction.from(signed).unsignedSerialized), 'fee_reservation_required');
      }
      tx.set(attemptRef(index), { stageDigest, index, attempt: next.attempts[String(index)] });
      tx.update(headRef, { revision: expectedRevision + 1, attemptCount: count });
    });
    revision++; state = structuredClone(next);
  };
  /** Only independent finality of every exact signed transaction releases the
   * durable nonce reservation. Reverted stages stay reserved for explicit review.
   * Callback must use the same two-operator finalized verifier as the runner. */
  const complete = async (finalized: ChangeoverFinality): Promise<void> => {
    await assertLease();
    requireValue(Object.keys(state.attempts).length === steps.length, 'incomplete');
    for (let index = 0; index < steps.length; index++) {
      const attempt = state.attempts[String(index)];
      requireValue(attempt.raw !== null, 'unsigned');
      const receipt = await finalized(attempt.raw);
      requireValue(receipt?.hash === attempt.hash && receipt?.status === 1, 'not_finalized');
    }
    const expectedRevision = revision;
    await db.runTransaction(async tx => {
      const [head, ...leases] = await Promise.all([tx.get(headRef), ...leaseRefs.map(ref => tx.get(ref))]);
      assertLeaseRows(leases);
      requireValue(head.get('revision') === expectedRevision && head.get('completed') === false, 'concurrent_write');
      tx.update(headRef, { completed: true, revision: expectedRevision + 1 });
      for (const ref of leaseRefs) tx.update(ref, { pending_operation: null });
    });
    state = { ...state, completed: true }; revision++;
  };
  return { stageDigest, read: (): ChangeoverJournal => structuredClone(state), assertLease, persist, complete, release };
}
