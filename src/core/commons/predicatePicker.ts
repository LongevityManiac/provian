/**
 * predicatePicker (§5) — plain sentences for "ask them to prove something".
 *
 * A challenge (forum) or a proof request (thread) names ONE predicate over the reputation
 * vocabulary (`provian-backend/src/core/presentation/vocabulary.ts`). People should not have to type
 * `work.total gte 10`, so the picker offers a handful of sentences, each of which maps 1:1 to a
 * `ChallengePredicate`. The raw field / operator / threshold form stays behind "Advanced", and it is
 * validated here with the same field shape the relay enforces (`CHALLENGE_FIELD_RE` in
 * `core/commons/forum.ts`) so an out-of-vocabulary field is refused before any burn.
 */
import type { ChallengePredicate } from './CommonsService';

export type GuidedClaimId =
  | 'work_total'
  | 'work_witnessed'
  | 'active_days'
  | 'streak_days'
  | 'promises_kept'
  | 'clean_record';

export interface GuidedClaim {
  id: GuidedClaimId;
  /** The vocabulary field (a number the relay computes live for every actor). */
  field: string;
  op: 'gte' | 'eq';
  /** The number the sentence starts with. */
  defaultN: number;
  /** A sentence with no number to pick (e.g. "has a clean record" = `standing.adverse_events eq 0`). */
  fixedN?: number;
}

/** The guided sentences, in display order. i18n: `commonsForum.claim.<id>` (with {{n}}). */
export const GUIDED_CLAIMS: readonly GuidedClaim[] = [
  { id: 'work_total', field: 'work.total', op: 'gte', defaultN: 10 },
  { id: 'work_witnessed', field: 'work.witnessed', op: 'gte', defaultN: 5 },
  { id: 'active_days', field: 'continuity.active_days', op: 'gte', defaultN: 30 },
  { id: 'streak_days', field: 'continuity.streak_days', op: 'gte', defaultN: 7 },
  { id: 'promises_kept', field: 'money.promises_fulfilled', op: 'gte', defaultN: 1 },
  { id: 'clean_record', field: 'standing.adverse_events', op: 'eq', defaultN: 0, fixedN: 0 },
];

/** The largest threshold a sentence accepts (a sanity bound; the relay only needs a finite number). */
export const MAX_CLAIM_N = 1_000_000;

/** The vocabulary namespaces a predicate field may name — mirrors the relay's CHALLENGE_FIELD_RE. */
export const VOCABULARY_FIELD_RE = /^(continuity|work|coupling|consumption|money|standing|accountability|composition|presentations|actor)\.[a-z0-9_.]+$/;

export const PREDICATE_OPS: readonly ChallengePredicate['op'][] = ['gte', 'gt', 'lte', 'lt', 'eq'];

export type PredicateResult =
  | { ok: true; predicate: ChallengePredicate }
  | { ok: false; error: 'unknown_claim' | 'bad_number' | 'field_out_of_vocabulary' | 'bad_op' };

export function guidedClaim(id: string): GuidedClaim | null {
  return GUIDED_CLAIMS.find((c) => c.id === id) ?? null;
}

/** Parse the number a person typed: a whole number 0…MAX_CLAIM_N, else null. */
export function parseClaimNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,7}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_CLAIM_N ? n : null;
}

/** A guided sentence + its number → the exact predicate the relay receives. */
export function buildGuidedPredicate(id: string, nText: string): PredicateResult {
  const claim = guidedClaim(id);
  if (!claim) return { ok: false, error: 'unknown_claim' };
  const n = claim.fixedN !== undefined ? claim.fixedN : parseClaimNumber(nText);
  if (n === null) return { ok: false, error: 'bad_number' };
  return { ok: true, predicate: { field: claim.field, op: claim.op, threshold: n } };
}

/** The Advanced (raw) form → a predicate, refused when the field is not a vocabulary field. */
export function buildRawPredicate(field: string, op: string, thresholdText: string): PredicateResult {
  const f = field.trim();
  if (!VOCABULARY_FIELD_RE.test(f) || f.split('.').some((seg) => seg === '__proto__' || seg === 'prototype' || seg === 'constructor' || seg === '')) {
    return { ok: false, error: 'field_out_of_vocabulary' };
  }
  if (!(PREDICATE_OPS as readonly string[]).includes(op)) return { ok: false, error: 'bad_op' };
  const trimmed = thresholdText.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, error: 'bad_number' };
  const threshold = Number(trimmed);
  if (!Number.isFinite(threshold)) return { ok: false, error: 'bad_number' };
  return { ok: true, predicate: { field: f, op: op as ChallengePredicate['op'], threshold } };
}

/** The guided sentence a predicate came from, if any (to describe it in plain words). */
export function matchGuidedClaim(p: { field: string; op: string; threshold?: number | null }): { claim: GuidedClaim; n: number } | null {
  const claim = GUIDED_CLAIMS.find((c) => c.field === p.field && c.op === p.op);
  if (!claim) return null;
  const n = typeof p.threshold === 'number' ? p.threshold : null;
  if (n === null) return null;
  if (claim.fixedN !== undefined && n !== claim.fixedN) return null;
  return { claim, n };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * A predicate in plain words: "has done at least 10 pieces of work". A predicate that is not one
 * of the guided sentences falls back to its raw form ("work.hardware_rooted ≥ 3") — never hidden.
 */
export function describePredicate(p: { field: string; op: string; threshold?: number | null; set?: number[] }, t: Translate): string {
  const hit = matchGuidedClaim(p);
  if (hit) return t(`commonsForum.claim.${hit.claim.id}`, { n: hit.n, count: hit.n });
  const sym: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=', in: '∈' };
  const rhs = p.op === 'in' && Array.isArray(p.set) ? `{${p.set.join(', ')}}` : String(p.threshold ?? '');
  return `${p.field} ${sym[p.op] ?? p.op} ${rhs}`.trim();
}

// ─── Picker state ────────────────────────────────────────────────────────────

/** What the picker holds while a person chooses (guided sentence, or the Advanced raw form). */
export interface PredicateDraft {
  mode: 'guided' | 'advanced';
  claimId: GuidedClaimId;
  nText: string;
  field: string;
  op: ChallengePredicate['op'];
  thresholdText: string;
}

export function initialPredicateDraft(): PredicateDraft {
  const first = GUIDED_CLAIMS[0];
  return { mode: 'guided', claimId: first.id, nText: String(first.defaultN), field: first.field, op: 'gte', thresholdText: String(first.defaultN) };
}

/** Pick a sentence: its number resets to that sentence's default. */
export function selectGuidedClaim(draft: PredicateDraft, id: GuidedClaimId): PredicateDraft {
  const claim = guidedClaim(id);
  if (!claim) return draft;
  return { ...draft, mode: 'guided', claimId: id, nText: String(claim.defaultN) };
}

export function predicateFromDraft(draft: PredicateDraft): PredicateResult {
  return draft.mode === 'guided'
    ? buildGuidedPredicate(draft.claimId, draft.nText)
    : buildRawPredicate(draft.field, draft.op, draft.thresholdText);
}
