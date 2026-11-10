import { randomUUID } from 'crypto';
import { Transaction, keccak256, hashMessage } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { acquireSignerLease, releaseSignerLease, listAllUnresolvedBatches, SETTLEMENT_CYCLES_COLLECTION,
  SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/wp4/durable-settlement-store';
import { finalizedOwnerTransaction } from './transaction-finality';
import { BINDING_OPERATIONS, REGISTRY_ABI, assertCheckedBindingOperation, checkBindingOperation,
  readConfirmedBinding, confirmBindingRegistration, type CheckedBindingOperation, type IdentityAttestor } from './binding-operation';
import { ownershipBindingMessage, RECOURSE_COLLECTIONS, type OwnershipBinding } from './ownership';

export interface BindingGasSigner {
  readonly address: string;
  sign(plan: CheckedBindingOperation): Promise<string>;
  broadcast(raw: string): Promise<string>;
}
export interface BindingWorkerPorts {
  check: typeof checkBindingOperation;
  finalized: typeof finalizedOwnerTransaction;
  registration: typeof readConfirmedBinding;
}
/** The existing minter pays binding gas under its settlement signer lease. No
 * member funds, generic calldata or restoration authority enter this worker. */
export async function executeBindingOperation(db: Firestore, id: string, signer: BindingGasSigner,
  attestor: IdentityAttestor, ports: BindingWorkerPorts = { check: checkBindingOperation, finalized: finalizedOwnerTransaction,
    registration: readConfirmedBinding }):
Promise<'submitted' | 'confirmed' | 'failed'> {
  if (!/^0x[0-9a-f]{64}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(signer.address)) throw new Error('recourse_binding_worker_invalid');
  const workerId = `recourse-binding-${randomUUID()}`, operationId = `binding:${id}`;
  const settlementDb = db as unknown as SettlementDb;
  const ref = db.collection(BINDING_OPERATIONS).doc(id);
  const leaseRef = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address);
  const renew = async () => {
    if ((await acquireSignerLease(settlementDb, { signer: signer.address, workerId, operationId,
      nowMs: Date.now(), leaseTtlMs: 120_000 })).kind !== 'acquired') throw new Error('recourse_binding_signer_busy');
  };
  await renew();
  try {
    let row = await ref.get();
    if (!row.exists) throw new Error('recourse_binding_operation_unknown');
    const binding = row.get('binding') as OwnershipBinding;
    if (hashMessage(ownershipBindingMessage(binding)) !== id) throw new Error('recourse_binding_record_invalid');
    if (row.get('status') === 'confirmed') return 'confirmed';
    if (row.get('status') === 'failed') return 'failed';
    const finish = async (status: 'confirmed' | 'failed', reason: string, unsigned = false) => {
      await db.runTransaction(async tx => {
        const addressRef = db.collection(RECOURSE_COLLECTIONS.addresses).doc(binding.address);
        const [lease, current, address] = await Promise.all([tx.get(leaseRef), tx.get(ref), tx.get(addressRef)]);
        const pending: unknown = lease.get('pending_operation');
        if (lease.get('owner') !== workerId || Number(lease.get('expires_at_ms')) <= Date.now()
          || (pending !== operationId && !(unsigned && (pending === null || pending === undefined)))) throw new Error('recourse_binding_lease_lost');
        if (unsigned ? current.get('signedTransaction') !== undefined : current.get('signedTransaction') !== row.get('signedTransaction')) {
          throw new Error('recourse_binding_record_changed');
        }
        tx.update(ref, { status, terminalReason: reason, finalizedAtMs: Date.now() });
        tx.update(leaseRef, { pending_operation: null });
      });
      return status;
    };
    let raw: unknown = row.get('signedTransaction');
    if (raw === undefined) {
      let prior: Awaited<ReturnType<typeof readConfirmedBinding>>;
      try { prior = await ports.registration(binding); }
      catch (error) {
        if (error instanceof Error && error.message === 'recourse_binding_operation_retired') return finish('failed', error.message, true);
        throw error;
      }
      if (prior) {
        await confirmBindingRegistration(db, prior);
        return finish('confirmed', 'binding_executed_by_other_submitter', true);
      }
      // This worker must not allocate the nonce of an unbroadcast settlement.
      for (const batch of await listAllUnresolvedBatches(settlementDb)) {
        const cycle = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
        const owner: unknown = cycle.get('signer');
        if (typeof owner !== 'string' || owner.toLowerCase() === signer.address) throw new Error('recourse_binding_settlement_reserved');
      }
      if (binding.expiresAtMs <= Date.now()) return finish('failed', 'binding_expired', true);
      let plan: CheckedBindingOperation;
      try { plan = await ports.check(db, binding, String(row.get('ownerSignature')), attestor); }
      catch (error) {
        if (error instanceof Error && ['recourse_binding_operation_retired', 'recourse_binding_operation_owner_mismatch'].includes(error.message)) {
          return finish('failed', error.message, true);
        }
        throw error;
      }
      assertCheckedBindingOperation(plan);
      await db.runTransaction(async tx => {
        const lease = await tx.get(leaseRef);
        if (lease.get('owner') !== workerId || Number(lease.get('expires_at_ms')) <= Date.now()) throw new Error('recourse_binding_lease_lost');
        tx.update(leaseRef, { pending_operation: operationId });
      });
      const prepared = await signer.sign(plan);
      validateTransaction(prepared, signer.address, plan.executor, plan.calldata);
      await db.runTransaction(async tx => {
        const [lease, current] = await Promise.all([tx.get(leaseRef), tx.get(ref)]);
        if (lease.get('owner') !== workerId || lease.get('pending_operation') !== operationId
          || Number(lease.get('expires_at_ms')) <= Date.now()) throw new Error('recourse_binding_lease_lost');
        if (current.get('signedTransaction') !== undefined) return;
        if (current.get('status') !== 'queued') throw new Error('recourse_binding_record_changed');
        tx.update(ref, { ...plan, signedTransaction: prepared, transactionHash: keccak256(prepared),
          gasSigner: signer.address, status: 'submitted', preparedAtMs: Date.now() });
      });
      row = await ref.get(); raw = row.get('signedTransaction');
    }
    if (typeof raw !== 'string' || keccak256(raw) !== row.get('transactionHash') || row.get('gasSigner') !== signer.address) {
      throw new Error('recourse_binding_record_invalid');
    }
    const calldata = REGISTRY_ABI.encodeFunctionData('bind', [[binding.identity, binding.address,
      binding.recoveryCommitment, binding.signingRoot, binding.kernel, binding.nonce, binding.expiresAtMs],
      row.get('ownerSignature'), row.get('identitySignature'), BigInt(String(row.get('revision')))]);
    validateTransaction(raw, signer.address, String(row.get('executor')), calldata);
    try {
      const terminal = await ports.finalized(raw);
      if (terminal) {
        let registration: Awaited<ReturnType<typeof readConfirmedBinding>>;
        try { registration = await ports.registration(binding); }
        catch (error) {
          if (error instanceof Error && error.message === 'recourse_binding_operation_retired') return finish('failed', error.message);
          throw error;
        }
        if (registration) {
          await confirmBindingRegistration(db, registration);
          return finish('confirmed', 'binding_finalized');
        }
        if (terminal.status === 1) throw new Error('recourse_binding_event_unconfirmed');
        return finish('failed', 'transaction_reverted');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'recourse_transaction_not_finalized') return 'submitted';
      throw error;
    }
    await renew();
    // An expired persisted transaction still owns its nonce. The exact signed
    // call either succeeds or reverts under the registry's on-chain guards.
    if (await signer.broadcast(raw) !== keccak256(raw)) throw new Error('recourse_binding_broadcast_mismatch');
    return 'submitted';
  } finally { await releaseSignerLease(settlementDb, { signer: signer.address, workerId, nowMs: Date.now() }); }
}
function validateTransaction(raw: string, signer: string, executor: string, calldata: string): void {
  const tx = Transaction.from(raw);
  if (!tx.signature || tx.from?.toLowerCase() !== signer || tx.chainId !== 8453n || tx.to?.toLowerCase() !== executor.toLowerCase()
    || tx.data !== calldata || tx.value !== 0n || tx.type !== 2 || tx.gasLimit <= 0n
    || tx.maxFeePerGas === null || tx.maxPriorityFeePerGas === null || tx.maxFeePerGas < tx.maxPriorityFeePerGas) {
    throw new Error('recourse_binding_signed_mismatch');
  }
}
