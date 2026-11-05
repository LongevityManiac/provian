/**
 * Presentation verification — what a COUNTERPARTY runs (no Provian account).
 *
 *  - PE-FACT: three independent proofs, ALL required. (1) The presenter's own
 *    signature over the canonical binding — live key possession + requester
 *    binding. (2) Each embedded anchor proof against the on-chain PEAnchor root —
 *    the PEs exist and are anchored on Base. (3) The Provian CO-SIGN JWS (EdDSA,
 *    a DISTINCT `typ`) against the Provian JWKS — Provian attests, at issuance,
 *    that a PVT burn was consumed and the cited PEs belong to this presenter,
 *    which the chain cannot show. No Provian ACCOUNT is needed (a fetched JWKS
 *    verifies the co-sign offline), but the co-sign itself is REQUIRED: without
 *    it a self-issued pe_fact citing anyone's public anchored PEs would verify.
 *  - REPUTATION: verify the Provian JWS (EdDSA) against the Provian JWKS, then
 *    the binding + freshness + requester binding. Provian is the attester of the
 *    scores (that is the tier's trust model), but no Provian ACCOUNT is needed —
 *    a fetched JWKS verifies the JWS offline.
 *
 * Freshness (`exp` in the future within skew), requester binding (`aud`/`chal`
 * equal what the verifier issued), and the presenter's live-possession signature
 * are checked for BOTH tiers. A raw id lookup that returns a bearer snapshot is
 * NOT a presentation and never verifies here.
 */

import { checkMeterFactLeaf } from '../meter/meter-fact-proof';
import crypto from 'crypto';
import { ethers } from 'ethers';
import { verifyEcdsaSha256 } from '../agent-wallet/proof-of-possession';
import type { CommerceAttestationPublicJwk } from './jws-key-material';
import { hashEnvelopeHashLeaf } from '../pvt/merkle';
import {
  canonicalReputationDirective,
  predicateMatchesRequest,
  standingSlice,
  type PredicateRequest,
} from './disclosure';
import { missingStandingFields } from './vocabulary-fields';
import {
  canonicalJson,
  disclosureRequestMatches,
  parseDisclosureAnswers,
  readFieldPath,
  recordMatchesRequest,
  DISCLOSURE_RECORDS_MAX_TOTAL,
  type CanonicalDisclosureRequest,
  type DisclosureAnswer,
  type DisclosedRecord,
} from './disclosure-request';
import { outputDigestsOf } from './disclosure-records';
import {
  PRESENTATION_ISSUER,
  PRESENTATION_TYP,
  PRESENTATION_PEFACT_TYP,
  PRESENTATION_VERSION,
  PRESENTATION_VERSION_SIGNED_CHALLENGE,
  PRESENTATION_CLOCK_SKEW_SECONDS,
  PRESENTATION_MAX_TTL_SECONDS,
  MAX_PE_FACT_CLAIMS,
  claimsDigest,
  presentationBindingString,
  type Presentation,
  type PresentationPayload,
  type PresenterPop,
  type PresentationRequester,
  type ReputationPredicate,
  requesterString,
} from './types';

export type PresentationRefusal =
  | 'malformed'
  | 'unsupported_version'
  | 'tier_mismatch'
  | 'missing_binding_fields'
  | 'audience_mismatch'
  | 'challenge_mismatch'
  | 'expired'
  | 'not_yet_valid'
  | 'window_too_long'
  | 'bad_presenter_pop'
  | 'presenter_address_mismatch'
  | 'reputation_not_signed'
  | 'reputation_jws_malformed'
  | 'reputation_jws_unsupported_alg'
  | 'reputation_jws_wrong_typ'
  | 'reputation_jws_unknown_kid'
  | 'reputation_jws_bad_signature'
  | 'reputation_jws_issuer_mismatch'
  | 'reputation_payload_mismatch'
  | 'pe_fact_no_claims'
  | 'pe_fact_not_cosigned'
  | 'pe_fact_cosign_malformed'
  | 'pe_fact_cosign_unsupported_alg'
  | 'pe_fact_cosign_wrong_typ'
  | 'pe_fact_cosign_unknown_kid'
  | 'pe_fact_cosign_bad_signature'
  | 'pe_fact_cosign_issuer_mismatch'
  | 'pe_fact_cosign_payload_mismatch'
  | 'pe_fact_no_proofs'
  | 'pe_fact_claim_proof_mismatch'
  | 'pe_fact_too_many_claims'
  | 'pe_fact_duplicate_claim'
  | 'pe_fact_proof_onchain_invalid'
  | 'predicates_unanswered'
  /** 2026-10-10: a disclosure request the requester named has no answer (disclosed or declined). */
  | 'disclosures_unanswered'
  /** 2026-10-10: a disclosed record is malformed, unproven, mismatched to its request, or carries a field
   * that differs from the anchored act record. */
  | 'disclosure_record_invalid'
  | 'disclosures_require_reputation_tier'
  /** close-out: a reputation payload missing an always-present Standing fact. */
  | 'standing_withheld'
  //
  | 'predicates_require_reputation_tier'
  | 'presenter_mismatch'
  | 'challenge_expired'
  | 'requester_mismatch';

export interface VerifyPresentationOptions {
  /** Provian public keys (from the JWKS) — required to verify a reputation JWS. */
  readonly publicKeys?: readonly CommerceAttestationPublicJwk[];
  /** The exact audience the verifier expects (the requester's own id). */
  readonly expectedAudience?: string;
  /** The exact challenge the verifier issued. Binding to it is what makes the
   *  presentation non-replayable to any other requester or moment. */
  readonly expectedChallenge?: string;
  readonly nowSeconds?: number;
  /**
   * §2.6: the predicates the requester named in its challenge envelope. A reputation presentation
   * that does not answer EVERY one of them (same field, op and threshold/set, canonically) is
   * refused `predicates_unanswered`. Empty / absent = nothing required.
   */
  readonly expectedPredicates?: readonly PredicateRequest[];
  /**
   * 2026-10-10: the disclosure requests the requester named in its challenge envelope. A reputation
   * presentation that does not ANSWER every one (disclosed or declined) is refused
   * `disclosures_unanswered`; every disclosed record is checked against its proof.
   */
  readonly expectedDisclosures?: readonly CanonicalDisclosureRequest[];
  /**
   * the presenter the requester addressed — a lowercase EVM address (compared to
   * `presenter_address`) or a presenter wallet id (compared to `sub`). Mismatch → `presenter_mismatch`.
   */
  readonly expectedPresenter?: string;
  /**
   * the requester's challenge deadline (unix seconds) from its own challenge envelope. A v2
   * presentation carries its own signed `chal_exp`, which is enforced whether or not this is given.
   */
  readonly challengeDeadline?: number;
  /** the requester identity of a SIGNED challenge the verifier issued; a v2 presentation's
   * relay-verified `requester` must equal it. */
  readonly expectedRequester?: PresentationRequester;
  /** Optional on-chain PEAnchor read contract. When provided, pe_fact proofs are
   *  additionally verified against Base as a server-side convenience; when absent,
   *  the structural checks pass and the counterparty verifies the embedded proofs
   *  themselves (the trustless path). */
  readonly peAnchorContract?: {
    verifyPE(batchId: string, peHash: string, proof: string[]): Promise<boolean>;
  } | null;
}

export type VerifyPresentationResult =
  | {
    valid: true;
    tier: 'pe_fact' | 'reputation';
    payload: PresentationPayload;
    onchain_checked: boolean;
    /** the stable dedupe key — the burn id. One burn backs exactly one presentation, globally
     * (the single-use `burn_consumptions` ledger), so a gate dedupes with one lookup on it. */
    presentation_id: string;
    /** the presenter's wallet id, only when a signature covers it (reputation JWS; pe_fact
     * co-sign). Null on a pe_fact whose co-sign predates the subject binding — never the bare `sub`. */
    sub: string | null;
    /** the requester identity the relay verified at issuance (v2), else null. */
    requester: PresentationRequester | null;
    /** the challenge deadline enforced (v2 `chal_exp`, else the caller's), else null. */
    challenge_expires_at: number | null;
    /** Reputation tier: every answered predicate with its co-signed result (§2.6). */
    predicates?: ReputationPredicate[];
    /** Reputation tier: the always-present `standing.*` facts (§2.5). */
    standing?: Record<string, number>;
    /** Reputation tier: every disclosed raw fact. */
    disclosed?: Record<string, number>;
    /** Reputation tier: the requester-named disclosure answers, each record checked against its anchored proof. */
    disclosures?: DisclosureAnswer[];
  }
  | { valid: false; reason: PresentationRefusal };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Verify the presenter's proof of live key possession over the canonical binding.
 * Agent: ECDSA-SHA256 over the binding by the sovereign secp256k1 key, whose
 * derived address MUST equal `presenter_address`. Human: EIP-191 personal_sign
 * whose recovered address MUST equal `presenter_address`. Either way the signing
 * key is bound to the address the presentation claims. Fail-closed on any error.
 */
export function verifyPresenterPop(
  binding: string,
  pop: PresenterPop,
  presenterAddress: string,
): boolean {
  if (!isRecord(pop) || typeof pop.signature !== 'string') return false;
  const expected = presenterAddress.toLowerCase();
  if (!ethers.isAddress(expected)) return false;

  if (pop.scheme === 'eip191_secp256k1') {
    try {
      const recovered = ethers.verifyMessage(binding, pop.signature);
      return recovered.toLowerCase() === expected;
    } catch {
      return false;
    }
  }

  if (pop.scheme === 'ecdsa_sha256_secp256k1') {
    if (typeof pop.pubkey !== 'string') return false;
    // The signature must verify under the pubkey AND the pubkey must derive to
    // the claimed address — so a valid signature by an unrelated key over the
    // same binding cannot impersonate this presenter.
    if (!verifyEcdsaSha256(pop.pubkey, binding, pop.signature)) return false;
    let derived: string;
    try {
      // Strip the 0x, and the 04 uncompressed prefix ONLY on the 130-hex form.
      // A bare 128-hex key whose x-coordinate high byte is 0x04 must NOT be
      // shortened — matches normalisePublicKeyHex, so ~0.4% of agents (04-leading
      // keys) are not falsely rejected after they have already burned PVT.
      let clean = pop.pubkey.toLowerCase().replace(/^0x/, '');
      if (clean.length === 130 && clean.startsWith('04')) clean = clean.slice(2);
      if (clean.length !== 128) return false;
      derived = ethers.computeAddress(`0x04${clean}`).toLowerCase();
    } catch {
      return false;
    }
    return derived === expected;
  }

  return false;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** A v2 payload's requester block, validated; null when absent or malformed. */
function payloadRequester(payload: PresentationPayload): PresentationRequester | null {
  const r = (payload as { requester?: unknown }).requester;
  if (!isRecord(r) || typeof r.id !== 'string' || r.id.length === 0) return null;
  if (r.type === 'domain' && r.address === undefined) return { type: 'domain', id: r.id };
  if (r.type === 'wallet' && typeof r.address === 'string' && ADDRESS_RE.test(r.address)) {
    return { type: 'wallet', id: r.id, address: r.address };
  }
  return null;
}

/**
 * The wallet-id form of an expected presenter, matched against a subject some signature covers
 * (the reputation JWS payload's `sub`; on pe_fact the Provian co-sign's `sub`). A presentation whose
 * subject no signature covers (a pre- pe_fact co-sign) can never satisfy a wallet-id check.
 */
function presenterIdMismatch(opts: VerifyPresentationOptions, verifiedSub: string | null): PresentationRefusal | null {
  const want = opts.expectedPresenter;
  if (want === undefined || want.length === 0 || ADDRESS_RE.test(want.toLowerCase())) return null;
  return verifiedSub !== null && verifiedSub === want ? null : 'presenter_mismatch';
}

/** Structural + freshness + binding checks common to both tiers. */
function checkCommon(
  payload: PresentationPayload,
  opts: VerifyPresentationOptions,
): PresentationRefusal | null {
  if (!isRecord(payload)) return 'malformed';
  if (payload.v !== PRESENTATION_VERSION && payload.v !== PRESENTATION_VERSION_SIGNED_CHALLENGE) return 'unsupported_version';
  if (payload.tier !== 'pe_fact' && payload.tier !== 'reputation') return 'malformed';
  if (
    typeof payload.presenter_address !== 'string'
    || typeof payload.aud !== 'string'
    || typeof payload.chal !== 'string'
    || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number'
    || typeof payload.jti !== 'string'
    || typeof payload.burn_id !== 'string'
    || !isRecord(payload.presenter_pop)
  ) {
    return 'missing_binding_fields';
  }

  // v2 ⇔ signed challenge: the requester block + deadline are present exactly on v2, and the
  // requester IS the audience (the audience binding the relay enforced at issuance).
  const requester = payloadRequester(payload);
  if (payload.v === PRESENTATION_VERSION_SIGNED_CHALLENGE) {
    if (!requester || !Number.isInteger(payload.chal_exp)) return 'missing_binding_fields';
    if (requester.id !== payload.aud) return 'audience_mismatch';
  } else if ((payload as { requester?: unknown }).requester !== undefined || (payload as { chal_exp?: unknown }).chal_exp !== undefined) {
    return 'malformed';
  }

  if (opts.expectedAudience !== undefined && payload.aud !== opts.expectedAudience) {
    return 'audience_mismatch';
  }
  if (opts.expectedChallenge !== undefined && payload.chal !== opts.expectedChallenge) {
    return 'challenge_mismatch';
  }
  // A verify against a SIGNED challenge requires the v2 presentation that names that requester — a
  // v1 presentation (the signature stripped at /present) answers the same nonce but never proves the
  // presenter saw a verified requester, so it is refused, not passed with `requester: null`.
  if (opts.expectedRequester !== undefined
    && (requester === null || requesterString(requester) !== requesterString(opts.expectedRequester))) {
    return 'requester_mismatch';
  }
  // The address form is checked here (the presenter address is signed on both tiers). The wallet-id
  // form is checked by `presenterIdMismatch` against a SIGNED subject only — on pe_fact the payload
  // `sub` is outside every signature, so it is matched after the co-sign is verified.
  if (opts.expectedPresenter !== undefined && ADDRESS_RE.test(opts.expectedPresenter.toLowerCase())
    && payload.presenter_address.toLowerCase() !== opts.expectedPresenter.toLowerCase()) {
    return 'presenter_mismatch';
  }

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = PRESENTATION_CLOCK_SKEW_SECONDS;
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return 'missing_binding_fields';
  if (payload.iat > now + skew) return 'not_yet_valid';
  if (payload.exp <= now - skew) return 'expired';
  if (payload.exp - payload.iat > PRESENTATION_MAX_TTL_SECONDS) return 'window_too_long';
  // The challenge deadline: the signed `chal_exp` (v2) and/or the requester's own deadline. Every
  // deadline in force must hold at verify time, and the presentation must have been issued by it.
  for (const deadline of [payload.chal_exp, opts.challengeDeadline]) {
    if (typeof deadline !== 'number') continue;
    if (now > deadline + skew || payload.iat > deadline + skew) return 'challenge_expired';
  }

  // Recompute the binding the presenter signed and verify the PoP.
  const answered = payload.tier === 'reputation' ? parseDisclosureAnswers(payload.disclosures) : [];
  if (answered === null) return 'disclosure_record_invalid';
  const digest = payload.tier === 'pe_fact'
    ? claimsDigest({ tier: 'pe_fact', pe_facts: payload.pe_facts ?? [] })
    : claimsDigest({ tier: 'reputation', reputation_directive: reputationDirective(payload), ...(answered.length > 0 ? { disclosures: answered } : {}) });
  const binding = presentationBindingString({
    tier: payload.tier,
    presenter_address: payload.presenter_address,
    aud: payload.aud,
    chal: payload.chal,
    iat: payload.iat,
    exp: payload.exp,
    jti: payload.jti,
    burn_id: payload.burn_id,
    claims_digest: digest,
    ...(payload.v === PRESENTATION_VERSION_SIGNED_CHALLENGE && requester ? { requester, chal_exp: payload.chal_exp } : {}),
  });
  if (!verifyPresenterPop(binding, payload.presenter_pop, payload.presenter_address)) {
    return 'bad_presenter_pop';
  }
  return null;
}

/** The deadline a verify enforced (v2 signed `chal_exp` wins; else the caller's), for the result. */
function enforcedDeadline(payload: PresentationPayload, opts: VerifyPresentationOptions): number | null {
  if (typeof payload.chal_exp === 'number') return payload.chal_exp;
  return typeof opts.challengeDeadline === 'number' ? opts.challengeDeadline : null;
}

/** The disclosure directive the presenter committed to (redactions + predicate
 *  specs), reconstructed from a reputation payload for the claims digest. Uses the
 *  SAME canonical builder the signer used, so the two can never drift. */
export function reputationDirective(payload: PresentationPayload): unknown {
  const r = payload.reputation;
  if (!r) return canonicalReputationDirective({ redact: [], predicates: [] });
  return canonicalReputationDirective({
    redact: r.redacted ?? [],
    ...(Array.isArray(r.shared) ? { share: r.shared } : {}),
    predicates: (r.predicates ?? []).map((p) => (
      p.op === 'in'
        ? { field: p.field, op: 'in' as const, set: p.set ?? [] }
        : { field: p.field, op: p.op, threshold: p.threshold }
    )),
  });
}

/** 2026-10-10: every named disclosure request must be answered — disclosed or declined. */
export function unansweredDisclosures(
  answered: readonly DisclosureAnswer[] | undefined,
  requested: readonly CanonicalDisclosureRequest[] | undefined,
): CanonicalDisclosureRequest[] {
  return (requested ?? []).filter((req) => !(answered ?? []).some((a) => disclosureRequestMatches(a.request, req)));
}

function valuesEqual(a: unknown, b: unknown): boolean {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}

/**
 * Check every DISCLOSED record of a reputation presentation against its two-hop proof: the proof
 * names the same PE and hash, its leaf rebuilds (hop 1), the record's action type / time / named
 * digest / fields / artifacts / fact tier equal the ANCHORED act record, and the record satisfies
 * the request it answers. With a PEAnchor contract, hop 2 is checked on Base. Returns a refusal or
 * null; `verifiedLeaves` dedupes on-chain calls across records.
 */
async function checkDisclosedRecords(
  answers: readonly DisclosureAnswer[],
  proofs: readonly { pe_id: string; envelope_hash: string; anchor: Record<string, unknown>; leaf: Record<string, unknown>; merkle_proof: string[] }[] | undefined,
  contract: VerifyPresentationOptions['peAnchorContract'],
): Promise<{ refusal: PresentationRefusal | null; onchain: boolean }> {
  const verifiedLeaves = new Set<string>();
  let onchain = false;
  let total = 0;
  for (const a of answers) {
    if (a.election !== 'disclosed') continue;
    for (const record of a.records ?? []) {
      total += 1;
      if (total > DISCLOSURE_RECORDS_MAX_TOTAL) return { refusal: 'disclosure_record_invalid', onchain };
      if (!recordMatchesRequest(record, a.request)) return { refusal: 'disclosure_record_invalid', onchain };
      const proof = (proofs ?? []).find((p) => p.pe_id === record.pe_id);
      if (!proof || proof.envelope_hash.toLowerCase() !== record.pe_hash) return { refusal: 'disclosure_record_invalid', onchain };
      const leafValue = checkMeterFactLeaf(record.pe_hash, proof.leaf);
      if (leafValue === null) return { refusal: 'disclosure_record_invalid', onchain };
      const act = (proof.leaf as { act: { action_type: string; timestamp: number; pricing: Record<string, unknown> } }).act;
      if (act.action_type !== record.action_type || act.timestamp !== record.timestamp) return { refusal: 'disclosure_record_invalid', onchain };
      if (record.output_digest !== undefined && !outputDigestsOf(act.pricing).includes(record.output_digest) && record.output_digest !== record.pe_hash) {
        return { refusal: 'disclosure_record_invalid', onchain };
      }
      // Every disclosed field equals the value at its path in the ANCHORED pricing projection — and only
      // requested paths appear.
      const requestedFields = a.request.fields ?? [];
      for (const [path, value] of Object.entries(record.fields ?? {})) {
        if (!requestedFields.includes(path)) return { refusal: 'disclosure_record_invalid', onchain };
        if (!valuesEqual(value, readFieldPath(act.pricing, path))) return { refusal: 'disclosure_record_invalid', onchain };
      }
      const requestedContent = a.request.content ?? [];
      for (const key of Object.keys(record.content ?? {})) {
        if (!(requestedContent as readonly string[]).includes(key)) return { refusal: 'disclosure_record_invalid', onchain };
      }
      const c = record.content ?? {};
      if (c.artifacts !== undefined && !valuesEqual(c.artifacts, Array.isArray(act.pricing.output_digests) ? act.pricing.output_digests : [])) {
        return { refusal: 'disclosure_record_invalid', onchain };
      }
      if (c.fact_tier !== undefined && !valuesEqual(c.fact_tier, act)) return { refusal: 'disclosure_record_invalid', onchain };
      // A chain witness names a transaction the anchored metadata carries.
      if (record.witness.kind === 'chain') {
        const md = (act.pricing.metadata ?? {}) as Record<string, unknown>;
        const ev = (md.economic_evidence ?? {}) as Record<string, unknown>;
        const refs = [md.tx_hash, md.txHash, ev.txHash, ev.tx_hash].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
        if (md.verified !== true || record.witness.ref === undefined || !refs.includes(record.witness.ref)) return { refusal: 'disclosure_record_invalid', onchain };
      }
      // A hardware witness names a report the anchored pricing carries.
      if (record.witness.kind === 'hardware' && act.pricing.hardware_witness === undefined) return { refusal: 'disclosure_record_invalid', onchain };
      if (contract) {
        const batchId = (proof.anchor as { batch_id?: unknown }).batch_id;
        if (typeof batchId !== 'string' || !Array.isArray(proof.merkle_proof)) return { refusal: 'disclosure_record_invalid', onchain };
        const key = `${batchId}:${leafValue.toLowerCase()}`;
        if (!verifiedLeaves.has(key)) {
          let ok = false;
          try { ok = await contract.verifyPE(batchId, leafValue, proof.merkle_proof); } catch { ok = false; }
          if (!ok) return { refusal: 'disclosure_record_invalid', onchain };
          verifiedLeaves.add(key);
        }
        onchain = true;
      }
    }
  }
  return { refusal: null, onchain };
}

/** §2.6: every requested predicate must be answered (canonically identical field/op/threshold|set). */
export function unansweredPredicates(
  answered: readonly ReputationPredicate[] | undefined,
  requested: readonly PredicateRequest[] | undefined,
): PredicateRequest[] {
  const missing: PredicateRequest[] = [];
  for (const req of requested ?? []) {
    const hit = (answered ?? []).some((a) => predicateMatchesRequest(
      a.op === 'in' ? { field: a.field, op: 'in', set: a.set ?? [] } : { field: a.field, op: a.op, threshold: a.threshold },
      req,
    ));
    if (!hit) missing.push(req);
  }
  return missing;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Tier-independent failure codes for a Provian compact JWS. Each caller maps
 *  these to its own tier-prefixed {@link PresentationRefusal} so the reputation
 *  and pe_fact-co-sign refusals stay distinct while the crypto path is ONE. */
type JwsCode =
  | 'malformed'
  | 'unsupported_alg'
  | 'wrong_typ'
  | 'unknown_kid'
  | 'bad_signature'
  | 'issuer_mismatch';

/**
 * Verify a Provian compact JWS (EdDSA / Ed25519) against the Provian JWKS and the
 * EXACT `expectedTyp`, returning the decoded payload. The single crypto path
 * behind both the reputation JWS and the pe_fact co-sign — so the two can never
 * drift, while `expectedTyp` keeps them un-cross-confusable (a reputation JWS
 * fails `wrong_typ` when checked as a pe_fact co-sign and vice-versa).
 */
function verifyProvianCompactJws(
  jws: string,
  keys: readonly CommerceAttestationPublicJwk[],
  expectedTyp: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; code: JwsCode } {
  const parts = jws.split('.');
  if (parts.length !== 3) return { ok: false, code: 'malformed' };
  const [headerB64, payloadB64, sigB64] = parts;
  if (!BASE64URL.test(headerB64) || !BASE64URL.test(payloadB64) || !BASE64URL.test(sigB64)) {
    return { ok: false, code: 'malformed' };
  }
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (!isRecord(header)) return { ok: false, code: 'malformed' };
  if (header.alg !== 'EdDSA') return { ok: false, code: 'unsupported_alg' };
  if (header.typ !== expectedTyp) return { ok: false, code: 'wrong_typ' };
  if ('crit' in header) return { ok: false, code: 'unsupported_alg' };
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0) return { ok: false, code: 'unknown_kid' };
  const key = keys.find((k) => k.kid === kid);
  if (!key) return { ok: false, code: 'unknown_kid' };

  const signature = Buffer.from(sigB64, 'base64url');
  if (signature.length !== 64) return { ok: false, code: 'bad_signature' };
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'), pub, signature);
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, code: 'bad_signature' };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, code: 'malformed' };
  }
  if (!isRecord(payload)) return { ok: false, code: 'malformed' };
  if (payload.iss !== PRESENTATION_ISSUER) return { ok: false, code: 'issuer_mismatch' };
  return { ok: true, payload };
}

const REPUTATION_JWS_REASON: Record<JwsCode, PresentationRefusal> = {
  malformed: 'reputation_jws_malformed',
  unsupported_alg: 'reputation_jws_unsupported_alg',
  wrong_typ: 'reputation_jws_wrong_typ',
  unknown_kid: 'reputation_jws_unknown_kid',
  bad_signature: 'reputation_jws_bad_signature',
  issuer_mismatch: 'reputation_jws_issuer_mismatch',
};

const PEFACT_COSIGN_REASON: Record<JwsCode, PresentationRefusal> = {
  malformed: 'pe_fact_cosign_malformed',
  unsupported_alg: 'pe_fact_cosign_unsupported_alg',
  wrong_typ: 'pe_fact_cosign_wrong_typ',
  unknown_kid: 'pe_fact_cosign_unknown_kid',
  bad_signature: 'pe_fact_cosign_bad_signature',
  issuer_mismatch: 'pe_fact_cosign_issuer_mismatch',
};

/** Verify a reputation-tier compact JWS and return its decoded payload. */
function verifyReputationJws(
  jws: string,
  keys: readonly CommerceAttestationPublicJwk[],
): { ok: true; payload: unknown } | { ok: false; reason: PresentationRefusal } {
  const r = verifyProvianCompactJws(jws, keys, PRESENTATION_TYP);
  if (!r.ok) return { ok: false, reason: REPUTATION_JWS_REASON[r.code] };
  return { ok: true, payload: r.payload };
}

/**
 * Bind a verified pe_fact CO-SIGN to the presentation it must belong to. The
 * co-sign is already proven authentic (Provian's key, correct `typ`, correct
 * issuer); this checks it was minted for THIS presenter, burn, window, jti, and
 * claim set — so a genuine co-sign from one presentation cannot be lifted onto
 * another. Claim-set equality is order-independent via the shared claims digest.
 * Returns a refusal reason on any mismatch, or null when the co-sign binds.
 */
function checkPeFactCosignBinding(
  cosign: Record<string, unknown>,
  payload: PresentationPayload,
  claims: readonly { pe_id: string; envelope_hash: string }[],
): PresentationRefusal | null {
  if (cosign.ctx !== 'pe_fact_cosign') return 'pe_fact_cosign_payload_mismatch';
  if (
    typeof cosign.presenter_address !== 'string'
    || cosign.presenter_address.toLowerCase() !== payload.presenter_address.toLowerCase()
  ) return 'pe_fact_cosign_payload_mismatch';
  if (cosign.burn_id !== payload.burn_id) return 'pe_fact_cosign_payload_mismatch';
  if (cosign.jti !== payload.jti) return 'pe_fact_cosign_payload_mismatch';
  if (cosign.iat !== payload.iat || cosign.exp !== payload.exp) return 'pe_fact_cosign_payload_mismatch';
  // review: a co-sign that names the subject must name THIS payload's subject.
  if (cosign.sub !== undefined && (typeof cosign.sub !== 'string' || cosign.sub !== payload.sub)) {
    return 'pe_fact_cosign_payload_mismatch';
  }
  // a v2 co-sign binds the signed-challenge deadline and the verified requester; a v1 co-sign
  // carries neither (so a v1 co-sign can never be lifted onto a v2 payload or vice-versa).
  if (cosign.v !== payload.v) return 'pe_fact_cosign_payload_mismatch';
  if (payload.v === PRESENTATION_VERSION_SIGNED_CHALLENGE) {
    const pr = payloadRequester(payload);
    const cr = isRecord(cosign.requester) ? payloadRequester({ requester: cosign.requester } as unknown as PresentationPayload) : null;
    if (!pr || !cr || requesterString(pr) !== requesterString(cr)) return 'pe_fact_cosign_payload_mismatch';
    if (cosign.chal_exp !== payload.chal_exp) return 'pe_fact_cosign_payload_mismatch';
  } else if (cosign.requester !== undefined || cosign.chal_exp !== undefined) {
    return 'pe_fact_cosign_payload_mismatch';
  }

  const cf = cosign.pe_facts;
  if (!Array.isArray(cf)) return 'pe_fact_cosign_payload_mismatch';
  for (const f of cf) {
    if (!isRecord(f) || typeof f.pe_id !== 'string' || typeof f.envelope_hash !== 'string') {
      return 'pe_fact_cosign_payload_mismatch';
    }
  }
  const cosignDigest = claimsDigest({ tier: 'pe_fact', pe_facts: cf as { pe_id: string; envelope_hash: string }[] });
  const payloadDigest = claimsDigest({ tier: 'pe_fact', pe_facts: claims });
  if (cosignDigest !== payloadDigest) return 'pe_fact_cosign_payload_mismatch';
  return null;
}

/**
 * Verify a full presentation. For reputation, the authoritative payload is the
 * one carried inside the Provian JWS (not the structured envelope). For pe_fact,
 * the authoritative payload is the structured one, authenticated by the presenter
 * signature, and each embedded proof must both match its claim and (when a
 * contract is supplied) verify against the on-chain root.
 */
export async function verifyPresentation(
  presentation: Presentation,
  opts: VerifyPresentationOptions = {},
): Promise<VerifyPresentationResult> {
  if (!isRecord(presentation) || (presentation.tier !== 'pe_fact' && presentation.tier !== 'reputation')) {
    return { valid: false, reason: 'malformed' };
  }
  // item 1: a verify that names predicates is a PREDICATE GATE, and only the reputation tier
  // answers predicates. A pe_fact token carries no predicate answers, so accepting it would let a
  // presenter walk past every question the gate asked. Refused before any crypto work.
  if ((opts.expectedPredicates ?? []).length > 0 && presentation.tier !== 'reputation') {
    return { valid: false, reason: 'predicates_require_reputation_tier' };
  }
  // 2026-10-10: a disclosure gate is answered only by the reputation tier (Standing always beside it).
  if ((opts.expectedDisclosures ?? []).length > 0 && presentation.tier !== 'reputation') {
    return { valid: false, reason: 'disclosures_require_reputation_tier' };
  }

  if (presentation.tier === 'reputation') {
    if (typeof presentation.provian_jws !== 'string' || presentation.provian_jws.length === 0) {
      return { valid: false, reason: 'reputation_not_signed' };
    }
    const keys = opts.publicKeys ?? [];
    const jws = verifyReputationJws(presentation.provian_jws, keys);
    if (!jws.ok) return { valid: false, reason: jws.reason };
    const payload = jws.payload as PresentationPayload;
    if (payload.tier !== 'reputation') return { valid: false, reason: 'tier_mismatch' };
    const common = checkCommon(payload, opts);
    if (common) return { valid: false, reason: common };
    const repSub = typeof payload.sub === 'string' ? payload.sub : null;
    const repPresenter = presenterIdMismatch(opts, repSub);
    if (repPresenter) return { valid: false, reason: repPresenter };
    const answered = payload.reputation?.predicates ?? [];
    if (unansweredPredicates(answered, opts.expectedPredicates).length > 0) {
      return { valid: false, reason: 'predicates_unanswered' };
    }
    // Standing is ALWAYS present and never withheld. The issuing relay refuses a
    // directive that withholds it; a payload that still lacks it is refused here, whoever signed it.
    if (missingStandingFields(payload.reputation?.facts).length > 0) {
      return { valid: false, reason: 'standing_withheld' };
    }
    // Requester-named disclosures: every named request answered; every disclosed record proven.
    const disclosures = parseDisclosureAnswers(payload.disclosures) ?? [];
    if (unansweredDisclosures(disclosures, opts.expectedDisclosures).length > 0) {
      return { valid: false, reason: 'disclosures_unanswered' };
    }
    const checked = await checkDisclosedRecords(disclosures, presentation.disclosure_proofs, opts.peAnchorContract);
    if (checked.refusal) return { valid: false, reason: checked.refusal };
    return {
      valid: true,
      tier: 'reputation',
      payload,
      onchain_checked: checked.onchain,
      presentation_id: payload.burn_id,
      sub: repSub,
      requester: payloadRequester(payload),
      challenge_expires_at: enforcedDeadline(payload, opts),
      predicates: [...answered],
      standing: standingSlice(payload.reputation?.facts),
      disclosed: { ...(payload.reputation?.facts ?? {}) },
      ...(disclosures.length > 0 ? { disclosures } : {}),
    };
  }

  // pe_fact
  const payload = presentation.payload;
  if (!isRecord(payload) || payload.tier !== 'pe_fact') return { valid: false, reason: 'tier_mismatch' };
  const common = checkCommon(payload, opts);
  if (common) return { valid: false, reason: common };

  const claims = payload.pe_facts ?? [];
  // Mirror the relay's issuance minimum (issuance rejects an empty pe_facts with
  // 400): a pe_fact with zero claims proves nothing and is refused everywhere.
  if (claims.length === 0) return { valid: false, reason: 'pe_fact_no_claims' };

  // REQUIRE the Provian co-sign. It is what proves — off the chain — that a PVT
  // burn was consumed and the cited PEs belong to THIS presenter. Without it, a
  // self-issued pe_fact citing anyone's public anchored PEs verifies (F4/F61).
  if (typeof presentation.provian_jws !== 'string' || presentation.provian_jws.length === 0) {
    return { valid: false, reason: 'pe_fact_not_cosigned' };
  }
  const cosign = verifyProvianCompactJws(presentation.provian_jws, opts.publicKeys ?? [], PRESENTATION_PEFACT_TYP);
  if (!cosign.ok) return { valid: false, reason: PEFACT_COSIGN_REASON[cosign.code] };
  const cosignMismatch = checkPeFactCosignBinding(cosign.payload, payload, claims);
  if (cosignMismatch) return { valid: false, reason: cosignMismatch };
  // The pe_fact subject is only what Provian co-signed : never the bare payload `sub`.
  const peFactSub = typeof cosign.payload.sub === 'string' ? cosign.payload.sub : null;
  const peFactPresenter = presenterIdMismatch(opts, peFactSub);
  if (peFactPresenter) return { valid: false, reason: peFactPresenter };

  const proofs = presentation.proofs ?? [];

  // F5/F52/F58: bound the work BEFORE any on-chain call. The verifier does NOT
  // trust that a presentation it receives was produced by our issuer, so it
  // re-enforces the same MAX_PE_FACT_CLAIMS cap the issuer applies — otherwise an
  // anonymous caller packs hundreds of claims/proofs into one request and drives
  // one PEAnchor eth_call per proof against the shared Base provider.
  if (claims.length > MAX_PE_FACT_CLAIMS || proofs.length > MAX_PE_FACT_CLAIMS) {
    return { valid: false, reason: 'pe_fact_too_many_claims' };
  }
  // claims.length > 0 is guaranteed above (pe_fact_no_claims), so this is the
  // sibling no-proofs guard, unchanged.
  if (proofs.length === 0) return { valid: false, reason: 'pe_fact_no_proofs' };

  // Refuse duplicate pe_ids in the claim set: a repeated pe_id would let one
  // genuine proof be counted/asserted many times and (before the dedupe below)
  // multiply the on-chain fan-out.
  const seenClaimIds = new Set<string>();
  for (const claim of claims) {
    if (seenClaimIds.has(claim.pe_id)) return { valid: false, reason: 'pe_fact_duplicate_claim' };
    seenClaimIds.add(claim.pe_id);
  }

  // Every claim must have a matching proof for the SAME pe_id + envelope_hash.
  for (const claim of claims) {
    const proof = proofs.find((p) => p.pe_id === claim.pe_id);
    if (!proof || proof.envelope_hash.toLowerCase() !== claim.envelope_hash.toLowerCase()) {
      return { valid: false, reason: 'pe_fact_claim_proof_mismatch' };
    }
  }

  let onchainChecked = false;
  // Short-circuit before ANY RPC when there are no claims (a claimless
  // presentation asserts no fact to prove on-chain, so unreferenced/padded
  // proofs must never trigger an eth_call — the F5 amplification vector).
  if (opts.peAnchorContract && claims.length > 0) {
    // Verify ONLY the proofs referenced by a claim, and each DISTINCT proof
    // (batch_id + leaf) at most once.
    const verifiedLeaves = new Set<string>();
    for (const claim of claims) {
      // Guaranteed present by the claim↔proof match loop above.
      const proof = proofs.find((p) => p.pe_id === claim.pe_id)!;
      const batchId = (proof.anchor as { batch_id?: unknown } | undefined)?.batch_id;
      const leafRaw = (proof.leaf as { leaf_value?: unknown } | undefined)?.leaf_value;
      if (typeof batchId !== 'string' || typeof leafRaw !== 'string' || !Array.isArray(proof.merkle_proof)) {
        return { valid: false, reason: 'pe_fact_proof_onchain_invalid' };
      }
      let leafValue: string = leafRaw;
      if ((proof.leaf as { kind?: unknown }).kind === 'meter_act') {
        // PE METER: hop 1 (the PE's act is in its batch, and the batch leaf is what was anchored)
        // checked here from the embedded act record; hop 2 is the same on-chain check below.
        const anchoredLeaf = checkMeterFactLeaf(proof.envelope_hash, proof.leaf);
        if (anchoredLeaf === null) return { valid: false, reason: 'pe_fact_proof_onchain_invalid' };
        leafValue = anchoredLeaf;
      } else {
      // Bind the anchored leaf to the CLAIMED envelope hash. `verifyPE` only
      // proves a leaf is in the anchored tree — nothing else ties `leaf_value`
      // to `envelope_hash`. Without this a presenter replays a genuine anchored
      // leaf (from any real PE, e.g. a public /proof response) while claiming a
      // different `envelope_hash`; the claim↔proof hashes match each other and
      // `verifyPE` passes on the real leaf, so a forged fact would verify. Recompute
      // the leaf-domain hash (identical to the on-chain rule + the daily/segment
      // anchor leaf) and require equality. `envelope_hash` is already pinned to the
      // claim above, so this binds the on-chain leaf to the claim. Fail-closed on a
      // malformed hash (Unknown = Block). This is the anchoring-claim path (the live
      // /v1/present/verify always supplies the contract; the structural-only path
      // makes no anchoring claim and returns onchain_checked:false).
      let expectedLeaf: string;
      try {
        expectedLeaf = hashEnvelopeHashLeaf(proof.envelope_hash);
      } catch {
        return { valid: false, reason: 'pe_fact_proof_onchain_invalid' };
      }
      if (leafValue.toLowerCase() !== expectedLeaf.toLowerCase()) {
        return { valid: false, reason: 'pe_fact_proof_onchain_invalid' };
      }
      }
      const dedupeKey = `${batchId}:${leafValue.toLowerCase()}`;
      if (verifiedLeaves.has(dedupeKey)) continue; // this exact proof already verified
      let ok = false;
      try {
        ok = await opts.peAnchorContract.verifyPE(batchId, leafValue, proof.merkle_proof);
      } catch {
        ok = false;
      }
      if (!ok) return { valid: false, reason: 'pe_fact_proof_onchain_invalid' };
      verifiedLeaves.add(dedupeKey);
    }
    onchainChecked = true;
  }

  return {
    valid: true,
    tier: 'pe_fact',
    payload,
    onchain_checked: onchainChecked,
    presentation_id: payload.burn_id,
    sub: peFactSub,
    requester: payloadRequester(payload),
    challenge_expires_at: enforcedDeadline(payload, opts),
  };
}
