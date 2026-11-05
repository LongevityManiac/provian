/**
 * Burn-backed presentation gate (the operator: "Sellers can require a burn-backed presentation from
 * buyers (reading stays free)").
 *
 * Only PAYING is gated: the 402 terms, /supported, /fee-quote and the seller listings stay free.
 * When a seller's profile has `require_presentation`, the payment payload must carry
 *
 * extensions["provian-presentation"] = { token: <presentation token>, challenge: "x402-pay:<payer>" }
 *
 * and the relay's public, stateless `POST /v1/present/verify` must accept it with
 * audience = the seller's registered id (`base:0x…` / `solana:<base58>`),
 * challenge = `x402-pay:<payer>` (EVM payer lowercased) — the presentation names THIS buyer,
 * expected_presenter = the payer (EVM only; the presenter address is an EVM address),
 * at the tier the seller requires, answering every predicate the seller named with `true`.
 * The presentation id (= its burn id) is single-use: checked at /verify, consumed at /settle
 * before anything is broadcast (the verifier accepts each presentation_id once).
 */
import { z } from 'zod';
import { PRESENTATION_EXTENSION_KEY } from './constants.js';
import type { FacilitatorStore, SellerRecord } from './store.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PresentationCheck =
  | { readonly ok: true; readonly presentationId: string | null; readonly expiresAtMs: number }
  | { readonly ok: false; readonly reason: string };

const extensionSchema = z.object({ token: z.string().min(16).max(16_384), challenge: z.string().min(1).max(256) }).strict();

const verifyResponseSchema = z
  .object({
    valid: z.boolean(),
    tier: z.enum(['pe_fact', 'reputation']).optional(),
    presentation_id: z.string().min(1).optional(),
    presenter_address: z.string().optional(),
    challenge_expires_at: z.number().nullable().optional(),
    predicates: z
      .array(z.object({ field: z.string(), op: z.string(), result: z.boolean() }).passthrough())
      .optional(),
    reason: z.string().optional(),
  })
  .passthrough();

export function expectedChallenge(chain: 'base' | 'solana', payer: string): string {
  return `x402-pay:${chain === 'base' ? payer.toLowerCase() : payer}`;
}

export async function checkPresentation(args: {
  seller: SellerRecord;
  payer: string;
  extensions: Record<string, unknown> | undefined;
  relayUrl: string;
  fetch: FetchLike;
  store: FacilitatorStore;
}): Promise<PresentationCheck> {
  const required = args.seller.require_presentation;
  if (!required) return { ok: true, presentationId: null, expiresAtMs: 0 };
  const raw = args.extensions?.[PRESENTATION_EXTENSION_KEY];
  const parsed = extensionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'presentation_required' };
  const challenge = expectedChallenge(args.seller.chain, args.payer);
  if (parsed.data.challenge !== challenge) return { ok: false, reason: 'presentation_challenge_mismatch' };

  const body: Record<string, unknown> = {
    token: parsed.data.token,
    audience: args.seller.seller_id,
    challenge,
  };
  if (args.seller.chain === 'base') body.expected_presenter = args.payer.toLowerCase();
  if (required.predicates && required.predicates.length > 0) body.predicates = required.predicates;

  let json: unknown;
  try {
    const res = await args.fetch(`${args.relayUrl}/v1/present/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 400) return { ok: false, reason: 'presentation_verifier_unavailable' };
    json = await res.json();
  } catch {
    return { ok: false, reason: 'presentation_verifier_unavailable' };
  }
  const result = verifyResponseSchema.safeParse(json);
  if (!result.success || !result.data.valid) return { ok: false, reason: 'presentation_invalid' };
  const r = result.data;
  if (r.tier !== required.tier) return { ok: false, reason: 'presentation_tier_mismatch' };
  if (!r.presentation_id) return { ok: false, reason: 'presentation_invalid' };
  if (args.seller.chain === 'base' && (r.presenter_address ?? '').toLowerCase() !== args.payer.toLowerCase()) {
    return { ok: false, reason: 'presentation_presenter_mismatch' };
  }
  if (required.tier === 'reputation' && required.predicates && required.predicates.length > 0) {
    const answered = r.predicates ?? [];
    for (const want of required.predicates) {
      const hit = answered.find((p) => p.field === want.field && p.op === want.op);
      if (!hit || hit.result !== true) return { ok: false, reason: 'presentation_predicate_unmet' };
    }
  }
  if (await args.store.isPresentationUsed(r.presentation_id)) return { ok: false, reason: 'presentation_already_used' };
  const expiresAtMs = typeof r.challenge_expires_at === 'number' ? r.challenge_expires_at * 1000 : Date.now() + 86_400_000;
  return { ok: true, presentationId: r.presentation_id, expiresAtMs: Math.max(expiresAtMs, Date.now() + 86_400_000) };
}
