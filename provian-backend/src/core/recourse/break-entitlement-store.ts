import { Interface, ZeroAddress } from 'ethers';
import type { Firestore } from 'firebase-admin/firestore';
import type { OwnerOperationChain } from './owner-operation-queue';
import { breakDeploymentChain } from './break-deployment-queue';
import { verifyBreakEntitlement, type BreakEntitlement } from './break-entitlement';

export const BREAK_ENTITLEMENTS = 'recourse_break_entitlements_v1';
const abi = new Interface(['function ownerAuthorization() view returns(address)', 'function kernel() view returns(address)',
  'function breakOrigin() view returns(address)', 'function predecessor() view returns(address)',
  'function lastGoodBlock() view returns(uint256)', 'function restorationRoot() view returns(bytes32)']);
export function breakEntitlementId(origin: string, identity: string): string {
  if (!/^0x[0-9a-f]{40}$/.test(origin) || origin === ZeroAddress || !/^0x[0-9a-f]{64}$/.test(identity) || /^0x0+$/.test(identity)) {
    throw Error('break_entitlement_identity_invalid');
  }
  return `${origin.slice(2)}-${identity.slice(2)}`;
}
/** Public snapshot data needs no lost credential. Both server and clients
 * authenticate the proof; the database never decides a restoration amount. */
export async function checkStoredBreakEntitlement(origin: string, identity: string, value: unknown,
  port: OwnerOperationChain = breakDeploymentChain()): Promise<BreakEntitlement> {
  breakEntitlementId(origin, identity);
  const deployment = await port.deployment(), kernel = deployment.addresses.kernel.toLowerCase();
  const tag = { blockHash: deployment.blockHash, requireCanonical: true };
  const call = async (to: string, method: string) => {
    const raw = await port.agree('eth_call', [{ to, data: abi.encodeFunctionData(method) }, tag]);
    if (typeof raw !== 'string') throw Error('break_entitlement_rpc_invalid');
    return abi.decodeFunctionResult(method, raw)[0];
  };
  const executor = String(await call(kernel, 'ownerAuthorization')).toLowerCase();
  if (executor === ZeroAddress || String(await call(executor, 'kernel')).toLowerCase() !== kernel
    || String(await call(executor, 'breakOrigin')).toLowerCase() !== origin) throw Error('break_entitlement_origin_changed');
  const [previous, cutoff, root] = await Promise.all(['predecessor','lastGoodBlock','restorationRoot'].map(name => call(origin, name)));
  const entitlement = verifyBreakEntitlement(value, String(previous).toLowerCase(), BigInt(cutoff), String(root));
  if (entitlement.identity !== identity) throw Error('break_entitlement_identity_changed');
  if ((await port.deployment()).manifestHash !== deployment.manifestHash) throw Error('break_entitlement_protocol_changed');
  return entitlement;
}
export async function readBreakEntitlement(db: Firestore, origin: string, identity: string): Promise<BreakEntitlement> {
  const row = await db.collection(BREAK_ENTITLEMENTS).doc(breakEntitlementId(origin, identity)).get();
  if (!row.exists) throw Error('break_entitlement_missing');
  return checkStoredBreakEntitlement(origin, identity, row.data());
}
