/**
 * — the on-demand payout's terms.
 *
 * Standard earnings settle on a schedule Provian sets, currently every 30 days, free. Any payee can have its earnings settled NOW for a flat
 * $1 USDC. The fee is a SERVICE FEE for running one settlement transaction for one payee — it
 * is never a price for PVT, it is the same $1 whatever the payee is owed, and it goes straight
 * to Provian's revenue wallet on Base. No request limit; a payout mints only that payee's own
 * earnings. Agents pay over x402 (`PAYMENT-SIGNATURE`, the exact scheme, EIP-3009 USDC on Base);
 * the app pays the same way with the person's own wallet key.
 *
 * The verified charge itself is the shared USDC charge path (`core/payments/usdc-charge.ts`, also
 * the PE Archive's); this module pins the payout's own terms over it. Nothing here is
 * argument-derived: amount, asset, network and payee of the fee are constants.
 */
import {
  BASE_USDC_ADDRESS as SHARED_BASE_USDC_ADDRESS,
  BASE_USDC_EIP712_DOMAIN as SHARED_BASE_USDC_EIP712_DOMAIN,
  checkUsdcChargePayment,
  encodeHeaderJson as sharedEncodeHeaderJson,
  USDC_CHARGE_CHAIN_ID,
  USDC_CHARGE_MAX_TIMEOUT_SECONDS,
  USDC_CHARGE_MIN_REMAINING_VALIDITY_SECONDS,
  USDC_CHARGE_NETWORK,
  USDC_CHARGE_RECIPIENT,
  usdcChargeRequestId,
  usdcChargeRequirement,
  usdcPaymentRequired,
  type Erc3009Authorization as SharedErc3009Authorization,
  type UsdcChargePayment,
  type UsdcChargeTermsResult,
  type UsdcPaymentRequirement,
  type UsdcServiceTerms,
} from '../payments/usdc-charge';

/** $1 in USDC atomic units (6 decimals). */
export const PAYOUT_FEE_USDC_ATOMIC = 1_000_000n;
export const PAYOUT_NETWORK = USDC_CHARGE_NETWORK;
export const PAYOUT_CHAIN_ID = USDC_CHARGE_CHAIN_ID;
/** Native USDC on Base (Circle), lowercased. */
export const BASE_USDC_ADDRESS = SHARED_BASE_USDC_ADDRESS;
/** The EIP-712 domain of Base USDC. Pinned here; never read from a request. */
export const BASE_USDC_EIP712_DOMAIN = SHARED_BASE_USDC_EIP712_DOMAIN;
/** Where the fee goes: Provian's revenue wallet. */
export const PAYOUT_FEE_RECIPIENT = USDC_CHARGE_RECIPIENT;
export const PAYOUT_MAX_TIMEOUT_SECONDS = USDC_CHARGE_MAX_TIMEOUT_SECONDS;
/** An authorization must stay valid at least this long after the relay accepts it. */
export const PAYOUT_MIN_REMAINING_VALIDITY_SECONDS = USDC_CHARGE_MIN_REMAINING_VALIDITY_SECONDS;

/** The payout's pinned service terms over the shared charge path. */
export const PAYOUT_SERVICE_TERMS: UsdcServiceTerms = {
  amountAtomic: PAYOUT_FEE_USDC_ATOMIC,
  service: 'provian_on_demand_payout',
  note: 'A flat service fee for settling this payee now. It is not a price for PVT.',
  description: 'Settle this payee\'s PVT earnings now (a flat $1 USDC service fee; standard earnings otherwise settle on a schedule Provian sets, currently every 30 days and free).',
};

export type PayoutPaymentRequirement = UsdcPaymentRequirement;

export function payoutRequirement(): PayoutPaymentRequirement {
  return usdcChargeRequirement(PAYOUT_SERVICE_TERMS);
}

/** The 402 body (and, base64, the PAYMENT-REQUIRED header). */
export function payoutPaymentRequired(resourceUrl: string, error?: string): Record<string, unknown> {
  return usdcPaymentRequired(PAYOUT_SERVICE_TERMS, resourceUrl, error);
}

export const encodeHeaderJson = sharedEncodeHeaderJson;

export type Erc3009Authorization = SharedErc3009Authorization;
export type PayoutPayment = UsdcChargePayment;
export type PayoutTermsResult = UsdcChargeTermsResult;

/**
 * Decode a `PAYMENT-SIGNATURE` value (base64 JSON, x402 v2) and check every term against the
 * constants above. Unknown = refuse: any field missing, mistyped, or different from the quote is a
 * refusal with a reason, never a best-effort read.
 */
export function checkPayoutPayment(raw: unknown, nowSeconds: number): PayoutTermsResult {
  return checkUsdcChargePayment(raw, nowSeconds, PAYOUT_FEE_USDC_ATOMIC);
}

/**
 * One payout request per USDC authorization: the id is derived from the authorization's own
 * (from, nonce), which USDC itself lets settle at most once. A retried request carrying the same
 * paid header lands on the same document.
 */
export function payoutRequestId(auth: Pick<Erc3009Authorization, 'from' | 'nonce'>): string {
  return usdcChargeRequestId('po', 'provian.payout.v1', auth);
}
