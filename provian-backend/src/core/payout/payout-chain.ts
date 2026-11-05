/**
 * — the on-demand payout's chain side. The verified charge is the shared USDC charge
 * path (`core/payments/usdc-charge-chain.ts`): the payout's $1 and the PE Archive's $5 per GB
 * are collected by the same gas key (`PAYOUT_BASE_GAS_KEY`) under the same nonce lease. This module
 * keeps the payout's own names for it.
 *
 * Custody: none. `transferWithAuthorization` moves USDC from the payer straight to the revenue
 * wallet; the gas key only pays gas and can move nothing but its own ETH. The recovered signer of
 * the EIP-712 authorization must equal `from` before anything is submitted.
 */
import type { ChargeConfirmation as SharedChargeConfirmation, UsdcChargeChain } from '../payments/usdc-charge';
import {
  createUsdcChargeChain,
  recoverUsdcChargeSigner,
  USDC_CHARGE_GAS_KEY_ENV,
} from '../payments/usdc-charge-chain';
import type { PayoutPayment } from './payout-terms';

export const PAYOUT_GAS_KEY_ENV = USDC_CHARGE_GAS_KEY_ENV;

/** The address that signed this authorization, lowercased (throws on a malformed signature). */
export function recoverPayoutSigner(payment: PayoutPayment): string {
  return recoverUsdcChargeSigner(payment);
}

export type ChargeConfirmation = SharedChargeConfirmation;

export type PayoutChain = UsdcChargeChain;

export function createPayoutChain(params: { rpcUrl: string; gasKey: string }): PayoutChain {
  return createUsdcChargeChain(params);
}
