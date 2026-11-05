/**
 * Test fixtures for the on-demand payout: a real EIP-712 signature over a USDC
 * TransferWithAuthorization, built the way an agent's SDK (or the app) builds it.
 */
import type { BaseWallet } from 'ethers';
import { randomBytes } from 'crypto';
import {
  BASE_USDC_ADDRESS,
  BASE_USDC_EIP712_DOMAIN,
  PAYOUT_FEE_RECIPIENT,
  PAYOUT_NETWORK,
  payoutRequirement,
} from './payout-terms';

export interface PaymentOverrides {
  readonly value?: string;
  readonly to?: string;
  readonly validAfter?: string;
  readonly validBefore?: string;
  readonly asset?: string;
  readonly network?: string;
  readonly x402Version?: number;
  readonly signWith?: BaseWallet;
  readonly nonce?: string;
}

export async function signedPaymentHeader(payer: BaseWallet, nowSeconds: number, o: PaymentOverrides = {}): Promise<string> {
  const authorization = {
    from: payer.address,
    to: o.to ?? PAYOUT_FEE_RECIPIENT,
    value: o.value ?? '1000000',
    validAfter: o.validAfter ?? '0',
    validBefore: o.validBefore ?? String(nowSeconds + 300),
    nonce: o.nonce ?? `0x${randomBytes(32).toString('hex')}`,
  };
  const signature = await (o.signWith ?? payer).signTypedData(
    BASE_USDC_EIP712_DOMAIN,
    {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    authorization,
  );
  const payload = {
    x402Version: o.x402Version ?? 2,
    accepted: { ...payoutRequirement(), asset: o.asset ?? BASE_USDC_ADDRESS, network: o.network ?? PAYOUT_NETWORK },
    payload: { signature, authorization },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
