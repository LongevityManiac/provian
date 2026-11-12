import { randomUUID } from 'crypto';
import { Transaction, keccak256 } from 'ethers';
import type { Firestore, Transaction as FirestoreTransaction } from 'firebase-admin/firestore';
import { acquireSignerLease, releaseSignerLease, listAllUnresolvedBatches, SETTLEMENT_CYCLES_COLLECTION,
  SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { finalizedOwnerTransaction } from './transaction-finality';

export interface SponsoredOperationPlan {
  readonly id: string; readonly executor: string; readonly calldata: string; readonly gasPayer: string;
}
export interface SponsoredOperationSigner<P extends SponsoredOperationPlan> {
  readonly address: string;
  sign(plan: P): Promise<string>;
  broadcast(raw: string): Promise<string>;
}
export interface SponsoredOperationAdapter<R, P extends SponsoredOperationPlan> {
  readonly collection: string;
  parse(value: unknown): R;
  id(request: R): string;
  target(request: R, recordedExecutor: unknown): string;
  calldata(request: R): string;
  check(request: R): Promise<P>;
  assert(plan: P): void;
  satisfied(plan: P): boolean;
  obsolete(error: unknown): boolean;
  finalized: typeof finalizedOwnerTransaction;
  /** Optional durable consumer receipt application. Complete this before the
   * operation leaves the retry queue or releases its reserved nonce. */
  reconcileConfirmed?(request: R, transactionHash: string): Promise<void>;
  /** Fence queue admission against a concurrently persisted owner intent. */
  beforeQueue?(tx: FirestoreTransaction, request: R): Promise<void>;
}
function validateTransaction(raw: string, signer: string, target: string, data: string): void {
  const tx = Transaction.from(raw);
  if (!tx.signature || tx.from?.toLowerCase() !== signer || tx.chainId !== 8453n || tx.type !== 2
    || tx.to?.toLowerCase() !== target || tx.data !== data || tx.value !== 0n || tx.gasLimit <= 0n
    || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null || tx.maxFeePerGas < tx.maxPriorityFeePerGas) {
    throw Error('recourse_sponsor_signed_mismatch');
  }
}
/** Reserve the shared settlement nonce before signing; persist exact bytes
 * before broadcasting. Only a verified operation adapter selects target/data.
 * Signed nonces remain reserved until independently finalized reconciliation. */
export async function executeSponsoredOperation<R, P extends SponsoredOperationPlan>(db: Firestore, id: string,
  signer: SponsoredOperationSigner<P>, adapter: SponsoredOperationAdapter<R, P>): Promise<'submitted' | 'confirmed' | 'failed'> {
  if (!/^0x[0-9a-f]{64}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(signer.address)) throw Error('recourse_sponsor_worker_invalid');
  const workerId = `recourse-sponsor-${randomUUID()}`, settlementDb = db as unknown as SettlementDb;
  const ref = db.collection(adapter.collection).doc(id);
  const leaseRef = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address);
  const renew = async () => {
    const lease = await acquireSignerLease(settlementDb, { signer: signer.address, workerId, nowMs: Date.now(), leaseTtlMs: 120_000, operationId: id });
    if (lease.kind !== 'acquired') throw Error('recourse_sponsor_signer_busy');
  };
  await renew();
  try {
    let snapshot = await ref.get();
    if (!snapshot.exists) throw Error('recourse_sponsor_unknown');
    const request = adapter.parse(snapshot.get('request'));
    if (adapter.id(request) !== id) throw Error('recourse_sponsor_record_mismatch');
    if (snapshot.get('status') === 'confirmed') return 'confirmed';
    if (snapshot.get('status') === 'failed') return 'failed';
    const data = adapter.calldata(request);
    const target = adapter.target(request, snapshot.get('executor'));
    const finish = async (status: 'confirmed' | 'failed', unsigned = false) => {
      await db.runTransaction(async tx => {
        const [lease, current] = await Promise.all([tx.get(leaseRef), tx.get(ref)]);
        const pending: unknown = lease.get('pending_operation');
        if (lease.get('owner') !== workerId || Number(lease.get('expires_at_ms')) <= Date.now()
          || (pending !== id && !(unsigned && (pending === undefined || pending === null)))) throw Error('recourse_sponsor_lease_lost');
        if (adapter.id(adapter.parse(current.get('request'))) !== id
          || current.get('signedTransaction') !== snapshot.get('signedTransaction')
          || (unsigned && current.get('signedTransaction') !== undefined)) throw Error('recourse_sponsor_record_changed');
        tx.update(ref, { status, finalizedAtMs: Date.now() });
        tx.update(leaseRef, { pending_operation: null });
      });
      return status;
    };
    let raw: unknown = snapshot.get('signedTransaction');
    if (raw === undefined) {
      for (const batch of await listAllUnresolvedBatches(settlementDb)) {
        const cycle = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
        const cycleSigner: unknown = cycle.get('signer');
        if (typeof cycleSigner !== 'string' || cycleSigner.toLowerCase() === signer.address) throw Error('recourse_sponsor_settlement_reserved');
      }
      let plan: P;
      try { plan = await adapter.check(request); }
      catch (error) {
        if (adapter.obsolete(error)) return finish('failed', true);
        throw error;
      }
      adapter.assert(plan);
      if (plan.id !== id || plan.executor !== target || plan.calldata !== data) throw Error('recourse_sponsor_plan_mismatch');
      if (plan.gasPayer !== signer.address) return finish('failed', true);
      if (adapter.satisfied(plan)) return finish('confirmed', true);
      await db.runTransaction(async tx => {
        const lease = await tx.get(leaseRef), pending: unknown = lease.get('pending_operation');
        if (lease.get('owner') !== workerId || Number(lease.get('expires_at_ms')) <= Date.now()
          || (pending !== undefined && pending !== null && pending !== id)) throw Error('recourse_sponsor_lease_lost');
        tx.update(leaseRef, { pending_operation: id });
      });
      const prepared = await signer.sign(plan);
      validateTransaction(prepared, signer.address, target, data);
      await db.runTransaction(async tx => {
        const [lease, current] = await Promise.all([tx.get(leaseRef), tx.get(ref)]);
        if (lease.get('owner') !== workerId || lease.get('pending_operation') !== id
          || Number(lease.get('expires_at_ms')) <= Date.now()) throw Error('recourse_sponsor_lease_lost');
        if (adapter.id(adapter.parse(current.get('request'))) !== id) throw Error('recourse_sponsor_record_changed');
        if (current.get('signedTransaction') !== undefined) return;
        if (current.get('status') !== 'queued') throw Error('recourse_sponsor_state_invalid');
        tx.update(ref, { signedTransaction: prepared, transactionHash: keccak256(prepared), executor: plan.executor,
          gasPayer: plan.gasPayer, status: 'submitted', preparedAtMs: Date.now() });
      });
      snapshot = await ref.get(); raw = snapshot.get('signedTransaction');
    }
    if (typeof raw !== 'string' || snapshot.get('transactionHash') !== keccak256(raw)
      || snapshot.get('executor') !== target || snapshot.get('gasPayer') !== signer.address) throw Error('recourse_sponsor_record_mismatch');
    validateTransaction(raw, signer.address, target, data);
    let terminal: Awaited<ReturnType<typeof finalizedOwnerTransaction>>;
    try { terminal = await adapter.finalized(raw); }
    catch (error) {
      if (error instanceof Error && error.message === 'recourse_transaction_not_finalized') return 'submitted';
      throw error;
    }
    // Success confirms this exact call, not current owner credentials. Consumers
    // must independently verify their present state before installing any key.
    if (terminal !== null) {
      if (terminal.status === 1 && adapter.reconcileConfirmed) await adapter.reconcileConfirmed(request, keccak256(raw));
      return finish(terminal.status === 1 ? 'confirmed' : 'failed');
    }
    await renew();
    // An already signed nonce must be reconciled even after a pointer change.
    // Only these previously persisted zero-value operation bytes can be retried.
    if (await signer.broadcast(raw) !== keccak256(raw)) throw Error('recourse_sponsor_broadcast_mismatch');
    return 'submitted';
  } finally {
    await releaseSignerLease(settlementDb, { signer: signer.address, workerId, nowMs: Date.now() });
  }
}
