/**
 * Burn-to-present — human first-party presentation (in-app).
 *
 * A human produces a presentation by burning PVT from their OWN wallet and signing
 * a requester-bound binding with their wallet key (EIP-191). This module builds the
 * canonical binding BYTE-IDENTICAL to the backend
 * (provian-backend/src/core/presentation/*) and the agent SDK, and accepts an
 * INJECTED EIP-191 signer so the biometric-gated SeedManager wiring stays in the
 * screen and this core is pure + testable. RN-safe: uses @noble/hashes (no node
 * crypto) and ethers for signing.
 *
 * Human/agent SYMMETRY: same primitive, same binding, same requester binding,
 * validity window, and single-use burn as the agent path — only the signer differs
 * (EIP-191 here; ECDSA-SHA256 for an agent).
 */

import { disclosureCommitmentDigest, type CanonicalDisclosureRequest, type DisclosureAnswer, type DisclosureElection } from './disclosureRequest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { ChallengeEnvelope } from './challengeEnvelope';
import { translate } from '../../i18n/translate';

export const PRESENTATION_BINDING_TAG = 'provian-presentation-v1';
/** binding tag for a presentation produced against a SIGNED challenge — the v1 lines plus
 * `req=<requesterString>` and `chal_exp=<n>` (mirrors the relay's `PRESENTATION_BINDING_TAG_V2`). */
export const PRESENTATION_BINDING_TAG_V2 = 'provian-presentation-v2';
export const PRESENTATION_MIN_TTL_SECONDS = 60;
export const PRESENTATION_MAX_TTL_SECONDS = 900;
export const PRESENTATION_DEFAULT_TTL_SECONDS = 300;

// Requester-binding bounds — MUST mirror the relay (core/presentation/types.ts).
// Checked ON-DEVICE before the biometric burn so a malformed / hostile challenge
// cannot strand a burn (F9): the relay would reject it AFTER the burn is spent.
export const PRESENTATION_CHALLENGE_MIN_LEN = 16;
export const PRESENTATION_CHALLENGE_MAX_LEN = 512;
export const PRESENTATION_AUDIENCE_MAX_LEN = 512;

/**
 * Validate the requester (audience) + challenge against the relay's bounds BEFORE
 * burning. The relay enforces the same bounds at produce time, but that is AFTER
 * the on-chain burn — so a below-floor / oversized / empty value here would burn
 * PVT that the produce call then rejects, stranding it. Fail-closed on device.
 */
export function validateRequesterBinding(input: { audience: string; challenge: string }): { ok: true } | { ok: false; error: string } {
  const audience = (input.audience ?? '').trim();
  const challenge = (input.challenge ?? '').trim();
  if (audience.length === 0) return { ok: false, error: translate('humanPresentation.audienceRequired', 'A requester (audience) is required before you burn.') };
  if (audience.length > PRESENTATION_AUDIENCE_MAX_LEN) return { ok: false, error: translate('humanPresentation.audienceTooLong', `The requester id must be at most ${PRESENTATION_AUDIENCE_MAX_LEN} characters.`, { max: PRESENTATION_AUDIENCE_MAX_LEN }) };
  if (challenge.length < PRESENTATION_CHALLENGE_MIN_LEN) return { ok: false, error: translate('humanPresentation.challengeTooShort', `The challenge must be at least ${PRESENTATION_CHALLENGE_MIN_LEN} characters — this does not look like a valid request.`, { min: PRESENTATION_CHALLENGE_MIN_LEN }) };
  if (challenge.length > PRESENTATION_CHALLENGE_MAX_LEN) return { ok: false, error: translate('humanPresentation.challengeTooLong', `The challenge must be at most ${PRESENTATION_CHALLENGE_MAX_LEN} characters.`, { max: PRESENTATION_CHALLENGE_MAX_LEN }) };
  return { ok: true };
}

/**
 * Parse a scanned challenge QR and validate its shape. Returns the {audience,
 * challenge} only when both are present strings and pass the requester-binding
 * bounds; null otherwise (a non-challenge QR, malformed JSON, or out-of-bounds
 * values) so the caller never burns against a hostile QR.
 */
export function parseChallengeQr(data: string): { audience: string; challenge: string; predicates: PredicateRequest[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const audience = typeof o.audience === 'string' ? o.audience.trim() : '';
  const challenge = typeof o.challenge === 'string' ? o.challenge.trim() : '';
  if (validateRequesterBinding({ audience, challenge }).ok !== true) return null;
  // §2.6: the requester's named predicates ride the envelope; a malformed list is not a valid request.
  const predicates = normalizePredicateRequests(o.predicates);
  if (predicates === null) return null;
  return { audience, challenge, predicates };
}

/**
 * True if a verified presentation's presenter matches the counterparty the
 * requester intended to ask. Compared case-insensitively against BOTH the
 * presenter's on-chain address and its wallet-id subject, since a profile may
 * carry either. Fail-closed: an unparseable payload or empty counterparty → false.
 */
export function presenterMatchesCounterparty(payload: unknown, counterparty: string): boolean {
  const cp = (counterparty ?? '').trim().toLowerCase();
  if (cp.length === 0) return false;
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const addr = typeof p.presenter_address === 'string' ? p.presenter_address.toLowerCase() : '';
  const sub = typeof p.sub === 'string' ? p.sub.toLowerCase() : '';
  return (addr.length > 0 && addr === cp) || (sub.length > 0 && sub === cp);
}

/** The presenter identity to SHOW on a verify result card (F8), from the payload. */
export function extractPresenterLabel(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.presenter_address === 'string' && p.presenter_address.length > 0) return p.presenter_address;
  if (typeof p.sub === 'string' && p.sub.length > 0) return p.sub;
  return null;
}

export type PresentationTier = 'pe_fact' | 'reputation';

/** §2.6: five comparisons + set membership (`in` over a numeric set). Mirrors the backend byte-for-byte. */
export type PredicateOp = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'in';
export const PREDICATE_OPS: readonly PredicateOp[] = ['gte', 'gt', 'lte', 'lt', 'eq', 'in'];
export const PREDICATE_SET_MAX = 64;
export interface PredicateRequest {
  field: string;
  op: PredicateOp;
  threshold?: number;
  set?: number[];
}
/** A predicate the presenter answered — the requester's predicate plus its boolean result (§2.6). */
export interface ReputationPredicateResult {
  field: string;
  op: PredicateOp;
  threshold?: number;
  set?: number[];
  result: boolean;
}

export interface DisclosureDirective {
  redact?: string[];
  predicates?: PredicateRequest[];
  /** Share-only mode : the relay reveals ONLY Standing, the predicate answers and these
   * fields — every other raw fact is withheld, even one that appears after the screen loaded.
   * Exclusive with `redact`. This is the app's default (an empty list shares no raw number). */
  share?: string[];
}
export type CanonicalPredicate =
  | { field: string; op: string; threshold: number }
  | { field: string; op: 'in'; set: number[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

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

/** Fail-closed parse of an untrusted predicate list (mirrors the backend). */
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

/**
 * §2.4: evaluate one predicate LOCALLY against the presenter's own live vocabulary,
 * so the presenter can PREVIEW the yes/no it is about to co-sign before the burn.
 * Mirrors the backend's comparison semantics (the relay recomputes and co-signs the
 * authoritative result; this is a preview only). A field the vocabulary does not
 * carry reads as 0 (the same absence-is-zero rule the relay uses for a flat count),
 * so a `gte 1` over a never-observed fact previews `false` rather than erroring.
 */
export function evaluatePredicateLocally(p: PredicateRequest, facts: Record<string, number>): boolean {
  const value = Number.isFinite(facts[p.field]) ? facts[p.field] : 0;
  switch (p.op) {
    case 'gte': return value >= (p.threshold ?? 0);
    case 'gt': return value > (p.threshold ?? 0);
    case 'lte': return value <= (p.threshold ?? 0);
    case 'lt': return value < (p.threshold ?? 0);
    case 'eq': return value === (p.threshold ?? 0);
    case 'in': return (p.set ?? []).includes(value);
    default: return false;
  }
}

function sha256hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/**
 * the relay's id for a burn — sha256 hex of `<chain>:<lowercase tx hash>` (backend
 * `burnIdFor`, SDK `burnIdForTx`). A presentation can bind to it the moment the burn is broadcast;
 * the relay records the burn inside the present call once it is mined (one Base block).
 */
export function burnIdForTx(chain: string, txHash: string): string {
  return sha256hex(`${chain}:${txHash.toLowerCase()}`);
}

/** Canonical, order-independent disclosure directive — matches backend + SDK. */
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

/**
 * A PE fact the presenter vouches for: its id and its anchored content hash. The relay keeps no PE
 *, so the fact also carries the PE itself and its two-hop inclusion proof from this phone's
 * store (`core/meter/phoneProve.ts`) — pulled back from the person's PE Archive when it was dropped
 * here. The claims digest binds only `peId:envelopeHash`, so the signed binding is unchanged.
 */
export interface PeFact {
  peId: string;
  envelopeHash: string;
  pe?: Record<string, unknown>;
  inclusion?: Record<string, unknown>;
}

/** Tier-specific claims digest — matches backend + SDK. Binds BOTH the pe_id AND
 *  the anchored envelope_hash (a hash-only binding would let a presenter swap in
 *  another anchored hash and forge ownership). */
export function claimsDigest(input: { tier: PresentationTier; peFacts?: PeFact[]; directive?: DisclosureDirective; disclosures?: readonly DisclosureAnswer[] }): string {
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

/** One record the person puts forward for a disclosure request: the PE and its two-hop proof. */
export interface DisclosedPeRecord {
  peId: string;
  envelopeHash: string;
  pe: Record<string, unknown>;
  inclusion: Record<string, unknown>;
}

/** The person's answer to one requester-named disclosure request. */
export interface DisclosureAnswerInput {
  request: CanonicalDisclosureRequest;
  election: DisclosureElection;
  records?: DisclosedPeRecord[];
}

/** The identity-only commitment the presenter signs for its disclosure answers (mirrors the relay). */
export function disclosureAnswersForCommitment(answers: readonly DisclosureAnswerInput[]): DisclosureAnswer[] {
  return answers.map((a) => ({
    request: a.request,
    election: a.election,
    ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((r) => ({ pe_id: r.peId, pe_hash: r.envelopeHash.toLowerCase(), action_type: '-', timestamp: 0, witness: { kind: 'device' as const } })) } : {}),
  }));
}

/** the verified requester identity a v2 presentation is addressed to (`aud` === `id`). */
export interface PresentationRequester {
  type: 'domain' | 'wallet';
  /** domain: the hostname. wallet: the Provian wallet id. */
  id: string;
  /** wallet only: the wallet's lowercase EVM address (Provian-attested). */
  address?: string;
}

/** Canonical requester string — the `req=` line of the challenge signing string and the v2 binding. */
export function requesterString(r: { type: 'domain' | 'wallet'; id: string; address?: string }): string {
  return r.type === 'wallet' ? `wallet:${r.id}:${(r.address ?? '').toLowerCase()}` : `domain:${r.id}`;
}

/** The canonical binding string the presenter signs — matches backend + SDK. With `requester` AND
 * `chalExp` (a SIGNED challenge,) it is the v2 binding: tag `provian-presentation-v2`, the v1
 * lines, then `req=` and `chal_exp=`. */
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

export interface HumanPresentationParams {
  tier: PresentationTier;
  burnId: string;
  audience: string;
  challenge: string;
  ttlSeconds?: number;
  nowSeconds?: number;
  jti?: string;
  /** For pe_fact: the PEs to present, each with its OWN anchored envelope_hash. */
  peFacts?: PeFact[];
  disclosure?: DisclosureDirective;
  /** 2026-10-10: the requester-named disclosure answers (reputation tier). */
  disclosures?: DisclosureAnswerInput[];
  /** the requester's challenge envelope. When SIGNED (and already verified on device), the
   * binding is v2 (requester + chal_exp) and the envelope rides to `/present` as `challenge_envelope`.
   * An unsigned envelope changes nothing — the body and binding stay v1, byte-identical. */
  challengeEnvelope?: ChallengeEnvelope | null;
  /**
   * pipelining: a burn only BROADCAST (not yet recorded). It rides to `/present` as `burn`,
   * and the relay records it once it is mined (one Base block) before issuing. `burnId` must be its
   * {@link burnIdForTx}.
   */
  burnTx?: { txHash: string; amountAtomic: string; chain?: string };
}

export interface HumanPresentationRequestBody {
  tier: PresentationTier;
  burn_id: string;
  /** the broadcast burn the relay records inside this call once it is mined. */
  burn?: { tx_hash: string; amount_atomic: string; chain: string };
  audience: string;
  challenge: string;
  iat: number;
  exp: number;
  jti: string;
  pop: { scheme: 'eip191_secp256k1'; signature: string };
  pe_facts?: { pe_id: string; envelope_hash: string; pe?: Record<string, unknown>; inclusion?: Record<string, unknown> }[];
  disclosure?: { redact: string[]; predicates: PredicateRequest[]; share?: string[] };
  /** 2026-10-10: one answer per disclosure request the signed challenge names. */
  disclosures?: { request: CanonicalDisclosureRequest; election: DisclosureElection; records?: { pe_id: string; pe_hash: string; pe: Record<string, unknown>; inclusion: Record<string, unknown> }[] }[];
  /** the SIGNED challenge envelope this presentation answers (absent for an unsigned challenge). */
  challenge_envelope?: ChallengeEnvelope;
}

/** An injected EIP-191 message signer (the biometric-gated wallet key). */
export type Eip191Signer = (message: string) => Promise<string>;

function randomJti(): string {
  // RN-safe unique id from @noble/hashes over time + random bytes provided by the
  // caller is overkill; a per-call jti only needs to be unique, so derive it from
  // the binding inputs the caller already supplies. The caller may also pass jti.
  return `pres_${sha256hex(`${Date.now()}:${Math.random()}`).slice(0, 24)}`;
}

/**
 * Build the signed human presentation-production request body to POST to
 * `/v1/wallet/present`. The presenter's OWN first-party EVM address must match the
 * wallet the injected signer holds (the relay re-derives it from the EIP-191
 * signature and the human's `wallets/` record).
 */
export async function buildHumanPresentationRequest(
  params: HumanPresentationParams,
  presenterAddress: string,
  signEip191: Eip191Signer,
): Promise<{ body: HumanPresentationRequestBody; binding: string }> {
  const iat = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(params.ttlSeconds ?? PRESENTATION_DEFAULT_TTL_SECONDS, PRESENTATION_MIN_TTL_SECONDS), PRESENTATION_MAX_TTL_SECONDS);
  const exp = iat + ttl;
  const jti = params.jti ?? randomJti();
  if (params.burnTx && burnIdForTx(params.burnTx.chain ?? 'base', params.burnTx.txHash) !== params.burnId) {
    throw new Error('burnId does not match the broadcast burn');
  }

  const answers = params.tier === 'reputation' && params.disclosures !== undefined && params.disclosures.length > 0
    ? disclosureAnswersForCommitment(params.disclosures)
    : [];
  const digest = params.tier === 'pe_fact'
    ? claimsDigest({ tier: 'pe_fact', peFacts: params.peFacts ?? [] })
    : claimsDigest({ tier: 'reputation', directive: params.disclosure ?? {}, ...(answers.length > 0 ? { disclosures: answers } : {}) });

  // a SIGNED challenge makes this a v2 presentation — the presenter's signature commits to the
  // verified requester identity and the challenge deadline, exactly as the relay rebuilds it.
  const env = params.challengeEnvelope ?? null;
  const signedEnv = env !== null && (env.requester !== undefined || env.sig !== undefined) ? env : null;
  let v2: { requester: PresentationRequester; chalExp: number } | undefined;
  if (signedEnv) {
    const r = signedEnv.requester;
    if (!r || typeof signedEnv.expiresAt !== 'number' || !Number.isInteger(signedEnv.expiresAt)) {
      throw new Error('signed challenge is missing its requester or deadline');
    }
    if (signedEnv.audience !== params.audience || signedEnv.challenge !== params.challenge) {
      throw new Error('audience/challenge do not match the signed challenge');
    }
    v2 = {
      requester: r.type === 'wallet'
        ? { type: 'wallet', id: r.id, address: (r.address ?? '').toLowerCase() }
        : { type: 'domain', id: r.id },
      chalExp: signedEnv.expiresAt,
    };
  }

  const binding = presentationBindingString({
    tier: params.tier, presenterAddress, aud: params.audience, chal: params.challenge,
    iat, exp, jti, burnId: params.burnId, claimsDigest: digest,
    ...(v2 ? { requester: v2.requester, chalExp: v2.chalExp } : {}),
  });

  const signature = await signEip191(binding);

  const body: HumanPresentationRequestBody = {
    tier: params.tier, burn_id: params.burnId, audience: params.audience, challenge: params.challenge,
    iat, exp, jti, pop: { scheme: 'eip191_secp256k1', signature },
  };
  if (params.tier === 'pe_fact') {
    body.pe_facts = [...(params.peFacts ?? [])].map((f) => ({
      pe_id: f.peId,
      envelope_hash: f.envelopeHash,
      ...(f.pe !== undefined ? { pe: f.pe } : {}),
      ...(f.inclusion !== undefined ? { inclusion: f.inclusion } : {}),
    }));
  } else {
    const c = canonicalReputationDirective(params.disclosure ?? {});
    body.disclosure = { redact: c.redact, predicates: c.predicates as PredicateRequest[], ...(c.share !== undefined ? { share: c.share } : {}) };
    if (answers.length > 0) {
      body.disclosures = (params.disclosures ?? []).map((a) => ({
        request: a.request,
        election: a.election,
        ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((r) => ({ pe_id: r.peId, pe_hash: r.envelopeHash.toLowerCase(), pe: r.pe, inclusion: r.inclusion })) } : {}),
      }));
    }
  }
  if (signedEnv) body.challenge_envelope = signedEnv;
  if (params.burnTx) {
    body.burn = { tx_hash: params.burnTx.txHash, amount_atomic: params.burnTx.amountAtomic, chain: params.burnTx.chain ?? 'base' };
  }
  return { body, binding };
}
