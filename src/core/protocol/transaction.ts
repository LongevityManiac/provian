import { Interface, TypedDataEncoder, type TypedDataField } from 'ethers';
import { assertNoRetiredProtocolAddresses, type ProtocolDeployment } from './pointer';
import type { OwnerChainNetwork } from '../recourse/owner-chain';

const tokens = new Interface([
  'function transfer(address to,uint256 amount)', 'function transferFrom(address from,address to,uint256 amount)',
  'function approve(address spender,uint256 amount)', 'function increaseAllowance(address spender,uint256 amount)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function transferCurrent(address to,uint256 amount,uint256 revision)',
  'function approveCurrent(address spender,uint256 amount,uint256 revision)',
]);
export function typedDataProtocolAddresses(verifyingContract: string | undefined | null,
  types: Record<string, TypedDataField[]>, value: Record<string, unknown>): string[] {
  const addresses = verifyingContract ? [verifyingContract] : [];
  TypedDataEncoder.from(types).visit(value, (type, field: unknown) => {
    if (type === 'address') {
      if (typeof field !== 'string') throw new Error('protocol_typed_address_invalid');
      addresses.push(field);
    }
    return field;
  });
  return addresses;
}
export function protocolTransactionAddresses(to: string, data?: string): string[] {
  const addresses = [to];
  if (data && data !== '0x') {
    const fragment = tokens.getFunction(data.slice(0, 10));
    if (fragment) {
      const decoded = tokens.decodeFunctionData(fragment, data);
      fragment.inputs.forEach((input, index) => { if (input.type === 'address') addresses.push(String(decoded[index])); });
    }
  }
  return addresses;
}
/** Fresh direct-chain retirement check at a signing or rebroadcast boundary.
 * The caller's arbitrary target option cannot bypass protocol retirement. */
export async function assertCurrentProtocolTransaction(network: OwnerChainNetwork, to: string, data?: string): Promise<ProtocolDeployment> {
  return assertCurrentProtocolAddresses(network, protocolTransactionAddresses(to, data));
}
export async function assertCurrentProtocolAddresses(network: OwnerChainNetwork, addresses: readonly string[]): Promise<ProtocolDeployment> {
  const deployment = await network.deployment();
  await assertNoRetiredProtocolAddresses(network.rpcs, deployment, addresses);
  if ((await network.deployment()).manifestHash !== deployment.manifestHash) throw new Error('protocol_pointer_changed');
  return deployment;
}
