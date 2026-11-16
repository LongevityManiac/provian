import { withoutBuilderCode } from '../onchain/builder-code';
import { Transaction, keccak256, type TransactionLike } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { CHANGEOVER_ATTEMPTS, CHANGEOVER_STAGES, type ChangeoverAttempt } from './changeover-journal';
import { estimateBaseTransactionFees, type BaseFeeReader } from './base-transaction-fees';

const requireValue = (value: unknown, code: string): void => { if (!value) throw Error(`changeover_fees_${code}`); };
const atomic = (value: unknown): bigint => {
  requireValue(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value), 'invalid_amount');
  return BigInt(String(value));
};

/** The approved stage budget bounds quoted fee reservations, including Base L1
 * and operator components. It is not an absolute ceiling on future L1/operator
 * fees. Reservations are never released merely because a process disappeared.
 * This adapter grants neither plan approval nor a signer lease. */
export async function openChangeoverFeeBudget(db: Firestore, input: {
  readonly stageDigest: string; readonly approvedBudgetWei: string;
  readonly readers: readonly BaseFeeReader[]; readonly assertLease: () => Promise<void>;
}): Promise<{
  reserve(index: number, from: string, transaction: TransactionLike, blockHash: string): Promise<string>;
}> {
  const stageDigest = input.stageDigest, budget = atomic(input.approvedBudgetWei);
  requireValue(/^0x[0-9a-f]{64}$/.test(stageDigest) && budget > 0n, 'configuration');
  const headRef = db.collection(CHANGEOVER_STAGES).doc(stageDigest);
  await input.assertLease();
  await db.runTransaction(async tx => {
    const head = await tx.get(headRef);
    requireValue(head.exists && head.get('stageDigest') === stageDigest && head.get('completed') === false, 'stage_missing_or_complete');
    const previous: unknown = head.get('feeBudgetWei');
    if (previous !== undefined) {
      requireValue(atomic(previous) === budget && atomic(head.get('feeReservedWei')) <= budget, 'budget_changed');
    } else {
      // A budget cannot erase liabilities signed before it was attached. The
      // stage engine permits at most one unsigned attempt at the end; any
      // second attempt therefore proves an earlier signed transaction exists.
      const count: unknown = head.get('attemptCount');
      requireValue(count === 0 || count === 1, 'prior_unsigned_budget_required');
      if (count === 1) {
        const row = await tx.get(db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:0`));
        const attempt: ChangeoverAttempt | undefined = row.get('attempt');
        requireValue(row.get('stageDigest') === stageDigest && row.get('index') === 0
          && attempt?.raw === null && attempt?.hash === null, 'prior_unsigned_budget_required');
      }
      tx.update(headRef, { feeBudgetWei: budget.toString(), feeReservedWei: '0' });
    }
  });
  return {
    reserve: async (index, from, transaction, blockHash): Promise<string> => {
      requireValue(Number.isSafeInteger(index) && index >= 0 && /^0x[0-9a-f]{40}$/.test(from), 'request_invalid');
      const prepared = Transaction.from(transaction);
      requireValue(prepared.value === 0n && !prepared.signature, 'request_invalid');
      const unsigned = prepared.unsignedSerialized;
      // Quote the private transaction copy, never a caller-mutated object.
      await input.assertLease();
      const estimate = await estimateBaseTransactionFees(input.readers, prepared, blockHash);
      await input.assertLease();
      const attemptRef = db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${index}`);
      // Same encrypted collection, separate row: do not enlarge the stage head
      // with one entry per transaction or overwrite its signed-attempt record.
      const feeRef = db.collection(CHANGEOVER_ATTEMPTS).doc(`${stageDigest}:${index}:fee`);
      const reserved = await db.runTransaction(async tx => {
        const [head, attemptRow, fee] = await Promise.all([tx.get(headRef), tx.get(attemptRef), tx.get(feeRef)]);
        requireValue(head.get('stageDigest') === stageDigest && head.get('completed') === false
          && atomic(head.get('feeBudgetWei')) === budget, 'stage_changed');
        requireValue(index < Number(head.get('attemptCount')) && attemptRow.get('stageDigest') === stageDigest
          && attemptRow.get('index') === index, 'attempt_missing');
        const attempt: ChangeoverAttempt = attemptRow.get('attempt');
        // The identity binds the planned call; the signed bytes also carry Provian's Builder Code.
        const expectedIdentity = keccak256(Transaction.from({ type: 2, chainId: 8453, nonce: 0, to: prepared.to,
          value: 0, data: withoutBuilderCode(prepared.data), gasLimit: 0, maxFeePerGas: 0, maxPriorityFeePerGas: 0 }).unsignedSerialized);
        requireValue(attempt && attempt.from === from && attempt.nonce === prepared.nonce
          && attempt.identity === expectedIdentity && attempt.raw === null && attempt.hash === null, 'attempt_changed');
        if (fee.exists) requireValue(fee.get('stageDigest') === stageDigest && fee.get('index') === index
          && fee.get('from') === from && fee.get('nonce') === prepared.nonce
          && fee.get('identity') === expectedIdentity, 'reservation_changed');
        const old = fee.exists ? atomic(fee.get('reservedWei')) : 0n;
        const next = estimate.totalEstimateWei > old ? estimate.totalEstimateWei : old;
        const total = atomic(head.get('feeReservedWei'));
        requireValue(total >= old && total <= budget && next + total - old <= budget, 'budget_exhausted');
        tx.set(feeRef, { stageDigest, index, from, nonce: prepared.nonce, identity: expectedIdentity,
          reservedWei: next.toString(), unsignedHash: keccak256(unsigned), blockHash,
          executionFeeMaxWei: estimate.executionFeeMaxWei.toString(),
          l1FeeEstimateWei: estimate.l1FeeEstimateWei.toString(), operatorFeeEstimateWei: estimate.operatorFeeEstimateWei.toString() });
        tx.update(headRef, { feeReservedWei: (total - old + next).toString() });
        return next.toString();
      });
      await input.assertLease();
      return reserved;
    },
  };
}
