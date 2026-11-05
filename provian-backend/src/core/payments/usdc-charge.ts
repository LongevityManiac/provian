/**
 * ONE verified USDC charge path for every flat service fee the relay collects ( payout
 * $1, PE Archive $5 per GB).
 *
 * A payer (an agent over x402, a person from the app wallet) signs an EIP-3009
 * `TransferWithAuthorization` on Base USDC for EXACTLY the service's fee, to Provian's revenue
 * wallet. The relay checks every term against constants, recovers the EIP-712 signer (must be
 * `from`), checks the nonce is unused and the balance covers it, then submits USDC's own
 * `transferWithAuthorization` with its gas key and confirms the Transfer log. Custody: none — USDC
 * moves payer → revenue wallet in one transaction; the gas key can move nothing but its own ETH.
 *
 * Nothing here is argument-derived except the fee amount, which each SERVICE pins as a constant
 * (`UsdcServiceTerms`); a request can never choose it. Pure apart from `submitUsdcCharge` /
 * `awaitUsdcCharge`, which talk to the chain through the injected `UsdcChargeChain`.
 */
import { createHash } from 'crypto';
import { PROVIAN_TREASURY } from '../config/live-value-recipients';

export const USDC_CHARGE_NETWORK = 'eip155:8453';
export const USDC_CHARGE_CHAIN_ID = 8453;
/** Native USDC on Base (Circle), lowercased. */
export const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** The EIP-712 domain of Base USDC. Pinned here; never read from a request. */
export const BASE_USDC_EIP712_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: USDC_CHARGE_CHAIN_ID,
  verifyingContract: BASE_USDC_ADDRESS,
} as const;
/** Where every service fee goes: Provian's revenue wallet. */
export const USDC_CHARGE_RECIPIENT = PROVIAN_TREASURY;
export const USDC_CHARGE_MAX_TIMEOUT_SECONDS = 300;
/** An authorization must stay valid at least this long after the relay accepts it. */
export const USDC_CHARGE_MIN_REMAINING_VALIDITY_SECONDS = 30;
/**
 * An authorization may expire at most this far after the relay accepts it: the quote's own
 * `maxTimeoutSeconds` plus allowance for the payer's clock. Every client signs `now + 300`. The bound
 * is what lets every unresolved charge be decided from the chain within minutes: a charge can only
 * land before `validBefore`, so once that has passed the chain's answer is final.
 */
export const USDC_CHARGE_MAX_REMAINING_VALIDITY_SECONDS = USDC_CHARGE_MAX_TIMEOUT_SECONDS + 120;
/** Gas for USDC `transferWithAuthorization` (observed ~60–70k on Base; padded). */
export const USDC_CHARGE_GAS = 90_000n;
/** How long a request handler waits for the charge receipt before handing it to a sweep. */
export const USDC_CHARGE_CONFIRM_WAIT_MS = 30_000;

/** One service's pinned terms. */
export interface UsdcServiceTerms {
  /** The exact fee in USDC atomic units (6 decimals). */
  readonly amountAtomic: bigint;
  /** `extra.service` in the quote (e.g. `provian_on_demand_payout`). */
  readonly service: string;
  /** `extra.note` in the quote. */
  readonly note: string;
  /** `resource.description` of the 402 body. */
  readonly description: string;
}

export interface UsdcPaymentRequirement {
  readonly scheme: 'exact';
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

export function usdcChargeRequirement(terms: UsdcServiceTerms): UsdcPaymentRequirement {
  return {
    scheme: 'exact',
    network: USDC_CHARGE_NETWORK,
    amount: terms.amountAtomic.toString(10),
    asset: BASE_USDC_ADDRESS,
    payTo: USDC_CHARGE_RECIPIENT,
    maxTimeoutSeconds: USDC_CHARGE_MAX_TIMEOUT_SECONDS,
    extra: {
      name: BASE_USDC_EIP712_DOMAIN.name,
      version: BASE_USDC_EIP712_DOMAIN.version,
      service: terms.service,
      note: terms.note,
    },
  };
}

/** The 402 body (and, base64, the PAYMENT-REQUIRED header). */
export function usdcPaymentRequired(terms: UsdcServiceTerms, resourceUrl: string, error?: string): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: {
      url: resourceUrl,
      description: terms.description,
      mimeType: 'application/json',
    },
    accepts: [usdcChargeRequirement(terms)],
    ...(error !== undefined ? { error } : {}),
  };
}

export function encodeHeaderJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

export interface Erc3009Authorization {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface UsdcChargePayment {
  readonly authorization: Erc3009Authorization;
  readonly signature: string;
}

export type UsdcChargeTermsResult =
  | { readonly ok: true; readonly payment: UsdcChargePayment }
  | { readonly ok: false; readonly reason: string };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^[0-9]{1,78}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const MAX_HEADER_BYTES = 8192;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decode a `PAYMENT-SIGNATURE` value (base64 JSON, x402 v2) and check every term against the
 * constants above and the service's exact fee. Unknown = refuse: any field missing, mistyped, or
 * different from the quote is a refusal with a reason, never a best-effort read.
 */
export function checkUsdcChargePayment(raw: unknown, nowSeconds: number, amountAtomic: bigint): UsdcChargeTermsResult {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'payment_missing' };
  if (raw.length > MAX_HEADER_BYTES) return { ok: false, reason: 'payment_too_large' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return { ok: false, reason: 'payment_not_base64_json' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'payment_not_object' };
  if (parsed.x402Version !== 2) return { ok: false, reason: 'payment_version_unsupported' };
  const accepted = parsed.accepted;
  if (!isRecord(accepted)) return { ok: false, reason: 'payment_accepted_missing' };
  if (accepted.scheme !== 'exact') return { ok: false, reason: 'payment_scheme_unsupported' };
  if (accepted.network !== USDC_CHARGE_NETWORK) return { ok: false, reason: 'payment_network_wrong' };
  if (typeof accepted.asset !== 'string' || accepted.asset.toLowerCase() !== BASE_USDC_ADDRESS) {
    return { ok: false, reason: 'payment_asset_wrong' };
  }
  const body = parsed.payload;
  if (!isRecord(body)) return { ok: false, reason: 'payment_payload_missing' };
  const signature = body.signature;
  const auth = body.authorization;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return { ok: false, reason: 'payment_signature_malformed' };
  if (!isRecord(auth)) return { ok: false, reason: 'payment_authorization_missing' };
  const { from, to, value, validAfter, validBefore, nonce } = auth;
  if (typeof from !== 'string' || !ADDRESS.test(from)) return { ok: false, reason: 'payment_from_malformed' };
  if (typeof to !== 'string' || !ADDRESS.test(to)) return { ok: false, reason: 'payment_to_malformed' };
  if (to.toLowerCase() !== USDC_CHARGE_RECIPIENT) return { ok: false, reason: 'payment_pay_to_wrong' };
  if (from.toLowerCase() === USDC_CHARGE_RECIPIENT) return { ok: false, reason: 'payment_from_is_recipient' };
  for (const [field, v] of [['value', value], ['validAfter', validAfter], ['validBefore', validBefore]] as const) {
    if (typeof v !== 'string' || !UINT.test(v)) return { ok: false, reason: `payment_${field}_malformed` };
  }
  if (BigInt(value as string) !== amountAtomic) return { ok: false, reason: 'payment_amount_wrong' };
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return { ok: false, reason: 'payment_nonce_malformed' };
  if (BigInt(validAfter as string) > BigInt(nowSeconds)) return { ok: false, reason: 'payment_not_yet_valid' };
  if (BigInt(validBefore as string) < BigInt(nowSeconds + USDC_CHARGE_MIN_REMAINING_VALIDITY_SECONDS)) {
    return { ok: false, reason: 'payment_expires_too_soon' };
  }
  if (BigInt(validBefore as string) > BigInt(nowSeconds + USDC_CHARGE_MAX_REMAINING_VALIDITY_SECONDS)) {
    return { ok: false, reason: 'payment_expires_too_late' };
  }
  return {
    ok: true,
    payment: {
      signature: signature.toLowerCase(),
      authorization: {
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        value: value as string,
        validAfter: validAfter as string,
        validBefore: validBefore as string,
        nonce: nonce.toLowerCase(),
      },
    },
  };
}

/**
 * One request per USDC authorization, per service: the id is derived from the authorization's own
 * (from, nonce), which USDC itself lets settle at most once. `domain` separates the services, so
 * the same authorization can never land on a payout AND an archive request.
 */
export function usdcChargeRequestId(prefix: string, domain: string, auth: Pick<Erc3009Authorization, 'from' | 'nonce'>): string {
  const digest = createHash('sha256')
    .update(`${domain}|${auth.from.toLowerCase()}|${auth.nonce.toLowerCase()}`)
    .digest('hex');
  return `${prefix}_${digest.slice(0, 40)}`;
}

export type ChargeConfirmation = 'confirmed' | 'reverted' | 'pending';

/** Where a charge search starts: the Base block recorded when the request was made (else its time). */
export interface ChargeSearchStart {
  readonly block: number | null;
  readonly ms: number;
}

export interface ChargeSearch {
  readonly txHash: string | null;
  readonly windowClosed: boolean;
}

/** The chain surface every charge uses (`usdc-charge-chain.ts` builds it over Base). */
export interface UsdcChargeChain {
  readonly gasAddress: string;
  authorizationUsed(from: string, nonce: string): Promise<boolean>;
  usdcBalance(address: string): Promise<bigint>;
  gasBalanceWei(): Promise<bigint>;
  /** maxFeePerGas the gas key would pay now. */
  gasPriceWei(): Promise<bigint>;
  /** Upper bound of the L1 data fee for a transaction of this many unsigned bytes. */
  l1FeeUpperBoundWei(unsignedTxBytes: number): Promise<bigint>;
  /** Submit the fee transfer. Returns the transaction hash. */
  submitCharge(payment: UsdcChargePayment): Promise<string>;
  /**
   * Read the receipt: `confirmed` only when it succeeded AND carries USDC's Transfer(from →
   * revenue wallet, exactly the authorized value); `reverted` on a failed receipt; `pending` while
   * there is none.
   */
  confirmCharge(txHash: string, payment: UsdcChargePayment): Promise<ChargeConfirmation>;
  /** The latest Base block number (recorded on a request so a later search starts there). */
  headBlock(): Promise<number>;
  /**
   * Search the chain for this authorization's charge (`findChargeVia` in usdc-charge-chain.ts):
   * `txHash` = a SUCCESSFUL transaction — submitted by anyone — in which USDC's
   * `AuthorizationUsed(from, nonce)` is followed by THE Transfer it caused, Transfer(from → revenue
   * wallet, exactly the authorized value); `windowClosed` = Base's own head block is past
   * `validBefore` + grace, so no transaction can use the authorization any more and every block it
   * could have landed in was searched. Throws when the chain cannot be read. USDC's
   * `authorizationState` alone is never proof of payment (a payer sets it with
   * `cancelAuthorization` or by reusing the nonce), and the decision never reads the relay's clock.
   */
  findCharge(payment: UsdcChargePayment, since: ChargeSearchStart): Promise<ChargeSearch>;
}

/** The runtime pieces a charge needs (a subset of each service's deps). */
export interface UsdcChargeRuntime {
  readonly chain: UsdcChargeChain;
  /** Serialises the gas key's transactions across instances (a nonce lease). */
  readonly withGasKeyLease: <T>(fn: () => Promise<T>) => Promise<T | 'lease_busy'>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

export type UsdcChargeSubmission =
  | { readonly kind: 'submitted'; readonly txHash: string }
  /**
   * We hold no transaction hash. `mayBeCharged` false: nothing was broadcast (the gas-key lease was
   * busy, so this request never submitted) and USDC says the authorization is unused — nothing was
   * charged. `mayBeCharged` true: the authorization is used, unreadable, or the submit itself threw
   * (a broadcast whose reply was lost can still land seconds later) — the charge is UNKNOWN, and the
   * caller keeps it unconfirmed for its sweep (`chargeStatusNow`), never calls it failed.
   */
  | { readonly kind: 'not_submitted'; readonly mayBeCharged: boolean; readonly reason: string };

/**
 * Chain-time seconds past an authorization's `validBefore` before a search with nothing found is
 * final: USDC refuses the authorization once `block.timestamp >= validBefore`, and the margin lets
 * every node behind a load-balanced RPC have indexed the last blocks it could have landed in.
 */
export const USDC_CHARGE_EXPIRY_GRACE_SECONDS = 120;

/**
 * Submit the charge under the gas-key lease. A submit that THROWS is never "not charged": the RPC
 * can accept a transaction and still fail the call (ethers resolves sendRawTransaction alongside a
 * block-number read; a lost reply looks the same), and the transaction then sits in the mempool
 * where USDC's authorization state still reads unused. Only a busy lease — this request broadcast
 * nothing — with the authorization read as unused is "not charged".
 */
export async function submitUsdcCharge(runtime: UsdcChargeRuntime, payment: UsdcChargePayment): Promise<UsdcChargeSubmission> {
  type Attempt = { readonly ok: true; readonly txHash: string } | { readonly ok: false; readonly error: string };
  const submitted = await runtime.withGasKeyLease(async (): Promise<Attempt> => {
    try {
      return { ok: true, txHash: await runtime.chain.submitCharge(payment) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : 'submit_failed' };
    }
  });
  if (submitted === 'lease_busy') {
    const consumed = await runtime.chain.authorizationUsed(payment.authorization.from, payment.authorization.nonce)
      .catch(() => true);
    return { kind: 'not_submitted', mayBeCharged: consumed, reason: 'gas_key_busy' };
  }
  if (!submitted.ok) return { kind: 'not_submitted', mayBeCharged: true, reason: submitted.error };
  return { kind: 'submitted', txHash: submitted.txHash };
}

/** Wait (bounded) for a submitted charge's receipt. Returns the last status seen. */
export async function awaitUsdcCharge(
  runtime: UsdcChargeRuntime,
  txHash: string,
  payment: UsdcChargePayment,
  waitMs: number = USDC_CHARGE_CONFIRM_WAIT_MS,
): Promise<ChargeConfirmation> {
  const deadline = runtime.now() + waitMs;
  let status: ChargeConfirmation = 'pending';
  while (runtime.now() < deadline) {
    status = await runtime.chain.confirmCharge(txHash, payment).catch(() => 'pending' as const);
    if (status !== 'pending') break;
    await runtime.sleep(2_000);
  }
  return status;
}

export interface ChargeStatus {
  readonly status: ChargeConfirmation;
  /** The transaction that paid the fee, when `confirmed` (it may not be the one the relay sent). */
  readonly txHash: string | null;
}

/**
 * Where a not-yet-confirmed charge stands now (the sweep's read). Paid means THIS authorization
 * moved the fee:
 *   - the receipt of the hash we hold shows it (`confirmCharge`) → confirmed;
 *   - otherwise any successful transaction in which it did (`findCharge`, whoever submitted it) →
 *     confirmed, with that transaction's hash;
 *   - nothing found and Base's head is past `validBefore` + grace → reverted: it can never charge;
 *   - anything else — still usable, or the chain unreadable — stays pending.
 * A reverted receipt is not the end (the authorization stays valid and its signature is public, so
 * anyone could still submit it). Decided by chain time only, never the relay's clock.
 */
export async function chargeStatusNow(
  runtime: Pick<UsdcChargeRuntime, 'chain'>,
  charge: { readonly txHash: string | null; readonly payment: UsdcChargePayment; readonly since: ChargeSearchStart },
): Promise<ChargeStatus> {
  if (charge.txHash !== null) {
    const receipt = await runtime.chain.confirmCharge(charge.txHash, charge.payment).catch(() => 'pending' as const);
    if (receipt === 'confirmed') return { status: 'confirmed', txHash: charge.txHash };
  }
  let search: ChargeSearch;
  try {
    search = await runtime.chain.findCharge(charge.payment, charge.since);
  } catch {
    return { status: 'pending', txHash: null };
  }
  if (search.txHash !== null) return { status: 'confirmed', txHash: search.txHash };
  return { status: search.windowClosed ? 'reverted' : 'pending', txHash: null };
}
