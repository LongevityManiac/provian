import { guardedFetch as fetch, guardedFetcher } from './guarded-fetch';
/**
 * Burn-to-present — REQUESTER side (agent SDK, the primary path).
 *
 * The requester is whoever asks a counterparty to prove something. It:
 *   1. ISSUES A CHALLENGE — a fresh nonce bound to its own audience id. The
 *      presenter must bind their presentation to this exact (audience, challenge),
 *      which is what makes a presentation non-replayable to any other requester or
 *      moment. {@link issuePresentationChallenge}.
 *   2. VERIFIES A PRESENTATION — with NO Provian account (a fetched JWKS verifies
 *      the Provian signatures offline):
 *        - structural + freshness + the requester binding (aud/chal it issued),
 *        - the presenter's live-key possession signature over the canonical
 *          binding (EIP-191 for a human, ECDSA-SHA256 for an agent),
 *        - REPUTATION tier: the Provian EdDSA JWS against the fetched JWKS
 *          (`/v1/present/jwks`) — Provian attests the scores, but a fetched key
 *          set verifies the JWS offline; no account.
 *        - PE-FACT tier: THREE proofs, all required. (a) the presenter signature
 *          (checkCommon). (b) each embedded anchor proof against the on-chain
 *          PEAnchor root via a Base RPC read (`verifyPE`); the verifier target is
 *          PINNED to the canonical Base PEAnchor (`PROVIAN_BASE_PE_ANCHOR`,
 *          overridable via `peAnchorAddress`), never read from the presentation,
 *          and the embedded `leaf_value` is independently recomputed from the
 *          CLAIMED envelope hash (`keccak256(0x00 || bytes32(envelope_hash))`) so a
 *          genuine anchored leaf cannot be replayed under a forged hash. (c) the
 *          Provian CO-SIGN JWS (EdDSA, a DISTINCT `typ`) against the fetched JWKS —
 *          Provian attests, at issuance, that a burn was consumed and the cited PEs
 *          belong to this presenter, which the chain cannot show. The co-sign is
 *          REQUIRED: without it a self-issued pe_fact citing anyone's public
 *          anchored PEs would verify. No Provian account is needed (a fetched JWKS
 *          verifies it offline). {@link verifyPresentationToken}.
 *
 * Byte-for-byte with the backend + presenter: reuses `presentationBindingString`
 * / `claimsDigest` / `canonicalReputationDirective` from ./presentation so the
 * recomputed binding is identical to what the presenter signed. Uses node `crypto`
 * (Ed25519 JWS, ECDSA-SHA256) and viem (EIP-191 recover, PEAnchor read) — both
 * already SDK deps.
 */

import crypto, { randomBytes } from 'crypto';
import { actLeafOf, batchLeafOf, verifyMerkleProofOf, type ActRecord } from './meter-wire';
import {
  canonicalJson as disclosureCanonicalJson,
  disclosureRequestMatches,
  normalizeDisclosureRequests,
  parseDisclosureAnswers,
  readFieldPath,
  recordMatchesRequest,
  DISCLOSURE_RECORDS_MAX_TOTAL,
  type CanonicalDisclosureRequest,
  type DisclosureAnswer,
} from './disclosure-request';
import {
  claimsDigest,
  presentationBindingString,
  requesterString,
  normalizeRequester,
  type PresentationRequester,
  type PresentationTier,
  type DisclosureDirective,
  normalizePredicateRequests,
  predicateMatchesRequest,
  type PredicateRequest,
  type PredicateOp,
} from './presentation';
import {
  parseChallengeEnvelope,
  isSignedChallenge,
  checkSignedStructure,
  signDomainChallenge,
  createMemorySeenStore,
  CHALLENGE_MIN_TTL_SECONDS,
  CHALLENGE_MAX_TTL_SECONDS,
  CHALLENGE_DEFAULT_TTL_SECONDS,
  type ChallengeEnvelope,
  type EnvelopeRequester,
  type PresentationSeenStore,
} from './challenge';

// ── Constants that MUST match the backend (core/presentation/types.ts) ───────
export const PRESENTATION_VERSION = 1;
/** payload version of a presentation produced against a SIGNED challenge. */
export const PRESENTATION_VERSION_SIGNED_CHALLENGE = 2;
export const PRESENTATION_ISSUER = 'https://provian.ai';
export const PRESENTATION_TYP = 'provian-presentation+jwt';
/** DISTINCT `typ` for the pe_fact Provian CO-SIGN — must equal the backend's
 *  PRESENTATION_PEFACT_TYP so the two verifiers pin the same value. */
export const PRESENTATION_PEFACT_TYP = 'provian-presentation-pefact+jwt';
export const PRESENTATION_CLOCK_SKEW_SECONDS = 60;
export const PRESENTATION_MAX_TTL_SECONDS = 900;
export const PRESENTATION_CHALLENGE_MIN_LEN = 16;

/**
 * The canonical deployed PEAnchor on Base. A pe_fact on-chain
 * verify calls `verifyPE` on THIS address — never on an address taken from the
 * (untrusted) presentation. A presenter must not be able to point verification
 * at a contract of its own that returns `true`. Overridable per-verify via
 * `VerifyPresentationOptions.peAnchorAddress` for a non-mainnet PEAnchor.
 */
export const PROVIAN_BASE_PE_ANCHOR = '0x889A59A847e490c5Cc91f281468AbAacc100a9fD';

/** the default Base RPC a pe_fact verify reads the PEAnchor through (requireOnchain defaults to true). */
export const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';
/** Provian's public presentation JWKS — the default key source for a reputation-tier verify. */
export const DEFAULT_PROVIAN_JWKS_URL = 'https://api.provian.ai/v1/present/jwks';

/**
 * A challenge a requester issues, to hand to the presenter and check at verify. A superset of the
 * wire envelope : `JSON.stringify` of it IS what the presenter receives. When SIGNED it
 * also carries `v`, `requester`, `sig` (and `presenter` when addressed).
 */
export interface PresentationChallenge extends ChallengeEnvelope {
  /** The requester's own id (the presentation's `aud`); binding to it is what
   *  makes the presentation addressed to THIS requester. Signed: equals `requester.id`. */
  readonly audience: string;
  /** The fresh, unguessable nonce (hex). */
  readonly challenge: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** A domain requester's local signing key for {@link issuePresentationChallenge}. */
export interface DomainRequesterSigningKey {
  /** The requester's DNS hostname (lowercase). The challenge audience. */
  readonly domain: string;
  /** The kid published in `https://<domain>/.well-known/provian-requester.json`. */
  readonly kid: string;
  /** The Ed25519 PKCS8 PEM from `generateRequesterKey()`. */
  readonly privateKeyPem: string;
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Issue a fresh presentation challenge bound to this requester's audience id.
 * Stateless — the caller keeps the returned challenge and passes it as the `challenge`
 * option at verify (or `expectedAudience` / `expectedChallenge`). `audience` should be a
 * stable id the requester controls (its agent wallet id, a domain, an order id).
 *
 * with `requester` the challenge is SIGNED locally with the domain requester's own
 * Ed25519 key (audience defaults to — and must equal — the domain), so the presenter can verify
 * whom it presents to before it burns. `presenter` addresses it to one presenter address.
 * `ttlSeconds` is clamped to 60..604800 (default 900).
 */
export function issuePresentationChallenge(params: {
  audience?: string;
  ttlSeconds?: number;
  nowSeconds?: number;
  /** §2.6: requester-named predicates over the vocabulary (`gte|gt|lte|lt|eq` + `in`). */
  predicates?: readonly PredicateRequest[];
  /** 2026-10-10: requester-named disclosure requests — a specific PE by output digest, or PEs
   *  witnessed by a named issuer / signer, each with the fields and content asked for. */
  disclosures?: readonly unknown[];
  /** the expected presenter (EVM address; lowercased). */
  presenter?: string;
  /** sign the challenge as this domain requester. */
  requester?: DomainRequesterSigningKey;
}): PresentationChallenge {
  const audience = params.audience ?? params.requester?.domain;
  if (!audience || typeof audience !== 'string') {
    throw new Error('audience is required to issue a presentation challenge');
  }
  if (params.requester && audience !== params.requester.domain) {
    throw new Error('a signed challenge\'s audience must equal requester.domain');
  }
  const predicates = normalizePredicateRequests(params.predicates);
  if (predicates === null) throw new Error('predicates is malformed (field, op gte|gt|lte|lt|eq|in, threshold | set)');
  const disclosures = normalizeDisclosureRequests(params.disclosures);
  if (disclosures === null) throw new Error('disclosures is malformed ({kind:pe, output_digest, issuer?, fields?, content?} | {kind:witness, issuer?|signer?, limit?, fields?, content?})');
  let presenter: string | undefined;
  if (params.presenter !== undefined) {
    presenter = params.presenter.toLowerCase();
    if (!ADDRESS_RE.test(presenter)) throw new Error('presenter must be an EVM address (0x + 40 hex)');
  }
  const issuedAt = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.floor(Math.min(Math.max(params.ttlSeconds ?? CHALLENGE_DEFAULT_TTL_SECONDS, CHALLENGE_MIN_TTL_SECONDS), CHALLENGE_MAX_TTL_SECONDS));
  // 32 random bytes → 64 hex chars, well above the 16-char floor and unguessable.
  const challenge = randomBytes(32).toString('hex');
  if (params.requester) {
    return signDomainChallenge({
      domain: params.requester.domain,
      kid: params.requester.kid,
      privateKeyPem: params.requester.privateKeyPem,
      challenge,
      issuedAt,
      expiresAt: issuedAt + ttl,
      presenter,
      predicates,
      disclosures,
    }) as PresentationChallenge;
  }
  return {
    audience,
    challenge,
    issuedAt,
    expiresAt: issuedAt + ttl,
    ...(predicates.length > 0 ? { predicates } : {}),
    ...(disclosures.length > 0 ? { disclosures } : {}),
    ...(presenter ? { presenter } : {}),
  };
}

/**
 * Parse a challenge payload the requester handed over — the JSON that
 * {@link issuePresentationChallenge} / the `present_challenge` MCP tool emit,
 * delivered over ANY channel (a QR string, a Telegram message, an email, an API
 * body). Returns the envelope (`{ audience, challenge, predicates? }` plus, when present, the
 * signed fields `v`/`issuedAt`/`expiresAt`/`presenter`/`requester`/`sig`) or `null` when it is
 * not a well-formed challenge. Structural only — a presenter MUST still run
 * `verifyChallengeEnvelope` before burning. Delegates to {@link parseChallengeEnvelope}.
 */
export function parseChallengePayload(data: string): ChallengeEnvelope | null {
  return parseChallengeEnvelope(data);
}

// ── Presentation shapes (the subset the requester reads) ─────────────────────
interface PresenterPop {
  scheme: 'ecdsa_sha256_secp256k1' | 'eip191_secp256k1';
  signature: string;
  pubkey?: string;
}
interface PeFactClaim { pe_id: string; envelope_hash: string }
interface ReputationPredicate { field: string; op: PredicateOp; threshold?: number; set?: number[]; result: boolean }
interface ReputationDisclosure { facts: Record<string, number>; predicates: ReputationPredicate[]; redacted: string[]; shared?: string[] }
interface PresentationPayload {
  v: number; tier: PresentationTier; iss: string; sub: string;
  presenter_address: string; aud: string; chal: string; iat: number; exp: number;
  jti: string; burn_id: string; presenter_pop: PresenterPop;
  pe_facts?: PeFactClaim[]; reputation?: ReputationDisclosure;
  /** 2026-10-10: the requester-named disclosure answers (reputation tier). */
  disclosures?: DisclosureAnswer[];
  /** v2 only : the signed challenge's deadline. */
  chal_exp?: number;
  /** v2 only : the requester identity the relay verified at issuance (`id` === `aud`). */
  requester?: PresentationRequester;
}
interface PeFactProof {
  pe_id: string; envelope_hash: string; anchored: true;
  anchor: Record<string, unknown>; leaf: Record<string, unknown>; merkle_proof: string[];
}
export interface Presentation {
  tier: PresentationTier;
  payload: PresentationPayload;
  provian_jws?: string;
  proofs?: PeFactProof[];
  /** 2026-10-10: one two-hop proof per DISCLOSED record. */
  disclosure_proofs?: PeFactProof[];
}

/** A JWK from the Provian presentation JWKS (`/v1/present/jwks`). */
export interface PresentationJwk { kty: string; crv?: string; x?: string; kid: string; alg?: string }

export type PresentationRefusal =
  | 'malformed' | 'unsupported_version' | 'tier_mismatch' | 'missing_binding_fields'
  | 'audience_mismatch' | 'challenge_mismatch' | 'expired' | 'not_yet_valid'
  | 'window_too_long' | 'bad_presenter_pop' | 'reputation_not_signed'
  | 'reputation_jws_malformed' | 'reputation_jws_unsupported_alg' | 'reputation_jws_wrong_typ'
  | 'reputation_jws_unknown_kid' | 'reputation_jws_bad_signature' | 'reputation_jws_issuer_mismatch'
  | 'reputation_jwks_unavailable'
  | 'pe_fact_no_claims' | 'pe_fact_not_cosigned' | 'pe_fact_cosign_jwks_unavailable'
  | 'pe_fact_cosign_malformed' | 'pe_fact_cosign_unsupported_alg' | 'pe_fact_cosign_wrong_typ'
  | 'pe_fact_cosign_unknown_kid' | 'pe_fact_cosign_bad_signature' | 'pe_fact_cosign_issuer_mismatch'
  | 'pe_fact_cosign_payload_mismatch'
  | 'pe_fact_no_proofs' | 'pe_fact_claim_proof_mismatch'
  | 'pe_fact_leaf_mismatch' | 'pe_fact_anchor_untrusted'
  | 'pe_fact_proof_onchain_invalid' | 'pe_fact_onchain_unchecked'
  | 'predicates_unanswered'
  /** 2026-10-10: a named disclosure request has no answer; a disclosed record fails its checks. */
  | 'disclosures_unanswered' | 'disclosure_record_invalid' | 'disclosures_require_reputation_tier'
  /** close-out: a reputation payload missing an always-present Standing fact. */
  | 'standing_withheld'
  //
  | 'predicates_require_reputation_tier' | 'presenter_mismatch' | 'challenge_expired' | 'requester_mismatch'
  /** SDK only: this verifier's seen-store already accepted this presentation. */
  | 'replayed'
  /** SDK only: the seen-store could not record the claim (fail closed). */
  | 'seen_store_unavailable';

export interface VerifyPresentationOptions {
  /** The exact audience the requester issued (its own id). Checked against `aud`.
   *  Required unless `challenge` is given (then derived from it). */
  expectedAudience?: string;
  /** The exact challenge the requester issued. Checked against `chal`.
   *  Required unless `challenge` is given (then derived from it). */
  expectedChallenge?: string;
  /** Pre-fetched Provian JWKS (offline). If absent, fetched from `jwksUrl`. */
  jwks?: readonly PresentationJwk[];
  /** Where to fetch the JWKS for a reputation-tier verify. Default: {@link DEFAULT_PROVIAN_JWKS_URL}. */
  jwksUrl?: string;
  /** Base RPC url for the pe_fact PEAnchor read. Defaults to {@link DEFAULT_BASE_RPC_URL} while
   *  `requireOnchain` is on (the default). With `requireOnchain: false` and no rpcUrl the chain is
   *  not read and `onchainChecked` is false. */
  rpcUrl?: string;
  /** Require the on-chain check for pe_fact (refuse when it cannot run or fails). Default TRUE
   *; opt out explicitly with `requireOnchain: false`. */
  requireOnchain?: boolean;
  /** The PEAnchor address the on-chain `verifyPE` is called on. Defaults to the
   *  canonical Base PEAnchor ({@link PROVIAN_BASE_PE_ANCHOR}). Pinned by the
   *  verifier, NEVER derived from the presentation. Override only for a
   *  non-mainnet PEAnchor deployment. */
  peAnchorAddress?: string;
  nowSeconds?: number;
  fetchFn?: typeof fetch;
  /** §2.6: the predicates you named in the challenge. A reputation presentation that does not
   * answer EVERY one (canonically identical field/op/threshold|set) is refused; any other tier is
   * refused `predicates_require_reputation_tier`. */
  expectedPredicates?: readonly PredicateRequest[];
  /** 2026-10-10: the disclosure requests you named. A reputation presentation that does not answer
   *  every one (disclosed or declined) is refused; every disclosed record is checked against its
   *  anchored proof (and, with the chain, on Base). Filled from `challenge` when given. */
  expectedDisclosures?: readonly CanonicalDisclosureRequest[];
  /** the presenter you addressed — a lowercase EVM address (compared to `presenter_address`)
   * or a presenter wallet id (compared to `sub`). Mismatch → `presenter_mismatch`. */
  expectedPresenter?: string;
  /** your challenge deadline (unix seconds). A v2 presentation's own signed `chal_exp` is
   * enforced whether or not this is given. */
  challengeDeadline?: number;
  /** the requester identity of the SIGNED challenge you issued; a v2 presentation's
   * requester must equal it. */
  expectedRequester?: PresentationRequester;
  /**
   * the challenge you issued (the object {@link issuePresentationChallenge} /
   * `CommonsInstitutions.issuePresentationChallenge` returned, or its JSON). Fills expectedAudience,
   * expectedChallenge, expectedPredicates, expectedPresenter (from `presenter`), challengeDeadline
   * (from `expiresAt`) and expectedRequester (when signed). Explicit options that disagree THROW.
   */
  challenge?: ChallengeEnvelope | string;
  /** accept each presentation (by `presentationId` = burn id) ONCE. Default TRUE. */
  acceptOnce?: boolean;
  /** where accepted presentation ids are remembered. Default: a module-level in-memory
   * store. Use `createFileSeenStore(path)` across processes. */
  seenStore?: PresentationSeenStore;
}

export type VerifyPresentationResult =
  | {
    valid: true; tier: PresentationTier; payload: PresentationPayload; onchainChecked: boolean;
    /** the stable dedupe key — the burn id (one burn backs exactly one presentation). */
    presentationId: string;
    presenterAddress: string;
    /** The presenter's wallet id, only when a signature covers it (reputation JWS; pe_fact co-sign);
     *  null on a pe_fact whose co-sign predates the subject binding — never the bare payload `sub`. */
    sub: string | null;
    /** the requester identity the relay verified at issuance (v2 payload), else null. */
    requester: PresentationRequester | null;
    /** the challenge deadline enforced (v2 `chal_exp`, else the issued challenge's), else null. */
    challengeExpiresAt: number | null;
    /** Reputation tier: every answered predicate with its co-signed result (§2.6). */
    predicates?: ReputationPredicate[];
    /** Reputation tier: the always-present `standing.*` facts (§2.5). */
    standing?: Record<string, number>;
    /** Reputation tier: every disclosed raw fact. */
    disclosed?: Record<string, number>;
    /** Reputation tier: the requester-named disclosure answers, each record checked against its proof. */
    disclosures?: DisclosureAnswer[];
  }
  | { valid: false; reason: PresentationRefusal };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recompute the anchored leaf for a PE from its envelope hash, byte-identical to
 * the backend `hashEnvelopeHashLeaf` (`merkle.ts`) and the on-chain leaf-domain
 * rule: `leaf = keccak256(0x00 || bytes32(envelope_sha256))`. Returns null for a
 * malformed hash (Unknown = Block — a bad hash can never become a leaf). Async so
 * viem is loaded lazily, matching the rest of the on-chain path.
 */
async function leafFromEnvelopeHash(envelopeHashHex: string): Promise<string | null> {
  if (typeof envelopeHashHex !== 'string') return null;
  const stripped = envelopeHashHex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) return null;
  try {
    const { keccak256, encodePacked } = await import('viem');
    return keccak256(encodePacked(['bytes1', 'bytes32'], ['0x00', `0x${stripped.toLowerCase()}`])).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * PE METER: the anchored leaf a `meter_act` proof commits to, or null. Hop 1 offline (the embedded
 * act record's leaf is in `acts_root` by `act_proof`; the batch identity with that root gives
 * `batch_leaf`), the act's pe_hash is the CLAIMED envelope hash, and the on-chain leaf is
 * keccak256(0x00 ‖ batch_leaf). Mirrors the relay's `checkMeterFactLeaf`; hop 2 is the same
 * `verifyPE` read every pe_fact proof gets.
 */
async function meterActAnchoredLeaf(envelopeHash: string, leafRaw: unknown): Promise<string | null> {
  if (!isRecord(leafRaw) || leafRaw.kind !== 'meter_act') return null;
  const { act, act_proof: actProof, acts_root: actsRoot, batch, batch_leaf: batchLeaf, leaf_value: leafValue } = leafRaw;
  if (!isRecord(act) || !Array.isArray(actProof) || !actProof.every((x) => typeof x === 'string')
    || typeof actsRoot !== 'string' || typeof batchLeaf !== 'string' || typeof leafValue !== 'string' || !isRecord(batch)) {
    return null;
  }
  if (typeof act.pe_hash !== 'string' || act.pe_hash !== envelopeHash.toLowerCase().replace(/^0x/, '')) return null;
  if (typeof batch.device_id !== 'string' || typeof batch.actor_id !== 'string'
    || typeof batch.seq !== 'number' || typeof batch.batch_hash !== 'string') {
    return null;
  }
  let recomputedBatchLeaf: string;
  try {
    if (!verifyMerkleProofOf(actLeafOf(act as unknown as ActRecord), actProof as string[], actsRoot)) return null;
    recomputedBatchLeaf = batchLeafOf({
      device_id: batch.device_id, actor_id: batch.actor_id, seq: batch.seq, batch_hash: batch.batch_hash, acts_root: actsRoot,
    });
  } catch {
    return null;
  }
  if (recomputedBatchLeaf !== batchLeaf) return null;
  const expected = await leafFromEnvelopeHash(recomputedBatchLeaf);
  return expected !== null && expected === leafValue.toLowerCase() ? expected : null;
}

/** Decode an opaque base64url presentation token to a structured presentation. */
export function decodePresentationToken(token: string): Presentation | null {
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    return isRecord(obj) ? (obj as unknown as Presentation) : null;
  } catch {
    return null;
  }
}

/** Normalize an uncompressed secp256k1 hex key to bare 128-hex (matches backend). */
function normPubkey(s: string): string {
  const c = s.toLowerCase().replace(/^0x/, '');
  return c.length === 130 && c.startsWith('04') ? c.slice(2) : c;
}

/** SPKI PEM for an uncompressed secp256k1 public key (matches backend). */
function uncompressedHexToSpkiPem(publicKeyHex: string): string {
  const cleaned = normPubkey(publicKeyHex);
  if (cleaned.length !== 128) throw new Error('bad pubkey length');
  const pubKeyBytes = Buffer.from('04' + cleaned, 'hex');
  const spkiHeaderHex = '3056301006072a8648ce3d020106052b8104000a034200';
  const spkiDer = Buffer.concat([Buffer.from(spkiHeaderHex, 'hex'), pubKeyBytes]);
  const b64 = spkiDer.toString('base64');
  const wrapped = b64.match(/.{1,64}/g)?.join('\n') ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

/** Verify the presenter's proof of live key possession over the binding. */
async function verifyPresenterPop(binding: string, pop: PresenterPop, presenterAddress: string): Promise<boolean> {
  if (!isRecord(pop) || typeof pop.signature !== 'string') return false;
  const expected = presenterAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(expected)) return false;

  if (pop.scheme === 'eip191_secp256k1') {
    try {
      const { recoverMessageAddress } = await import('viem');
      const recovered = await recoverMessageAddress({
        message: binding,
        signature: pop.signature as `0x${string}`,
      });
      return recovered.toLowerCase() === expected;
    } catch {
      return false;
    }
  }

  if (pop.scheme === 'ecdsa_sha256_secp256k1') {
    if (typeof pop.pubkey !== 'string') return false;
    if (!/^[0-9a-fA-F]+$/.test(pop.signature) || pop.signature.length % 2 !== 0) return false;
    let spkiPem: string;
    try {
      spkiPem = uncompressedHexToSpkiPem(pop.pubkey);
    } catch {
      return false;
    }
    let sigOk = false;
    try {
      const verifier = crypto.createVerify('SHA256');
      verifier.update(binding);
      sigOk = verifier.verify(spkiPem, Buffer.from(pop.signature, 'hex'));
    } catch {
      return false;
    }
    if (!sigOk) return false;
    // The pubkey must derive to the claimed address (viem computeAddress).
    try {
      const clean = normPubkey(pop.pubkey);
      if (clean.length !== 128) return false;
      const { publicKeyToAddress } = await import('viem/utils');
      const derived = publicKeyToAddress(`0x04${clean}` as `0x${string}`);
      return derived.toLowerCase() === expected;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * The Standing facts EVERY reputation presentation carries (: adverse facts are
 * always present and never redactable). Mirrors the relay's `STANDING_ALWAYS_PRESENT_FIELDS`
 * (`core/presentation/vocabulary-fields.ts`); bound to the served schema snapshot by
 * `presentation-verify.test.ts`. A co-signed payload missing any of them is refused `standing_withheld`.
 */
export const STANDING_ALWAYS_PRESENT_FIELDS: readonly string[] = [
  'standing.adverse_events',
  'standing.bond_active',
  'standing.open_bond_claims_against',
  'standing.invalidation_active',
  'standing.adverse_events_30d',
  'standing.adverse_events_90d',
  'standing.adverse_events_365d',
];

/** Reconstruct the reputation disclosure directive from a payload (matches backend). An `in`
 * predicate carries its SET (item 4) — dropping it rebuilt the wrong claims digest, so a
 * legitimate `in` presentation failed presenter-PoP. */
function reputationDirective(payload: PresentationPayload): DisclosureDirective {
  const r = payload.reputation;
  if (!r) return { redact: [], predicates: [] };
  return {
    redact: r.redacted ?? [],
    ...(Array.isArray(r.shared) ? { share: r.shared } : {}),
    predicates: (r.predicates ?? []).map((p): PredicateRequest => (
      p.op === 'in'
        ? { field: p.field, op: 'in', set: p.set ?? [] }
        : { field: p.field, op: p.op, threshold: p.threshold }
    )),
  };
}

/** A v2 payload's requester block, validated; null when absent or malformed (mirrors the relay). */
function payloadRequester(payload: { requester?: unknown }): PresentationRequester | null {
  const r = payload.requester;
  if (!isRecord(r) || typeof r.id !== 'string' || r.id.length === 0) return null;
  if (r.type === 'domain' && r.address === undefined) return { type: 'domain', id: r.id };
  if (r.type === 'wallet' && typeof r.address === 'string' && ADDRESS_RE.test(r.address)) {
    return { type: 'wallet', id: r.id, address: r.address };
  }
  return null;
}

/** The expectations a verify enforces, after folding in an issued `challenge`. */
interface ResolvedExpectations {
  audience: string;
  challenge: string;
  predicates: readonly PredicateRequest[];
  disclosures: readonly CanonicalDisclosureRequest[];
  presenter?: string;
  deadline?: number;
  requester?: PresentationRequester;
}

/** Fold the `challenge` option into the explicit expectations; explicit values that disagree throw. */
function resolveExpectations(opts: VerifyPresentationOptions): ResolvedExpectations {
  let audience = opts.expectedAudience;
  let challenge = opts.expectedChallenge;
  let predicates: readonly PredicateRequest[] = opts.expectedPredicates ?? [];
  let disclosures: readonly CanonicalDisclosureRequest[] = opts.expectedDisclosures ?? [];
  let presenter = typeof opts.expectedPresenter === 'string' && opts.expectedPresenter.trim().length > 0
    ? opts.expectedPresenter.trim() : undefined;
  let deadline = opts.challengeDeadline;
  let requester = opts.expectedRequester ? normalizeRequester(opts.expectedRequester) : undefined;

  if (opts.challenge !== undefined) {
    const env = parseChallengeEnvelope(opts.challenge);
    if (!env) throw new Error('verifyPresentationToken: the challenge option is not a well-formed challenge');
    let envRequester: PresentationRequester | undefined;
    if (isSignedChallenge(env)) {
      const structural = checkSignedStructure(env);
      if (structural) throw new Error(`verifyPresentationToken: the challenge option is not a valid signed challenge (${structural})`);
      const r = env.requester as EnvelopeRequester;
      envRequester = normalizeRequester({ type: r.type, id: r.id, address: r.address });
    }
    const envPredicates = env.predicates ?? [];
    const envDisclosures = env.disclosures ?? [];
    const explicitDisclosures = opts.expectedDisclosures ?? [];
    const explicitPredicates = opts.expectedPredicates ?? [];
    const envDeadline = typeof env.expiresAt === 'number' && Number.isFinite(env.expiresAt) ? env.expiresAt : undefined;
    const disagree = (audience !== undefined && audience !== env.audience)
      || (challenge !== undefined && challenge !== env.challenge)
      || (explicitPredicates.length > 0 && (explicitPredicates.length !== envPredicates.length
        || !explicitPredicates.every((p) => envPredicates.some((e) => predicateMatchesRequest(e, p)))))
      || (explicitDisclosures.length > 0 && (explicitDisclosures.length !== envDisclosures.length
        || !explicitDisclosures.every((d) => envDisclosures.some((e) => disclosureRequestMatches(e, d)))))
      || (presenter !== undefined && env.presenter !== undefined && presenter.toLowerCase() !== env.presenter.toLowerCase())
      || (deadline !== undefined && envDeadline !== undefined && deadline !== envDeadline)
      || (requester !== undefined && (envRequester === undefined || requesterString(requester) !== requesterString(envRequester)));
    if (disagree) {
      throw new Error('verifyPresentationToken: explicit expectations disagree with the challenge option');
    }
    audience = env.audience;
    challenge = env.challenge;
    predicates = [...envPredicates];
    disclosures = [...envDisclosures];
    if (presenter === undefined && env.presenter !== undefined) presenter = env.presenter;
    if (envDeadline !== undefined) deadline = envDeadline;
    if (envRequester !== undefined) requester = envRequester;
  }
  if (typeof audience !== 'string' || typeof challenge !== 'string') {
    throw new Error('verifyPresentationToken requires expectedAudience and expectedChallenge (or the issued challenge)');
  }
  return { audience, challenge, predicates, disclosures, presenter, deadline, requester };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  try { return disclosureCanonicalJson(a) === disclosureCanonicalJson(b); } catch { return false; }
}

function outputDigestsOf(pricing: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = pricing.output_digests;
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    const h = isRecord(e) && typeof e.hash === 'string' ? e.hash.trim().toLowerCase().replace(/^sha256:/, '').replace(/^0x/, '') : '';
    if (/^[0-9a-f]{64}$/.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * 2026-10-10: check every DISCLOSED record against its two-hop proof — the proof names the same PE
 * and hash, hop 1 rebuilds, the record's action type / time / named digest / fields / artifacts /
 * fact tier equal the ANCHORED act record, the record satisfies its request; hop 2 on Base when a
 * reader is given. Mirrors the relay's `checkDisclosedRecords`.
 */
async function checkDisclosedRecords(
  answers: readonly DisclosureAnswer[],
  proofs: readonly PeFactProof[] | undefined,
  verifyOnChain: ((batchId: string, leaf: string, proof: string[]) => Promise<boolean>) | null,
): Promise<{ refusal: PresentationRefusal | null; onchain: boolean }> {
  const verified = new Set<string>();
  let onchain = false;
  let total = 0;
  for (const a of answers) {
    if (a.election !== 'disclosed') continue;
    for (const record of a.records ?? []) {
      total += 1;
      if (total > DISCLOSURE_RECORDS_MAX_TOTAL) return { refusal: 'disclosure_record_invalid', onchain };
      if (!recordMatchesRequest(record, a.request)) return { refusal: 'disclosure_record_invalid', onchain };
      const proof = (proofs ?? []).find((p) => p.pe_id === record.pe_id);
      if (!proof || typeof proof.envelope_hash !== 'string' || proof.envelope_hash.toLowerCase() !== record.pe_hash) return { refusal: 'disclosure_record_invalid', onchain };
      const leafValue = await meterActAnchoredLeaf(record.pe_hash, proof.leaf);
      if (leafValue === null) return { refusal: 'disclosure_record_invalid', onchain };
      const act = (proof.leaf as { act: { action_type: string; timestamp: number; pricing: Record<string, unknown> } }).act;
      if (act.action_type !== record.action_type || act.timestamp !== record.timestamp) return { refusal: 'disclosure_record_invalid', onchain };
      if (record.output_digest !== undefined && !outputDigestsOf(act.pricing).includes(record.output_digest) && record.output_digest !== record.pe_hash) {
        return { refusal: 'disclosure_record_invalid', onchain };
      }
      const requestedFields = a.request.fields ?? [];
      for (const [path, value] of Object.entries(record.fields ?? {})) {
        if (!requestedFields.includes(path)) return { refusal: 'disclosure_record_invalid', onchain };
        if (!valuesEqual(value, readFieldPath(act.pricing, path))) return { refusal: 'disclosure_record_invalid', onchain };
      }
      const requestedContent: readonly string[] = a.request.content ?? [];
      for (const key of Object.keys(record.content ?? {})) {
        if (!requestedContent.includes(key)) return { refusal: 'disclosure_record_invalid', onchain };
      }
      const c = record.content ?? {};
      if (c.artifacts !== undefined && !valuesEqual(c.artifacts, Array.isArray(act.pricing.output_digests) ? act.pricing.output_digests : [])) {
        return { refusal: 'disclosure_record_invalid', onchain };
      }
      if (c.fact_tier !== undefined && !valuesEqual(c.fact_tier, act)) return { refusal: 'disclosure_record_invalid', onchain };
      if (record.witness.kind === 'chain') {
        const md = (isRecord(act.pricing.metadata) ? act.pricing.metadata : {}) as Record<string, unknown>;
        const ev = (isRecord(md.economic_evidence) ? md.economic_evidence : {}) as Record<string, unknown>;
        const refs = [md.tx_hash, md.txHash, ev.txHash, ev.tx_hash].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
        if (md.verified !== true || record.witness.ref === undefined || !refs.includes(record.witness.ref)) return { refusal: 'disclosure_record_invalid', onchain };
      }
      if (record.witness.kind === 'hardware' && act.pricing.hardware_witness === undefined) return { refusal: 'disclosure_record_invalid', onchain };
      if (verifyOnChain) {
        const batchId = (proof.anchor as { batch_id?: unknown }).batch_id;
        if (typeof batchId !== 'string' || !Array.isArray(proof.merkle_proof)) return { refusal: 'disclosure_record_invalid', onchain };
        const key = `${batchId}:${leafValue}`;
        if (!verified.has(key)) {
          let ok = false;
          try { ok = await verifyOnChain(batchId, leafValue, proof.merkle_proof); } catch { ok = false; }
          if (!ok) return { refusal: 'disclosure_record_invalid', onchain };
          verified.add(key);
        }
        onchain = true;
      }
    }
  }
  return { refusal: null, onchain };
}

/** Structural + freshness + requester-binding + presenter-PoP checks (both tiers). Mirrors the relay's checkCommon. */
async function checkCommon(payload: PresentationPayload, x: ResolvedExpectations, now: number): Promise<PresentationRefusal | null> {
  if (!isRecord(payload)) return 'malformed';
  if (payload.v !== PRESENTATION_VERSION && payload.v !== PRESENTATION_VERSION_SIGNED_CHALLENGE) return 'unsupported_version';
  if (payload.tier !== 'pe_fact' && payload.tier !== 'reputation') return 'malformed';
  if (
    typeof payload.presenter_address !== 'string' || typeof payload.aud !== 'string'
    || typeof payload.chal !== 'string' || typeof payload.iat !== 'number'
    || typeof payload.exp !== 'number' || typeof payload.jti !== 'string'
    || typeof payload.burn_id !== 'string' || !isRecord(payload.presenter_pop)
  ) return 'missing_binding_fields';

  // v2 ⇔ signed challenge: the requester block + deadline are present exactly on v2, and the
  // requester IS the audience (the audience binding the relay enforced at issuance).
  const requester = payloadRequester(payload);
  if (payload.v === PRESENTATION_VERSION_SIGNED_CHALLENGE) {
    if (!requester || !Number.isInteger(payload.chal_exp)) return 'missing_binding_fields';
    if (requester.id !== payload.aud) return 'audience_mismatch';
  } else if ((payload as { requester?: unknown }).requester !== undefined || (payload as { chal_exp?: unknown }).chal_exp !== undefined) {
    return 'malformed';
  }

  if (payload.aud !== x.audience) return 'audience_mismatch';
  if (payload.chal !== x.challenge) return 'challenge_mismatch';
  // A SIGNED challenge requires the v2 presentation naming that requester; a v1 presentation (the
  // signature stripped at /present) is refused, never passed with `requester: null`.
  if (x.requester !== undefined
    && (requester === null || requesterString(requester) !== requesterString(x.requester))) {
    return 'requester_mismatch';
  }
  // The address form is checked here (the presenter address is signed on both tiers). The wallet-id
  // form is checked by `presenterIdMismatch` against a SIGNED subject only — on pe_fact the payload
  // `sub` is outside every signature, so it is matched after the co-sign is verified.
  if (x.presenter !== undefined && ADDRESS_RE.test(x.presenter.toLowerCase())
    && payload.presenter_address.toLowerCase() !== x.presenter.toLowerCase()) {
    return 'presenter_mismatch';
  }

  const skew = PRESENTATION_CLOCK_SKEW_SECONDS;
  if (payload.iat > now + skew) return 'not_yet_valid';
  if (payload.exp <= now - skew) return 'expired';
  if (payload.exp - payload.iat > PRESENTATION_MAX_TTL_SECONDS) return 'window_too_long';
  // The challenge deadline: the signed `chal_exp` (v2) and/or the requester's own deadline. Every
  // deadline in force must hold at verify time, and the presentation must have been issued by it.
  for (const deadline of [payload.chal_exp, x.deadline]) {
    if (typeof deadline !== 'number') continue;
    if (now > deadline + skew || payload.iat > deadline + skew) return 'challenge_expired';
  }

  const answered = payload.tier === 'reputation' ? parseDisclosureAnswers(payload.disclosures) : [];
  if (answered === null) return 'disclosure_record_invalid';
  const digest = payload.tier === 'pe_fact'
    ? claimsDigest({ tier: 'pe_fact', peFacts: (payload.pe_facts ?? []).map((f) => ({ peId: f.pe_id, envelopeHash: f.envelope_hash })) })
    : claimsDigest({ tier: 'reputation', directive: reputationDirective(payload), ...(answered.length > 0 ? { disclosures: answered } : {}) });
  const binding = presentationBindingString({
    tier: payload.tier, presenterAddress: payload.presenter_address, aud: payload.aud,
    chal: payload.chal, iat: payload.iat, exp: payload.exp, jti: payload.jti,
    burnId: payload.burn_id, claimsDigest: digest,
    ...(payload.v === PRESENTATION_VERSION_SIGNED_CHALLENGE && requester ? { requester, chalExp: payload.chal_exp as number } : {}),
  });
  if (!(await verifyPresenterPop(binding, payload.presenter_pop, payload.presenter_address))) return 'bad_presenter_pop';
  return null;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Tier-independent failure codes for a Provian compact JWS; each caller maps to a
 *  tier-prefixed {@link PresentationRefusal}. Mirrors the backend's verify.ts. */
type JwsCode = 'malformed' | 'unsupported_alg' | 'wrong_typ' | 'unknown_kid' | 'bad_signature' | 'issuer_mismatch';

/** Verify a Provian compact JWS (EdDSA) against the JWKS and the EXACT `expectedTyp`,
 *  returning the decoded payload. ONE crypto path behind both the reputation JWS and
 *  the pe_fact co-sign — so they cannot drift, while `expectedTyp` keeps them
 *  un-cross-confusable (a reputation JWS is `wrong_typ` as a pe_fact co-sign). */
function verifyProvianCompactJws(
  jws: string,
  keys: readonly PresentationJwk[],
  expectedTyp: string,
): { ok: true; payload: Record<string, unknown> } | { ok: false; code: JwsCode } {
  const parts = jws.split('.');
  if (parts.length !== 3) return { ok: false, code: 'malformed' };
  const [h, p, s] = parts;
  if (!BASE64URL.test(h) || !BASE64URL.test(p) || !BASE64URL.test(s)) return { ok: false, code: 'malformed' };
  let header: unknown;
  try { header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')); } catch { return { ok: false, code: 'malformed' }; }
  if (!isRecord(header)) return { ok: false, code: 'malformed' };
  if (header.alg !== 'EdDSA') return { ok: false, code: 'unsupported_alg' };
  if (header.typ !== expectedTyp) return { ok: false, code: 'wrong_typ' };
  if ('crit' in header) return { ok: false, code: 'unsupported_alg' };
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0) return { ok: false, code: 'unknown_kid' };
  const key = keys.find((k) => k.kid === kid);
  if (!key || !key.x) return { ok: false, code: 'unknown_kid' };
  const signature = Buffer.from(s, 'base64url');
  if (signature.length !== 64) return { ok: false, code: 'bad_signature' };
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(`${h}.${p}`, 'utf8'), pub, signature);
  } catch { ok = false; }
  if (!ok) return { ok: false, code: 'bad_signature' };
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return { ok: false, code: 'malformed' }; }
  if (!isRecord(payload)) return { ok: false, code: 'malformed' };
  if (payload.iss !== PRESENTATION_ISSUER) return { ok: false, code: 'issuer_mismatch' };
  return { ok: true, payload };
}

const REPUTATION_JWS_REASON: Record<JwsCode, PresentationRefusal> = {
  malformed: 'reputation_jws_malformed', unsupported_alg: 'reputation_jws_unsupported_alg',
  wrong_typ: 'reputation_jws_wrong_typ', unknown_kid: 'reputation_jws_unknown_kid',
  bad_signature: 'reputation_jws_bad_signature', issuer_mismatch: 'reputation_jws_issuer_mismatch',
};

const PEFACT_COSIGN_REASON: Record<JwsCode, PresentationRefusal> = {
  malformed: 'pe_fact_cosign_malformed', unsupported_alg: 'pe_fact_cosign_unsupported_alg',
  wrong_typ: 'pe_fact_cosign_wrong_typ', unknown_kid: 'pe_fact_cosign_unknown_kid',
  bad_signature: 'pe_fact_cosign_bad_signature', issuer_mismatch: 'pe_fact_cosign_issuer_mismatch',
};

/** Verify a reputation compact JWS against the Provian JWKS and return its payload. */
function verifyReputationJws(jws: string, keys: readonly PresentationJwk[]): { ok: true; payload: PresentationPayload } | { ok: false; reason: PresentationRefusal } {
  const r = verifyProvianCompactJws(jws, keys, PRESENTATION_TYP);
  if (!r.ok) return { ok: false, reason: REPUTATION_JWS_REASON[r.code] };
  return { ok: true, payload: r.payload as unknown as PresentationPayload };
}

/** Bind a verified pe_fact CO-SIGN to the presentation it must belong to (mirrors
 *  the backend). The co-sign is already proven authentic; this checks it was minted
 *  for THIS presenter, burn, window, jti, and claim set. Returns a refusal reason
 *  on mismatch, or null when the co-sign binds. */
function checkPeFactCosignBinding(
  cosign: Record<string, unknown>,
  payload: PresentationPayload,
  claims: readonly PeFactClaim[],
): PresentationRefusal | null {
  if (cosign.ctx !== 'pe_fact_cosign') return 'pe_fact_cosign_payload_mismatch';
  if (typeof cosign.presenter_address !== 'string'
    || cosign.presenter_address.toLowerCase() !== payload.presenter_address.toLowerCase()) return 'pe_fact_cosign_payload_mismatch';
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
    const cr = isRecord(cosign.requester) ? payloadRequester({ requester: cosign.requester }) : null;
    if (!pr || !cr || requesterString(pr) !== requesterString(cr)) return 'pe_fact_cosign_payload_mismatch';
    if (cosign.chal_exp !== payload.chal_exp) return 'pe_fact_cosign_payload_mismatch';
  } else if (cosign.requester !== undefined || cosign.chal_exp !== undefined) {
    return 'pe_fact_cosign_payload_mismatch';
  }
  const cf = cosign.pe_facts;
  if (!Array.isArray(cf)) return 'pe_fact_cosign_payload_mismatch';
  for (const f of cf) {
    if (!isRecord(f) || typeof f.pe_id !== 'string' || typeof f.envelope_hash !== 'string') return 'pe_fact_cosign_payload_mismatch';
  }
  const toDigestInput = (fs: readonly { pe_id: string; envelope_hash: string }[]) =>
    claimsDigest({ tier: 'pe_fact', peFacts: fs.map((f) => ({ peId: f.pe_id, envelopeHash: f.envelope_hash })) });
  if (toDigestInput(cf as { pe_id: string; envelope_hash: string }[]) !== toDigestInput(claims)) {
    return 'pe_fact_cosign_payload_mismatch';
  }
  return null;
}

/** The module-level default seen-store (in-memory, TTL-pruned) behind `acceptOnce`. */
const DEFAULT_SEEN_STORE: PresentationSeenStore = createMemorySeenStore();

/** The shared result fields every valid verify carries. */
/**
 * The wallet-id form of an expected presenter, matched against a subject some signature covers (the
 * reputation JWS payload's `sub`; on pe_fact the Provian co-sign's `sub`). A pe_fact co-sign issued
 * before the subject binding carries no signed subject and can never satisfy a wallet-id check.
 */
function presenterIdMismatch(x: ResolvedExpectations, verifiedSub: string | null): PresentationRefusal | null {
  const want = x.presenter;
  if (want === undefined || ADDRESS_RE.test(want.toLowerCase())) return null;
  return verifiedSub !== null && verifiedSub === want ? null : 'presenter_mismatch';
}

function resultIdentity(payload: PresentationPayload, x: ResolvedExpectations, verifiedSub: string | null): {
  presentationId: string; presenterAddress: string; sub: string | null;
  requester: PresentationRequester | null; challengeExpiresAt: number | null;
} {
  return {
    presentationId: payload.burn_id,
    presenterAddress: payload.presenter_address,
    sub: verifiedSub,
    requester: payloadRequester(payload),
    challengeExpiresAt: typeof payload.chal_exp === 'number' ? payload.chal_exp : (x.deadline ?? null),
  };
}

/** Accept-once (item 6): claim the presentation id ONLY after every other check passed. */
async function claimOnce(payload: PresentationPayload, opts: VerifyPresentationOptions, now: number): Promise<PresentationRefusal | null> {
  if (opts.acceptOnce === false) return null;
  const store = opts.seenStore ?? DEFAULT_SEEN_STORE;
  let fresh: boolean;
  try {
    // Remember it for as long as it could still verify (exp + skew); after that it is `expired`.
    fresh = await store.claim(payload.burn_id, payload.exp + PRESENTATION_CLOCK_SKEW_SECONDS, now);
  } catch {
    return 'seen_store_unavailable';
  }
  return fresh ? null : 'replayed';
}

/**
 * Verify a presentation (token string OR structured object) against the challenge
 * + audience the requester issued. Trustless: reputation via the fetched JWKS,
 * pe_fact via the presenter signature + Provian co-sign + on-chain anchor proofs
 * (required by default —). Mirrors the relay verify contract (spec C): v1 | v2
 * payloads, signed-challenge deadline, requester + presenter binding, predicate gate needs
 * the reputation tier, and — SDK only — each presentation is accepted ONCE (`replayed`).
 */
export async function verifyPresentationToken(
  input: string | Presentation,
  opts: VerifyPresentationOptions,
): Promise<VerifyPresentationResult> {
  const presentation = typeof input === 'string' ? decodePresentationToken(input) : input;
  if (!presentation || !isRecord(presentation) || (presentation.tier !== 'pe_fact' && presentation.tier !== 'reputation')) {
    return { valid: false, reason: 'malformed' };
  }
  const x = resolveExpectations(opts);
  // item 1: a verify that names predicates is a PREDICATE GATE, and only the reputation tier
  // answers predicates. Refused before any crypto work.
  if (x.predicates.length > 0 && presentation.tier !== 'reputation') {
    return { valid: false, reason: 'predicates_require_reputation_tier' };
  }
  if (x.disclosures.length > 0 && presentation.tier !== 'reputation') {
    return { valid: false, reason: 'disclosures_require_reputation_tier' };
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (presentation.tier === 'reputation') {
    if (typeof presentation.provian_jws !== 'string' || presentation.provian_jws.length === 0) {
      return { valid: false, reason: 'reputation_not_signed' };
    }
    let keys = opts.jwks;
    if (!keys) {
      keys = await fetchJwks(opts).catch(() => undefined);
      if (!keys) return { valid: false, reason: 'reputation_jwks_unavailable' };
    }
    const jws = verifyReputationJws(presentation.provian_jws, keys);
    if (!jws.ok) return { valid: false, reason: jws.reason };
    const payload = jws.payload;
    if (payload.tier !== 'reputation') return { valid: false, reason: 'tier_mismatch' };
    const common = await checkCommon(payload, x, now);
    if (common) return { valid: false, reason: common };
    const repSub = typeof payload.sub === 'string' ? payload.sub : null;
    const repPresenter = presenterIdMismatch(x, repSub);
    if (repPresenter) return { valid: false, reason: repPresenter };
    const answered = payload.reputation?.predicates ?? [];
    for (const req of x.predicates) {
      const hit = answered.some((a) => predicateMatchesRequest(
        a.op === 'in' ? { field: a.field, op: 'in', set: a.set ?? [] } : { field: a.field, op: a.op, threshold: a.threshold },
        req,
      ));
      if (!hit) return { valid: false, reason: 'predicates_unanswered' };
    }
    // Standing is never withheld: refused before the seen-store claim, so a refused token burns no slot.
    const repFacts = payload.reputation?.facts;
    if (STANDING_ALWAYS_PRESENT_FIELDS.some((f) => !repFacts || typeof repFacts[f] !== 'number')) {
      return { valid: false, reason: 'standing_withheld' };
    }
    // 2026-10-10: every named disclosure request answered; every disclosed record proven against its
    // anchored act record — and on Base, through the pinned PEAnchor, unless the caller opted out.
    const disclosures = parseDisclosureAnswers(payload.disclosures) ?? [];
    for (const req of x.disclosures) {
      if (!disclosures.some((a) => disclosureRequestMatches(a.request, req))) return { valid: false, reason: 'disclosures_unanswered' };
    }
    let disclosureOnchain = false;
    if (disclosures.length > 0) {
      const requireOnchain = opts.requireOnchain !== false;
      const rpcUrl = opts.rpcUrl ?? (requireOnchain ? DEFAULT_BASE_RPC_URL : undefined);
      const anchorAddress = opts.peAnchorAddress ?? PROVIAN_BASE_PE_ANCHOR;
      const onchain = rpcUrl
        ? async (batchId: string, leaf: string, proof: string[]): Promise<boolean> => (await verifyProofsOnchain(
          [{ pe_id: '', envelope_hash: '', anchored: true, anchor: { batch_id: batchId }, leaf: { leaf_value: leaf }, merkle_proof: proof }],
          rpcUrl, anchorAddress, opts.fetchFn,
        )) === null
        : null;
      const checked = await checkDisclosedRecords(disclosures, presentation.disclosure_proofs, onchain);
      if (checked.refusal) return { valid: false, reason: checked.refusal };
      const hasRecords = disclosures.some((a) => a.election === 'disclosed' && (a.records ?? []).length > 0);
      if (requireOnchain && hasRecords && !checked.onchain) return { valid: false, reason: 'pe_fact_onchain_unchecked' };
      disclosureOnchain = checked.onchain;
    }
    const replay = await claimOnce(payload, opts, now);
    if (replay) return { valid: false, reason: replay };
    const facts = payload.reputation?.facts ?? {};
    const standing: Record<string, number> = {};
    for (const [k, v] of Object.entries(facts)) if (k.startsWith('standing.')) standing[k] = v;
    return {
      valid: true, tier: 'reputation', payload, onchainChecked: disclosureOnchain, ...resultIdentity(payload, x, repSub),
      predicates: [...answered], standing, disclosed: { ...facts },
      ...(disclosures.length > 0 ? { disclosures } : {}),
    };
  }

  // pe_fact
  const payload = presentation.payload;
  if (!isRecord(payload) || payload.tier !== 'pe_fact') return { valid: false, reason: 'tier_mismatch' };
  const common = await checkCommon(payload, x, now);
  if (common) return { valid: false, reason: common };

  const claims = payload.pe_facts ?? [];
  // Mirror the relay's issuance minimum: a pe_fact with zero claims proves nothing.
  if (claims.length === 0) return { valid: false, reason: 'pe_fact_no_claims' };

  // REQUIRE + verify the Provian CO-SIGN. It is what proves — off the chain — that
  // a burn was consumed and the cited PEs belong to this presenter. Without it, a
  // self-issued pe_fact citing anyone's public anchored PEs would verify (F61).
  if (typeof presentation.provian_jws !== 'string' || presentation.provian_jws.length === 0) {
    return { valid: false, reason: 'pe_fact_not_cosigned' };
  }
  let cosignKeys = opts.jwks;
  if (!cosignKeys) {
    cosignKeys = await fetchJwks(opts).catch(() => undefined);
    if (!cosignKeys) return { valid: false, reason: 'pe_fact_cosign_jwks_unavailable' };
  }
  const cosign = verifyProvianCompactJws(presentation.provian_jws, cosignKeys, PRESENTATION_PEFACT_TYP);
  if (!cosign.ok) return { valid: false, reason: PEFACT_COSIGN_REASON[cosign.code] };
  const cosignMismatch = checkPeFactCosignBinding(cosign.payload, payload, claims);
  if (cosignMismatch) return { valid: false, reason: cosignMismatch };
  // The pe_fact subject is only what Provian co-signed : never the bare payload `sub`.
  const peFactSub = typeof cosign.payload.sub === 'string' ? cosign.payload.sub : null;
  const peFactPresenter = presenterIdMismatch(x, peFactSub);
  if (peFactPresenter) return { valid: false, reason: peFactPresenter };

  const proofs = presentation.proofs ?? [];
  if (proofs.length === 0) return { valid: false, reason: 'pe_fact_no_proofs' };
  for (const claim of claims) {
    const proof = proofs.find((pr) => pr.pe_id === claim.pe_id);
    if (!proof || proof.envelope_hash.toLowerCase() !== claim.envelope_hash.toLowerCase()) {
      return { valid: false, reason: 'pe_fact_claim_proof_mismatch' };
    }
  }

  // Bind each embedded leaf to its CLAIMED envelope hash — offline, no chain
  // needed. `verifyPE` only proves a leaf is in the anchored tree; without this a
  // presenter could carry a genuine anchored leaf (from any real PE) while
  // claiming a different `envelope_hash`. Recompute the leaf and require equality.
  for (const proof of proofs) {
    if (isRecord(proof.leaf) && proof.leaf.kind === 'meter_act') {
      // PE METER: the leaf is the batch leaf of the batch that carried the claimed PE's act.
      if ((await meterActAnchoredLeaf(proof.envelope_hash, proof.leaf)) === null) return { valid: false, reason: 'pe_fact_leaf_mismatch' };
      continue;
    }
    const expectedLeaf = await leafFromEnvelopeHash(proof.envelope_hash);
    const leafValue = (proof.leaf as { leaf_value?: unknown }).leaf_value;
    if (!expectedLeaf || typeof leafValue !== 'string' || leafValue.toLowerCase() !== expectedLeaf) {
      return { valid: false, reason: 'pe_fact_leaf_mismatch' };
    }
  }

  // item 3: the on-chain PEAnchor check is REQUIRED by default, through the canonical Base
  // RPC unless the caller names its own. Only an explicit `requireOnchain: false` skips it.
  const requireOnchain = opts.requireOnchain !== false;
  const rpcUrl = opts.rpcUrl ?? (requireOnchain ? DEFAULT_BASE_RPC_URL : undefined);
  let onchainChecked = false;
  if (rpcUrl) {
    const anchorAddress = opts.peAnchorAddress ?? PROVIAN_BASE_PE_ANCHOR;
    const reason = await verifyProofsOnchain(proofs, rpcUrl, anchorAddress, opts.fetchFn);
    if (reason) return { valid: false, reason };
    onchainChecked = proofs.length > 0;
  }
  // requireOnchain refuses whenever the on-chain check did not actually run over
  // >=1 proof, so it can never return valid:true with onchainChecked:false.
  if (requireOnchain && !onchainChecked) return { valid: false, reason: 'pe_fact_onchain_unchecked' };
  const replay = await claimOnce(payload, opts, now);
  if (replay) return { valid: false, reason: replay };
  return { valid: true, tier: 'pe_fact', payload, onchainChecked, ...resultIdentity(payload, x, peFactSub) };
}

async function fetchJwks(opts: VerifyPresentationOptions): Promise<PresentationJwk[]> {
  const url = opts.jwksUrl ?? DEFAULT_PROVIAN_JWKS_URL;
  const f = guardedFetcher(opts.fetchFn);
  const res = await f(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`jwks fetch failed (${res.status})`);
  const body = (await res.json()) as { keys?: PresentationJwk[] };
  if (!Array.isArray(body.keys)) throw new Error('jwks response missing keys');
  return body.keys;
}

/**
 * Verify each embedded anchor proof against the on-chain PEAnchor root (Base RPC).
 * The verifier target is PINNED to `anchorAddress` — the presentation's own
 * `anchor.contract_address` is NEVER used as the call target; if it is present and
 * names a different contract the proof is refused (`pe_fact_anchor_untrusted`), so
 * a presenter cannot substitute a contract of its own that returns `true`.
 * Returns null on success, or a refusal reason on the first failing proof.
 */
async function verifyProofsOnchain(
  proofs: PeFactProof[],
  rpcUrl: string,
  anchorAddress: string,
  _fetchFn?: typeof fetch,
): Promise<PresentationRefusal | null> {
  const { createPublicClient, http } = await import('viem');
  const client = createPublicClient({ transport: http(rpcUrl, { fetchFn: guardedFetcher(_fetchFn) }) });
  const pinned = anchorAddress.toLowerCase();
  const abi = [{
    type: 'function', name: 'verifyPE', stateMutability: 'view',
    inputs: [{ name: 'batchId', type: 'bytes32' }, { name: 'peHash', type: 'bytes32' }, { name: 'proof', type: 'bytes32[]' }],
    outputs: [{ name: '', type: 'bool' }],
  }] as const;
  for (const proof of proofs) {
    const batchId = (proof.anchor as { batch_id?: unknown }).batch_id;
    const leafValue = (proof.leaf as { leaf_value?: unknown }).leaf_value;
    const claimedContract = (proof.anchor as { contract_address?: unknown }).contract_address;
    if (typeof batchId !== 'string' || typeof leafValue !== 'string' || !Array.isArray(proof.merkle_proof)) {
      return 'pe_fact_proof_onchain_invalid';
    }
    // Refuse a proof that names a verifier other than the pinned PEAnchor.
    if (typeof claimedContract === 'string' && claimedContract.toLowerCase() !== pinned) {
      return 'pe_fact_anchor_untrusted';
    }
    try {
      const ok = await client.readContract({
        address: pinned as `0x${string}`,
        abi,
        functionName: 'verifyPE',
        args: [batchId as `0x${string}`, leafValue as `0x${string}`, proof.merkle_proof as `0x${string}`[]],
      });
      if (ok !== true) return 'pe_fact_proof_onchain_invalid';
    } catch {
      return 'pe_fact_proof_onchain_invalid';
    }
  }
  return null;
}
