/**
 * Burn-to-present — the cryptographic core (types + canonical binding).
 *
 * A PRESENTATION is a signed, requester-bound, fresh, single-use disclosure a
 * presenter produces by burning PVT. It comes in two tiers:
 *
 *  - PE-FACT: claims about the presenter's provenance envelopes and their
 *    anchored on-chain history. PRESENTER-SIGNED, chain-anchored, AND Provian
 *    co-signed. The embedded Merkle inclusion proofs verify against the deployed
 *    PEAnchor on Base (the chain proves the PEs exist and are anchored), the
 *    presenter's own signature proves live-key possession + requester binding,
 *    and a Provian JWS co-signature (a DISTINCT `typ`, same key/JWKS as the
 *    reputation tier) proves the two things the chain cannot: that a PVT burn was
 *    consumed and that the cited PEs belong to THIS presenter. All three are
 *    REQUIRED at every verifier — no Provian ACCOUNT is needed (a fetched JWKS
 *    verifies the co-sign offline), but the Provian co-sign itself is not optional.
 *
 *  - REPUTATION: scores/standing/history-derived claims. PROVIAN-ATTESTED at
 *    issuance as a compact JWS (EdDSA), fresh when issued, requester-bound.
 *    Supports selective disclosure: reveal-all-minus-redactions plus derived
 *    predicates (e.g. score-above-threshold) in place of a raw value.
 *
 * BOTH tiers bind to a requester-supplied `challenge` and `audience`, carry a
 * bounded validity window, and are single-use (each consumes exactly one verified
 * on-chain PVT burn through the GLOBAL single-use `burn_consumptions` ledger). In
 * BOTH tiers the presenter signs the SAME canonical binding string with their own
 * live key (proof of possession at presentation time), and in BOTH tiers Provian
 * signs a JWS with its own key at issuance. The JWS differs by tier: for
 * reputation it carries the disclosed scores (Provian attests the values); for
 * pe_fact it is a CO-SIGN over {presenter_address, burn_id, pe_facts, jti, iat,
 * exp} under a DISTINCT `typ` (Provian attests that the burn was consumed and the
 * PEs are owned, which the chain cannot show). The tiers no longer differ in
 * WHETHER Provian signs — only in WHAT the signature attests.
 *
 * WIRE FORMAT is the compact-JWS convention the (previously unwired) Provian
 * attestation signer defines (`src/core/attestation/attestation.ts` at repo root,
 * verified by `commerce-attestation.ts`): EdDSA / Ed25519, header
 * `{ alg, kid, typ }`, Provian issuer. The reputation authenticity IS such a JWS.
 * Human/agent symmetry: a human signs the binding with their wallet key (EIP-191);
 * an agent signs it with its sovereign secp256k1 key (ECDSA-SHA256). Same primitive.
 */

import { createHash } from 'crypto';
import { disclosureCommitmentDigest, type DisclosureAnswer } from './disclosure-request';

/** Provian issuer stamped into a reputation-tier presentation. */
export const PRESENTATION_ISSUER = 'https://provian.ai';

/** JWS `typ` header for a REPUTATION-tier presentation (distinct from the commerce
 *  attestation `provian-attestation+jwt`, so the two can never be cross-confused
 *  even though they share the same Ed25519 signing key). */
export const PRESENTATION_TYP = 'provian-presentation+jwt';

/** JWS `typ` header for the PE-FACT Provian CO-SIGN. Deliberately DISTINCT from
 *  the reputation `typ` and the commerce-attestation `typ`, all three sharing the
 *  one Ed25519 key: a reputation JWS can never be replayed as a pe_fact co-sign or
 *  vice-versa, because each verifier pins the exact `typ` it accepts. */
export const PRESENTATION_PEFACT_TYP = 'provian-presentation-pefact+jwt';

/** Binding-string domain tag. Version-pinned so a format change is a new tag. */
export const PRESENTATION_BINDING_TAG = 'provian-presentation-v1';
/** Binding tag for a presentation produced against a SIGNED challenge : the v1 lines plus
 * `req=<type>:<id>` and `chal_exp=<n>`, so the presenter's signature commits to the verified
 * requester identity and the challenge deadline. */
export const PRESENTATION_BINDING_TAG_V2 = 'provian-presentation-v2';

/** Payload format version (unsigned challenge). */
export const PRESENTATION_VERSION = 1 as const;
/** Payload format version for a presentation produced against a SIGNED challenge. */
export const PRESENTATION_VERSION_SIGNED_CHALLENGE = 2 as const;
export type PresentationVersion = typeof PRESENTATION_VERSION | typeof PRESENTATION_VERSION_SIGNED_CHALLENGE;

/** The verified requester identity a v2 presentation is addressed to (`aud` === `id`). */
export interface PresentationRequester {
  readonly type: 'domain' | 'wallet';
  /** domain: the hostname. wallet: the Provian wallet id. */
  readonly id: string;
  /** wallet only: the wallet's lowercase EVM address (Provian-attested). */
  readonly address?: string;
}

/** Canonical requester string — the `req=` line of the challenge signing string and the v2 binding. */
export function requesterString(r: { type: 'domain' | 'wallet'; id: string; address?: string }): string {
  return r.type === 'wallet' ? `wallet:${r.id}:${(r.address ?? '').toLowerCase()}` : `domain:${r.id}`;
}

/** Normalized requester object for a payload / co-sign (wallet keeps its address, domain has none). */
export function normalizeRequester(r: PresentationRequester): PresentationRequester {
  return r.type === 'wallet'
    ? { type: 'wallet', id: r.id, address: (r.address ?? '').toLowerCase() }
    : { type: 'domain', id: r.id };
}

/** Validity-window bounds (seconds). A presentation is fresh and short-lived: the
 *  presenter may request any window inside [MIN, MAX]; the server clamps/validates.
 *  Default mirrors the attestation TTL (300s). */
export const PRESENTATION_MIN_TTL_SECONDS = 60;
export const PRESENTATION_MAX_TTL_SECONDS = 900;
export const PRESENTATION_DEFAULT_TTL_SECONDS = 300;

/** Max pe_fact claims (and embedded proofs) per presentation. Enforced at BOTH
 *  issuance (service.ts) and verification (verify.ts) — the verifier must not
 *  trust that a presentation it receives was produced by our issuer, so it
 *  re-checks this bound before doing any per-proof on-chain call (F5/F52/F58).
 *  Lives here (the leaf module) so both sides import ONE literal — no redeclared
 *  copy that could drift. */
export const MAX_PE_FACT_CLAIMS = 50;

/** Clock-skew tolerance for iat/exp checks (seconds). */
export const PRESENTATION_CLOCK_SKEW_SECONDS = 60;

/** Requester-supplied challenge bounds — an opaque nonce the requester generates.
 *  Long enough to be unguessable, capped so it can't be abused as a data channel. */
export const PRESENTATION_CHALLENGE_MIN_LEN = 16;
export const PRESENTATION_CHALLENGE_MAX_LEN = 512;
export const PRESENTATION_AUDIENCE_MAX_LEN = 512;

/**
 * Firestore collection for recorded presentations (the burn→present ledger the
 * rail handshake and the Commons aggregates read). Defined HERE, in the light
 * types module, not in the heavy `service.ts` — so a lightweight reader (rail
 * handshake, presentation-activity, standing-export) can import the collection
 * name without transitively loading the presentation-production + PE-anchor
 * chain. Pulling that chain into an unrelated module graph is what regressed the
 * genesis-rollback suite (a load-order cycle at the init of the since-deleted
 * PVTv8 minting engine). `service.ts` re-exports this for its existing importers.
 */
export const COMMONS_PRESENTATIONS_COLLECTION = 'commons_presentations';

export type PresentationTier = 'pe_fact' | 'reputation';

/** How the presenter proved possession of their own live key over the binding. */
export type PresenterPopScheme =
  | 'ecdsa_sha256_secp256k1' // agent: node crypto.createSign('SHA256') / DER sig, verified by verifyEcdsaSha256
  | 'eip191_secp256k1'; // human: EIP-191 personal_sign, verified by ethers.verifyMessage

export interface PresenterPop {
  readonly scheme: PresenterPopScheme;
  /** Hex signature over `presentationBindingString(payload)`. DER for ECDSA;
   *  0x r||s||v (65 bytes) for EIP-191. */
  readonly signature: string;
  /** Agent only: the 64-byte uncompressed secp256k1 public key (128 hex, no
   *  0x/04 prefix) the signature verifies under. Absent for EIP-191 (the address
   *  is recovered from the signature). */
  readonly pubkey?: string;
}

/** A single PE-fact claim (the claim; the chain proof rides in `proofs`). */
export interface PeFactClaim {
  readonly pe_id: string;
  readonly envelope_hash: string;
}

/** The embedded anchor inclusion proof for one PE-fact claim, self-verifying
 *  against the on-chain PEAnchor root (Provian is not needed to check it). The
 *  shape mirrors GET /v1/pe/:pe_id/proof so an existing verifier reproduces it. */
export interface PeFactProof {
  readonly pe_id: string;
  readonly envelope_hash: string;
  readonly anchored: true;
  readonly anchor: Record<string, unknown>;
  readonly leaf: Record<string, unknown>;
  readonly merkle_proof: string[];
  readonly aggregate?: Record<string, unknown>;
  readonly verification: Record<string, unknown>;
}

/** The predicate operators a requester can name (§2.6): five comparisons + set membership. */
export const PREDICATE_OPS = ['gte', 'gt', 'lte', 'lt', 'eq', 'in'] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];
/** The most values a set-membership predicate may name. */
export const PREDICATE_SET_MAX = 64;

/** A derived predicate disclosed with its result. `threshold` for the comparisons, `set` for `in`. */
export interface ReputationPredicate {
  readonly field: string;
  readonly op: PredicateOp;
  readonly threshold?: number;
  readonly set?: readonly number[];
  readonly result: boolean;
}

/** The disclosed reputation block: full facts EXCEPT redactions, plus predicates. */
export interface ReputationDisclosure {
  /** Fields disclosed with their raw value (full minus redactions minus
   *  predicate-only fields). */
  readonly facts: Record<string, number>;
  /** Derived predicates the presenter chose in place of raw values. */
  readonly predicates: ReputationPredicate[];
  /** Field names the presenter explicitly withheld (for verifier transparency). */
  readonly redacted: string[];
  /** Share-only mode : the non-standing fields the presenter chose to reveal; every other
   * raw fact was withheld. Absent on a reveal-minus-redactions presentation. */
  readonly shared?: string[];
}

export interface PresentationPayload {
  readonly v: PresentationVersion;
  readonly tier: PresentationTier;
  /** Reputation: the Provian issuer. PE-fact: the presenter's own address
   *  (self-issued — Provian is not the attester). */
  readonly iss: string;
  /** Presenter identity handle (agent wallet id or human wallet id). */
  readonly sub: string;
  /** The presenter's first-party / sovereign EVM address (lowercased 0x…). */
  readonly presenter_address: string;
  /** Requester (audience) — requester-supplied. */
  readonly aud: string;
  /** Requester-supplied challenge (their fresh nonce). */
  readonly chal: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  /** The verified on-chain PVT burn this presentation consumed (audit + the
   *  chain-verifiable proof that a real burn backs this presentation). */
  readonly burn_id: string;
  /** The presenter's proof of live key possession over the binding. Present in
   *  BOTH tiers. For pe_fact it IS the authenticity; for reputation it is
   *  live-possession evidence carried under Provian's JWS. */
  readonly presenter_pop: PresenterPop;
  /** PE-fact tier claims. */
  readonly pe_facts?: PeFactClaim[];
  /** Reputation tier disclosure. */
  readonly reputation?: ReputationDisclosure;
  /** Requester-named disclosures (2026-10-10): one answer per request the signed challenge named —
   *  elected `disclosed` (with the relay-verified records) or `declined`. Reputation tier only, so
   *  Standing is always beside it. Covered by the Provian JWS; the presenter's PoP commits to the
   *  elections and record identities (`disclosureCommitmentDigest`). */
  readonly disclosures?: readonly DisclosureAnswer[];
  /** v2 only: the signed challenge's deadline (unix seconds). Enforced at every verify. */
  readonly chal_exp?: number;
  /** v2 only: the requester identity the relay verified at issuance (`id` === `aud`). */
  readonly requester?: PresentationRequester;
}

/** A produced presentation (structured; also serializable to an opaque token). */
export interface Presentation {
  readonly tier: PresentationTier;
  readonly payload: PresentationPayload;
  /** The compact JWS (Provian EdDSA). Present in BOTH tiers and REQUIRED at every
   *  verifier. Reputation: over the exact payload bytes (`typ` PRESENTATION_TYP) —
   *  Provian attests the disclosed scores. PE-fact: the CO-SIGN over the canonical
   *  {@link PeFactCosignPayload} (`typ` PRESENTATION_PEFACT_TYP) — Provian attests
   *  the burn was consumed and the cited PEs are owned by the presenter. Verified
   *  via the Provian JWKS (no account needed). */
  readonly provian_jws?: string;
  /** PE-fact only: the embedded anchor inclusion proofs, one per claim. */
  readonly proofs?: PeFactProof[];
  /** Reputation tier with disclosures: one two-hop proof per DISCLOSED record, so a verifier checks
   *  every disclosed field against the anchored act record and the chain. */
  readonly disclosure_proofs?: PeFactProof[];
}

/**
 * The canonical payload of the PE-FACT Provian CO-SIGN JWS. Provian signs this at
 * issuance — where ownership and burn consumption are already enforced — so a
 * verifier that checks it learns the two facts the chain and the presenter
 * signature cannot prove on their own: a real burn was consumed (`burn_id`) and
 * the cited PEs belong to `presenter_address`. Bound to `jti`/`iat`/`exp` so the
 * co-sign is pinned to exactly one presentation and window; a co-sign minted for
 * one presentation can never be lifted onto another.
 */
export interface PeFactCosignPayload {
  readonly v: PresentationVersion;
  /** The Provian issuer — mirrors the reputation JWS `iss`. */
  readonly iss: string;
  /** In-payload context tag (defense-in-depth beside the header `typ`). */
  readonly ctx: 'pe_fact_cosign';
  /** The presenter the co-sign vouches for (lowercased 0x…). */
  readonly presenter_address: string;
  /** The verified on-chain PVT burn this presentation consumed. */
  readonly burn_id: string;
  /** The exact PE-fact claims Provian confirmed the presenter owns + anchored. */
  readonly pe_facts: PeFactClaim[];
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  /** review: the presenter's wallet id, so a wallet-id presenter check has a signed subject.
   * Absent on co-signs issued before it (those can never satisfy a wallet-id check). */
  readonly sub?: string;
  /** v2 only: the signed challenge's deadline. */
  readonly chal_exp?: number;
  /** v2 only: the verified requester identity. */
  readonly requester?: PresentationRequester;
}

/**
 * Build the canonical PE-fact co-sign payload. ONE builder used by the signer (at
 * issuance) — the verifier never re-serializes it, it decodes the JWS and compares
 * the decoded fields to the presentation, so there is no canonicalization to drift.
 * Lowercases `presenter_address` and every `envelope_hash` so the verifier's
 * claims-digest comparison is case-stable.
 */
export function buildPeFactCosignPayload(fields: {
  presenter_address: string;
  burn_id: string;
  pe_facts: readonly PeFactClaim[];
  jti: string;
  iat: number;
  exp: number;
  sub?: string;
  chal_exp?: number;
  requester?: PresentationRequester;
}): PeFactCosignPayload {
  const signed = fields.requester !== undefined && fields.chal_exp !== undefined;
  return {
    v: signed ? PRESENTATION_VERSION_SIGNED_CHALLENGE : PRESENTATION_VERSION,
    iss: PRESENTATION_ISSUER,
    ctx: 'pe_fact_cosign',
    presenter_address: fields.presenter_address.toLowerCase(),
    burn_id: fields.burn_id,
    pe_facts: fields.pe_facts.map((f) => ({ pe_id: f.pe_id, envelope_hash: f.envelope_hash.toLowerCase() })),
    jti: fields.jti,
    iat: fields.iat,
    exp: fields.exp,
    ...(fields.sub !== undefined ? { sub: fields.sub } : {}),
    // The requester + deadline keys exist only on a v2 presentation.
    ...(signed ? { chal_exp: fields.chal_exp, requester: normalizeRequester(fields.requester!) } : {}),
  };
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical digest of the tier-specific claim commitment the presenter signs. */
export function claimsDigest(payload: {
  tier: PresentationTier;
  pe_facts?: readonly { pe_id: string; envelope_hash: string }[];
  reputation_directive?: unknown;
  /** Requester-named disclosure answers (reputation tier). Absent / empty → the pre-existing bytes. */
  disclosures?: readonly DisclosureAnswer[];
}): string {
  if (payload.tier === 'pe_fact') {
    // Bind BOTH the pe_id AND the anchored envelope_hash. Binding pe_id alone
    // would leave the content hash unsigned — a presenter could swap in a
    // different anchored hash (+ its proof) and forge ownership of a PE they do
    // not own. The presenter signs the exact anchored content it vouches for.
    const lines = (payload.pe_facts ?? [])
      .map((f) => `${f.pe_id}:${f.envelope_hash.toLowerCase()}`)
      .sort();
    return sha256hex(`pe_fact\n${lines.join('\n')}`);
  }
  // Reputation: commit to the DISCLOSURE DIRECTIVE the presenter chose (which
  // fields to redact / which predicates to derive), not the server-authenticated
  // values — Provian attests those, the presenter attests the disclosure choice.
  // The disclosure commitment line exists ONLY when the presentation answers disclosure requests,
  // so every presentation without them signs byte-identical bytes.
  const disclosures = payload.disclosures !== undefined && payload.disclosures.length > 0
    ? `\ndisclosures=${disclosureCommitmentDigest(payload.disclosures)}`
    : '';
  return sha256hex(`reputation\n${JSON.stringify(payload.reputation_directive ?? null)}${disclosures}`);
}

/**
 * The canonical binding string the presenter signs with their live key. Fixed
 * line order, no JSON ambiguity. Committing to tier+presenter+aud+chal+iat+exp+
 * jti+burn+claims makes the proof-of-possession bind to exactly one requester,
 * one moment, one burn, and one claim set — non-replayable to any other requester
 * or later moment.
 */
export function presentationBindingString(fields: {
  tier: PresentationTier;
  presenter_address: string;
  aud: string;
  chal: string;
  iat: number;
  exp: number;
  jti: string;
  burn_id: string;
  claims_digest: string;
  /** v2 (signed challenge) only — both or neither. */
  requester?: PresentationRequester;
  chal_exp?: number;
}): string {
  const signed = fields.requester !== undefined && fields.chal_exp !== undefined;
  const lines = [
    signed ? PRESENTATION_BINDING_TAG_V2 : PRESENTATION_BINDING_TAG,
    `tier=${fields.tier}`,
    `presenter=${fields.presenter_address.toLowerCase()}`,
    `aud=${fields.aud}`,
    `chal=${fields.chal}`,
    `iat=${fields.iat}`,
    `exp=${fields.exp}`,
    `jti=${fields.jti}`,
    `burn=${fields.burn_id}`,
    `claims=${fields.claims_digest}`,
  ];
  if (signed) lines.push(`req=${requesterString(fields.requester!)}`, `chal_exp=${fields.chal_exp}`);
  return lines.join('\n');
}

/** Serialize a presentation to an opaque, portable base64url token. */
export function encodePresentationToken(p: Presentation): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}

/** Parse an opaque presentation token. Returns null on any malformed input. */
export function decodePresentationToken(token: string): Presentation | null {
  try {
    const obj = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    return obj as Presentation;
  } catch {
    return null;
  }
}
