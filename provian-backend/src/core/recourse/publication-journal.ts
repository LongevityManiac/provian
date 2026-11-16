import { matchesPlannedCall } from '../onchain/builder-code';
import { randomUUID } from 'crypto';
import { Transaction, keccak256, sha256, toUtf8Bytes, type TransactionLike } from 'ethers';
import type { Firestore, DocumentSnapshot, Transaction as DbTransaction } from 'firebase-admin/firestore';
import { acquireSignerLease, releaseSignerLease, listAllUnresolvedBatches,
  SETTLEMENT_SIGNER_LEASES_COLLECTION, SETTLEMENT_CYCLES_COLLECTION, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import { estimateBaseTransactionFees, type BaseFeeReader } from './base-transaction-fees';

export const PUBLICATION_JOURNALS = 'recourse_publication_journals_v1';
export const PUBLICATION_ATTEMPTS = 'recourse_publication_attempts_v1';
const hashPattern = /^0x[0-9a-f]{64}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;
function check(value: unknown, reason: string): asserts value { if (!value) throw Error(`publication_journal_${reason}`); }
const digest = (value: unknown): string => sha256(toUtf8Bytes(JSON.stringify(value)));
const atomic = (value: unknown): bigint => {
  check(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'amount_invalid'); return BigInt(value);
};
export interface PublicationGoal {
  readonly pointer: string; readonly authority: string; readonly revision: string; readonly componentsDigest: string;
}
export interface PublicationVariant { readonly kind: 'call' | 'cancel'; readonly raw: string; readonly hash: string }
export interface PublicationClosure {
  readonly status: 'consumed' | 'open'; readonly from: string; readonly nonce: number; readonly finalizedNonce: string;
  readonly checkpoint: { readonly number: number; readonly hash: string }; readonly retainedHashes: readonly string[];
}
export interface PublicationAttempt {
  readonly nonce: number; readonly authorityTransaction: { readonly to: string; readonly data: string };
  readonly variants: readonly PublicationVariant[]; readonly closed: boolean; readonly closure: PublicationClosure | null;
}
export interface PublicationJournalState {
  readonly lifecycleDigest: string; readonly attempts: readonly PublicationAttempt[];
  readonly feeReservedWei: string; readonly completed: boolean;
}
export type PublicationClosureReader = (input: {
  from: string; nonce: number; authorityTransaction: { to: string; data: string }; variants: readonly PublicationVariant[];
}, priorCheckpoint?: PublicationClosure['checkpoint']) => Promise<PublicationClosure>;
export interface PublicationJournal {
  readonly lifecycleDigest: string;
  read(): PublicationJournalState;
  assertLease(): Promise<void>;
  reserve(nonce: number, authorityTransaction: { to: string; data: string }): Promise<void>;
  reserveFee(kind: PublicationVariant['kind'], transaction: TransactionLike, blockHash: string): Promise<void>;
  append(variant: PublicationVariant): Promise<void>;
  close(inspect: PublicationClosureReader): Promise<void>;
  complete(inspect: PublicationClosureReader, verifyGoal: (goal: PublicationGoal) => Promise<boolean>): Promise<void>;
  release(): Promise<void>;
}
function validateTransaction(tx: Transaction, attempt: PublicationAttempt, kind: PublicationVariant['kind'], from: string): void {
  check(tx.type === 2 && tx.chainId === 8453n && tx.nonce === attempt.nonce && tx.value === 0n
    && tx.gasLimit > 0n && tx.maxFeePerGas !== null && tx.maxPriorityFeePerGas !== null
    && tx.maxFeePerGas >= tx.maxPriorityFeePerGas, 'transaction_invalid');
  check(kind === 'call' ? tx.to?.toLowerCase() === attempt.authorityTransaction.to && matchesPlannedCall(tx.data, attempt.authorityTransaction.data)
    : kind === 'cancel' && tx.to?.toLowerCase() === from && matchesPlannedCall(tx.data, '0x'), 'call_changed');
}
function validateClosure(proof: PublicationClosure, attempt: PublicationAttempt, from: string): void {
  check(proof?.status === 'consumed' && proof.from === from && proof.nonce === attempt.nonce
    && atomic(proof.finalizedNonce) > BigInt(attempt.nonce)
    && Number.isSafeInteger(proof.checkpoint?.number) && proof.checkpoint.number > 0 && hashPattern.test(proof.checkpoint.hash)
    && JSON.stringify(proof.retainedHashes) === JSON.stringify(attempt.variants.map(v => v.hash)), 'nonce_not_closed');
}

/** Durable gas delivery for one independently reviewed pointer revision. The
 * same goal binds retirement, publication, every replacement and fresh-nonce
 * retry to one immutable aggregate budget. Fees are conservative reservations
 * of quotes, not a guarantee about future Base L1/operator charges.
 *
 * Use the private-store-wrapped database. Callers authenticate retained authority
 * operations before reserve/sign/broadcast and supply independent canonical
 * closure/goal readers. Persistence alone authorizes neither signing nor launch.
 * A process release never clears the durable signer reservation. */
export async function openPublicationJournal(db: Firestore, input: {
  goal: PublicationGoal; from: string; approvedBudgetWei: string; readers: readonly BaseFeeReader[];
  now?: () => number; workerId?: string;
  requireCompleted?: boolean;
}): Promise<PublicationJournal> {
  const goal = structuredClone(input.goal), from = input.from, budget = atomic(input.approvedBudgetWei);
  check(addressPattern.test(goal.pointer) && addressPattern.test(goal.authority) && addressPattern.test(from)
    && hashPattern.test(goal.componentsDigest) && atomic(goal.revision) > 0n && budget > 0n, 'configuration');
  const lifecycleDigest = digest({ pointer: goal.pointer, authority: goal.authority,
    revision: goal.revision, componentsDigest: goal.componentsDigest });
  const operationId = `publication:${lifecycleDigest}`, workerId = input.workerId ?? `publication-${randomUUID()}`;
  const now = input.now ?? Date.now, readers = [...input.readers], settlement = db as unknown as SettlementDb;
  const headRef = db.collection(PUBLICATION_JOURNALS).doc(lifecycleDigest);
  const attemptRef = (index: number) => db.collection(PUBLICATION_ATTEMPTS).doc(`${lifecycleDigest}:${index}`);
  const variantRef = (index: number, variant: number) => db.collection(PUBLICATION_ATTEMPTS).doc(`${lifecycleDigest}:${index}:variant:${variant}`);
  const feeRef = (index: number, variant: number) => db.collection(PUBLICATION_ATTEMPTS).doc(`${lifecycleDigest}:${index}:fee:${variant}`);
  const leaseRef = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(from);
  let revision = 0, released = false;
  let state: PublicationJournalState = { lifecycleDigest, attempts: [], feeReservedWei: '0', completed: false };
  function owned(row: DocumentSnapshot): void {
    check(row.get('owner') === workerId && Number(row.get('expires_at_ms')) > now()
      && row.get('pending_operation') === operationId, 'lease_lost');
  }
  function headValid(head: DocumentSnapshot): void {
    check(head.get('lifecycleDigest') === lifecycleDigest && head.get('from') === from
      && head.get('budgetWei') === budget.toString(), 'configuration_changed');
    check(atomic(head.get('feeReservedWei')) <= budget, 'budget_invalid');
  }
  async function load(head: DocumentSnapshot): Promise<void> {
    headValid(head);
    const count: unknown = head.get('attemptCount'), rev: unknown = head.get('revision');
    check(Number.isSafeInteger(count) && Number(count) >= 0 && Number.isSafeInteger(rev) && Number(rev) >= 0
      && typeof head.get('completed') === 'boolean', 'head_invalid');
    const attempts: PublicationAttempt[] = [];
    for (let i = 0; i < Number(count); i++) {
      const row = await attemptRef(i).get(), variantCount: unknown = row.get('variantCount');
      const attempt: PublicationAttempt = { nonce: row.get('nonce'), authorityTransaction: row.get('authorityTransaction'),
        closed: row.get('closed'), closure: row.get('closure'), variants: [] };
      check(row.get('lifecycleDigest') === lifecycleDigest && row.get('index') === i
        && Number.isSafeInteger(variantCount) && Number(variantCount) >= 0 && Number.isSafeInteger(attempt.nonce) && attempt.nonce >= 0
        && attempt.authorityTransaction?.to === goal.authority && /^0x(?:[0-9a-f]{2})+$/.test(attempt.authorityTransaction.data)
        && typeof attempt.closed === 'boolean', 'attempt_invalid');
      const variants: PublicationVariant[] = [];
      for (let j = 0; j < Number(variantCount); j++) {
        const row = await variantRef(i, j).get(), variant: PublicationVariant = row.get('variant');
        check(row.get('lifecycleDigest') === lifecycleDigest && row.get('index') === i && row.get('variantIndex') === j && variant, 'variant_missing');
        const tx = Transaction.from(variant.raw); validateTransaction(tx, attempt, variant.kind, from);
        check(tx.signature && tx.from?.toLowerCase() === from && tx.hash === variant.hash
          && !variants.some(v => v.hash === variant.hash), 'signed_binding');
        variants.push(variant);
      }
      const loaded = { ...attempt, variants };
      if (loaded.closed && variants.length) validateClosure(loaded.closure!, loaded, from);
      else check(loaded.closure === null, 'closure_invalid');
      if (i > 0) check(attempts[i - 1].closed && loaded.nonce >= attempts[i - 1].nonce
        + (attempts[i - 1].variants.length ? 1 : 0), 'nonce_sequence');
      if (head.get('completed')) check(loaded.closed, 'open_attempt');
      attempts.push(loaded);
    }
    revision = Number(rev);
    state = { lifecycleDigest, attempts, feeReservedWei: head.get('feeReservedWei'), completed: head.get('completed') };
  }
  const release = async (): Promise<void> => {
    released = true;
    if (!state.completed) await releaseSignerLease(settlement, { signer: from, workerId, nowMs: now() });
  };
  let head = await headRef.get();
  if (input.requireCompleted === true) check(head.exists && head.get('completed') === true, 'not_completed');
  if (head.exists && head.get('completed') === true) await load(head);
  else try {
    const lease = await acquireSignerLease(settlement, { signer: from, workerId, operationId, nowMs: now(), leaseTtlMs: 120_000 });
    check(lease.kind === 'acquired', 'signer_busy');
    for (const batch of await listAllUnresolvedBatches(settlement)) {
      const cycle = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
      const signer: unknown = cycle.get('signer');
      check(typeof signer === 'string' && signer.toLowerCase() !== from, 'settlement_reserved');
    }
    await db.runTransaction(async tx => {
      const [current, lease] = await Promise.all([tx.get(headRef), tx.get(leaseRef)]);
      check(lease.get('owner') === workerId && Number(lease.get('expires_at_ms')) > now()
        && [undefined, null, operationId].includes(lease.get('pending_operation')), 'lease_lost');
      if (current.exists) { headValid(current); check(current.get('completed') === false, 'completed'); }
      else tx.create(headRef, { lifecycleDigest, from, budgetWei: budget.toString(), feeReservedWei: '0',
        revision: 0, attemptCount: 0, completed: false });
      tx.update(leaseRef, { pending_operation: operationId });
    });
    head = await headRef.get(); await load(head);
  } catch (error) {
    await release();
    head = await headRef.get();
    if (head.exists && head.get('completed') === true) await load(head);
    else throw error;
  }
  async function assertLease(): Promise<void> {
    check(!released && !state.completed, 'closed');
    const expected = revision;
    // Renewal can extend our own expired lease after slow reads. Only opening
    // a new journal instance may take over another worker's expired lease.
    await db.runTransaction(async tx => {
      const [head, lease] = await Promise.all([tx.get(headRef), tx.get(leaseRef)]);
      check(!released && !state.completed, 'closed');
      check(lease.get('owner') === workerId && lease.get('pending_operation') === operationId, 'lease_lost');
      headValid(head);
      check(head.get('revision') === expected && head.get('completed') === false, 'concurrent_write');
      tx.update(leaseRef, { expires_at_ms: now() + 120_000 });
    });
  }
  async function mutate(expected: number, action: (tx: DbTransaction, head: DocumentSnapshot) => Promise<void>): Promise<void> {
    check(!released && !state.completed, 'closed');
    await db.runTransaction(async tx => {
      const [head, lease] = await Promise.all([tx.get(headRef), tx.get(leaseRef)]);
      owned(lease); headValid(head);
      check(head.get('revision') === expected && head.get('completed') === false, 'concurrent_write');
      await action(tx, head);
      tx.update(headRef, { revision: expected + 1 });
    });
    // A lost write response is recovered by reopening, never by guessing which
    // mutation committed or replacing already retained signed bytes.
    await load(await headRef.get());
  }
  const active = (): { attempt: PublicationAttempt; index: number } => {
    const index = state.attempts.length - 1, attempt = state.attempts[index];
    check(attempt && !attempt.closed, 'no_open_attempt'); return { attempt, index };
  };
  async function verifyClosed(attempt: PublicationAttempt, inspect: PublicationClosureReader): Promise<void> {
    if (!attempt.variants.length) return;
    const proof = await inspect({ from, nonce: attempt.nonce, authorityTransaction: structuredClone(attempt.authorityTransaction),
      variants: structuredClone(attempt.variants) }, attempt.closure?.checkpoint);
    validateClosure(proof, attempt, from);
  }
  return {
    lifecycleDigest, read: () => structuredClone(state), assertLease, release,
    async reserve(nonce, incoming): Promise<void> {
      const authorityTransaction = structuredClone(incoming), expected = revision, index = state.attempts.length;
      const previous = state.attempts[index - 1];
      check(Number.isSafeInteger(nonce) && nonce >= 0 && authorityTransaction.to === goal.authority
        && /^0x(?:[0-9a-f]{2})+$/.test(authorityTransaction.data), 'reservation_invalid');
      check(!previous || previous.closed && nonce >= previous.nonce + (previous.variants.length ? 1 : 0), 'prior_not_closed');
      await mutate(expected, async (tx, head) => {
        check(head.get('attemptCount') === index && !(await tx.get(attemptRef(index))).exists, 'attempt_changed');
        tx.create(attemptRef(index), { lifecycleDigest, index, nonce, authorityTransaction, variantCount: 0, closed: false, closure: null });
        tx.update(headRef, { attemptCount: index + 1 });
      });
    },
    async reserveFee(kind, incoming, blockHash): Promise<void> {
      const transaction = Transaction.from(incoming), expected = revision, { attempt, index } = active();
      validateTransaction(transaction, attempt, kind, from); check(!transaction.signature, 'already_signed');
      const unsignedHash = keccak256(transaction.unsignedSerialized), slot = attempt.variants.length;
      await assertLease();
      const quote = await estimateBaseTransactionFees(readers, transaction, blockHash);
      await assertLease();
      await mutate(expected, async (tx, head) => {
        const [row, fee] = await Promise.all([tx.get(attemptRef(index)), tx.get(feeRef(index, slot))]);
        check(row.get('closed') === false && row.get('variantCount') === slot, 'attempt_changed');
        const prior = fee.exists ? atomic(fee.get('reservedWei')) : 0n;
        const reserved = quote.totalEstimateWei > prior ? quote.totalEstimateWei : prior;
        const total = atomic(head.get('feeReservedWei'));
        check(total >= prior && total - prior + reserved <= budget, 'budget_exhausted');
        tx.set(feeRef(index, slot), { reservedWei: reserved.toString(), unsignedHash, kind, blockHash });
        tx.update(headRef, { feeReservedWei: (total - prior + reserved).toString() });
      });
    },
    async append(incoming): Promise<void> {
      const variant = structuredClone(incoming), expected = revision, { attempt, index } = active(), slot = attempt.variants.length;
      const transaction = Transaction.from(variant.raw); validateTransaction(transaction, attempt, variant.kind, from);
      check(transaction.signature && transaction.from?.toLowerCase() === from && transaction.hash === variant.hash
        && !attempt.variants.some(v => v.hash === variant.hash), 'signed_binding');
      check(Buffer.byteLength(JSON.stringify(variant)) < 700_000, 'variant_too_large');
      await mutate(expected, async tx => {
        const [row, existing, fee] = await Promise.all([tx.get(attemptRef(index)), tx.get(variantRef(index, slot)), tx.get(feeRef(index, slot))]);
        check(row.get('closed') === false && row.get('variantCount') === slot && !existing.exists, 'attempt_changed');
        check(fee.exists && fee.get('unsignedHash') === keccak256(transaction.unsignedSerialized) && fee.get('kind') === variant.kind, 'fee_required');
        tx.create(variantRef(index, slot), { lifecycleDigest, index, variantIndex: slot, variant });
        tx.update(attemptRef(index), { variantCount: slot + 1 });
      });
    },
    async close(inspect): Promise<void> {
      const expected = revision, { attempt, index } = active();
      // With no retained signed bytes, owned lease + CAS can abandon the
      // unsigned reservation. A late signer cannot persist after closure.
      const proof = attempt.variants.length ? structuredClone(await inspect({ from, nonce: attempt.nonce,
        authorityTransaction: structuredClone(attempt.authorityTransaction), variants: structuredClone(attempt.variants) })) : null;
      if (proof) validateClosure(proof, attempt, from);
      await assertLease();
      await mutate(expected, async tx => {
        const row = await tx.get(attemptRef(index));
        check(row.get('closed') === false && row.get('variantCount') === attempt.variants.length, 'attempt_changed');
        tx.update(attemptRef(index), { closed: true, closure: proof });
      });
    },
    async complete(inspect, verifyGoal): Promise<void> {
      const expected = revision, snapshot = structuredClone(state);
      check(snapshot.attempts.every(attempt => attempt.closed), 'open_attempt');
      for (const attempt of snapshot.attempts) await verifyClosed(attempt, inspect);
      check(await verifyGoal(structuredClone(goal)) === true, 'goal_unverified');
      if (snapshot.completed) return; // Read-only restart cannot seize a later lease.
      await assertLease();
      await mutate(expected, async tx => {
        tx.update(headRef, { completed: true });
        tx.update(leaseRef, { pending_operation: null, owner: null, expires_at_ms: 0 });
      });
    },
  };
}
