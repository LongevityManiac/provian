/**
 * link_spend — the Stripe Link spend WITNESS (, wallet simplification).
 *
 * When an agent completes a purchase through Link's wallet for agents (the Link
 * CLI `spend-request` lifecycle: one-time card, Shared Payment Token, or Link Pay
 * Token — one spend request either way), Provian records a `link_spend`
 * Provenance Envelope carrying the spend-request RECORD — id, amount, currency,
 * merchant, status, timestamps, the agent, its beneficiary — and NOTHING else.
 * Provian witnesses after the fact; it never approves the spend, never holds a
 * credential, never sits in the money path. Stripe/Link need not know Provian
 * exists. the ONLY recorder is the observer daemon's transcript lane,
 * which witnesses the Link CLI result on the agent's machine; the public
 * `recordLinkSpend` API (the agent's own report of its spend) was removed.
 *
 * MINT-ONCE anchor: Link's spend-request id (`lsrq_…`) — the daemon route's
 * canonical event `link_spend:<id>`. A replay of one id reprices to 0. Only a
 * SUCCEEDED spend is the completed act.
 *
 * SECURITY INVARIANT #1 — no credential, card object, or LINK_ACCESS_TOKEN can
 * enter a PE, a log, or a transcript. This module PROJECTS a Link record onto
 * the exact allowlisted witness fields (a `card` object is never copied), scans
 * the projection for anything credential-shaped, and — on the explicit path —
 * REFUSES a raw input that carries a live credential rather than quietly
 * trimming it. The relay runs the identical scan again before persisting.
 * This file mirrors `provian-backend/src/core/pvt/link-spend-witness.ts`.
 */
import { ProvianError } from './errors';

export const LINK_SPEND_ACTION_TYPE = 'link_spend' as const;

/** Stripe Link spend-request id shape (`lsrq_` + opaque token). */
export const LINK_SPEND_ID_RE = /^lsrq_[A-Za-z0-9]{6,120}$/;

/** Spend-request lifecycle statuses the Link CLI documents (0.20.x). */
export const LINK_SPEND_STATUSES = [
  'created', 'pending_approval', 'requires_action', 'approved', 'submitted',
  'denied', 'expired', 'canceled', 'succeeded', 'failed',
] as const;
export type LinkSpendStatus = (typeof LINK_SPEND_STATUSES)[number];

/** Only a SUCCEEDED spend is a completed purchase — the act the eligible row prices. */
export const LINK_SPEND_ELIGIBLE_STATUS: LinkSpendStatus = 'succeeded';

export const LINK_SPEND_CREDENTIAL_TYPES = ['card', 'shared_payment_token', 'link_pay_token'] as const;
export type LinkSpendCredentialType = (typeof LINK_SPEND_CREDENTIAL_TYPES)[number];

/** The exact witness fields a link_spend PE carries (allowlist — nothing else). */
export interface LinkSpendWitness {
  readonly link_spend_id: string;
  readonly amount: number;            // minor units, integer ≥ 0
  readonly currency: string;          // ISO-4217, lowercase
  readonly status: LinkSpendStatus;
  readonly merchant_name: string | null;
  readonly merchant_url: string | null;
  readonly credential_type: LinkSpendCredentialType | null;
  readonly created_at: number | null;  // epoch ms
  readonly approved_at: number | null; // epoch ms
  readonly agent_wallet_id: string | null;
  readonly beneficiary_wallet_id: string | null;
}

/**
 * A Link spend-request record as the transcript lane sees it: either the SDK shape (`link_spend_id`,
 * ISO or epoch timestamps) or the raw Link CLI `spend-request retrieve` object
 * (`id`, `created` in unix seconds, …). Extra keys are dropped by projection.
 */
export interface LinkSpendInput {
  link_spend_id?: string;
  id?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  merchant_name?: string | null;
  merchant_url?: string | null;
  credential_type?: string | null;
  execution_method?: string | null;
  created_at?: number | string | null;
  approved_at?: number | string | null;
  created?: number | string | null;
  agent_wallet_id?: string | null;
  beneficiary_wallet_id?: string | null;
  [extra: string]: unknown;
}

export class LinkSpendCredentialError extends ProvianError {
  constructor(reason: string) {
    super(`link_spend refused: ${reason}. A PE never carries a card object, a credential, or LINK_ACCESS_TOKEN — record the spend-request RECORD (id/amount/currency/merchant/status), e.g. from \`spend-request retrieve\` WITHOUT --include.`, 'LINK_SPEND_CREDENTIAL_REJECTED');
    this.name = 'LinkSpendCredentialError';
  }
}

export class LinkSpendInvalidError extends ProvianError {
  constructor(reason: string) {
    super(`link_spend invalid: ${reason}`, 'LINK_SPEND_INVALID');
    this.name = 'LinkSpendInvalidError';
  }
}

// --- credential scan (byte-mirror of the relay's) ------------------------------
const CREDENTIAL_KEY_RE = /(^|_|-)(card|pan|cvc|cvv|cvv2|exp_month|exp_year|expiry|number|credential|credentials|secret|password|token|access_token|link_access_token|shared_payment_token|spt|link_pay_token|lpt|authorization)($|_|-)/i;
const PAN_RE = /(?:\d[ -]?){13,19}/;
const TOKEN_VALUE_RE = /\b(lat_|lpt_|spt_|sk_live_|sk_test_|pk_live_|pk_test_)[A-Za-z0-9_]{6,}/;
const ENV_TOKEN_RE = /LINK_ACCESS_TOKEN/;
const EXEMPT_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['credential_type']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Human-readable reason when `value` carries anything credential-shaped at any
 * depth (keys AND values), else null. Same rule the relay enforces.
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

// Keys whose presence in a RAW input means a LIVE credential was handed over
// (the Link CLI's `--include card|shared_payment_token|link_pay_token` shapes).
// A redacted card summary ({brand,last4}) carries none of these and is simply
// dropped by projection.
const LIVE_CREDENTIAL_KEY_RE = /^(number|cvc|cvv|cvv2|link_access_token|access_token|shared_payment_token|link_pay_token|spt|lpt)$/i;

/** Reason when a RAW input carries a live credential value, else null. */
export function linkSpendRawCredentialLeak(value: unknown, keyPath = ''): string | null {
  if (typeof value === 'string') {
    if (ENV_TOKEN_RE.test(value)) return `value at ${keyPath || '$'} mentions LINK_ACCESS_TOKEN`;
    if (TOKEN_VALUE_RE.test(value)) return `value at ${keyPath || '$'} is token-shaped`;
    if (PAN_RE.test(value)) return `value at ${keyPath || '$'} is card-number-shaped`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const leak = linkSpendRawCredentialLeak(value[i], `${keyPath}[${i}]`);
      if (leak) return leak;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      const p = keyPath ? `${keyPath}.${k}` : k;
      const nonEmpty = (typeof v === 'string' && v.length > 0) || isRecord(v) || (Array.isArray(v) && v.length > 0);
      if (LIVE_CREDENTIAL_KEY_RE.test(k) && nonEmpty) return `key ${p} carries a live credential`;
      const leak = linkSpendRawCredentialLeak(v, p);
      if (leak) return leak;
    }
  }
  return null;
}

// --- projection -----------------------------------------------------------------
function toEpochMs(v: unknown, unit: 'auto' | 'seconds' = 'auto'): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    if (unit === 'seconds') return Math.floor(v * 1000);
    // Heuristic: anything below 1e11 is unix seconds (year 5138 in seconds; 1973 in ms).
    return v < 1e11 ? Math.floor(v * 1000) : Math.floor(v);
  }
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return toEpochMs(n, unit);
    const p = Date.parse(v);
    return Number.isFinite(p) && p > 0 ? p : null;
  }
  return null;
}
function optStr(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
}

/**
 * Project a Link spend-request RECORD (SDK shape or raw CLI object) onto the
 * exact allowlisted witness fields. Returns null when the input is not a Link
 * spend request (no `lsrq_` id or no known status) — never throws, never copies
 * a `card` object, a token, or any key outside the allowlist.
 */
export function projectLinkSpendRecord(input: unknown): LinkSpendWitness | null {
  if (!isRecord(input)) return null;
  const idRaw = typeof input.link_spend_id === 'string' ? input.link_spend_id : input.id;
  if (typeof idRaw !== 'string' || !LINK_SPEND_ID_RE.test(idRaw)) return null;
  const status = typeof input.status === 'string' ? input.status.trim().toLowerCase() : '';
  if (!(LINK_SPEND_STATUSES as readonly string[]).includes(status)) return null;

  const amountRaw = typeof input.amount === 'string' ? Number(input.amount) : input.amount;
  const amount = typeof amountRaw === 'number' && Number.isInteger(amountRaw) && amountRaw >= 0 ? amountRaw : -1;
  const currency = typeof input.currency === 'string' ? input.currency.trim().toLowerCase() : '';

  let credentialType: LinkSpendCredentialType | null = null;
  if (input.execution_method === 'link_pay_token') credentialType = 'link_pay_token';
  else if (typeof input.credential_type === 'string'
    && (LINK_SPEND_CREDENTIAL_TYPES as readonly string[]).includes(input.credential_type)) {
    credentialType = input.credential_type as LinkSpendCredentialType;
  }

  return {
    link_spend_id: idRaw,
    amount,
    currency,
    status: status as LinkSpendStatus,
    merchant_name: optStr(input.merchant_name),
    merchant_url: optStr(input.merchant_url, 500),
    credential_type: credentialType,
    created_at: input.created_at !== undefined ? toEpochMs(input.created_at) : toEpochMs(input.created, 'seconds'),
    approved_at: toEpochMs(input.approved_at),
    agent_wallet_id: optStr(input.agent_wallet_id, 120),
    beneficiary_wallet_id: optStr(input.beneficiary_wallet_id, 120),
  };
}

/**
 * The EXPLICIT path's validator: refuses a raw input carrying a live credential,
 * requires a well-formed record, and returns the projected witness (scanned).
 * Throws `LinkSpendCredentialError` / `LinkSpendInvalidError`.
 */
export function buildLinkSpendWitness(input: LinkSpendInput | unknown): LinkSpendWitness {
  const rawLeak = linkSpendRawCredentialLeak(input);
  if (rawLeak) throw new LinkSpendCredentialError(rawLeak);
  const w = projectLinkSpendRecord(input);
  if (!w) throw new LinkSpendInvalidError('a Link spend-request id (lsrq_…) and a known status are required');
  if (w.amount < 0) throw new LinkSpendInvalidError('amount must be an integer in minor units (≥ 0)');
  if (!/^[a-z]{3}$/.test(w.currency)) throw new LinkSpendInvalidError('currency must be a 3-letter ISO code');
  const leak = linkSpendCredentialLeak(w);
  if (leak) throw new LinkSpendCredentialError(leak);
  return w;
}

/** The PE metadata for a witness — the allowlisted fields, nothing else. */
export function linkSpendWitnessMetadata(w: LinkSpendWitness): Record<string, unknown> {
  return { ...w };
}

/** One-line description (content-free: merchant name only, never a URL or an id). */
export function linkSpendDescription(w: LinkSpendWitness): string {
  const merchant = w.merchant_name ?? 'a merchant';
  return `Link spend ${w.status} at ${merchant} (${w.amount} ${w.currency})`;
}

// --- transcript-lane recognizer (PASSIVE; never throws; content-free output) ---
const KV_LINE_RE = /^\s*[-*]?\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*[:=]\s*"?([^"\n]*?)"?\s*,?\s*$/;
const KV_KEYS: ReadonlySet<string> = new Set([
  'id', 'link_spend_id', 'status', 'amount', 'currency', 'merchant_name', 'merchant_url',
  'credential_type', 'execution_method', 'created', 'created_at', 'approved_at',
]);

/**
 * Recognize a Link spend-request record inside a tool RESULT's text: JSON first,
 * then the key/value line formats the Link CLI prints for agents (toon/yaml/md).
 * Returns the projected witness ONLY when the record is a SUCCEEDED spend with a
 * clean projection — anything else (other statuses, lists, non-Link text, a
 * projection that still looks credential-shaped) → null. Never copies content
 * beyond the allowlisted fields; a `card` object in the result is never read.
 */
export function recognizeLinkSpendInText(text: string): LinkSpendWitness | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 262_144) return null;
  if (!text.includes('lsrq_')) return null;
  let candidate: unknown = null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try { candidate = JSON.parse(trimmed); } catch { candidate = null; }
  }
  if (!isRecord(candidate)) {
    // Key/value lines: only top-level-looking `key: value` pairs for the allowlisted keys.
    const kv: Record<string, unknown> = {};
    for (const line of text.split('\n')) {
      const m = KV_LINE_RE.exec(line);
      if (!m) continue;
      const k = m[1].toLowerCase();
      if (!KV_KEYS.has(k) || k in kv) continue;
      kv[k] = m[2].trim();
    }
    if (!('id' in kv) && !('link_spend_id' in kv)) return null;
    candidate = kv;
  }
  const w = projectLinkSpendRecord(candidate);
  if (!w) return null;
  if (w.status !== LINK_SPEND_ELIGIBLE_STATUS) return null;
  if (w.amount < 0 || !/^[a-z]{3}$/.test(w.currency)) return null;
  if (linkSpendCredentialLeak(w)) return null;
  return w;
}
