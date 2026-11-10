import { RESTORATION_REQUESTS } from './restoration-request';
import type { Firestore } from 'firebase-admin/firestore';
import { Interface, concat, sha256 } from 'ethers';
import { currentProtocolDeployment } from '../protocol/runtime';
import type { ProtocolDeployment } from '../protocol/pointer';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import { RECOURSE_COLLECTIONS } from './ownership';
import { OWNER_EXECUTOR_ABI, OWNER_KERNEL_ABI, ownerOperationIntent, recoveryOperationCall,
  recoveryOperationHash, recoveryOperationId, parseRestorationScope, parseRecoveryOwnerOperation, type RecoveryOwnerOperation } from './owner-operation';

export const OWNER_SPONSOR_ABI = new Interface(['function kernel() view returns(address)', 'function pool() view returns(address)', 'function submitter() view returns(address)']);
export const OWNER_OPERATIONS = 'recourse_owner_operations_v1';
export interface OwnerOperationChain {
  deployment(): Promise<ProtocolDeployment>;
  agree(method: string, params: readonly unknown[]): Promise<unknown>;
}
function chainPort(): OwnerOperationChain {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw new Error('recourse_rpc_operators_not_independent');
  return { deployment: currentProtocolDeployment, async agree(method, params) {
    const values = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(values[0], values[1])) throw new Error('recourse_owner_operation_rpc_disagreement');
    return values[0];
  } };
}
export interface CheckedOwnerOperation {
  readonly id: string; readonly operation: RecoveryOwnerOperation;
  readonly gasPayer: string; readonly executor: string; readonly calldata: string;
  readonly blockHash: string; readonly manifestHash: string;
}
const checked = new WeakSet<CheckedOwnerOperation>();
export function assertCheckedOwnerOperation(value: CheckedOwnerOperation): void {
  if (!checked.has(value)) throw new Error('recourse_owner_operation_unverified');
}
/** Repeat immediately before sponsor signing. Simulation executes the actual
 * hash verifier and nonce/commitment transition at one independently agreed block. */
export async function checkOwnerOperation(value: unknown, port = chainPort()): Promise<CheckedOwnerOperation> {
  const operation = parseRecoveryOwnerOperation(value);
  const deployment = await port.deployment();
  if (operation.kernel !== deployment.addresses.kernel.toLowerCase() || operation.revision !== deployment.revision.toString()) throw new Error('recourse_owner_operation_retired');
  const pin = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (target: string, abi: typeof OWNER_KERNEL_ABI, name: string, args: readonly unknown[] = []) => {
    const value = await port.agree('eth_call', [{ to: target, data: abi.encodeFunctionData(name, args) }, pin]);
    if (typeof value !== 'string') throw new Error('recourse_owner_operation_rpc_invalid');
    return abi.decodeFunctionResult(name, value);
  };
  const [executorResult, minterResult] = await Promise.all([
    call(operation.kernel, OWNER_KERNEL_ABI, 'ownerAuthorization'), call(operation.kernel, OWNER_KERNEL_ABI, 'operationalMinter'),
  ]);
  const settlement = deployment.addresses.settlement.toLowerCase();
  if (String(minterResult[0]).toLowerCase() !== settlement) throw new Error('recourse_owner_sponsor_binding_invalid');
  const [submitter, sponsorKernel, sponsorPool] = await Promise.all([
    call(settlement,OWNER_SPONSOR_ABI,'submitter'),call(settlement,OWNER_SPONSOR_ABI,'kernel'),call(settlement,OWNER_SPONSOR_ABI,'pool'),
  ]);
  if(String(sponsorKernel[0]).toLowerCase()!==operation.kernel || String(sponsorPool[0]).toLowerCase()!==deployment.addresses.recoursePool.toLowerCase()) throw new Error('recourse_owner_sponsor_binding_invalid');
  const executor = String(executorResult[0]).toLowerCase(), gasPayer = String(submitter[0]).toLowerCase();
  if ([executor, gasPayer].some(address => !/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address))) throw new Error('recourse_owner_operation_gas_payer_invalid');
  const [nonce, commitment, root, digest] = await Promise.all([
    call(executor, OWNER_EXECUTOR_ABI, 'ownerAuthorizationNonce', [operation.identity]),
    call(executor, OWNER_EXECUTOR_ABI, 'ownerRecoveryCommitment', [operation.identity]),
    call(executor, OWNER_EXECUTOR_ABI, 'ownerSigningRoot', [operation.identity]),
    call(executor, OWNER_EXECUTOR_ABI, 'ownerAuthorizationDigest', [operation.identity,
      recoveryOperationHash(operation.identity, operation.destination, operation.restoration), operation.proof.nextCommitment, operation.proof.nextSigningRoot]),
  ]);
  if (nonce[0] !== BigInt(operation.nonce) || root[0] !== operation.proof.signingRoot
    || commitment[0] !== sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot]))
    || digest[0] !== ownerOperationIntent(operation)) throw new Error('recourse_owner_operation_stale');
  const calldata = recoveryOperationCall(operation);
  const simulation = await port.agree('eth_call', [{ to: executor, from: gasPayer, data: calldata }, pin]);
  if (simulation !== '0x') throw new Error('recourse_owner_operation_simulation_invalid');
  const latest = await port.deployment();
  if (latest.manifestHash !== deployment.manifestHash) throw new Error('recourse_owner_operation_retired');
  const result = { id: recoveryOperationId(operation), operation, gasPayer, executor, calldata,
    blockHash: deployment.blockHash, manifestHash: deployment.manifestHash };
  checked.add(result);
  return result;
}
/** A historical loss retains its original kernel. Ordinary executor ancestry,
 * rather than a rewritten loss record, authenticates its successor execution. */
async function assertExecutionAncestry(previousKernel: string, plan: CheckedOwnerOperation, port: OwnerOperationChain): Promise<void> {
  if (previousKernel === plan.operation.kernel) return;
  const pin = { blockHash: plan.blockHash, requireCanonical: true };
  const call = async (target: string, abi: typeof OWNER_EXECUTOR_ABI, method: string) => {
    const raw = await port.agree('eth_call', [{ to: target, data: abi.encodeFunctionData(method) }, pin]);
    if (typeof raw !== 'string') throw new Error('recourse_restoration_ancestry_invalid');
    return String(abi.decodeFunctionResult(method, raw)[0]).toLowerCase();
  };
  const ancestor = await call(previousKernel, OWNER_KERNEL_ABI, 'ownerAuthorization');
  let executor = plan.executor;
  const seen = new Set<string>();
  while (executor !== ancestor) {
    if (!/^0x[0-9a-f]{40}$/.test(executor) || /^0x0+$/.test(executor) || seen.has(executor)) throw new Error('recourse_restoration_ancestry_invalid');
    seen.add(executor);
    executor = await call(executor, OWNER_EXECUTOR_ABI, 'previousAuthorization');
  }
}
export interface OwnerOperationStatus { readonly id: string; readonly status: 'queued' | 'submitted' | 'confirmed' | 'failed'; readonly transactionHash: string | null; }
function status(id: string, row: Record<string, unknown>): OwnerOperationStatus {
  if (!['queued', 'submitted', 'confirmed', 'failed'].includes(String(row.status))
    || (row.transactionHash !== null && (typeof row.transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.transactionHash)))) throw new Error('recourse_owner_operation_record_invalid');
  return { id, status: row.status as OwnerOperationStatus['status'], transactionHash: row.transactionHash as string | null };
}
export async function readOwnerOperation(db: Firestore, id: string): Promise<OwnerOperationStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error('recourse_owner_operation_invalid');
  const record = await db.collection(OWNER_OPERATIONS).doc(id).get();
  if (!record.exists) throw new Error('recourse_owner_operation_unknown');
  return status(id, record.data()!);
}
export async function queueOwnerOperation(db: Firestore, value: unknown, port?: OwnerOperationChain): Promise<OwnerOperationStatus> {
  const operation = parseRecoveryOwnerOperation(value);
  const id = recoveryOperationId(operation);
  const ref = db.collection(OWNER_OPERATIONS).doc(id);
  // A valid exact-intent operation can be resumed after its nonce was consumed.
  // The record ID commits every effect; callers cannot change a queued target.
  const existing = await ref.get();
  if (existing.exists) return status(id, existing.data()!);
  const executionPort = port ?? chainPort();
  const plan = await checkOwnerOperation(operation, executionPort);
  let supersedes: string | null = null;
  if (operation.restoration) {
    const request = await db.collection(RESTORATION_REQUESTS).doc(operation.restoration.request).get();
    const snapshot: unknown = request.get('snapshot');
    if (!snapshot || typeof snapshot !== 'object' || !('kernel' in snapshot) || typeof snapshot.kernel !== 'string') throw new Error('recourse_restoration_scope_unverified');
    await assertExecutionAncestry(snapshot.kernel, plan, executionPort);
    const oldId: unknown = request.get('ownerOperationId');
    if (oldId !== undefined && oldId !== id) {
      if (typeof oldId !== 'string' || !/^0x[0-9a-f]{64}$/.test(oldId)) throw new Error('recourse_restoration_scope_unverified');
      const oldRecord = await db.collection(OWNER_OPERATIONS).doc(oldId).get();
      const old = parseRecoveryOwnerOperation(oldRecord.get('operation'));
      if (!oldRecord.exists || oldRecord.get('status') === 'confirmed' || recoveryOperationId(old) !== oldId
        || old.identity !== operation.identity || old.destination !== operation.destination || old.nonce !== operation.nonce
        || !old.restoration || old.restoration.request !== operation.restoration.request
        || old.restoration.lossHash !== operation.restoration.lossHash || old.restoration.maximumLoss !== operation.restoration.maximumLoss
        || BigInt(old.revision) >= BigInt(operation.revision)) throw new Error('recourse_restoration_scope_unverified');
      // The new checked operation already proves the same nonce/commitment is
      // unconsumed. The permanent pointer's higher revision makes old calldata
      // unexecutable. Signed outer transactions retain their signer lease until
      // their original worker reconciles them; no nonce is reused here.
      supersedes = oldId;
    }
  }
  const ownerRef = db.collection(RECOURSE_COLLECTIONS.identities).doc(operation.identity);
  return db.runTransaction(async tx => {
    const [current, owner] = await Promise.all([tx.get(ref), tx.get(ownerRef)]);
    if (current.exists) return status(id, current.data()!);
    if (!owner.exists || owner.get('recoveryCommitment') !== sha256(concat([operation.proof.recoverySecret, operation.proof.signingRoot]))
      || owner.get('signingRoot') !== operation.proof.signingRoot) throw new Error('recourse_owner_operation_identity_invalid');
    if (operation.restoration) {
      const requestRef = db.collection(RESTORATION_REQUESTS).doc(operation.restoration.request);
      const request = await tx.get(requestRef);
      const snapshot: unknown = request.get('snapshot');
      if (!request.exists || !snapshot || typeof snapshot !== 'object' || !('kernel' in snapshot)
        || !('addresses' in snapshot) || !Array.isArray(snapshot.addresses) || snapshot.addresses.length === 0
        || snapshot.addresses.some((row: unknown) => !row || typeof row !== 'object' || !('address' in row) || row.address === operation.destination)
        || request.get('identity') !== operation.identity
        || parseRestorationScope(request.get('scope')).lossHash !== operation.restoration.lossHash
        || parseRestorationScope(request.get('scope')).maximumLoss !== operation.restoration.maximumLoss
        || !['prepared', 'authorization_queued', 'authorization_failed'].includes(String(request.get('status')))
        || (request.get('ownerOperationId') && request.get('ownerOperationId') !== id && request.get('ownerOperationId') !== supersedes)) throw new Error('recourse_restoration_scope_unverified');
      tx.update(requestRef, { status: 'authorization_queued', ownerOperationId: id, destination: operation.destination,
        ...(supersedes ? { supersededOwnerOperationId: supersedes } : {}) });
    }
    // This is intentionally public transaction calldata, including the revealed
    // recovery preimage and exact-intent signature, not a signing key or seed.
    // Private-store encryption additionally protects it while awaiting execution.
    tx.create(ref, { operation, executor: plan.executor, gasPayer: plan.gasPayer, manifestHash: plan.manifestHash, queuedAtBlockHash:plan.blockHash,
      status: 'queued', transactionHash: null, createdAtMs: Date.now() });
    return { id, status: 'queued', transactionHash: null };
  });
}
