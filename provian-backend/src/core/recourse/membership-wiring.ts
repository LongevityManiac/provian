import { Interface, getCreateAddress } from 'ethers';
import type { ProtocolDeployment } from '../protocol/pointer';
import type { OwnerOperationChain } from './owner-operation-queue';

const wiring = new Interface(['function registryOperator() view returns(address)', 'function identityAttestor() view returns(address)',
  'function restorationAuthority() view returns(address)', 'function pointer() view returns(address)',
  'function operationalMinter() view returns(address)', 'function kernel() view returns(address)',
  'function standingMembership() view returns(address)', 'function pool() view returns(address)', 'function submitter() view returns(address)']);
/** Identity attestation remains independent from restoration execution. The
 * sponsor is the current settlement submitter, never a caller-selected payer. */
export async function readMembershipWiring(chain: OwnerOperationChain, deployment: ProtocolDeployment) {
  const pin = { blockHash: deployment.blockHash, requireCanonical: true };
  const kernel = deployment.addresses.kernel.toLowerCase(), pool = deployment.addresses.recoursePool.toLowerCase();
  const call = async (to: string, name: string): Promise<string> => {
    const raw = await chain.agree('eth_call', [{ to, data: wiring.encodeFunctionData(name) }, pin]);
    if (typeof raw !== 'string') throw Error('recourse_membership_wiring_rpc');
    return String(wiring.decodeFunctionResult(name, raw)[0]).toLowerCase();
  };
  const registry = await call(kernel, 'registryOperator'), settlement = deployment.addresses.settlement.toLowerCase();
  const [poolRegistry, pointer, identityAttestor, restorationAuthority, minter, settlementKernel, settlementPool, gasPayer] = await Promise.all([
    call(pool, 'registryOperator'), call(registry, 'pointer'), call(registry, 'identityAttestor'), call(kernel, 'restorationAuthority'),
    call(kernel, 'operationalMinter'), call(settlement, 'kernel'), call(settlement, 'pool'), call(settlement, 'submitter')]);
  if (poolRegistry !== registry || pointer !== deployment.pointer.toLowerCase() || identityAttestor === restorationAuthority || /^0x0+$/.test(identityAttestor)
    || minter !== settlement || settlementKernel !== kernel || settlementPool !== pool || /^0x0+$/.test(gasPayer)) throw Error('recourse_membership_wiring_invalid');
  const standingMembership = await call(pool, 'standingMembership');
  if (standingMembership !== getCreateAddress({from: pool, nonce: 1}).toLowerCase() || await call(standingMembership, 'pool') !== pool) throw Error('recourse_membership_wiring_invalid');
  return { identityAttestor, gasPayer, pin, standingMembership };
}
