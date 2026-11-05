/**
 * Solana fee quotes.
 *
 * On Solana the BUYER's transaction carries the fee, so the amount is fixed when the seller writes
 * its 402 terms, before the facilitator sees the transaction. The fee is still "actual gas +
 * $0.0003": the gas is exactly what the transaction itself sets (5,000 lamports per signature + the
 * compute-unit limit × price it declares), priced in USD at SOL/USD.
 *
 * GET /fee-quote returns that amount with a signed quote token (5-minute validity) naming the SOL
 * price used. At /verify the facilitator requires BOTH:
 *   (a) fee ≥ ceil(lamports × quoted price) + $0.0003 — the quoted fee for this exact transaction, and
 *   (b) fee ≥ ceil(lamports × live price)               — the gas is covered at today's price,
 * so a quote can never leave Provian paying gas the fee does not cover. Without a valid quote the
 * live price is used for (a). The token is an HMAC under a key derived from the relay secret.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { SOLANA_QUOTE_TTL_MS } from '../constants.js';

export interface QuotePrice {
  readonly price: bigint;
  readonly expo: number;
  readonly issuedAtMs: number;
}

function keyOf(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), Buffer.from('provian-x402-solana-fee-quote-v1'), 32));
}

function b64url(b: Buffer): string {
  return b.toString('base64url');
}

export function signQuote(secret: string, network: string, q: QuotePrice): string {
  const body = b64url(Buffer.from(JSON.stringify({ v: 1, n: network, p: q.price.toString(), e: q.expo, t: q.issuedAtMs })));
  const mac = createHmac('sha256', keyOf(secret)).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

/** The quoted price, or null when the token is absent, forged, for another network, or expired. */
export function readQuote(secret: string | null, network: string, token: unknown, nowMs: number): QuotePrice | null {
  if (!secret || typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const want = createHmac('sha256', keyOf(secret)).update(body).digest();
  let got: Buffer;
  try {
    got = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1 || o.n !== network || typeof o.p !== 'string' || !/^[1-9]\d{0,30}$/.test(o.p)) return null;
  if (typeof o.e !== 'number' || !Number.isInteger(o.e) || typeof o.t !== 'number' || !Number.isInteger(o.t)) return null;
  if (nowMs - o.t > SOLANA_QUOTE_TTL_MS || o.t > nowMs + 60_000) return null;
  return { price: BigInt(o.p), expo: o.e, issuedAtMs: o.t };
}
