/**
 * Burn-to-present — canonical binding + claims digest for the MCP `present` tool.
 *
 * SHARED CORE — canonical in `provian-mcp/src/core/`, mirrored byte-identically
 * into `provian-backend/src/mcp/core/`. Edit only the canonical copy and run
 * `scripts/sync-mcp-core.sh`.
 *
 * a presentation against a SIGNED challenge binds `provian-presentation-v2` the v1 lines
 * plus `req=<requesterString>` and `chal_exp=<n>`; without a signed challenge the binding is v1,
 * byte-identical to before. The challenge envelope itself lives in `challenge.ts`.
 *
 * A LINE-FOR-LINE PORT of `provian-agent-sdk/src/presentation.ts`
 * (`claimsDigest` / `presentationBindingString` / `canonicalReputationDirective`)
 * and the backend's `core/presentation/types.ts` the SAME bytes the presenter
 * signs and the relay verifies. The MCP core cannot import the SDK (separate
 * package) or the relay internals, so it carries its own audited copy, exactly as
 * `crypto.ts` ports the SDK key handling. Pinned by a fixed-vector parity test
 * (`presentation.test.ts`); a drift there means the presenter PoP would verify
 * against the wrong bytes. Node-crypto-only (no npm deps), so the backend mirror
 * compiles with nothing new.
 */

import { createHash } from 'crypto';
import { disclosureCommitmentDigest, type CanonicalDisclosureRequest, type DisclosureAnswer, type DisclosureElection } from './disclosure-request';

export const PRESENTATION_BINDING_TAG = 'provian-presentation-v1';
/** the binding tag for a presentation produced against a SIGNED challenge. */
export const PRESENTATION_BINDING_TAG_V2 = 'provian-presentation-v2';
export const PRESENTATION_MIN_TTL_SECONDS = 60;
export const PRESENTATION_MAX_TTL_SECONDS = 900;
export const PRESENTATION_DEFAULT_TTL_SECONDS = 300;
/** Clock skew every verifier tolerates past a deadline (seconds). */
export const PRESENTATION_CLOCK_SKEW_SECONDS = 60;
/** Challenge nonce length bounds (characters) and the audience length cap — mirror the relay. */
export const PRESENTATION_CHALLENGE_MIN_LEN = 16;
export const PRESENTATION_CHALLENGE_MAX_LEN = 512;
export const PRESENTATION_AUDIENCE_MAX_LEN = 512;

export type PresentationTier = 'pe_fact' | 'reputation';

/** the VERIFIED requester a v2 presentation names (wallet keeps its lowercase address). */
export interface PresentationRequester {
  readonly type: 'domain' | 'wallet';
  readonly id: string;
  readonly address?: string;
}

/** `domain:<host>` | `wallet:<walletId>:<lowercase address>` — the signing-string / binding form. */
export function requesterString(r: { type: 'domain' | 'wallet'; id: string; address?: string }): string {
  return r.type === 'wallet' ? `wallet:${r.id}:${(r.address ?? '').toLowerCase()}` : `domain:${r.id}`;
}

/** §2.6: five comparisons + set membership (`in` over a numeric set). Mirrors the backend byte-for-byte. */
export type PredicateOp = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';
export const PREDICATE_OPS: readonly PredicateOp[] = ['gte', 'gt', 'lte', 'lt', 'eq', 'in'];
export const PREDICATE_SET_MAX = 64;
export interface PredicateRequest {
  readonly field: string;
  readonly op: PredicateOp;
  /** The comparison value (every op but `in`). */
  readonly threshold?: number;
  /** The membership set (`in` only). */
  readonly set?: readonly number[];
}
export interface DisclosureDirective {
  readonly redact?: readonly string[];
  readonly predicates?: readonly PredicateRequest[];
  /** Share-only mode : reveal ONLY Standing, the predicate answers and these fields. Exclusive with `redact`. */
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

function predicateSortKey(c: CanonicalPredicate): string {
  return `${c.field}\n${c.op}\n${'set' in c ? c.set.join(',') : c.threshold}`;
}

/**
 * Parse an untrusted predicate list into well-formed requests, fail-closed (`null` on any malformed
 * entry). Mirrors the backend `normalizePredicateRequests`.
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
      if (!Array.isArray(p.set) || p.set.length === 0 || p.set.length > PREDICATE_SET_MAX || !p.set.every(isFiniteNumber)) return null;
      out.push({ field, op: 'in', set: [...(p.set as number[])] });
    } else {
      if (!isFiniteNumber(p.threshold)) return null;
      out.push({ field, op: op as PredicateOp, threshold: p.threshold });
    }
  }
  return out;
}

/** Two predicates are the same request when their canonical forms are byte-identical. */
export function predicateMatchesRequest(answered: PredicateRequest, requested: PredicateRequest): boolean {
  return JSON.stringify(canonicalPredicate(answered)) === JSON.stringify(canonicalPredicate(requested));
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical, order-independent disclosure directive — matches SDK + backend. */
export function canonicalReputationDirective(directive: DisclosureDirective): {
  redact: string[];
  predicates: CanonicalPredicate[];
  share?: string[];
} {
  return {
    redact: [...(directive.redact ?? [])].sort(),
    predicates: [...(directive.predicates ?? [])]
      .map(canonicalPredicate)
      .sort((a, b) => predicateSortKey(a).localeCompare(predicateSortKey(b))),
    // Present ONLY in share-only mode, so every pre-existing directive's bytes (and digest) are unchanged.
    ...(directive.share !== undefined ? { share: [...new Set(directive.share)].sort() } : {}),
  };
}

/** A PE fact the presenter vouches for: its id and its anchored content hash. */
export interface PeFact {
  peId: string;
  envelopeHash: string;
  /**
   * PE meter: the PE itself (v2) and its two-hop inclusion proof. The relay keeps no PE, so a
   * pe_fact presentation carries them; the claims digest still binds only peId + envelopeHash.
   */
  pe?: Readonly<Record<string, unknown>>;
  inclusion?: Readonly<Record<string, unknown>>;
}

/** Tier-specific claims digest — matches SDK + backend claimsDigest. */
export function claimsDigest(input: { tier: PresentationTier; peFacts?: readonly PeFact[]; directive?: DisclosureDirective; disclosures?: readonly DisclosureAnswer[] }): string {
  if (input.tier === 'pe_fact') {
    const lines = [...(input.peFacts ?? [])].map((f) => `${f.peId}:${f.envelopeHash.toLowerCase()}`).sort();
    return sha256hex(`pe_fact\n${lines.join('\n')}`);
  }
  // The disclosure commitment line exists ONLY when the presentation answers disclosure requests.
  const disclosures = input.disclosures !== undefined && input.disclosures.length > 0
    ? `\ndisclosures=${disclosureCommitmentDigest(input.disclosures)}`
    : '';
  return sha256hex(`reputation\n${JSON.stringify(canonicalReputationDirective(input.directive ?? {}))}${disclosures}`);
}

/** One record the presenter puts forward for a disclosure request: the PE and its two-hop proof. */
export interface DisclosedPeRecord {
  readonly peId: string;
  readonly envelopeHash: string;
  readonly pe: Record<string, unknown>;
  readonly inclusion: Record<string, unknown>;
}

/** The presenter's answer to one requester-named disclosure request. */
export interface DisclosureAnswerInput {
  readonly request: CanonicalDisclosureRequest;
  readonly election: DisclosureElection;
  readonly records?: readonly DisclosedPeRecord[];
}

/** The identity-only commitment the presenter signs for its disclosure answers (mirrors the SDK). */
export function disclosureAnswersForCommitment(answers: readonly DisclosureAnswerInput[]): DisclosureAnswer[] {
  return answers.map((a) => ({
    request: a.request,
    election: a.election,
    ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((r) => ({ pe_id: r.peId, pe_hash: r.envelopeHash.toLowerCase(), action_type: '-', timestamp: 0, witness: { kind: 'device' as const } })) } : {}),
  }));
}

/**
 * The canonical binding string the presenter signs — matches SDK + backend. With a signed challenge
 * (`requester` AND `chalExp`) it is v2: the v2 tag, the same lines, then `req=` and `chal_exp=`.
 */
export function presentationBindingString(fields: {
  tier: PresentationTier;
  presenterAddress: string;
  aud: string;
  chal: string;
  iat: number;
  exp: number;
  jti: string;
  burnId: string;
  claimsDigest: string;
  /** v2 (signed challenge) only — both or neither. */
  requester?: PresentationRequester;
  chalExp?: number;
}): string {
  const signed = fields.requester !== undefined && fields.chalExp !== undefined;
  const lines = [
    signed ? PRESENTATION_BINDING_TAG_V2 : PRESENTATION_BINDING_TAG,
    `tier=${fields.tier}`,
    `presenter=${fields.presenterAddress.toLowerCase()}`,
    `aud=${fields.aud}`,
    `chal=${fields.chal}`,
    `iat=${fields.iat}`,
    `exp=${fields.exp}`,
    `jti=${fields.jti}`,
    `burn=${fields.burnId}`,
    `claims=${fields.claimsDigest}`,
  ];
  if (signed) lines.push(`req=${requesterString(fields.requester as PresentationRequester)}`, `chal_exp=${fields.chalExp}`);
  return lines.join('\n');
}
