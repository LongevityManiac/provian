/**
 * Burn-to-present — agent-side presentation binding + proof-of-possession.
 *
 * The agent produces a presentation by burning PVT and signing a requester-bound
 * binding with its OWN sovereign key. This module builds the canonical binding
 * string BYTE-IDENTICAL to the backend (`provian-backend/src/core/presentation/
 * types.ts` presentationBindingString / claimsDigest, and disclosure.ts
 * canonicalReputationDirective) and signs it with `signMessage` (ECDSA-SHA256/DER),
 * exactly as connect-pop does for the connect challenge. MUST match the backend
 * or the presenter proof-of-possession verifies against the wrong bytes.
 */

import { createHash, randomUUID } from 'crypto';
import { signMessage, deriveAgentIdentityFromPrivateKey } from './wallet';
import type { ChallengeEnvelope } from './challenge';
import type { ActInclusionProof, PeV2 } from './meter-wire';
import { disclosureCommitmentDigest, type CanonicalDisclosureRequest, type DisclosureAnswer, type DisclosureElection } from './disclosure-request';

export const PRESENTATION_BINDING_TAG = 'provian-presentation-v1';
/** binding tag for a presentation produced against a SIGNED challenge — the v1 lines plus
 * `req=<requesterString>` and `chal_exp=<n>`. Mirrors the relay's PRESENTATION_BINDING_TAG_V2. */
export const PRESENTATION_BINDING_TAG_V2 = 'provian-presentation-v2';
export const PRESENTATION_MIN_TTL_SECONDS = 60;
export const PRESENTATION_MAX_TTL_SECONDS = 900;
export const PRESENTATION_DEFAULT_TTL_SECONDS = 300;

export type PresentationTier = 'pe_fact' | 'reputation';

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
  /** Share-only mode : reveal ONLY Standing, the predicate answers and these fields —
   * every other raw fact is withheld. Exclusive with `redact`. */
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

/** Canonical, order-independent disclosure directive — matches the backend. */
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
 * A PE fact the presenter vouches for: its id and its content hash (a v2 PE's `pe_hash`).
 *
 * PE METER: the relay keeps no PE, so the presenter supplies the PE itself and its two-hop
 * inclusion proof (`actInclusionProofFor` / `peFactFromStore` in `meter/prove.ts`) and the relay
 * proves both hops against Base. The claims digest binds only `peId` + `envelopeHash`; `pe` and
 * `inclusion` are evidence, checked by the relay against that hash.
 */
export interface PeFact {
  peId: string;
  envelopeHash: string;
  pe?: PeV2;
  inclusion?: ActInclusionProof;
}

/** The wire form of one pe_fact entry. */
export interface PeFactWire {
  pe_id: string;
  envelope_hash: string;
  pe?: PeV2;
  inclusion?: ActInclusionProof;
}

/** One PeFact → its wire entry (the PE and its inclusion ride along when the presenter has them). */
export function peFactWire(f: PeFact): PeFactWire {
  return {
    pe_id: f.peId,
    envelope_hash: f.envelopeHash,
    ...(f.pe !== undefined ? { pe: f.pe } : {}),
    ...(f.inclusion !== undefined ? { inclusion: f.inclusion } : {}),
  };
}

/** Tier-specific claims digest — matches the backend claimsDigest. Binds BOTH the
 *  pe_id AND the anchored envelope_hash (a hash-only binding would let a presenter
 *  swap in another anchored hash and forge ownership). */
export function claimsDigest(input: {
  tier: PresentationTier;
  peFacts?: readonly PeFact[];
  directive?: DisclosureDirective;
  /** Requester-named disclosure answers (reputation tier). Absent / empty → the pre-existing bytes. */
  disclosures?: readonly DisclosureAnswer[];
}): string {
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
  readonly pe: PeV2 | Record<string, unknown>;
  readonly inclusion: ActInclusionProof | Record<string, unknown>;
}

/** The presenter's answer to one requester-named disclosure request. */
export interface DisclosureAnswerInput {
  readonly request: CanonicalDisclosureRequest;
  readonly election: DisclosureElection;
  /** `disclosed` only: the matching records this presenter holds (may be empty). */
  readonly records?: readonly DisclosedPeRecord[];
}

/** The identity-only commitment the presenter signs for its disclosure answers. */
export function disclosureAnswersForCommitment(answers: readonly DisclosureAnswerInput[]): DisclosureAnswer[] {
  return answers.map((a) => ({
    request: a.request,
    election: a.election,
    ...(a.election === 'disclosed' ? { records: (a.records ?? []).map((r) => ({ pe_id: r.peId, pe_hash: r.envelopeHash.toLowerCase(), action_type: '-', timestamp: 0, witness: { kind: 'device' as const } })) } : {}),
  }));
}

/** the verified requester identity a v2 presentation is addressed to (`aud` === `id`). */
export interface PresentationRequester {
  readonly type: 'domain' | 'wallet';
  /** domain: the hostname. wallet: the Provian wallet id. */
  readonly id: string;
  /** wallet only: the wallet's lowercase EVM address (Provian-attested). */
  readonly address?: string;
}

/** Canonical requester string — the `req=` line of the challenge signing string and the v2 binding.
 *  `domain:<host>` | `wallet:<walletId>:<lowercase address>`. Mirrors the relay byte-for-byte. */
export function requesterString(r: { type: 'domain' | 'wallet'; id: string; address?: string }): string {
  return r.type === 'wallet' ? `wallet:${r.id}:${(r.address ?? '').toLowerCase()}` : `domain:${r.id}`;
}

/** Normalized requester object for a payload / co-sign (wallet keeps its lowercase address, domain has none). */
export function normalizeRequester(r: PresentationRequester): PresentationRequester {
  return r.type === 'wallet'
    ? { type: 'wallet', id: r.id, address: (r.address ?? '').toLowerCase() }
    : { type: 'domain', id: r.id };
}

/**
 * The canonical binding string the presenter signs — matches the backend. With `requester` +
 * `chalExp` (both or neither —, a presentation against a SIGNED challenge) it is the v2
 * binding: tag `provian-presentation-v2` and two appended lines `req=` / `chal_exp=`.
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
  requester?: PresentationRequester;
  chalExp?: number;
}): string {
  if ((fields.requester === undefined) !== (fields.chalExp === undefined)) {
    throw new Error('presentationBindingString: requester and chalExp are both-or-neither (v2 binding)');
  }
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

export interface PresenterPop {
  readonly scheme: 'ecdsa_sha256_secp256k1';
  readonly signature: string;
  readonly pubkey: string;
}

export interface PresentationRequestBody {
  tier: PresentationTier;
  burn_id: string;
  audience: string;
  challenge: string;
  iat: number;
  exp: number;
  jti: string;
  pop: PresenterPop;
  pe_facts?: PeFactWire[];
  disclosure?: { redact: string[]; predicates: PredicateRequest[]; share?: string[] };
  /** Requester-named disclosures (2026-10-10): one answer per request the signed challenge names. */
  disclosures?: { request: CanonicalDisclosureRequest; election: DisclosureElection; records?: { pe_id: string; pe_hash: string; pe: unknown; inclusion: unknown }[] }[];
  /** the requester's SIGNED challenge envelope; the relay verifies it before consuming the
   * burn and issues a v2 presentation. Present only for a signed challenge. */
  challenge_envelope?: ChallengeEnvelope;
  /** pipelining: the burn by its tx — the relay records it in this call once it is mined (one Base block). */
  burn?: { tx_hash: string; amount_atomic: string; chain: string };
}

/**
 * the burn id every product keys on — `sha256(chain:txHash)` over the lower-cased tx hash.
 * Byte-identical to the relay's `burnIdFor`, so a presenter can sign its binding the moment the
 * burn is broadcast, before anything is recorded.
 */
export function burnIdForTx(chain: string, txHash: string): string {
  return createHash('sha256').update(`${chain}:${txHash.toLowerCase()}`).digest('hex');
}

export interface BuildPresentationParams {
  privateKeyHex: string;
  tier: PresentationTier;
  /** The recorded burn's id. Optional when `burnTx` is given (then derived from it). */
  burnId?: string;
  /**
   * pipelining: present a burn that was only BROADCAST. The relay records it inside the
   * present call once it is mined in one Base block (while it prepares the presentation) and issues
   * then — one call from broadcast to token. The relay checks 12-block finality afterwards and
   * revokes the presentation (and anything it opened) if the burn fails it. `burnId`, if also given, must equal the derived id.
   */
  burnTx?: { txHash: string; amountAtomic: string | bigint; chain?: string };
  audience: string;
  challenge: string;
  ttlSeconds?: number;
  nowSeconds?: number;
  jti?: string;
  /** For pe_fact: the PEs to present, each with its OWN anchored envelope_hash. */
  peFacts?: readonly PeFact[];
  disclosure?: DisclosureDirective;
  /** Requester-named disclosures (reputation tier): the elections and records put forward. */
  disclosures?: readonly DisclosureAnswerInput[];
  /**
   * the requester's challenge envelope. When it is SIGNED (`requester` + `sig`), the binding
   * is v2 — requester = the envelope's requester (normalized), chalExp = its `expiresAt` and the
   * body carries it as `challenge_envelope` so the relay verifies it before the burn is consumed.
   * An unsigned envelope changes nothing (v1, byte-identical). Its audience/challenge must equal
   * `audience`/`challenge`.
   */
  challengeEnvelope?: ChallengeEnvelope;
}

const REQ_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** The v2 binding inputs from a SIGNED envelope, or null for an unsigned one. Throws when the
 *  envelope does not belong to this presentation or its signed fields are not well-formed. */
function signedChallengeBinding(
  env: ChallengeEnvelope | undefined,
  audience: string,
  challenge: string,
): { requester: PresentationRequester; chalExp: number } | null {
  if (!env) return null;
  if (env.audience !== audience || env.challenge !== challenge) {
    throw new Error('challengeEnvelope audience/challenge do not match the presentation');
  }
  if (env.requester === undefined && env.sig === undefined) return null;
  const r = env.requester;
  if (!r || (r.type !== 'domain' && r.type !== 'wallet') || typeof r.id !== 'string' || r.id.length === 0) {
    throw new Error('challengeEnvelope carries a malformed requester');
  }
  if (r.type === 'wallet' && (typeof r.address !== 'string' || !REQ_ADDRESS_RE.test(r.address.toLowerCase()))) {
    throw new Error('challengeEnvelope wallet requester needs a 0x address');
  }
  if (typeof env.sig !== 'string' || env.sig.length === 0) throw new Error('challengeEnvelope is missing its signature');
  if (!Number.isInteger(env.expiresAt)) throw new Error('challengeEnvelope expiresAt must be an integer');
  return {
    requester: normalizeRequester({ type: r.type, id: r.id, address: r.address }),
    chalExp: env.expiresAt as number,
  };
}

/**
 * Build the full, signed presentation-production request body an agent POSTs to
 * `/v1/agent/wallet/:wallet_id/present`. Derives the agent's identity from its own
 * key, builds the canonical binding, and signs it (ECDSA-SHA256/DER).
 */
/** The burn id a presentation binds: the given one, or the one derived from `burnTx` (they must agree). */
export function resolveBurnId(params: Pick<BuildPresentationParams, 'burnId' | 'burnTx'>): string {
  if (params.burnTx) {
    if (typeof params.burnTx.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(params.burnTx.txHash)) {
      throw new Error('burnTx.txHash must be a 0x-prefixed 32-byte hash');
    }
    const derived = burnIdForTx(params.burnTx.chain ?? 'base', params.burnTx.txHash);
    if (params.burnId && params.burnId !== derived) throw new Error('burnId does not match burnTx (sha256(chain:txHash))');
    return derived;
  }
  if (!params.burnId) throw new Error('burnId or burnTx is required');
  return params.burnId;
}

export function buildAgentPresentationRequest(params: BuildPresentationParams): { body: PresentationRequestBody; binding: string } {
  // Normalize the key once: deriveAgentIdentityFromPrivateKey strips 0x but
  // signMessage does NOT, so an un-normalized 0x key would derive the right
  // address yet sign with the wrong key. Use the SAME clean hex for both.
  const key = params.privateKeyHex.trim().toLowerCase().replace(/^0x/, '');
  const { publicKey, address } = deriveAgentIdentityFromPrivateKey(key);
  const iat = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(Math.max(params.ttlSeconds ?? PRESENTATION_DEFAULT_TTL_SECONDS, PRESENTATION_MIN_TTL_SECONDS), PRESENTATION_MAX_TTL_SECONDS);
  const exp = iat + ttl;
  const jti = params.jti ?? `pres_${randomUUID().replace(/-/g, '')}`;

  const answers = params.tier === 'reputation' && params.disclosures !== undefined && params.disclosures.length > 0
    ? disclosureAnswersForCommitment(params.disclosures)
    : [];
  const digest = params.tier === 'pe_fact'
    ? claimsDigest({ tier: 'pe_fact', peFacts: params.peFacts ?? [] })
    : claimsDigest({ tier: 'reputation', directive: params.disclosure ?? {}, ...(answers.length > 0 ? { disclosures: answers } : {}) });

  const burnId = resolveBurnId(params);
  const signed = signedChallengeBinding(params.challengeEnvelope, params.audience, params.challenge);
  const binding = presentationBindingString({
    tier: params.tier, presenterAddress: address, aud: params.audience, chal: params.challenge,
    iat, exp, jti, burnId, claimsDigest: digest,
    ...(signed ? { requester: signed.requester, chalExp: signed.chalExp } : {}),
  });

  const pop: PresenterPop = { scheme: 'ecdsa_sha256_secp256k1', signature: signMessage(key, binding), pubkey: publicKey };

  const body: PresentationRequestBody = { tier: params.tier, burn_id: burnId, audience: params.audience, challenge: params.challenge, iat, exp, jti, pop };
  if (params.burnTx) {
    const amount = typeof params.burnTx.amountAtomic === 'bigint' ? params.burnTx.amountAtomic.toString() : String(params.burnTx.amountAtomic);
    body.burn = { tx_hash: params.burnTx.txHash, amount_atomic: amount, chain: params.burnTx.chain ?? 'base' };
  }
  if (params.tier === 'pe_fact') {
    body.pe_facts = [...(params.peFacts ?? [])].map(peFactWire);
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
  if (signed && params.challengeEnvelope) body.challenge_envelope = params.challengeEnvelope;
  return { body, binding };
}
