/**
 * Test helper : sign the human-wallet registration address proof exactly as the app does
 * (`RelayAPIService.signHumanWalletAddressProof`) — the pinned domain + types, a real secp256k1
 * key, the relay-side message fields.
 */
import { ethers } from 'ethers';

import {
  HUMAN_WALLET_REGISTRATION_DOMAIN,
  HUMAN_WALLET_REGISTRATION_TYPES,
} from '../human-wallet-address-proof';

/** A deterministic test key: `seedByte` repeated 32 times (e.g. '11'). */
export function testSigner(seedByte: string): ethers.Wallet {
  return new ethers.Wallet(`0x${seedByte.repeat(32)}`);
}

export async function signAddressProof(
  wallet: ethers.Wallet,
  params: { readonly userId: string; readonly deviceId: string; readonly nowMs: number; readonly address?: string },
): Promise<{ signature: string; timestamp: number }> {
  const timestamp = Math.floor(params.nowMs / 1000);
  const signature = await wallet.signTypedData(HUMAN_WALLET_REGISTRATION_DOMAIN, HUMAN_WALLET_REGISTRATION_TYPES, {
    user_id: params.userId,
    address: (params.address ?? wallet.address).toLowerCase(),
    device_id: params.deviceId,
    timestamp,
  });
  return { signature, timestamp };
}

/** The proof for `address` when one of `signers` holds it; undefined otherwise (no key → no proof). */
export async function proofForAddress(
  address: string,
  signers: readonly ethers.Wallet[],
  params: { readonly userId: string; readonly deviceId: string; readonly nowMs: number },
): Promise<{ signature: string; timestamp: number } | undefined> {
  const signer = signers.find((w) => w.address.toLowerCase() === address.toLowerCase());
  return signer ? signAddressProof(signer, params) : undefined;
}
