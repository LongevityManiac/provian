/**
 * Coinbase CDP's x402 facilitator: the PE Archive's settler from the launch flip (:
 * "The PE Archive settles through Coinbase's CDP facilitator, using the existing CDP developer API
 * key (the onramp key), and declares the x402 Bazaar discovery extension"). Provian's own facilitator
 * (`provian-facilitator/`) stays as built, for other sellers; the $1 payout keeps the relay's
 * charge gas key.
 *
 * What CDP does here is submit the payer's EIP-3009 `transferWithAuthorization` and pay its gas.
 * Nothing about what counts as paid changes: the relay checks every term against its own constants
 * before calling CDP, sends CDP the relay's OWN requirement (never the client's echo of it), and
 * then decides "charged" from the chain exactly as before — the receipt must show USDC's
 * `AuthorizationUsed(from, nonce)` followed by THE Transfer(from → revenue wallet, exact fee)
 * (`authorizationPaidFee`). CDP's answer only supplies the transaction hash to look at; a CDP
 * failure of any kind throws, and the shared charge path keeps a thrown submit UNCONFIRMED until the
 * chain decides (`submitUsdcCharge`, `chargeStatusNow`), because a settle can broadcast and still
 * fail the call. Custody: none — USDC moves payer → revenue wallet in one transaction.
 *
 * The listing a settle carries (`resource` + `extensions`) is built by the relay from pinned
 * constants (`archive-terms.ts`); what the client sent in its payload's `resource` / `extensions`
 * is never forwarded. A settlement that carries the Bazaar extension is what makes Coinbase's
 * Bazaar index the resource.
 *
 * Auth: a CDP JWT signed with the Secret API key (EdDSA), the same shape `@coinbase/x402` builds
 * through `@coinbase/cdp-sdk` (`uris` claim, header nonce, 120 s). Verified against
 * `GET /platform/v2/x402/supported` and `POST /verify` with the production key on 2026-10-07.
 */
import crypto from 'crypto';
import { ed25519KeyFromCdpSecret, type CdpCredentials } from '../onramp/coinbase-cdp-auth';
import type { UsdcChargePayment, UsdcPaymentRequirement } from './usdc-charge';

export const CDP_FACILITATOR_HOST = 'api.cdp.coinbase.com';

/** CDP's settle schema caps `paymentPayload.resource.description` at this many characters (`maxLength`). */
export const CDP_RESOURCE_DESCRIPTION_MAX_CHARS = 500;
export const CDP_FACILITATOR_ROUTE = '/platform/v2/x402';
/** A settle waits at most this long for CDP; a timeout is a thrown (unconfirmed) submit. */
export const CDP_FACILITATOR_TIMEOUT_MS = 30_000;
const CDP_JWT_TTL_SECONDS = 120;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

const b64u = (bytes: Buffer | string): string => Buffer.from(bytes).toString('base64url');

/** One request's bearer token (EdDSA over the CDP Secret API key; `uris` = METHOD host+path). */
export function cdpFacilitatorJwt(
  creds: CdpCredentials,
  method: 'GET' | 'POST',
  path: string,
  nowSeconds: number,
  nonceHex: string = crypto.randomBytes(16).toString('hex'),
): string {
  const header = { alg: 'EdDSA', kid: creds.keyId, typ: 'JWT', nonce: nonceHex };
  const claims = {
    sub: creds.keyId,
    iss: 'cdp',
    uris: [`${method} ${CDP_FACILITATOR_HOST}${path}`],
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + CDP_JWT_TTL_SECONDS,
  };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const signature = crypto.sign(null, Buffer.from(input), ed25519KeyFromCdpSecret(creds.secret));
  return `${input}.${b64u(signature)}`;
}

/** The x402 v2 `resource` a settlement declares (Bazaar reads description / serviceName / tags / iconUrl). */
export interface X402ResourceInfo {
  readonly url: string;
  readonly description: string;
  readonly mimeType: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
}

/** What a settlement says about the resource it pays for. Built by the relay, never by the client. */
export interface CdpSettlementListing {
  readonly resource: X402ResourceInfo;
  /** `{ bazaar: { info, schema } }` on a resource meant to be listed; absent otherwise. */
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * The `/settle` body: the payer's authorization and signature, inside a payload whose `accepted`
 * is the relay's own requirement and whose `resource` / `extensions` are the relay's listing.
 */
export function cdpSettleBody(
  payment: UsdcChargePayment,
  requirement: UsdcPaymentRequirement,
  listing: CdpSettlementListing,
): Record<string, unknown> {
  const paymentPayload: Record<string, unknown> = {
    x402Version: 2,
    resource: listing.resource,
    accepted: requirement,
    payload: { signature: payment.signature, authorization: payment.authorization },
    ...(listing.extensions !== undefined ? { extensions: listing.extensions } : {}),
  };
  return { x402Version: 2, paymentPayload, paymentRequirements: requirement };
}

export interface CdpFacilitator {
  /**
   * Ask CDP to settle. Returns the settlement transaction hash (lowercased) when CDP reports
   * success with a well-formed hash; THROWS on anything else (refusal, HTTP error, timeout,
   * malformed reply). The caller treats a throw as "may be charged" and lets the chain decide.
   */
  settle(payment: UsdcChargePayment, requirement: UsdcPaymentRequirement, listing: CdpSettlementListing): Promise<string>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function createCdpFacilitator(params: {
  readonly creds: CdpCredentials;
  readonly fetchImpl?: FetchLike;
  readonly nowSeconds?: () => number;
  readonly timeoutMs?: number;
}): CdpFacilitator {
  const doFetch: FetchLike = params.fetchImpl ?? ((url, init) => fetch(url, init));
  const nowSeconds = params.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = params.timeoutMs ?? CDP_FACILITATOR_TIMEOUT_MS;
  return {
    settle: async (payment, requirement, listing) => {
      const path = `${CDP_FACILITATOR_ROUTE}/settle`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let status = 0;
      let text = '';
      try {
        const res = await doFetch(`https://${CDP_FACILITATOR_HOST}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${cdpFacilitatorJwt(params.creds, 'POST', path, nowSeconds())}`,
          },
          body: JSON.stringify(cdpSettleBody(payment, requirement, listing)),
          signal: controller.signal,
        });
        status = res.status;
        text = await res.text();
        if (!res.ok) throw new Error(`cdp_settle_http_${status}:${text.slice(0, 200)}`);
      } finally {
        clearTimeout(timer);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`cdp_settle_reply_not_json:${status}`);
      }
      const reply = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
      if (reply.success !== true) {
        const reason = typeof reply.errorReason === 'string' ? reply.errorReason : 'unknown';
        throw new Error(`cdp_settle_refused:${reason}`);
      }
      const tx = reply.transaction;
      if (typeof tx !== 'string' || !TX_HASH.test(tx)) throw new Error('cdp_settle_transaction_malformed');
      return tx.toLowerCase();
    },
  };
}
