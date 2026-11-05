/**
 * — the person's PE Archive payment.
 *
 * One GB (10^9 bytes) of PE Archive space costs $5 USDC, paid up front from this wallet when the
 * Archive is turned on and each time another GB is reached, kept permanently: an EIP-3009
 * `TransferWithAuthorization` on Base USDC straight to Provian's revenue wallet, signed on this
 * device, carried to the relay as an x402 v2 payment.
 *
 * The app does NOT trust the relay's quote for the money terms: amount ($5.00), token (Base USDC),
 * chain and recipient are pinned here and in `core/payout/payoutPayment.ts`, and a quote naming
 * anything else is refused before the key is touched. Mirrors
 * `provian-backend/src/core/archive/archive-terms.ts` (ARCHIVE_GB_FEE_USDC_ATOMIC).
 */
import {
    signUsdcServicePayment,
    usdcServiceRequirementProblem,
    type PayoutRequirement,
    type PayoutSigner,
} from '../payout/payoutPayment';
import { ARCHIVE_GB_PRICE_USDC_ATOMIC } from './pe-archive-wire';

/** $5.00 in USDC atomic units: one GB of PE Archive space. */
export const ARCHIVE_GB_FEE_USDC_ATOMIC = '5000000';
if (ARCHIVE_GB_FEE_USDC_ATOMIC !== ARCHIVE_GB_PRICE_USDC_ATOMIC) {
    throw new Error('archive_fee_drift: archivePayment and pe-archive-wire disagree on the GB price');
}

export function archiveRequirementProblem(req: PayoutRequirement | null | undefined): string | null {
    return usdcServiceRequirementProblem(req, ARCHIVE_GB_FEE_USDC_ATOMIC);
}

/** Sign the pinned $5 payment for one GB and return the base64 x402 v2 payment the relay expects. */
export async function signArchivePayment(
    signer: PayoutSigner,
    requirement: PayoutRequirement | null,
    nowMs: number = Date.now(),
    nonce?: string,
): Promise<string> {
    return nonce === undefined
        ? signUsdcServicePayment(signer, requirement, ARCHIVE_GB_FEE_USDC_ATOMIC, 'archive_quote_refused', nowMs)
        : signUsdcServicePayment(signer, requirement, ARCHIVE_GB_FEE_USDC_ATOMIC, 'archive_quote_refused', nowMs, nonce);
}
