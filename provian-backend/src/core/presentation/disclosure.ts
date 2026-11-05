/**
 * Selective disclosure for the reputation tier — reveal-all-minus-redactions, plus derived
 * predicates (Trust Layer build §2.5/§2.6).
 *
 * The DEFAULT is full disclosure: the presentation carries every server-authenticated vocabulary
 * fact EXCEPT what the presenter explicitly redacts. A presenter may instead disclose a DERIVED
 * PREDICATE over a field (e.g. `continuity.chain_depth >= 100`, `standing.adverse_events in {0}`)
 * in place of the raw value — the raw value is then withheld and only the boolean result is
 * revealed. EXCEPTION: `standing.*` is ALWAYS PRESENT — it can neither be redacted nor withheld
 * behind a predicate (a predicate over it is answered AND the value stays disclosed).
 *
 * Requesters name predicates in the challenge envelope (§2.6); the presenter echoes them into its
 * directive, the server computes the results, Provian co-signs them, and the verifier returns the
 * results — never the chain. The presenter's proof of possession commits to the DIRECTIVE, so the
 * issuing server and a later verifier reconstruct the SAME canonical directive from the disclosed
 * block. This one module is the single source of that shape (mirrored byte-for-byte in the SDK,
 * the MCP core and the app: `canonicalReputationDirective`).
 */

import type { ReputationDisclosure, ReputationPredicate, PredicateOp } from './types';
import { PREDICATE_OPS, PREDICATE_SET_MAX } from './types';
import { isKnownVocabularyField, isPredicateOnlyField, isStandingField, PREDICATE_ONLY_OPS } from './vocabulary-fields';

/** A requested predicate over one vocabulary field. */
export interface PredicateRequest {
  readonly field: string;
  readonly op: PredicateOp;
  /** The comparison value (every op but `in`). */
  readonly threshold?: number;
  /** The membership set (`in` only). */
  readonly set?: readonly number[];
}

/**
 * The presenter's disclosure choice. Default (both empty, no `share`) = full disclosure.
 * SHARE-ONLY (, the operator on device): when `share` is present the relay reveals ONLY Standing, the
 * predicate answers and the listed fields — every other raw fact is withheld, including any field
 * that first appears between the presenter's last look and issuance. `share` and `redact` are
 * exclusive (a directive names one side of the line, never both).
 */
export interface DisclosureDirective {
  /** Field names to withhold entirely (no raw value, no predicate). Never `standing.*`. */
  readonly redact: readonly string[];
  /** Predicates to derive (the field is then withheld — except `standing.*`, always disclosed). */
  readonly predicates: readonly PredicateRequest[];
  /** Share-only mode: the non-standing fields to reveal as raw values; everything else is withheld. */
  readonly share?: readonly string[];
}

export type CanonicalPredicate =
  | { field: string; op: string; threshold: number }
  | { field: string; op: 'in'; set: number[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** One predicate in canonical form: `in` carries a sorted, de-duplicated set; every other op its threshold. */
export function canonicalPredicate(p: PredicateRequest): CanonicalPredicate {
  if (p.op === 'in') {
    const set = [...new Set((p.set ?? []).filter(isFiniteNumber))].sort((a, b) => a - b);
    return { field: p.field, op: 'in', set };
  }
  return { field: p.field, op: p.op, threshold: isFiniteNumber(p.threshold) ? p.threshold : NaN };
}

export function predicateSortKey(c: CanonicalPredicate): string {
  return `${c.field}\n${c.op}\n${'set' in c ? c.set.join(',') : c.threshold}`;
}

/** The canonical, order-independent representation the PoP binding commits to.
 *  Signer and verifier both derive the claims digest from THIS. */
export function canonicalReputationDirective(directive: DisclosureDirective): {
  redact: string[];
  predicates: CanonicalPredicate[];
  share?: string[];
} {
  return {
    redact: [...directive.redact].sort(),
    predicates: [...directive.predicates]
      .map(canonicalPredicate)
      .sort((a, b) => predicateSortKey(a).localeCompare(predicateSortKey(b))),
    // Present ONLY in share-only mode, so every pre-existing directive's bytes (and digest) are unchanged.
    ...(directive.share !== undefined ? { share: [...new Set(directive.share)].sort() } : {}),
  };
}

/** Two predicates are the same request when their canonical forms are byte-identical. */
export function predicateMatchesRequest(answered: PredicateRequest, requested: PredicateRequest): boolean {
  return JSON.stringify(canonicalPredicate(answered)) === JSON.stringify(canonicalPredicate(requested));
}

/**
 * Parse an untrusted predicate list into well-formed requests, fail-closed: `null` when the value is
 * not a list or any entry is malformed (an unknown op, a non-finite threshold, a set that is not a
 * bounded list of finite numbers, an over-long field name). Fields are NOT validated against the
 * vocabulary here — that is `applyReputationDisclosure`'s job, against the live facts.
 */
export function normalizePredicateRequests(raw: unknown): PredicateRequest[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > PREDICATE_SET_MAX) return null;
  const out: PredicateRequest[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const p = entry as Record<string, unknown>;
    const field = typeof p.field === 'string' ? p.field.trim() : '';
    if (field.length === 0 || field.length > 128) return null;
    const op = p.op;
    if (typeof op !== 'string' || !(PREDICATE_OPS as readonly string[]).includes(op)) return null;
    if (op === 'in') {
      if (!Array.isArray(p.set) || p.set.length === 0 || p.set.length > PREDICATE_SET_MAX) return null;
      if (!p.set.every(isFiniteNumber)) return null;
      out.push({ field, op: 'in', set: [...p.set] as number[] });
    } else {
      if (!isFiniteNumber(p.threshold)) return null;
      out.push({ field, op: op as PredicateOp, threshold: p.threshold });
    }
  }
  return out;
}

function evalPredicate(value: number, p: PredicateRequest): boolean {
  switch (p.op) {
    case 'gte': return value >= (p.threshold as number);
    case 'gt': return value > (p.threshold as number);
    case 'lte': return value <= (p.threshold as number);
    case 'lt': return value < (p.threshold as number);
    case 'eq': return value === p.threshold;
    case 'in': return (p.set ?? []).includes(value);
    default: return false;
  }
}

export type ApplyDisclosureResult =
  | { ok: true; disclosure: ReputationDisclosure }
  | { ok: false; error: string };

/**
 * Apply a disclosure directive to the FULL server-authenticated vocabulary facts.
 * Reveal-all-minus-redactions: every fact is disclosed with its raw value unless it is redacted or
 * covered by a predicate. Predicate fields are withheld and emitted only as a boolean result.
 * A directive naming a field that is neither a live fact nor a pattern-valid never-seen key is
 * refused (fail-closed — no silent no-op that would let a presenter believe a value was hidden when
 * it was disclosed); a pattern-valid never-seen key reads 0 and evaluates normally (item 5).
 * `standing.*` can never be redacted (refused) and is never withheld behind a predicate (§2.5:
 * ALWAYS PRESENT). PREDICATE-ONLY fields (the witnessed payment volume) are never disclosed raw,
 * accept only an order op (`gte|gt|lte|lt`), and at most ONE predicate per field (item 8).
 */
export function applyReputationDisclosure(
  fullFacts: Readonly<Record<string, number>>,
  directive: DisclosureDirective,
): ApplyDisclosureResult {
  for (const f of directive.redact) {
    if (!isKnownVocabularyField(f, fullFacts)) return { ok: false, error: `unknown reputation field in redact: ${f}` };
    if (isStandingField(f)) return { ok: false, error: `standing is always present and cannot be redacted: ${f}` };
  }
  const shareOnly = directive.share !== undefined;
  if (shareOnly && directive.redact.length > 0) {
    return { ok: false, error: 'disclosure.share and disclosure.redact are exclusive — name the fields to share OR to withhold' };
  }
  for (const f of directive.share ?? []) {
    if (!isKnownVocabularyField(f, fullFacts)) return { ok: false, error: `unknown reputation field in share: ${f}` };
    if (isStandingField(f)) return { ok: false, error: `standing is always present; it is not listed in share: ${f}` };
    if (isPredicateOnlyField(f)) return { ok: false, error: `${f} is predicate-only and is never disclosed raw` };
  }
  const predicateOnlySeen = new Set<string>();
  for (const p of directive.predicates) {
    if (!isKnownVocabularyField(p.field, fullFacts)) return { ok: false, error: `unknown reputation field in predicate: ${p.field}` };
    if (!(PREDICATE_OPS as readonly string[]).includes(p.op)) {
      return { ok: false, error: `unsupported predicate op: ${p.op}` };
    }
    if (isPredicateOnlyField(p.field)) {
      if (!PREDICATE_ONLY_OPS.includes(p.op)) {
        return { ok: false, error: `${p.field} is predicate-only and accepts only ${PREDICATE_ONLY_OPS.join('|')} (an exact-match probe would disclose the amount): ${p.op}` };
      }
      if (predicateOnlySeen.has(p.field)) {
        return { ok: false, error: `${p.field} is predicate-only and accepts at most one predicate per presentation (a ladder of thresholds would disclose the amount)` };
      }
      predicateOnlySeen.add(p.field);
    }
    if (p.op === 'in') {
      if (!Array.isArray(p.set) || p.set.length === 0 || p.set.length > PREDICATE_SET_MAX || !p.set.every(isFiniteNumber)) {
        return { ok: false, error: `predicate set must be a non-empty list of at most ${PREDICATE_SET_MAX} finite numbers for ${p.field}` };
      }
    } else if (!isFiniteNumber(p.threshold)) {
      return { ok: false, error: `predicate threshold must be a finite number for ${p.field}` };
    }
  }

  const redacted = new Set(directive.redact);
  const shared = new Set(directive.share ?? []);
  const predicateFields = new Set(directive.predicates.map((p) => p.field));

  const facts: Record<string, number> = {};
  for (const [field, value] of Object.entries(fullFacts)) {
    if (isStandingField(field)) { facts[field] = value; continue; } // never withheld
    if (isPredicateOnlyField(field)) continue; // never disclosed raw
    if (redacted.has(field) || predicateFields.has(field)) continue; // withheld
    if (shareOnly && !shared.has(field)) continue; // share-only: withheld unless listed
    facts[field] = value;
  }

  // A pattern-valid key the actor never produced is an observed 0.
  const valueOf = (field: string): number => (Object.prototype.hasOwnProperty.call(fullFacts, field) ? fullFacts[field] : 0);
  const predicates: ReputationPredicate[] = directive.predicates.map((p) => ({
    field: p.field,
    op: p.op,
    ...(p.op === 'in' ? { set: canonicalPredicate(p).op === 'in' ? (canonicalPredicate(p) as { set: number[] }).set : [] } : { threshold: p.threshold as number }),
    result: evalPredicate(valueOf(p.field), p),
  }));

  return {
    ok: true,
    disclosure: {
      facts,
      predicates,
      redacted: [...redacted].sort(),
      // The committed share list rides in the payload so any verifier rebuilds the directive the
      // presenter signed (the claims digest covers it).
      ...(shareOnly ? { shared: [...shared].sort() } : {}),
    },
  };
}

/** The `standing.*` slice of a disclosed facts block — what a verifier hands back as `standing`. */
export function standingSlice(facts: Readonly<Record<string, number>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(facts ?? {})) if (isStandingField(k)) out[k] = v;
  return out;
}
