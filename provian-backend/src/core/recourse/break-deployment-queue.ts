import { recourseLaneAddress } from './transaction-lane-key';
import { laneQueuedFields, laneHoldsOperation } from './transaction-lane';
import { AbiCoder, Interface, ZeroAddress, Transaction, concat, getBytes, keccak256, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { currentProtocolDeployment } from '../protocol/runtime';
import { getOperatorBoundRpcLegs } from '../onchain/rpc-provider';
import { rpcChainFactsEqual } from '../onchain/rpc-chain-facts';
import type { OwnerOperationChain } from './owner-operation-queue';
import { accountDeploymentDigest, parseAccountDeploymentRequest, type AccountDeploymentRequest } from './break-deployment-data';
import { finalizedOwnerTransaction } from './transaction-finality';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';

const abi = new Interface([
  'function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function restorationRoot() view returns(bytes32)',
  'function hashAccountFactory() view returns(address)', 'function hashAccountCodeHash() view returns(bytes32)',
  'function accountAddress(bytes32) view returns(address)', 'function deploy(bytes32) returns(address)',
  'function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)',
  'function ownerAuthorizationNonce(bytes32) view returns(uint256)', 'function ownerRecoveryCommitment(bytes32) view returns(bytes32)',
  'function ownerSigningRoot(bytes32) view returns(bytes32)', 'function recoveredDestination(bytes32) view returns(address)',
  'function operationalMinter() view returns(address)', 'function submitter() view returns(address)', 'function pool() view returns(address)',
]);
export const BREAK_DEPLOYMENTS = 'recourse_break_deployments_v1';
export const BREAK_DEPLOYMENT_SLOTS = 'recourse_break_deployment_slots_v1';
export const BREAK_DEPLOYMENT_ATTEMPTS = 'recourse_break_deployment_attempts_v1';
export interface CheckedBreakDeployment {
  readonly id: string; readonly request: AccountDeploymentRequest; readonly executor: string; readonly calldata: string;
  readonly gasPayer: string; readonly manifestHash: string; readonly blockHash: string; readonly alreadyDeployed: boolean;
}
const checked = new WeakSet<CheckedBreakDeployment>();
export function assertCheckedBreakDeployment(plan: CheckedBreakDeployment): void {
  if (!checked.has(plan)) throw Error('break_deployment_unverified');
}
export function breakDeploymentChain(): OwnerOperationChain {
  const legs = getOperatorBoundRpcLegs('base');
  if (legs[0].operatorId === legs[1].operatorId) throw Error('recourse_rpc_operators_not_independent');
  return { deployment: () => currentProtocolDeployment({ fresh: true }), async agree(method, params) {
    const values = await Promise.all(legs.map(leg => leg.provider.send(method, [...params])));
    if (!rpcChainFactsEqual(values[0], values[1])) throw Error('break_deployment_rpc_disagreement');
    return values[0];
  } };
}
/** Signature, snapshot membership and factory binding precede any gas spend.
 * The gas key has no restoration-authority role. */
export async function checkBreakDeployment(value: unknown, port: OwnerOperationChain = breakDeploymentChain(),
  sponsor: string = recourseLaneAddress()): Promise<CheckedBreakDeployment> {
  const request = parseAccountDeploymentRequest(value), id = accountDeploymentDigest(request);
  if (sha256(request.publicKey) !== request.signingRoot
    || sha256(concat([request.recoverySecret, request.signingRoot])) !== request.commitment) throw Error('break_deployment_owner_proof_invalid');
  const { slh_dsa_sha2_128s } = await import('@noble/post-quantum/slh-dsa.js');
  if (!slh_dsa_sha2_128s.verify(getBytes(request.signature), getBytes(id), getBytes(request.publicKey))) throw Error('break_deployment_owner_proof_invalid');
  const deployment = await port.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, method: string, args: readonly unknown[] = []) => {
    const raw = await port.agree('eth_call', [{ to, data: abi.encodeFunctionData(method, args) }, tag]);
    if (typeof raw !== 'string') throw Error('break_deployment_rpc_invalid');
    return abi.decodeFunctionResult(method, raw)[0];
  };
  const authorization = String(await call(kernel, 'ownerAuthorization')).toLowerCase();
  if (authorization === ZeroAddress || String(await call(authorization, 'kernel')).toLowerCase() !== kernel) throw Error('break_deployment_binding_invalid');
  if (String(await call(authorization, 'breakOrigin')).toLowerCase() !== request.breakOrigin) throw Error('break_deployment_retired');
  if (String(await call(request.breakOrigin, 'hashAccountFactory')).toLowerCase() !== request.factory
    || String(await call(request.factory, 'accountAddress', [request.initialRoot])).toLowerCase() !== request.account) throw Error('break_deployment_binding_invalid');
  if (request.kind === 'replacement') {
    if (request.kernel !== kernel || request.revision !== String(deployment.revision)) throw Error('break_deployment_retired');
    if (String(await call(authorization, 'ownerAuthorizationNonce', [request.identity])) !== String(request.nonce)
      || String(await call(authorization, 'ownerRecoveryCommitment', [request.identity])) !== request.commitment
      || String(await call(authorization, 'ownerSigningRoot', [request.identity])) !== request.signingRoot) throw Error('break_deployment_owner_changed');
    const destination = String(await call(authorization, 'recoveredDestination', [request.identity])).toLowerCase();
    if (destination === ZeroAddress || destination === request.account) throw Error('break_deployment_destination_invalid');
  } else {
    const [previous, cutoff, root] = await Promise.all(['predecessor', 'lastGoodBlock', 'restorationRoot'].map(method => call(request.breakOrigin, method)));
    let leaf = sha256(AbiCoder.defaultAbiCoder().encode(['string', 'address', 'uint256', 'bytes32', 'uint256', 'bytes32'],
      ['Provian restoration', previous, cutoff, request.identity, request.amount, request.commitment]));
    for (const sibling of request.proof) leaf = sha256(concat(leaf < sibling ? [leaf, sibling] : [sibling, leaf]));
    if (leaf !== root) throw Error('break_deployment_entitlement_invalid');
  }
  const code = await port.agree('eth_getCode', [request.account, tag]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(code)) throw Error('break_deployment_rpc_invalid');
  // CREATE2 binds the initial root. A subsequently rotated account has already
  // completed deployment; consumers independently check its current credentials.
  if (code !== '0x' && keccak256(code) !== await call(authorization, 'hashAccountCodeHash')) throw Error('break_deployment_account_changed');
  const settlement = deployment.addresses.settlement.toLowerCase();
  if (String(await call(kernel, 'operationalMinter')).toLowerCase() !== settlement
    || String(await call(settlement, 'kernel')).toLowerCase() !== kernel
    || String(await call(settlement, 'pool')).toLowerCase() !== deployment.addresses.recoursePool.toLowerCase()) throw Error('break_deployment_sponsor_invalid');
  // Gas comes from the Recourse lane, never the settlement submitter.
  const submitter = String(await call(settlement, 'submitter')).toLowerCase(), gasPayer = sponsor.toLowerCase();
  if (submitter === ZeroAddress || gasPayer === submitter || !/^0x[0-9a-f]{40}$/.test(gasPayer)) throw Error('break_deployment_sponsor_invalid');
  const calldata = abi.encodeFunctionData('deploy', [request.initialRoot]);
  const simulated = await port.agree('eth_call', [{ to: request.factory, from: gasPayer, data: calldata }, tag]);
  if (typeof simulated !== 'string' || String(abi.decodeFunctionResult('deploy', simulated)[0]).toLowerCase() !== request.account) throw Error('break_deployment_simulation_invalid');
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_deployment_protocol_changed');
  const result = { id, request, executor: request.factory, calldata, gasPayer, manifestHash: deployment.manifestHash,
    blockHash: deployment.blockHash, alreadyDeployed: code !== '0x' };
  checked.add(result); return result;
}
export interface BreakDeploymentStatus {
  readonly id: string; readonly status: 'queued' | 'submitted' | 'confirmed' | 'failed'; readonly transactionHash: string | null;
}
export async function readBreakDeployment(db: Firestore, id: string): Promise<BreakDeploymentStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('break_deployment_id_invalid');
  const record = await db.collection(BREAK_DEPLOYMENTS).doc(id).get();
  const status: unknown = record.get('status'), transactionHash: unknown = record.get('transactionHash');
  if (!record.exists || !['queued', 'submitted', 'confirmed', 'failed'].includes(String(status))
    || (transactionHash !== null && (typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(transactionHash)))) throw Error('break_deployment_unknown');
  return { id, status: status as BreakDeploymentStatus['status'], transactionHash: transactionHash as string | null };
}
export async function queueBreakDeployment(db: Firestore, value: unknown, port?: OwnerOperationChain,
  finalized: typeof finalizedOwnerTransaction = finalizedOwnerTransaction): Promise<BreakDeploymentStatus> {
  const request = parseAccountDeploymentRequest(value), id = accountDeploymentDigest(request);
  const ref = db.collection(BREAK_DEPLOYMENTS).doc(id);
  const prior = await ref.get();
  if (prior.exists && prior.get('status') !== 'failed') return readBreakDeployment(db, id);
  const oldRaw: unknown = prior.get('signedTransaction');
  let oldSigner: string | null = null;
  if (oldRaw !== undefined) {
    if (typeof oldRaw !== 'string' || keccak256(oldRaw) !== prior.get('transactionHash')) throw Error('break_deployment_record_mismatch');
    const transaction = Transaction.from(oldRaw);
    if (!transaction.from || transaction.chainId !== 8453n || transaction.to?.toLowerCase() !== request.factory
      || transaction.data !== abi.encodeFunctionData('deploy', [request.initialRoot]) || transaction.value !== 0n) throw Error('break_deployment_record_mismatch');
    const outcome = await finalized(oldRaw);
    if (outcome === null || outcome.status !== 0) throw Error('break_deployment_retry_unreconciled');
    oldSigner = transaction.from.toLowerCase();
  }
  const plan = await checkBreakDeployment(request, port);
  const slotRef = db.collection(BREAK_DEPLOYMENT_SLOTS).doc(sha256(AbiCoder.defaultAbiCoder().encode(
    request.kind === 'deploy' ? ['address', 'bytes32'] : ['string', 'address', 'uint256', 'bytes32', 'uint256'],
    request.kind === 'deploy' ? [request.breakOrigin, request.identity]
      : ['replacement', request.kernel, request.revision, request.identity, request.nonce])));
  await db.runTransaction(async tx => {
    const [current, slot] = await Promise.all([tx.get(ref), tx.get(slotRef)]);
    if (current.exists && current.get('status') !== 'failed') return;
    if (current.get('signedTransaction') !== oldRaw) throw Error('break_deployment_record_changed');
    const archiveRef = oldRaw === undefined ? null : db.collection(BREAK_DEPLOYMENT_ATTEMPTS).doc(`${id}_${keccak256(String(oldRaw))}`);
    const archive = archiveRef ? await tx.get(archiveRef) : null;
    if (oldSigner !== null) {
      const lease = await tx.get(db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(oldSigner));
      if (lease.get('pending_operation') === id || await laneHoldsOperation(tx, db, oldSigner, BREAK_DEPLOYMENTS, id)) throw Error('break_deployment_retry_unreconciled');
    }
    const selected: unknown = slot.get('operation');
    if (slot.exists && selected !== id) {
      if (typeof selected !== 'string' || !/^0x[0-9a-f]{64}$/.test(selected)) throw Error('break_deployment_slot_invalid');
      const previous = await tx.get(db.collection(BREAK_DEPLOYMENTS).doc(selected));
      // A durable destination fixes one workflow per entitlement. Replacement
      // is possible only after an obsolete unsigned reservation was released.
      if (!previous.exists || previous.get('status') !== 'failed' || previous.get('signedTransaction') !== undefined) throw Error('break_deployment_destination_selected');
    }
    if (archiveRef && !archive?.exists) tx.create(archiveRef, { operation: id, signedTransaction: oldRaw,
      transactionHash: keccak256(String(oldRaw)), status: 'finalized_revert', archivedAtMs: Date.now() });
    tx.set(ref, { request, executor: plan.executor, gasPayer: plan.gasPayer, manifestHash: plan.manifestHash,
      queuedAtBlockHash: plan.blockHash, status: plan.alreadyDeployed ? 'confirmed' : 'queued', transactionHash: null, createdAtMs: Date.now(),
      ...(plan.alreadyDeployed ? {} : laneQueuedFields(Date.now(), id)) });
    tx.set(slotRef, { operation: id, breakOrigin: request.breakOrigin, identity: request.identity, account: request.account });
  });
  return readBreakDeployment(db, id);
}
