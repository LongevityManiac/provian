import { Interface, sha256, AbiCoder } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import { BREAK_RESTORATIONS, checkBreakRestoration } from './break-restoration-queue';
import { HASH_ACCOUNT_ABI, hashAccountCall, hashAccountIntentDigest, parseSignedHashAccountOperation, type SignedHashAccountOperation } from './hash-account-data';
import { breakDeploymentChain } from './break-deployment-queue';
import type { OwnerOperationChain } from './owner-operation-queue';
import { executeSponsoredOperation, type SponsoredOperationAdapter, type SponsoredOperationSigner } from './sponsored-operation-worker';
import { queueSponsoredOperation } from './sponsored-operation-queue';
import { finalizedOwnerTransaction } from './transaction-finality';

export const BREAK_AUTHORITY_EXECUTIONS = 'recourse_break_authority_executions_v1';
export interface BreakAuthorityRequest { readonly restoration: string; readonly operation: SignedHashAccountOperation; }
export function parseBreakAuthorityRequest(value: unknown): BreakAuthorityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('break_authority_request_invalid');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'operation,restoration' || typeof row.restoration !== 'string'
    || !/^0x[0-9a-f]{64}$/.test(row.restoration)) throw Error('break_authority_request_invalid');
  return { restoration: row.restoration, operation: parseSignedHashAccountOperation(row.operation) };
}
export function breakAuthorityId(request: BreakAuthorityRequest): string {
  return sha256(AbiCoder.defaultAbiCoder().encode(['string','bytes32','bytes32'],
    ['Provian break authority execution', request.restoration, hashAccountIntentDigest(request.operation)]));
}
export interface CheckedBreakAuthority {
  readonly id: string; readonly executor: string; readonly calldata: string; readonly gasPayer: string; readonly manifestHash: string;
}
const checked = new WeakSet<CheckedBreakAuthority>();
export function assertCheckedBreakAuthority(plan: CheckedBreakAuthority): void {
  if (!checked.has(plan)) throw Error('break_authority_unverified');
}
/** A gas sponsor cannot alter either signature layer: the owner fixes the
 * restoration and the independent authority fixes its exact executor call. */
export async function checkBreakAuthority(db: Firestore, value: unknown, port: OwnerOperationChain = breakDeploymentChain()): Promise<CheckedBreakAuthority> {
  const request = parseBreakAuthorityRequest(value), operation = request.operation;
  const row = await db.collection(BREAK_RESTORATIONS).doc(request.restoration).get();
  const restoration = await checkBreakRestoration(row.get('request'), port);
  if (restoration.id !== request.restoration || operation.chainId !== '8453' || operation.account !== restoration.authority
    || operation.target !== restoration.executor || operation.data !== restoration.request.data || operation.value !== '0') throw Error('break_authority_scope_invalid');
  if (operation.nonce !== restoration.authorityNonce || operation.signingRoot !== restoration.authorityRoot) throw Error('break_authority_stale');
  const deployment = await port.deployment();
  if (deployment.manifestHash !== restoration.manifestHash) throw Error('break_authority_protocol_changed');
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, abi: Interface, name: string, args: readonly unknown[] = []) => {
    const raw = await port.agree('eth_call', [{ to, data: abi.encodeFunctionData(name, args) }, tag]);
    if (typeof raw !== 'string') throw Error('break_authority_rpc_invalid');
    return abi.decodeFunctionResult(name, raw)[0];
  };
  const sponsorAbi = new Interface(['function operationalMinter() view returns(address)', 'function kernel() view returns(address)',
    'function pool() view returns(address)', 'function submitter() view returns(address)']);
  const settlement = deployment.addresses.settlement.toLowerCase();
  if (String(await call(restoration.request.kernel, sponsorAbi, 'operationalMinter')).toLowerCase() !== settlement
    || String(await call(settlement, sponsorAbi, 'kernel')).toLowerCase() !== restoration.request.kernel
    || String(await call(settlement, sponsorAbi, 'pool')).toLowerCase() !== deployment.addresses.recoursePool.toLowerCase()) throw Error('break_authority_sponsor_invalid');
  const gasPayer = String(await call(settlement, sponsorAbi, 'submitter')).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(gasPayer) || /^0x0+$/.test(gasPayer)) throw Error('break_authority_sponsor_invalid');
  if (await call(operation.account, HASH_ACCOUNT_ABI, 'intentDigest', [operation.target, operation.value, operation.callGas,
    operation.data, operation.nextCommitment]) !== hashAccountIntentDigest(operation)) throw Error('break_authority_digest_invalid');
  const data = hashAccountCall(operation);
  const result = await port.agree('eth_call', [{ to: operation.account, from: gasPayer, data }, tag]);
  if (typeof result !== 'string' || HASH_ACCOUNT_ABI.decodeFunctionResult('execute', result)[0] !== true) throw Error('break_authority_simulation_refused');
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_authority_protocol_changed');
  const plan = { id: breakAuthorityId(request), executor: operation.account, calldata: data, gasPayer, manifestHash: deployment.manifestHash };
  checked.add(plan); return plan;
}
export function breakAuthorityAdapter(db: Firestore, port?: OwnerOperationChain): SponsoredOperationAdapter<BreakAuthorityRequest, CheckedBreakAuthority> {
  return { collection: BREAK_AUTHORITY_EXECUTIONS, parse: parseBreakAuthorityRequest, id: breakAuthorityId,
    target: request => request.operation.account, calldata: request => hashAccountCall(request.operation),
    check: request => checkBreakAuthority(db, request, port), assert: assertCheckedBreakAuthority, satisfied: () => false,
    obsolete: error => error instanceof Error && ['break_authority_stale','break_restoration_retired','break_restoration_owner_changed','break_restoration_destination_changed'].includes(error.message),
    finalized: finalizedOwnerTransaction };
}
export async function queueBreakAuthority(db: Firestore, value: unknown, port?: OwnerOperationChain) {
  return queueSponsoredOperation(db, value, breakAuthorityAdapter(db, port));
}
export async function executeBreakAuthority(db: Firestore, id: string, signer: SponsoredOperationSigner<CheckedBreakAuthority>, port?: OwnerOperationChain) {
  return executeSponsoredOperation(db, id, signer, breakAuthorityAdapter(db, port));
}
