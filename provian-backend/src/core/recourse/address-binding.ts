import { AbiCoder, sha256 as evmSha256 } from 'ethers';

export interface AddressRecoveryDomain {
  readonly chainId: string;
  readonly pointer: string;
  /** Original address, retained through individually linked recoveries. */
  readonly origin: string;
}
function validateDomain(domain: AddressRecoveryDomain): void {
  if (!/^[1-9][0-9]*$/.test(domain.chainId) || BigInt(domain.chainId) >= 2n ** 256n
    || ![domain.pointer, domain.origin].every(value => /^0x[0-9a-f]{40}$/.test(value) && !/^0x0+$/.test(value))) {
    throw new Error('recourse_address_domain_invalid');
  }
}
/** Public identifier of one address's recovery lineage, never an owner ID. */
export function addressRecoveryBinding(domain: AddressRecoveryDomain): string {
  validateDomain(domain);
  return evmSha256(AbiCoder.defaultAbiCoder().encode(['string', 'uint256', 'address', 'address'],
    ['Provian address recovery binding', domain.chainId, domain.pointer, domain.origin]));
}
