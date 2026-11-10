import { AbiCoder, Interface, ZeroAddress, concat, keccak256, sha256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { breakDeploymentChain } from './break-deployment-queue';
import { breakRestorationDetails, breakRestorationId, parseBreakRestorationRequest, type BreakRestorationRequest } from './break-restoration-data';
import { OWNER_EXECUTOR_ABI } from './owner-operation';
import type { OwnerOperationChain } from './owner-operation-queue';
import { verifyRecoveryAuthorization } from './recovery-authorization';
import { findExecutedRecovery } from './owner-operation-executed';

export const BREAK_RESTORATIONS = 'recourse_break_restorations_v1';
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function restorationAuthority() view returns(address)',
  'function kernel() view returns(address)', 'function breakOrigin() view returns(address)', 'function hashAccountCodeHash() view returns(bytes32)',
  'function predecessor() view returns(address)', 'function lastGoodBlock() view returns(uint256)', 'function restorationRoot() view returns(bytes32)',
  'function keyCommitment() view returns(bytes32)', 'function nonce() view returns(uint256)']);
export interface CheckedBreakRestoration {
  readonly id: string; readonly request: BreakRestorationRequest; readonly executor: string; readonly authority: string;
  readonly identity: string; readonly destination: string; readonly amount: string; readonly nonce: number;
  readonly authorityRoot: string; readonly authorityNonce: string; readonly targetRuntimeHash: string;
  readonly manifestHash: string; readonly blockHash: string;
}
const checked = new WeakSet<CheckedBreakRestoration>();
export function assertCheckedBreakRestoration(plan: CheckedBreakRestoration): void {
  if (!checked.has(plan)) throw Error('break_restoration_unverified');
}
/** The relay verifies the exact owner-signed snapshot restoration but cannot
 * execute it. A separate hash-held authority must authorize this same call. */
export async function checkBreakRestoration(value: unknown, port: OwnerOperationChain = breakDeploymentChain()): Promise<CheckedBreakRestoration> {
  const request = parseBreakRestorationRequest(value), details = breakRestorationDetails(request);
  const deployment = await port.deployment();
  if (deployment.addresses.kernel.toLowerCase() !== request.kernel) throw Error('break_restoration_retired');
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, iface: Interface, name: string, args: readonly unknown[] = []) => {
    const raw = await port.agree('eth_call', [{ to, data: iface.encodeFunctionData(name, args) }, tag]);
    if (typeof raw !== 'string') throw Error('break_restoration_rpc_invalid');
    return iface.decodeFunctionResult(name, raw)[0];
  };
  const executor = String(await call(request.kernel, abi, 'ownerAuthorization')).toLowerCase();
  const authority = String(await call(request.kernel, abi, 'restorationAuthority')).toLowerCase();
  if ([executor, authority].includes(ZeroAddress) || String(await call(executor, abi, 'kernel')).toLowerCase() !== request.kernel) throw Error('break_restoration_binding_invalid');
  const origin = String(await call(executor, abi, 'breakOrigin')).toLowerCase();
  if (origin === ZeroAddress) throw Error('break_restoration_origin_invalid');
  const [previous, block, root] = await Promise.all(['predecessor','lastGoodBlock','restorationRoot'].map(name => call(origin, abi, name)));
  const coder = AbiCoder.defaultAbiCoder();
  let leaf = sha256(coder.encode(['string','address','uint256','bytes32','uint256','bytes32'],
    ['Provian restoration', previous, block, details.identity, details.amount, details.commitment]));
  for (const sibling of details.snapshotProof) leaf = sha256(concat(leaf < sibling ? [leaf, sibling] : [sibling, leaf]));
  const operation = sha256(coder.encode(['string','bytes32','uint256','address','bytes32','address','uint256'],
    ['Provian cryptographic break', details.identity, details.amount, details.destination, details.destinationKeyRoot, previous, block]));
  if (leaf !== root || operation !== details.operationHash) throw Error('break_restoration_entitlement_invalid');
  const accountHash = await call(executor, abi, 'hashAccountCodeHash');
  for (const account of [authority, details.destination]) {
    const code = await port.agree('eth_getCode', [account, tag]);
    if (typeof code !== 'string' || code === '0x' || keccak256(code) !== accountHash) throw Error('break_restoration_hash_account_required');
  }
  if (await call(details.destination, abi, 'keyCommitment') !== details.destinationKeyRoot) throw Error('break_restoration_destination_changed');
  const nonce = BigInt(await call(executor, OWNER_EXECUTOR_ABI, 'ownerAuthorizationNonce', [details.identity]));
  if (nonce >= BigInt(Number.MAX_SAFE_INTEGER) || await call(executor, OWNER_EXECUTOR_ABI, 'ownerRecoveryCommitment', [details.identity]) !== details.commitment
    || await call(executor, OWNER_EXECUTOR_ABI, 'ownerSigningRoot', [details.identity]) !== details.proof.signingRoot) throw Error('break_restoration_owner_changed');
  const computedIntent = sha256(coder.encode(['string','uint256','address','bytes32','bytes32','uint256','bytes32','bytes32','bytes32'],
    ['Provian restoration owner authorization', 8453, request.kernel, details.identity, details.commitment, nonce,
      operation, details.proof.nextCommitment, details.proof.nextSigningRoot]));
  if (computedIntent !== request.ownerIntent || await call(executor, OWNER_EXECUTOR_ABI, 'ownerAuthorizationDigest',
    [details.identity, operation, details.proof.nextCommitment, details.proof.nextSigningRoot]) !== request.ownerIntent) throw Error('break_restoration_intent_invalid');
  // This simulation checks the actual on-chain SLH verifier and full snapshot
  // authorization. Supplying a sender to eth_call does not create its signature.
  if (await port.agree('eth_call', [{ to: executor, from: authority, data: request.data }, tag]) !== '0x') throw Error('break_restoration_simulation_invalid');
  const authorityRoot = String(await call(authority, abi, 'keyCommitment'));
  const authorityNonce = String(await call(authority, abi, 'nonce'));
  const code = await port.agree('eth_getCode', [executor, tag]);
  if (typeof code !== 'string' || code === '0x') throw Error('break_restoration_executor_invalid');
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_restoration_protocol_changed');
  const result = { id: breakRestorationId(request), request, executor, authority, identity: details.identity, destination: details.destination,
    amount: details.amount, nonce: Number(nonce), authorityRoot, authorityNonce, targetRuntimeHash: keccak256(code),
    manifestHash: deployment.manifestHash, blockHash: deployment.blockHash };
  checked.add(result); return result;
}
export interface BreakRestorationStatus { readonly id: string; readonly status: 'awaiting_authority' | 'submitted' | 'confirmed'; readonly transactionHash: string | null; }
export async function readBreakRestoration(db: Firestore, id: string): Promise<BreakRestorationStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('break_restoration_invalid');
  const row = await db.collection(BREAK_RESTORATIONS).doc(id).get();
  const status: unknown = row.get('status'), hash: unknown = row.get('transactionHash');
  if (!row.exists || !['awaiting_authority','submitted','confirmed'].includes(String(status))
    || (hash !== null && (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(hash)))) throw Error('break_restoration_unknown');
  return { id, status: status as BreakRestorationStatus['status'], transactionHash: hash as string | null };
}
export async function queueBreakRestoration(db: Firestore, value: unknown, port?: OwnerOperationChain): Promise<BreakRestorationStatus> {
  const request = parseBreakRestorationRequest(value), id = breakRestorationId(request), ref = db.collection(BREAK_RESTORATIONS).doc(id);
  if ((await ref.get()).exists) return readBreakRestoration(db, id);
  const plan = await checkBreakRestoration(request, port);
  await db.runTransaction(async tx => {
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, { request, executor: plan.executor, authority: plan.authority, identity: plan.identity,
      destination: plan.destination, amount: plan.amount, nonce: plan.nonce, queuedAtBlockHash: plan.blockHash,
      status: 'awaiting_authority', transactionHash: null, createdAtMs: Date.now() });
  });
  return readBreakRestoration(db, id);
}
/** Any sponsor may supply a public transaction hash. Only finalized independent
 * chain evidence can complete the request or authorize credential installation. */
export async function confirmBreakRestoration(db: Firestore, id: string, transactionHash: string,
  verify: typeof verifyRecoveryAuthorization = verifyRecoveryAuthorization, port: OwnerOperationChain = breakDeploymentChain()): Promise<BreakRestorationStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id) || !/^0x[0-9a-f]{64}$/.test(transactionHash)) throw Error('break_restoration_invalid');
  const ref = db.collection(BREAK_RESTORATIONS).doc(id), row = await ref.get();
  const request = parseBreakRestorationRequest(row.get('request')), details = breakRestorationDetails(request);
  if (breakRestorationId(request) !== id) throw Error('break_restoration_record_changed');
  const deployment = await port.deployment();
  try {
    await verify({ kernel: request.kernel, currentKernel: deployment.addresses.kernel.toLowerCase(), identity: details.identity,
      destination: details.destination, consumedCommitment: details.commitment, nextCommitment: details.proof.nextCommitment,
      nextSigningRoot: details.proof.nextSigningRoot, nonce: row.get('nonce') as number, transactionHash,
      breakDestinationRoot: details.destinationKeyRoot, expectedIntent: request.ownerIntent });
  } catch (error) {
    // This verifier reports supersession only after proving the exact finalized
    // receipt and rechecking both block hashes. Completion grants no credentials.
    if (!(error instanceof Error) || error.message !== 'recourse_authorization_superseded') throw error;
  }
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (breakRestorationId(parseBreakRestorationRequest(current.get('request'))) !== id) throw Error('break_restoration_record_changed');
    if (current.get('status') === 'confirmed' && current.get('transactionHash') !== transactionHash) throw Error('break_restoration_outcome_changed');
    tx.update(ref, { status: 'confirmed', transactionHash, confirmedAtMs: Date.now() });
  });
  return readBreakRestoration(db, id);
}
export async function reconcileBreakRestoration(db: Firestore, id: string): Promise<BreakRestorationStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('break_restoration_invalid');
  const row = await db.collection(BREAK_RESTORATIONS).doc(id).get();
  if (row.get('status') === 'confirmed') return readBreakRestoration(db, id);
  const request = parseBreakRestorationRequest(row.get('request')), details = breakRestorationDetails(request);
  if (breakRestorationId(request) !== id) throw Error('break_restoration_record_changed');
  const executed = await findExecutedRecovery({ kernel: request.kernel, identity: details.identity, destination: details.destination,
    nonce: row.get('nonce') as number, proof: details.proof, breakDestinationRoot: details.destinationKeyRoot },
  request.ownerIntent, String(row.get('executor')), String(row.get('queuedAtBlockHash')));
  return executed ? confirmBreakRestoration(db, id, executed.transactionHash) : readBreakRestoration(db, id);
}
