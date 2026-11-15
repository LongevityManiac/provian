import { findExecutedOwnerOperation } from './owner-operation-executed';
import { RESTORATION_REQUESTS } from './restoration-request';
import { randomUUID } from 'crypto';
import { acquireSignerLease, releaseSignerLease, listAllUnresolvedBatches, SETTLEMENT_CYCLES_COLLECTION,
  SETTLEMENT_SIGNER_LEASES_COLLECTION, type SettlementDb } from '../pvt/settlement/durable-settlement-store';
import type { Firestore } from 'firebase-admin/firestore';
import { keccak256, Transaction } from 'ethers';
import { OWNER_OPERATIONS, checkOwnerOperation, assertCheckedOwnerOperation,
  type CheckedOwnerOperation } from './owner-operation-queue';
import { parseRecoveryOwnerOperation, recoveryOperationId, recoveryOperationCall } from './owner-operation';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { concat, sha256 } from 'ethers';
import { finalizedOwnerTransaction } from './transaction-finality';

export interface OwnerOperationSigner {
  readonly address: string;
  /** Must return a signed Base transaction with zero value and the exact target/data.
   * Its adapter verifies current chain nonce and fee facts before signing. */
  sign(plan: CheckedOwnerOperation): Promise<string>;
  broadcast(raw: string): Promise<string>;
}
export interface OwnerOperationWorkerPorts {
  check: typeof checkOwnerOperation;
  verify: typeof verifyRecoveryAuthorization;
  finalized: typeof finalizedOwnerTransaction;
  executed?: typeof findExecutedOwnerOperation;
}
/** No raw generic execution route: targets and data are reconstructed from the
 * structurally kind-2-or-3-only record. Signed bytes are persisted before broadcast,
 * so retries rebroadcast the same nonce/hash instead of signing another spend. */
export async function executeOwnerOperation(db: Firestore, id: string, signer: OwnerOperationSigner,
  ports: OwnerOperationWorkerPorts = { check: checkOwnerOperation, verify: verifyRecoveryAuthorization,
    finalized: finalizedOwnerTransaction, executed:findExecutedOwnerOperation }): Promise<'submitted' | 'confirmed' | 'failed'> {
  if (!/^0x[0-9a-f]{64}$/.test(id) || !/^0x[0-9a-f]{40}$/.test(signer.address)) throw new Error('recourse_owner_worker_invalid');
  const workerId = `recourse-${randomUUID()}`;
  const settlementDb = db as unknown as SettlementDb;
  const renew = async () => {
    const lease = await acquireSignerLease(settlementDb, { signer: signer.address, workerId, nowMs: Date.now(), leaseTtlMs: 120_000, operationId: id });
    if (lease.kind !== 'acquired') throw new Error('recourse_owner_worker_signer_busy');
  };
  await renew();
  try { return await executeLeased(db, id, signer, ports, workerId, renew); }
  finally { await releaseSignerLease(settlementDb, { signer: signer.address, workerId, nowMs: Date.now() }); }
}
async function executeLeased(db: Firestore, id: string, signer: OwnerOperationSigner, ports: OwnerOperationWorkerPorts,
  workerId: string, renew: () => Promise<void>): Promise<'submitted' | 'confirmed' | 'failed'> {
  const ref = db.collection(OWNER_OPERATIONS).doc(id);
  let snapshot = await ref.get();
  if (!snapshot.exists) throw new Error('recourse_owner_operation_unknown');
  const operation = parseRecoveryOwnerOperation(snapshot.get('operation'));
  if (recoveryOperationId(operation) !== id) throw new Error('recourse_owner_worker_record_mismatch');
  if (snapshot.get('status') === 'confirmed') return 'confirmed';
  if (snapshot.get('status') === 'failed') return 'failed';
  const finish = async (status: 'confirmed' | 'failed', reason: string, unsigned = false, externalHash?: string) => {
    await db.runTransaction(async tx => {
      const leaseRef = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address);
      const [lease, current] = await Promise.all([tx.get(leaseRef), tx.get(ref)]);
      const pending: unknown = lease.get('pending_operation');
      if (lease.get('owner') !== workerId || (pending !== id && !(unsigned && (pending === undefined || pending === null)))
        || Number(lease.get('expires_at_ms')) <= Date.now()) throw new Error('recourse_owner_worker_lease_lost');
      if (unsigned && current.get('signedTransaction') !== undefined) throw new Error('recourse_owner_worker_state_invalid');
      if (!unsigned && current.get('signedTransaction') !== snapshot.get('signedTransaction')) throw new Error('recourse_owner_worker_record_changed');
      if (operation.restoration) {
        const requestRef = db.collection(RESTORATION_REQUESTS).doc(operation.restoration.request);
        const request = await tx.get(requestRef);
        if (!request.exists || request.get('destination') !== operation.destination) throw new Error('recourse_restoration_scope_unverified');
        if (request.get('ownerOperationId') !== id) {
          const successorId: unknown = request.get('ownerOperationId');
          if (status !== 'failed' || typeof successorId !== 'string' || !/^0x[0-9a-f]{64}$/.test(successorId)) throw new Error('recourse_restoration_scope_unverified');
          const successorRecord = await tx.get(db.collection(OWNER_OPERATIONS).doc(successorId));
          const successor = parseRecoveryOwnerOperation(successorRecord.get('operation'));
          if (recoveryOperationId(successor) !== successorId || successor.identity !== operation.identity
            || successor.destination !== operation.destination || successor.nonce !== operation.nonce
            || BigInt(successor.revision) <= BigInt(operation.revision)
            || successor.restoration?.request !== operation.restoration.request
            || successor.restoration.lossHash !== operation.restoration.lossHash
            || successor.restoration.maximumLoss !== operation.restoration.maximumLoss) throw new Error('recourse_restoration_scope_unverified');
        }
        if (request.get('ownerOperationId') === id) tx.update(requestRef, { status: status === 'confirmed' ? 'awaiting_determination' : 'authorization_failed',
          authorizationTxHash: externalHash ?? current.get('transactionHash'), authorizationFinalizedAtMs: Date.now() });
      }
      tx.update(ref, { status, terminalReason: reason, finalizedAtMs: Date.now(), ...(externalHash ? { transactionHash:externalHash, sponsoredTransactionHash:current.get('transactionHash') ?? null } : {}) });
      tx.update(leaseRef, { pending_operation: null });
    });
    return status;
  };
  const externallyExecuted = async () => ports.executed ? ports.executed(operation,String(snapshot.get('executor')),String(snapshot.get('queuedAtBlockHash'))) : null;
  let raw: unknown = snapshot.get('signedTransaction');
  if (raw === undefined) {
    // Settlement reservations can exist before there is a transaction in either
    // RPC's mempool. They must be reconciled by their own runner first.
    for (const batch of await listAllUnresolvedBatches(db as unknown as SettlementDb)) {
      const cycle = await db.collection(SETTLEMENT_CYCLES_COLLECTION).doc(batch.cycle_id).get();
      const cycleSigner: unknown = cycle.get('signer');
      if (typeof cycleSigner !== 'string' || cycleSigner.toLowerCase() === signer.address) {
        throw new Error('recourse_owner_worker_settlement_reserved');
      }
    }
    let plan: CheckedOwnerOperation;
    try { plan = await ports.check(operation); }
    catch (error) {
      // Nothing has been persisted or broadcast. Only an objectively retired
      // deployment or consumed owner nonce can retire this unsigned operation.
      if (error instanceof Error && ['recourse_owner_operation_retired', 'recourse_owner_operation_stale'].includes(error.message)) {
        const external = await externallyExecuted();
        if(external)return finish('confirmed',external.superseded?'authorization_superseded':'authorization_executed_by_other_sponsor',true,external.transactionHash);
        return finish('failed', error.message, true);
      }
      throw error;
    }
    assertCheckedOwnerOperation(plan);
    if (plan.gasPayer !== signer.address) throw new Error('recourse_owner_worker_wrong_gas_payer');
    // Reserve before signing. If signing or persistence crashes, only this
    // operation can reacquire the signer; another worker cannot reuse its nonce.
    await db.runTransaction(async tx => {
      const leaseRef = db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address);
      const lease = await tx.get(leaseRef);
      if (lease.get('owner') !== workerId || Number(lease.get('expires_at_ms')) <= Date.now()) throw new Error('recourse_owner_worker_lease_lost');
      const pending: unknown = lease.get('pending_operation');
      if (pending !== undefined && pending !== null && pending !== id) throw new Error('recourse_owner_worker_signer_busy');
      tx.update(leaseRef, { pending_operation: id });
    });
    const prepared = await signer.sign(plan);
    validateSigned(prepared, signer.address, plan);
    const transactionHash = keccak256(prepared);
    await db.runTransaction(async tx => {
      const [current, lease] = await Promise.all([tx.get(ref), tx.get(db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address))]);
      if (lease.get('owner') !== workerId || lease.get('pending_operation') !== id || Number(lease.get('expires_at_ms')) <= Date.now()) throw new Error('recourse_owner_worker_lease_lost');
      if (!current.exists || recoveryOperationId(parseRecoveryOwnerOperation(current.get('operation'))) !== id) throw new Error('recourse_owner_worker_record_changed');
      if (current.get('signedTransaction') !== undefined) return;
      if (current.get('status') !== 'queued') throw new Error('recourse_owner_worker_state_invalid');
      tx.update(ref, { signedTransaction: prepared, transactionHash, executor: plan.executor, gasPayer: plan.gasPayer,
        status: 'submitted', preparedAtMs: Date.now() });
    });
    snapshot = await ref.get(); raw = snapshot.get('signedTransaction');
  }
  if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/.test(raw)) throw new Error('recourse_owner_worker_transaction_missing');
  const transactionHash = keccak256(raw);
  if (snapshot.get('transactionHash') !== transactionHash) throw new Error('recourse_owner_worker_hash_mismatch');
  const executor: unknown = snapshot.get('executor');
  if (typeof executor !== 'string' || !/^0x[0-9a-f]{40}$/.test(executor)
    || snapshot.get('gasPayer') !== signer.address) throw new Error('recourse_owner_worker_record_mismatch');
  validateTransaction(raw, signer.address, executor, recoveryOperationCall(operation));
  // A persisted signed transaction may already be mined. Verify first so a lost
  // broadcast response never causes a second authorization or gas payment.
  const verify = async () => ports.verify({ kernel: operation.kernel, identity: operation.identity,
    destination: operation.destination, consumedCommitment: sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot])),
    nextCommitment: operation.proof.nextCommitment, nextSigningRoot: operation.proof.nextSigningRoot,
    nonce: operation.nonce, transactionHash });
  let terminal: Awaited<ReturnType<typeof finalizedOwnerTransaction>>;
  try { terminal = await ports.finalized(raw); }
  catch (error) {
    if (error instanceof Error && error.message === 'recourse_transaction_not_finalized') return 'submitted';
    throw error;
  }
  if (terminal !== null) {
    if (terminal.status === 0) {
      const external=await externallyExecuted();
      if(external)return finish('confirmed',external.superseded?'authorization_superseded':'authorization_executed_by_other_sponsor',false,external.transactionHash);
      return finish('failed','transaction_reverted');
    }
    try { await verify(); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'recourse_authorization_superseded') throw error;
      // Receipt success is final; current credentials still require their own
      // independent current-state verifier and cannot install this older intent.
      return finish('confirmed', 'authorization_superseded');
    }
    return finish('confirmed', 'authorization_finalized');
  }
  await renew();
  try {
    const plan = await ports.check(operation);
    assertCheckedOwnerOperation(plan);
    validateSigned(raw, signer.address, plan);
  } catch (error) {
    if (!(error instanceof Error) || !['recourse_owner_operation_retired', 'recourse_owner_operation_stale'].includes(error.message)) throw error;
    // Finish the exact already-signed transaction, including a now-inevitable
    // revert. Never free or reuse an unresolved signed nonce. Current-pointer
    // and owner-nonce guards in the executor prevent the retired operation.
  }
  if (await signer.broadcast(raw) !== transactionHash) throw new Error('recourse_owner_worker_broadcast_mismatch');
  return 'submitted';
}
function validateSigned(raw: string, gasPayer: string, plan: CheckedOwnerOperation): void {
  assertCheckedOwnerOperation(plan);
  if (gasPayer !== plan.gasPayer) throw new Error('recourse_owner_worker_signed_mismatch');
  validateTransaction(raw, gasPayer, plan.executor, plan.calldata);
}
function validateTransaction(raw: string, gasPayer: string, executor: string, calldata: string): void {
  const transaction = Transaction.from(raw);
  if (!transaction.signature || transaction.from?.toLowerCase() !== gasPayer
    || transaction.chainId !== 8453n || transaction.to?.toLowerCase() !== executor
    || transaction.data !== calldata || transaction.value !== 0n || transaction.type !== 2
    || transaction.gasLimit <= 0n || transaction.maxFeePerGas === null || transaction.maxPriorityFeePerGas === null
    || transaction.maxFeePerGas < transaction.maxPriorityFeePerGas) throw new Error('recourse_owner_worker_signed_mismatch');
}
