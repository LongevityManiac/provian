/**
 * pe-origin-resolver — the `pe:` origin class (Trust Layer build, §2.1/§2.3).
 *
 * A PE cites another PE's OUTPUT as an `input_origins` entry `pe:<pe_id>`, DECLARED by the citer's
 * daemon/app (a human-approval PE, an agent building on a known PE). The owner of a `pe:` origin is
 * resolved by reading the cited act's priced row (never from the body): owner party =
 * `signer:<cited userId>` the SAME id space the reference graph keys `signer` on, so the
 * closed-loop detector walks `pe:` edges by construction.
 *
 * a `pe:` citation carries no producer signature, so it never counts toward the
 * cited party's Consumption (`origin-reference-graph.ts` records it as `cite_unsigned`); only a
 * SIGNED `out:` citation does (`output-citation.ts`). It is still resolved because it carries the
 * Accountability fact (an agent citing its human's `human_approval` PE) while the cited act's row
 * lives. The relay no longer DERIVES `pe:` origins from content hashes: the per-output digest index
 * that did it grew with history and is retired.
 *
 * Nothing here prices anything: a `pe:` origin adds ZERO to the independence multiplier (§2.2);
 * `origin-independence.ts` seals it `reason:'consumption_edge'`. This module only resolves.
 */

import { readActRow } from '../meter/act-row-store';
import type { Firestore } from 'firebase-admin/firestore';
import type { InputOrigin } from '../provenance/input-origins';

/** `pe:<pe_id>` — the pe_id grammar matches the relay's own (`pe_` + 1..240 url-safe chars). */
export const PE_ORIGIN_RE = /^pe:(pe_[A-Za-z0-9_-]{1,240})$/;
/** The owner-party scheme a resolved `pe:` origin maps to (a Provian signer id, verbatim). */
export const SIGNER_OWNER_RE = /^signer:(.+)$/;

export function isPeOriginIdentifier(id: string): boolean {
  return PE_ORIGIN_RE.test(id);
}

export function peOriginIdentifier(peId: string): string {
  return `pe:${peId}`;
}

export function signerOwner(signerId: string): string {
  return `signer:${signerId}`;
}

/** What a `pe:` origin resolved to (the cited PE's identity), or null when the PE is unknown. */
export interface ResolvedPeOrigin {
  readonly citedPeId: string;
  /** The cited PE's economic actor id (`pe_history.userId`) — the graph `signer` of that PE. */
  readonly citedSigner: string;
  readonly citedActionType: string;
  /** The cited PE's sealed hash (`pe_history.peHash`) — the `hash` a folded citation edge carries. */
  readonly citedPeHash: string | null;
}

/**
 * Resolve every `pe:` identifier among `origins` by reading the cited act's priced row. A missing or malformed
 * row resolves to null (→ `unresolvable_owner`, recorded, counts zero). Reads are per-doc, deduped.
 * A read that THROWS propagates so the caller can fail closed (never guesses an owner).
 */
export async function resolvePeOrigins(
  db: Firestore,
  origins: readonly InputOrigin[],
): Promise<Map<string, ResolvedPeOrigin | null>> {
  const out = new Map<string, ResolvedPeOrigin | null>();
  for (const o of origins) {
    const m = PE_ORIGIN_RE.exec(o.origin_identifier);
    if (!m || out.has(o.origin_identifier)) continue;
    // PE METER: the cited act's priced row lives in its 31-day act key (or, until the migration
    // retires them, a pre-meter `pe_history` row). Past its key a cited PE no longer resolves here
    // and counts zero — a consumption edge pays nothing either way.
    const data = (await readActRow(db, m[1]))?.row;
    if (!data || typeof data.userId !== 'string' || data.userId.length === 0
      || typeof data.actionType !== 'string') {
      out.set(o.origin_identifier, null);
      continue;
    }
    out.set(o.origin_identifier, {
      citedPeId: m[1],
      citedSigner: data.userId,
      citedActionType: data.actionType,
      citedPeHash: typeof data.peHash === 'string' && data.peHash.length > 0 ? data.peHash : null,
    });
  }
  return out;
}
