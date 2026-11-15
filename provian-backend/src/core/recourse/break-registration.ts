import { Interface, Transaction, Wallet, ZeroHash, keccak256 } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { breakDeploymentChain, checkBreakDeployment } from './break-deployment-queue';
import { parseBreakRegistration, breakRegistrationId, type BreakRegistrationRequest } from './break-registration-data';
export { parseBreakRegistration, breakRegistrationId, type BreakRegistrationRequest } from './break-registration-data';
import type { OwnerOperationChain } from './owner-operation-queue';
import { executeSponsoredOperation, type SponsoredOperationSigner } from './sponsored-operation-worker';
import { finalizedOwnerTransaction } from './transaction-finality';
import { createRecourseGasSigner } from './gas-signer';
import { SETTLEMENT_SIGNER_LEASES_COLLECTION } from '../pvt/settlement/durable-settlement-store';

export const BREAK_REGISTRATIONS = 'recourse_break_registrations_v1';
const abi = new Interface(['function ownerAuthorization() view returns(address)',
  'function ownerRecoveryCommitment(bytes32) view returns(bytes32)', 'function ownerSigningRoot(bytes32) view returns(bytes32)',
  'function restoredIdentity(bytes32) view returns(bool)',
  'function registerBreakOwner(bytes32,uint256,bytes32,bytes32,bytes32[])']);
function calldata(request: BreakRegistrationRequest): string {
  const p = request.deployment;
  return abi.encodeFunctionData('registerBreakOwner', [p.identity, p.amount, p.recoverySecret, p.signingRoot, p.proof]);
}
function target(_request: BreakRegistrationRequest, value: unknown): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/.test(value) || /^0x0+$/.test(value)) throw Error('break_registration_executor_invalid');
  return value;
}
export interface CheckedBreakRegistration {
  readonly id: string; readonly request: BreakRegistrationRequest; readonly executor: string; readonly calldata: string;
  readonly gasPayer: string; readonly manifestHash: string; readonly alreadyRegistered: boolean;
}
const checked = new WeakSet<CheckedBreakRegistration>();
export function assertCheckedBreakRegistration(plan: CheckedBreakRegistration): void {
  if (!checked.has(plan)) throw Error('break_registration_unverified');
}
/** Registration installs only the recovery commitment already authenticated by
 * the last-good snapshot. It cannot move PVT or select a restoration outcome. */
export async function checkBreakRegistration(value: unknown, port: OwnerOperationChain = breakDeploymentChain()): Promise<CheckedBreakRegistration> {
  const request = parseBreakRegistration(value);
  const deployment = await port.deployment();
  if (deployment.addresses.kernel.toLowerCase() !== request.kernel) throw Error('break_registration_retired');
  const account = await checkBreakDeployment(request.deployment, port);
  if (!account.alreadyDeployed || account.manifestHash !== deployment.manifestHash) throw Error('break_registration_account_unavailable');
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, name: string, args: readonly unknown[] = []) => {
    const raw = await port.agree('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, tag]);
    if (typeof raw !== 'string') throw Error('break_registration_rpc_invalid');
    return abi.decodeFunctionResult(name, raw)[0];
  };
  const executor = target(request, String(await call(request.kernel, 'ownerAuthorization')).toLowerCase());
  const p = request.deployment, restored = await call(executor, 'restoredIdentity', [p.identity]);
  const commitment = await call(executor, 'ownerRecoveryCommitment', [p.identity]);
  let alreadyRegistered = restored === true;
  if (!alreadyRegistered && commitment !== ZeroHash) {
    if (commitment !== p.commitment || await call(executor, 'ownerSigningRoot', [p.identity]) !== p.signingRoot) throw Error('break_registration_owner_changed');
    alreadyRegistered = true;
  }
  const data = calldata(request);
  if (!alreadyRegistered) {
    const result = await port.agree('eth_call', [{ to: executor, from: account.gasPayer, data }, tag]);
    if (result !== '0x') throw Error('break_registration_simulation_invalid');
  }
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_registration_protocol_changed');
  const result = { id: breakRegistrationId(request), request, executor, calldata: data, gasPayer: account.gasPayer,
    manifestHash: deployment.manifestHash, alreadyRegistered };
  checked.add(result); return result;
}
export interface BreakRegistrationStatus { readonly id: string; readonly status: 'queued' | 'submitted' | 'confirmed' | 'failed'; readonly transactionHash: string | null; }
export async function readBreakRegistration(db: Firestore, id: string): Promise<BreakRegistrationStatus> {
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw Error('break_registration_invalid');
  const row = await db.collection(BREAK_REGISTRATIONS).doc(id).get();
  const status: unknown = row.get('status'), hash: unknown = row.get('transactionHash');
  if (!row.exists || !['queued','submitted','confirmed','failed'].includes(String(status))
    || (hash !== null && (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(hash)))) throw Error('break_registration_unknown');
  return { id, status: status as BreakRegistrationStatus['status'], transactionHash: hash as string | null };
}
export async function queueBreakRegistration(db: Firestore, value: unknown, port?: OwnerOperationChain,
  finalized: typeof finalizedOwnerTransaction = finalizedOwnerTransaction): Promise<BreakRegistrationStatus> {
  const request = parseBreakRegistration(value), id = breakRegistrationId(request), ref = db.collection(BREAK_REGISTRATIONS).doc(id);
  const prior = await ref.get();
  if (prior.exists && prior.get('status') !== 'failed') return readBreakRegistration(db, id);
  const oldRaw: unknown = prior.get('signedTransaction');
  let oldSigner: string | null = null;
  if (oldRaw !== undefined) {
    if (typeof oldRaw !== 'string' || keccak256(oldRaw) !== prior.get('transactionHash')) throw Error('break_registration_record_invalid');
    const tx = Transaction.from(oldRaw);
    const oldRequest = parseBreakRegistration(prior.get('request'));
    if (!tx.from || tx.chainId !== 8453n || tx.to?.toLowerCase() !== target(oldRequest, prior.get('executor'))
      || tx.data !== calldata(oldRequest) || tx.value !== 0n) throw Error('break_registration_record_invalid');
    const outcome = await finalized(oldRaw);
    if (!outcome || outcome.status !== 0) throw Error('break_registration_retry_unreconciled');
    oldSigner = tx.from.toLowerCase();
  }
  const plan = await checkBreakRegistration(request, port);
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists && current.get('status') !== 'failed') return;
    if (current.get('signedTransaction') !== oldRaw) throw Error('break_registration_record_changed');
    const archiveRef = oldRaw === undefined ? null : db.collection('recourse_break_registration_attempts_v1').doc(`${id}_${keccak256(String(oldRaw))}`);
    const archive = archiveRef ? await tx.get(archiveRef) : null;
    if (oldSigner !== null && (await tx.get(db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(oldSigner))).get('pending_operation') === id) throw Error('break_registration_retry_unreconciled');
    if (archiveRef && !archive?.exists) tx.create(archiveRef, { operation: id, signedTransaction: oldRaw,
      transactionHash: keccak256(String(oldRaw)), status: 'finalized_revert', archivedAtMs: Date.now() });
    tx.set(ref, { request, executor: plan.executor, gasPayer: plan.gasPayer, manifestHash: plan.manifestHash,
      status: plan.alreadyRegistered ? 'confirmed' : 'queued', transactionHash: null, createdAtMs: Date.now() });
  });
  return readBreakRegistration(db, id);
}
export async function executeBreakRegistration(db: Firestore, id: string, signer: SponsoredOperationSigner<CheckedBreakRegistration>,
  ports = { check: checkBreakRegistration, finalized: finalizedOwnerTransaction }): Promise<'submitted' | 'confirmed' | 'failed'> {
  return executeSponsoredOperation<BreakRegistrationRequest, CheckedBreakRegistration>(db, id, signer, {
    collection: BREAK_REGISTRATIONS, parse: parseBreakRegistration, id: breakRegistrationId, target, calldata,
    check: ports.check, assert: assertCheckedBreakRegistration, satisfied: plan => plan.alreadyRegistered,
    obsolete: error => error instanceof Error && ['break_registration_retired', 'break_deployment_retired', 'break_registration_owner_changed'].includes(error.message),
    finalized: ports.finalized,
  });
}
export async function runBreakRegistrationWorker(db: Firestore, env: NodeJS.ProcessEnv = process.env): Promise<{ id: string; status: string } | null> {
  if (!env.PVT9_SETTLEMENT_MINTER_KEY) throw Error('break_registration_gas_signer_unavailable');
  const signer = createRecourseGasSigner(new Wallet(env.PVT9_SETTLEMENT_MINTER_KEY), assertCheckedBreakRegistration);
  const pending: unknown = (await db.collection(SETTLEMENT_SIGNER_LEASES_COLLECTION).doc(signer.address).get()).get('pending_operation');
  let id: string;
  if (typeof pending === 'string') {
    if (!/^0x[0-9a-f]{64}$/.test(pending) || !(await db.collection(BREAK_REGISTRATIONS).doc(pending).get()).exists) return null;
    id = pending;
  } else {
    const submitted = await db.collection(BREAK_REGISTRATIONS).where('status','==','submitted').limit(1).get();
    const rows = submitted.empty ? await db.collection(BREAK_REGISTRATIONS).where('status','==','queued').limit(1).get() : submitted;
    if (rows.empty) return null; id = rows.docs[0].id;
  }
  return { id, status: await executeBreakRegistration(db, id, signer) };
}
