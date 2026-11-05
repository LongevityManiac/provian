/**
 * EIP-712 recovery signature verification (WS5).
 *
 * Pure, testable surface for POST /v1/users/recover. The domain + struct are
 * PINNED here and reconstructed server-side; the client-supplied
 * eip712.domain/types are ignored. Trusting the client domain meant any same-key
 * EIP-712 signature produced for a different dApp/domain whose struct happened to
 * match {user,timestamp,purpose} could be replayed to rotate the auth secret.
 */
import { ethers } from 'ethers';

export const RECOVERY_DOMAIN: ethers.TypedDataDomain = {
  name: 'Provian Relay Recovery',
  version: '1',
  chainId: 8453, // Base mainnet — the canonical recovery chain.
  verifyingContract: '0x94F3D06ca027dFD1e6cCaa1117b050E08D5EA936', // Foundation Safe (domain separator).
};

export const RECOVERY_TYPES: Record<string, ethers.TypedDataField[]> = {
  RelayRecovery: [
    { name: 'user', type: 'address' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'purpose', type: 'string' },
  ],
};

export const RECOVERY_PURPOSE = 'Recover Provian relay credentials';

export interface RecoveryMessage {
  user: string;
  timestamp: number;
  purpose: string;
}

/**
 * Recover the signer of a recovery message using the PINNED domain + types.
 * Returns the recovered address (lowercased) or throws on a malformed signature.
 */
export function recoverRecoverySigner(message: RecoveryMessage, signature: string): string {
  return ethers.verifyTypedData(RECOVERY_DOMAIN, RECOVERY_TYPES, message, signature).toLowerCase();
}

/** Replay-nonce material: the typed-data digest under the pinned domain. */
export function recoveryNonceMaterial(message: RecoveryMessage): string {
  return `eip712:${ethers.TypedDataEncoder.hash(RECOVERY_DOMAIN, RECOVERY_TYPES, message)}`;
}
