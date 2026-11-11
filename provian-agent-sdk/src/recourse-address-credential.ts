import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { addressRecoveryBinding, type AddressRecoveryDomain } from './recourse-address-binding';

/** Both outputs are independent of the wallet curve key and of every other
 * binding. Publishing one recovery secret discloses neither the signing seed nor
 * any sibling address credential. The root material remains solely with its owner. */
export function deriveAddressRecoveryCredential(rootMaterial: Uint8Array, domain: AddressRecoveryDomain,
  generation: string): { recoverySecret: Uint8Array; signingSeed: Uint8Array } {
  return deriveBoundRecoveryCredential(rootMaterial, addressRecoveryBinding(domain), generation);
}

/** Use only a binding independently resolved from the pointer's registry, or
 * locally derived from the public address domain. A relay cannot choose it. */
export function deriveBoundRecoveryCredential(rootMaterial: Uint8Array, binding: string,
  generation: string): { recoverySecret: Uint8Array; signingSeed: Uint8Array } {
  if (rootMaterial.length < 32 || !/^0x[0-9a-f]{64}$/.test(binding) || /^0x0+$/.test(binding)
    || !/^(0|[1-9][0-9]*)$/.test(generation) || BigInt(generation) >= 2n ** 256n) {
    throw new Error('recourse_address_credential_invalid');
  }
  const salt = hexToBytes(binding.slice(2));
  return {
    recoverySecret: hkdf(sha256, rootMaterial, salt, utf8ToBytes(`provian.address.recovery.secret:${generation}`), 32),
    signingSeed: hkdf(sha256, rootMaterial, salt, utf8ToBytes(`provian.address.recovery.signing:${generation}`), 32),
  };
}
