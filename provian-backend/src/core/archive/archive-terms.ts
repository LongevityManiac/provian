/**
 * — the paid PE Archive's terms.
 *
 * "Paid PE Archive, opt-in per wallet. $5 USDC per GB, paid up front at turn-on and each time
 * another GB is reached, kept for as long as Provian operates the Archive; x402 for agents, the app wallet for humans; payments go
 * straight to Provian's revenue wallet on chain."
 *
 * - 1 GB = 10^9 bytes (decimal). Space is counted as the bytes of ciphertext stored (every part
 * of every archived day), never as anything the relay could read — and each part counts as at
 * least ARCHIVE_MIN_CHARGED_PART_BYTES (1 MB;,). Storage's long-run cost
 * is per object (a write, a check, a read-back), not per byte: without a floor, a wallet with many
 * devices each sending a small part a day would cost more in operations than its $5 ever covers;
 * with it, one GB covers at most 1,000 parts and every GB pays for its own operations.
 * - Turning the Archive on buys the first GB. The next GB is bought when the used space reaches
 * the paid space — or, so a device never stalls on the boundary, once less than
 * ARCHIVE_TOPUP_WINDOW_BYTES remain. Never earlier: a second payment while most of a GB is
 * unused is refused before anything is charged (`archive_space_available`).
 * - What is stored is kept while Provian operates the Archive: nothing in the relay deletes an archived day, and an
 * unpaid next GB only stops new uploads (new days then stay on the owner's devices).
 *
 * The charge is the shared USDC charge path (`core/payments/usdc-charge.ts`): the same checks and
 * signer recovery as the $1 on-demand payout. Before the launch flip the relay's charge gas key
 * submits it; from the flip Coinbase's CDP facilitator settles it (`core/payments/cdp-facilitator.ts`)
 * and the agent route declares the listing below. Pure.
 */
import {
  checkUsdcChargePayment,
  usdcChargeRequestId,
  usdcPaymentRequired,
  type Erc3009Authorization,
  type UsdcChargeTermsResult,
  type UsdcServiceTerms,
} from '../payments/usdc-charge';
import type { CdpSettlementListing } from '../payments/cdp-facilitator';
import { ARCHIVE_BYTES_PER_GB, ARCHIVE_GB_PRICE_USDC_ATOMIC } from '../meter/pe-archive-wire';

/** $5 in USDC atomic units (6 decimals): the price of one GB. Equal to the wire's pinned literal. */
export const ARCHIVE_GB_FEE_USDC_ATOMIC = 5_000_000n;
if (ARCHIVE_GB_FEE_USDC_ATOMIC.toString(10) !== ARCHIVE_GB_PRICE_USDC_ATOMIC) {
  throw new Error('archive_price_drift: archive-terms and pe-archive-wire disagree on the GB price');
}
export const ARCHIVE_GB_BYTES = ARCHIVE_BYTES_PER_GB;
/** The next GB may be bought once less than this remains (100 MB), and never earlier. */
export const ARCHIVE_TOPUP_WINDOW_BYTES = 100_000_000;
/** $5, the ceiling the charge's own gas must fit under (it always does on Base; unknown price waits). */
export const ARCHIVE_FEE_USD = 5;

/** The Archive bucket (Archive storage class; the operator creates it). */
export const ARCHIVE_BUCKET_ENV = 'PE_ARCHIVE_BUCKET';
export const ARCHIVE_DEFAULT_BUCKET = 'provian-ai-pe-archive';

export const ARCHIVE_ACCOUNTS_COLLECTION = 'archive_accounts_v1';
export const ARCHIVE_DAYS_COLLECTION = 'archive_days_v1';
export const ARCHIVE_PAYMENTS_COLLECTION = 'archive_payments_v1';

export const ARCHIVE_SERVICE_TERMS: UsdcServiceTerms = {
  amountAtomic: ARCHIVE_GB_FEE_USDC_ATOMIC,
  service: 'provian_pe_archive_gb',
  note: 'One GB of PE Archive space, kept for as long as Provian operates the Archive. Your PEs stay yours: the Archive holds encrypted days only you (and your linked human) can open.',
  description: 'PE Archive: one GB of space for encrypted days of your PEs, kept for as long as Provian operates the Archive ($5 USDC per GB, paid at turn-on and each time another GB is reached; each part a device uploads, normally one a day, counts as at least 1 MB).',
};

export function archivePaymentRequired(resourceUrl: string, error?: string): Record<string, unknown> {
  return usdcPaymentRequired(ARCHIVE_SERVICE_TERMS, resourceUrl, error);
}

// ─── the agent route's public listing ──────────────────────────
//
// From the launch flip the Archive settles through Coinbase's CDP facilitator, and the agent route
// (`POST /v1/archive/pay`, x402 under the agent's API key) declares the x402 Bazaar discovery
// extension, so Coinbase's Bazaar indexes it after its first paid settlement. Everything below is
// public listing copy: it leads with the agent's self-custodial wallet and its PE record, and states
// the fee only as the x402 requirement states it (USDC). The people's route (`/v1/archive/mobile/pay`,
// wallet auth) is not an x402 resource anyone else can call, so it declares no listing.

export const ARCHIVE_LISTING_SERVICE_NAME = 'Provian PE Archive';
export const ARCHIVE_LISTING_TAGS: readonly string[] = ['agent-wallet', 'provenance', 'pe-archive', 'storage', 'base'];
/** Served by provian.ai (provian-website/public/logos/) once the site opens. */
export const ARCHIVE_LISTING_ICON_URL = 'https://provian.ai/logos/provian-256.png';
export const ARCHIVE_LISTING_DESCRIPTION =
  'For AI agents with a Provian wallet: a self-custodial wallet on Base whose key the agent holds, and a signed, '
  + 'hash-chained record of the work the agent does (Provenance Envelopes, PEs). The PE Archive keeps that record '
  + 'by day, for as long as Provian operates the Archive: the agent\'s own machine encrypts each day to the agent (and to its linked human, if it '
  + 'has one) before upload, so Provian stores only ciphertext, each PE with its proof against the day\'s on-chain '
  + 'anchor. Each paid call adds 1 GB (10^9 bytes; each uploaded part counts as at least 1 MB), kept for as long as Provian operates the Archive. '
  + 'Call with the agent\'s Provian API key (Authorization: Bearer pvn_live_...:pvns_...). An agent without a '
  + 'wallet creates one through the hosted MCP server at https://api.provian.ai/mcp (wallet_challenge, then '
  + 'wallet_create).';

/** The 200 a paid call returns (illustrative values; the fields are the route's own). */
const ARCHIVE_PAY_OUTPUT_EXAMPLE = {
  request_id: 'ap_3f1c0d2e9a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d',
  wallet: 'wallet_aw_00000000-0000-4000-8000-000000000000',
  state: 'charged',
  credited: true,
  fee_usdc: '5.00',
  credited_bytes: 1_000_000_000,
  charge_tx_hash: `0x${'ab'.repeat(32)}`,
  created_at_ms: 1_791_000_000_000,
  charged_at_ms: 1_791_000_004_000,
  payer: `0x${'cd'.repeat(20)}`,
  last_error: null,
  archive: {
    on: true,
    paid_bytes: 1_000_000_000,
    used_bytes: 0,
    free_bytes: 1_000_000_000,
    gb_purchased: 1,
    gb_bytes: 1_000_000_000,
    price_usdc_per_gb: '5.00',
    space_exhausted: false,
    next_gb_purchasable: false,
  },
} as const;

const ARCHIVE_PAY_OUTPUT_SCHEMA = {
  properties: {
    request_id: { type: 'string', description: 'This payment (one per USDC authorization).' },
    wallet: { type: 'string', description: 'The agent wallet the space belongs to.' },
    state: { type: 'string', enum: ['charging', 'charge_unconfirmed', 'charged', 'charge_failed'] },
    credited: { type: 'boolean', description: 'The GB has been added to the Archive.' },
    fee_usdc: { type: 'string' },
    credited_bytes: { type: 'integer' },
    charge_tx_hash: { type: ['string', 'null'], description: 'The Base transaction that moved the fee.' },
    created_at_ms: { type: 'integer' },
    charged_at_ms: { type: ['integer', 'null'] },
    payer: { type: 'string', description: 'The address that signed the USDC authorization.' },
    last_error: { type: ['string', 'null'] },
    archive: {
      type: 'object',
      properties: {
        on: { type: 'boolean' },
        paid_bytes: { type: 'integer' },
        used_bytes: { type: 'integer' },
        free_bytes: { type: 'integer' },
        gb_purchased: { type: 'integer' },
        gb_bytes: { type: 'integer' },
        price_usdc_per_gb: { type: 'string' },
        space_exhausted: { type: 'boolean' },
        next_gb_purchasable: { type: 'boolean' },
      },
      required: ['on', 'paid_bytes', 'used_bytes', 'free_bytes', 'gb_purchased'],
    },
  },
  required: ['request_id', 'wallet', 'state', 'credited', 'fee_usdc', 'credited_bytes', 'charge_tx_hash', 'payer', 'archive'],
} as const;

/** The placeholder the listing shows for the agent's API key (never a real credential). */
export const ARCHIVE_LISTING_AUTH_PLACEHOLDER = 'Bearer pvn_live_<key>:pvns_<secret>';

/**
 * The x402 Bazaar discovery extension for `POST /v1/archive/pay` (the `@x402/extensions` body-method
 * shape, method already enriched to POST): an empty JSON body, the agent's API key in
 * `Authorization`, and the 200 the call returns. Validated by the official validator in
 * archive-listing.test.ts.
 */
export const ARCHIVE_BAZAAR_EXTENSION = {
  info: {
    input: {
      type: 'http',
      method: 'POST',
      bodyType: 'json',
      body: {},
      headers: { Authorization: ARCHIVE_LISTING_AUTH_PLACEHOLDER },
    },
    output: { type: 'json', example: ARCHIVE_PAY_OUTPUT_EXAMPLE },
  },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['POST'] },
          bodyType: { type: 'string', enum: ['json', 'form-data', 'text'] },
          body: { type: 'object', properties: {}, additionalProperties: false },
          headers: {
            type: 'object',
            properties: {
              Authorization: {
                type: 'string',
                pattern: '^Bearer pvn_live_',
                description: "The agent's Provian API key: Bearer <api_key>:<api_secret>.",
              },
            },
            required: ['Authorization'],
            additionalProperties: { type: 'string' },
          },
        },
        required: ['type', 'method', 'bodyType', 'body', 'headers'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          example: { type: 'object', ...ARCHIVE_PAY_OUTPUT_SCHEMA },
        },
        required: ['type'],
      },
    },
    required: ['input'],
  },
} as const;

/** What a settlement of the agent route declares: the listing resource and the Bazaar extension. */
export function archiveAgentListing(resourceUrl: string): CdpSettlementListing {
  return {
    resource: {
      url: resourceUrl,
      description: ARCHIVE_LISTING_DESCRIPTION,
      mimeType: 'application/json',
      serviceName: ARCHIVE_LISTING_SERVICE_NAME,
      tags: ARCHIVE_LISTING_TAGS,
      iconUrl: ARCHIVE_LISTING_ICON_URL,
    },
    extensions: { bazaar: ARCHIVE_BAZAAR_EXTENSION },
  };
}

/** What a settlement of the people's route declares: its resource only, no listing. */
export function archiveHumanListing(resourceUrl: string): CdpSettlementListing {
  return {
    resource: { url: resourceUrl, description: ARCHIVE_SERVICE_TERMS.description, mimeType: 'application/json' },
  };
}

/** The agent route's 402: the shared quote with the listing's `resource` and the Bazaar extension. */
export function archiveAgentPaymentRequired(resourceUrl: string, error?: string): Record<string, unknown> {
  const listing = archiveAgentListing(resourceUrl);
  return {
    ...usdcPaymentRequired(ARCHIVE_SERVICE_TERMS, resourceUrl, error),
    resource: listing.resource,
    extensions: listing.extensions,
  };
}

export function checkArchivePayment(raw: unknown, nowSeconds: number): UsdcChargeTermsResult {
  return checkUsdcChargePayment(raw, nowSeconds, ARCHIVE_GB_FEE_USDC_ATOMIC);
}

/** One archive payment per USDC authorization (domain-separated from every other service). */
export function archivePaymentRequestId(auth: Pick<Erc3009Authorization, 'from' | 'nonce'>): string {
  return usdcChargeRequestId('ap', 'provian.archive.v1', auth);
}

/**
 * Whether a payment may buy a GB now: always when the Archive has no space yet (turn-on), and
 * otherwise only once the used space is within ARCHIVE_TOPUP_WINDOW_BYTES of the paid space.
 */
export function archiveGbPurchasable(account: { readonly paid_bytes: number; readonly used_bytes: number } | null): boolean {
  if (account === null || account.paid_bytes <= 0) return true;
  return account.paid_bytes - account.used_bytes < ARCHIVE_TOPUP_WINDOW_BYTES;
}

/** The least any one stored part counts against the paid space: 1 MB (10^6 bytes). */
export const ARCHIVE_MIN_CHARGED_PART_BYTES = 1_000_000;

/** What a part of `bytes` bytes counts against the paid space (never less than 1 MB). */
export function archiveChargedBytes(bytes: number): number {
  return Math.max(bytes, ARCHIVE_MIN_CHARGED_PART_BYTES);
}

/** Whether `bytes` more fit in the paid space. */
export function archiveSpaceFits(account: { readonly paid_bytes: number; readonly used_bytes: number }, bytes: number): boolean {
  return account.used_bytes + bytes <= account.paid_bytes;
}
