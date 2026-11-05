/**
 * link_spend — the Stripe Link spend WITNESS (wallet simplification, ).
 *
 * When an agent completes a purchase through Link's wallet for agents, the SDK /
 * daemon records a `link_spend` Provenance Envelope carrying the spend-request
 * record — id, amount, currency, merchant, terminal status, timestamps — and
 * NOTHING else. Provian witnesses after the fact; it never approves, holds a
 * credential, or sits in the money path. There is no Stripe-side verifier: the
 * witness is the observer's own submission signature (device body-binding on the
 * daemon route, the agent's EOA binding on the sovereign route), exactly as for
 * daemon-captured work and self-wrapped x402.
 *
 * MINT-ONCE / NOVELTY ANCHOR: the Link spend-request id (`lsrq_…`). On the
 * sovereign route it IS the `occurrence_id` (the (signer, occurrence) claim); on
 * the device route it is the canonical event (`link_spend:<id>`, device_occurrence
 * claim). A replay of the same id reprices to 0 on either route.
 *
 * SECURITY INVARIANT #1 — no credential can enter a PE, a log, or a transcript.
 * `linkSpendCredentialLeak` REJECTS (never redacts-and-continues) a payload that
 * carries a card object, a card-number-shaped value, a Link access token, a
 * shared payment token / Link Pay Token, or any key whose name says credential.
 * Both routes run it BEFORE anything is persisted or logged. RED controls live in
 * `link-spend-witness.test.ts`.
 */

/** Stripe Link spend-request id shape (`lsrq_` + opaque token). */
export const LINK_SPEND_ID_RE = /^lsrq_[A-Za-z0-9]{6,120}$/;

/** Spend-request lifecycle statuses the Link CLI documents. */
export const LINK_SPEND_STATUSES = [
  'created', 'pending_approval', 'requires_action', 'approved', 'submitted',
  'denied', 'expired', 'canceled', 'succeeded', 'failed',
] as const;
export type LinkSpendStatus = (typeof LINK_SPEND_STATUSES)[number];

/** Only a SUCCEEDED spend is a completed purchase — the act the eligible row prices. */
export const LINK_SPEND_ELIGIBLE_STATUS: LinkSpendStatus = 'succeeded';

export const LINK_SPEND_CREDENTIAL_TYPES = ['card', 'shared_payment_token', 'link_pay_token'] as const;

/** The exact witness fields a link_spend PE may carry (allowlist — nothing else is stored). */
export interface LinkSpendWitnessFields {
  readonly link_spend_id: string;
  readonly amount: number;            // minor units, integer ≥ 0
  readonly currency: string;          // ISO-4217 lowercase, 3 letters
  readonly status: LinkSpendStatus;
  readonly merchant_name: string | null;
  readonly merchant_url: string | null;
  readonly credential_type: (typeof LINK_SPEND_CREDENTIAL_TYPES)[number] | null;
  readonly created_at: number | null;  // epoch ms
  readonly approved_at: number | null; // epoch ms
  readonly agent_wallet_id: string | null;
  readonly beneficiary_wallet_id: string | null;
}

export type LinkSpendValidation =
  | { readonly ok: true; readonly fields: LinkSpendWitnessFields }
  | { readonly ok: false; readonly code: LinkSpendRejectCode; readonly reason: string };

export type LinkSpendRejectCode =
  | 'LINK_SPEND_CREDENTIAL_REJECTED'
  | 'LINK_SPEND_ID_MALFORMED'
  | 'LINK_SPEND_STATUS_INVALID'
  | 'LINK_SPEND_AMOUNT_INVALID'
  | 'LINK_SPEND_CURRENCY_INVALID'
  | 'LINK_SPEND_METADATA_INVALID';

// Keys that name a credential, a card, or a token. Matched case-insensitively on
// every key at every depth. `token` alone is deliberately included: nothing a
// link_spend witness legitimately carries is called a token.
const CREDENTIAL_KEY_RE = /(^|_|-)(card|pan|cvc|cvv|cvv2|exp_month|exp_year|expiry|number|credential|credentials|secret|password|token|access_token|link_access_token|shared_payment_token|spt|link_pay_token|lpt|authorization)($|_|-)/i;
// A 13–19 digit run (optionally space/dash separated) is card-number-shaped.
const PAN_RE = /(?:\d[ -]?){13,19}/;
// Link access tokens / Link Pay Tokens / shared payment tokens by prefix.
const TOKEN_VALUE_RE = /\b(lat_|lpt_|spt_|sk_live_|sk_test_|pk_live_|pk_test_)[A-Za-z0-9_]{6,}/;
const ENV_TOKEN_RE = /LINK_ACCESS_TOKEN/;
// The ONE allowlisted witness field whose NAME contains a credential word: its value
// is the enum `card|shared_payment_token|link_pay_token` (which credential KIND Link
// used), never a credential. Exempt by exact top-level key only; its value is still
// scanned, and the same key nested anywhere deeper is still refused.
const EXEMPT_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['credential_type']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns a human-readable reason when the payload carries anything credential-
 * shaped, else null. Walks keys AND values at every depth (objects, arrays).
 */
export function linkSpendCredentialLeak(value: unknown, keyPath = ''): string | null {
  if (typeof value === 'string') {
    if (ENV_TOKEN_RE.test(value)) return `value at ${keyPath || '$'} mentions LINK_ACCESS_TOKEN`;
    if (TOKEN_VALUE_RE.test(value)) return `value at ${keyPath || '$'} is token-shaped`;
    if (PAN_RE.test(value)) return `value at ${keyPath || '$'} is card-number-shaped`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const leak = linkSpendCredentialLeak(value[i], `${keyPath}[${i}]`);
      if (leak) return leak;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = keyPath ? `${keyPath}.${k}` : k;
      const exempt = keyPath === '' && EXEMPT_TOP_LEVEL_KEYS.has(k);
      if (!exempt && CREDENTIAL_KEY_RE.test(k)) return `key ${p} names a credential/card/token`;
      const leak = linkSpendCredentialLeak(v, p);
      if (leak) return leak;
    }
  }
  return null;
}

function optString(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
}
function optEpochMs(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

/**
 * Validate a client-supplied link_spend metadata object and project it onto the
 * exact allowlisted witness fields. Credential check runs FIRST so a leaking
 * payload is refused before any field is read.
 */
export function validateLinkSpendMetadata(metadata: unknown): LinkSpendValidation {
  if (!isRecord(metadata)) {
    return { ok: false, code: 'LINK_SPEND_METADATA_INVALID', reason: 'metadata must be an object' };
  }
  const leak = linkSpendCredentialLeak(metadata);
  if (leak) return { ok: false, code: 'LINK_SPEND_CREDENTIAL_REJECTED', reason: leak };

  const id = metadata.link_spend_id;
  if (typeof id !== 'string' || !LINK_SPEND_ID_RE.test(id)) {
    return { ok: false, code: 'LINK_SPEND_ID_MALFORMED', reason: 'metadata.link_spend_id must be a Link spend-request id (lsrq_…)' };
  }
  const status = metadata.status;
  if (typeof status !== 'string' || !(LINK_SPEND_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, code: 'LINK_SPEND_STATUS_INVALID', reason: `metadata.status must be one of ${LINK_SPEND_STATUSES.join('|')}` };
  }
  const amount = metadata.amount;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    return { ok: false, code: 'LINK_SPEND_AMOUNT_INVALID', reason: 'metadata.amount must be an integer in minor units (≥ 0)' };
  }
  const currency = metadata.currency;
  if (typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) {
    return { ok: false, code: 'LINK_SPEND_CURRENCY_INVALID', reason: 'metadata.currency must be a 3-letter lowercase ISO-4217 code' };
  }
  const credentialType = typeof metadata.credential_type === 'string'
    && (LINK_SPEND_CREDENTIAL_TYPES as readonly string[]).includes(metadata.credential_type)
    ? (metadata.credential_type as LinkSpendWitnessFields['credential_type'])
    : null;
  return {
    ok: true,
    fields: {
      link_spend_id: id,
      amount,
      currency,
      status: status as LinkSpendStatus,
      merchant_name: optString(metadata.merchant_name),
      merchant_url: optString(metadata.merchant_url, 500),
      credential_type: credentialType,
      created_at: optEpochMs(metadata.created_at),
      approved_at: optEpochMs(metadata.approved_at),
      agent_wallet_id: optString(metadata.agent_wallet_id, 120),
      beneficiary_wallet_id: optString(metadata.beneficiary_wallet_id, 120),
    },
  };
}

/**
 * the Link invocation a TRANSCRIPT-lane record came from. The SDK
 * daemon's transcript lane (source `transcript`) used to witness any `lsrq_`
 * record appearing in ANY tool result — an `echo`, a Read of a file, a WebFetch —
 * so a fresh id minted every time. The fixed daemon pairs a result with its tool
 * call and stamps `link_spend_binding` (`link_cli:<verb>` / `link_mcp:<verb>`)
 * only when the call was the Link CLI's own spend-request invocation (or its MCP
 * tool) naming the same id. Mirrors `provian-agent-sdk/src/link-invocation.ts`.
 */
export const LINK_SPEND_BINDING_RE = /^link_(cli|mcp):(create|retrieve|update|request_approval|cancel|mpp_pay)$/;

/**
 * True unless the record claims to come from the daemon's transcript lane
 * without the pairing binding — i.e. a daemon that predates the pairing
 * gate, whose recognizer turns arbitrary tool-output text into a record. Such a
 * record still RECORDS (validation is unchanged) but has no canonical act, so it
 * seals record_only. A link_spend body with no transcript source (the removed
 * explicit `recordLinkSpend` API — the agent's own report of its spend) never
 * reaches this function: the device route refuses it upstream.
 */
export function linkSpendTranscriptBindingPresent(metadata: unknown): boolean {
  if (!isRecord(metadata) || metadata.source !== 'transcript') return true;
  const b = metadata.link_spend_binding;
  return typeof b === 'string' && LINK_SPEND_BINDING_RE.test(b);
}

/** The device-route canonical event: only a SUCCEEDED spend is a completed act. */
export function linkSpendCanonicalEvent(metadata: unknown): string | null {
  const v = validateLinkSpendMetadata(metadata);
  if (!v.ok || v.fields.status !== LINK_SPEND_ELIGIBLE_STATUS) return null;
  if (!linkSpendTranscriptBindingPresent(metadata)) return null;
  return `link_spend:${v.fields.link_spend_id}`;
}
