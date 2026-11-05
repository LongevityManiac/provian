/**
 * Burn-to-present production service — consume a verified on-chain PVT burn and
 * produce a signed, requester-bound, fresh, single-use presentation.
 *
 * SYMMETRIC across humans and agents: the caller passes a {@link PresenterPrincipal}
 * built from either a human first-party wallet (wallet-auth) or an agent sovereign
 * wallet (agent-auth). The burn, the ledger, the binding, the disclosure, and the
 * signing are identical; only the principal and the PoP scheme differ.
 *
 * Ordering is fail-closed and matches the other burn products: SIGN LOCALLY FIRST
 * (deterministic, cannot fail on external state), then consume the burn + write
 * the presentation record ATOMICALLY in one Firestore transaction through the
 * GLOBAL single-use `burn_consumptions` ledger. If the burn is already spent the
 * transaction throws and no presentation is returned; the locally-signed token is
 * discarded, never emitted.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  BURN_CONSUMPTIONS_COLLECTION,
  PVT_BURN_RECORDS_COLLECTION,
  BurnConsumptionError,
  BURN_ALREADY_CONSUMED,
  assertBurnRowUsable,
  resolvePresentationFloorAtomic,
  buildBurnConsumptionMarker,
  isBurnId,
} from '../commons/burn-consumption';
import {
  applyReputationDisclosure,
  canonicalReputationDirective,
  type DisclosureDirective,
  normalizePredicateRequests,
} from './disclosure';
import { computeActorVocabulary, VocabularyUnavailableError } from './vocabulary';
import { proveMeterFact } from '../meter/meter-fact-proof';
import { canonicalPeAnchorReadContract, type PeAnchorVerifyContract } from './anchor-contract';
import {
  loadPresentationSigningKey,
  signReputationPresentation,
  signPeFactCosign,
} from './signer';
import {
  PRESENTATION_ISSUER,
  PRESENTATION_VERSION,
  PRESENTATION_VERSION_SIGNED_CHALLENGE,
  normalizeRequester,
  PRESENTATION_MIN_TTL_SECONDS,
  PRESENTATION_MAX_TTL_SECONDS,
  PRESENTATION_CLOCK_SKEW_SECONDS,
  PRESENTATION_CHALLENGE_MIN_LEN,
  PRESENTATION_CHALLENGE_MAX_LEN,
  PRESENTATION_AUDIENCE_MAX_LEN,
  COMMONS_PRESENTATIONS_COLLECTION,
  buildPeFactCosignPayload,
  MAX_PE_FACT_CLAIMS,
  claimsDigest,
  presentationBindingString,
  type Presentation,
  type PresentationPayload,
  type PresenterPop,
  type PeFactClaim,
  type PeFactProof,
} from './types';
import { verifyPresenterPop } from './verify';
import { recordFirstPartyBurn, burnIdFor, BURN_RECORD_MAX_WAIT_MS, type BurnRecordDeps } from './burn-record';
import {
  parseChallengeEnvelope,
  isSignedChallenge,
  verifyChallengeEnvelope,
  type ChallengeEnvelope,
  type FetchRequesterKeys,
} from './challenge';
import { fetchRequesterKeysGuarded } from './requester-keys';
import { loadCommerceAttestationKeys } from './jws-key-material';
import { predicateMatchesRequest } from './disclosure';
import type { PresentationRequester } from './types';
import {
  parseDisclosureAnswers,
  disclosureRequestMatches,
  canonicalDisclosureAnswers,
  type CanonicalDisclosureRequest,
  type DisclosureAnswer,
  type DisclosedRecord,
} from './disclosure-request';
import { buildDisclosedRecord } from './disclosure-records';

// Re-exported from the light types module (its canonical home). Kept here so
// existing `import { COMMONS_PRESENTATIONS_COLLECTION } from './service'` callers
// are unaffected; lightweight readers should import it from './types' directly.
export { COMMONS_PRESENTATIONS_COLLECTION };

// Max PE-fact claims per presentation. Canonical home is ./types (imported above)
// so issuance here and verification in ./verify share ONE literal; re-exported
// for any existing `import { MAX_PE_FACT_CLAIMS } from './service'` caller.
export { MAX_PE_FACT_CLAIMS };

export interface PresenterPrincipal {
  readonly kind: 'agent' | 'human';
  /** The wallet id the burn was recorded under (agent wallet id / human wallet id). */
  readonly walletId: string;
  /** Sovereign / first-party EVM address (lowercased 0x…) — the burning address
   *  and the presenter identity the PoP binds to. */
  readonly address: string;
  /** The pe_history `userId` this principal's PEs are attributed to (agent_id for
   *  an agent, user_id for a human) — used to guard PE-fact ownership. */
  readonly peOwnerUserId: string;
  /** Server-authenticated full reputation facts (never client-supplied). */
  readonly standing: Readonly<Record<string, number>>;
  /** Agent only: the 64-byte uncompressed secp256k1 public key (128 hex). */
  readonly publicKeyHex?: string;
}

export interface ProducePresentationCommon {
  readonly principal: PresenterPrincipal;
  readonly burnId: string;
  /** Requester (audience) — requester-supplied. */
  readonly audience: string;
  /** Requester-supplied challenge (their fresh nonce). */
  readonly challenge: string;
  /** Presenter-chosen issued-at (unix seconds). Validated fresh vs server now. */
  readonly iat: number;
  /** Presenter-chosen expiry (unix seconds). Window validated in [MIN, MAX]. */
  readonly exp: number;
  /** Presenter-chosen unique presentation id. */
  readonly jti: string;
  /** The presenter's signature over the canonical binding (live-possession proof). */
  readonly pop: PresenterPop;
  /** the requester's SIGNED challenge envelope. When present the relay verifies it before
   * anything is consumed and issues a v2 presentation naming the verified requester. */
  readonly challengeEnvelope?: ChallengeEnvelope;
  readonly nowSeconds?: number;
  /**
   * pipelining: resolves when the backing burn is recorded — accepted at one-block inclusion,
   * (null) or has failed to be (the refusal). Everything that does not depend on the moment of issuance — the
   * request validation, the signed-challenge check, the pe_fact anchor proofs, the presenter's
   * proof of possession — runs BEFORE it, overlapping the chain wait; the live vocabulary, the
   * signing and the burn consumption run AFTER it. Absent: the burn was recorded beforehand.
   */
  readonly burnGate?: () => Promise<ProduceFailure | null>;
}

/** One disclosed record as the PRESENTER supplies it: the PE and its two-hop proof beside the identity. */
export interface SuppliedDisclosedRecord {
  readonly pe_id: string;
  readonly pe_hash: string;
  readonly pe?: unknown;
  readonly inclusion?: unknown;
}

/** The presenter's answer to one requester-named disclosure request. */
export interface SuppliedDisclosureAnswer {
  readonly request: CanonicalDisclosureRequest;
  readonly election: 'disclosed' | 'declined';
  readonly records?: readonly SuppliedDisclosedRecord[];
}

export interface ProduceReputationInput extends ProducePresentationCommon {
  readonly directive: DisclosureDirective;
  /** Requester-named disclosures (2026-10-10): elections + the PEs put forward, proven here. */
  readonly disclosures?: readonly SuppliedDisclosureAnswer[];
}

export interface ProducePeFactInput extends ProducePresentationCommon {
  /** The PEs to present, each with its OWN anchored envelope_hash so the presenter
   *  signs the exact content it vouches for (the server cross-checks against chain). */
  readonly peFacts: readonly {
    pe_id: string;
    envelope_hash: string;
    /** PE METER: the PE itself and its two-hop inclusion proof, held by the presenter. */
    pe?: unknown;
    inclusion?: unknown;
  }[];
}

export type ProduceFailure = {
  ok: false; status: number; error: string; reason?: string;
  /** a pipelined call's burn id, when its burn WAS recorded (reusable by a retry). */
  burnId?: string;
};
export type ProducePresentationResult =
  | { ok: true; presentation: Presentation }
  | ProduceFailure;

interface ServiceDeps {
  readonly db: Firestore;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Test seam: the live vocabulary computation (defaults to {@link computeActorVocabulary}). */
  readonly vocabulary?: (principal: PresenterPrincipal) => Promise<Readonly<Record<string, number>>>;
  /** test seam: a domain requester's key fetch (defaults to the SSRF-guarded fetcher). */
  readonly fetchRequesterKeys?: FetchRequesterKeys;
  /** test seam: the pipelined burn recorder's probe / clock / verifier (defaults: production). */
  readonly burnRecord?: Pick<BurnRecordDeps, 'probe' | 'sleep' | 'now' | 'verify'>;
  /** PE METER test seam: the PEAnchor read contract a presented metered PE is proven against. */
  readonly peAnchor?: PeAnchorVerifyContract | null;
  /** TEST SEAM ONLY: the hardware verifier context a disclosed record's witness is re-admitted under. */
  readonly hardware?: Pick<import('../hardware/types').HardwareVerifyContext, 'rootsOverride' | 'fetch'>;
}

function fail(status: number, error: string, reason?: string): ProduceFailure {
  return { ok: false, status, error, reason };
}

/**
 * wait at the burn gate (when there is one), then re-check freshness. The presentation and
 * the signed challenge were fresh when the call arrived; they must still be fresh at issuance, which
 * now comes after the chain wait. Neither refusal consumes the burn — it stays recorded for a retry.
 */
async function passBurnGate(
  deps: ServiceDeps,
  input: ProducePresentationCommon,
  chalExp: number | null,
): Promise<ProduceFailure | null> {
  if (!input.burnGate) return null;
  const refused = await input.burnGate();
  if (refused) return refused;
  // The clock that ran the wait judges what the wait did to freshness.
  const now = input.nowSeconds ?? Math.floor((deps.burnRecord?.now ?? Date.now)() / 1000);
  if (input.exp <= now - PRESENTATION_CLOCK_SKEW_SECONDS) {
    return fail(400, 'the presentation window expired while the burn was being mined', 'presentation_expired');
  }
  if (chalExp !== null && now > chalExp + PRESENTATION_CLOCK_SKEW_SECONDS) {
    return fail(400, 'the signed challenge expired while the burn was being mined', 'challenge_expired');
  }
  return null;
}

/** Validate the requester-binding + window fields shared by both tiers. */
function validateCommon(input: ProducePresentationCommon): { ok: true; now: number } | ProduceFailure {
  const { principal, burnId, audience, challenge, iat, exp, jti, pop } = input;
  if (!isBurnId(burnId)) return fail(400, 'burn_id must be a 64-char hex burn identifier');
  if (typeof audience !== 'string' || audience.length === 0 || audience.length > PRESENTATION_AUDIENCE_MAX_LEN) {
    return fail(400, 'audience (requester id) is required and must be <= 512 chars');
  }
  if (
    typeof challenge !== 'string'
    || challenge.length < PRESENTATION_CHALLENGE_MIN_LEN
    || challenge.length > PRESENTATION_CHALLENGE_MAX_LEN
  ) {
    return fail(400, 'challenge must be a requester-supplied nonce of 16..512 chars');
  }
  if (typeof jti !== 'string' || jti.length === 0 || jti.length > 128) {
    return fail(400, 'jti is required (<= 128 chars)');
  }
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) return fail(400, 'iat and exp must be integer unix seconds');
  const windowSeconds = exp - iat;
  if (windowSeconds < PRESENTATION_MIN_TTL_SECONDS || windowSeconds > PRESENTATION_MAX_TTL_SECONDS) {
    return fail(400, `validity window (exp-iat) must be ${PRESENTATION_MIN_TTL_SECONDS}..${PRESENTATION_MAX_TTL_SECONDS}s`);
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (iat > now + PRESENTATION_CLOCK_SKEW_SECONDS) return fail(400, 'iat is in the future');
  if (exp <= now - PRESENTATION_CLOCK_SKEW_SECONDS) return fail(400, 'presentation window already expired');
  if (!pop || typeof pop.signature !== 'string') return fail(400, 'presenter proof-of-possession (pop) is required');
  // The PoP scheme must match the principal kind, and an agent must present the
  // public key that matches its own wallet — so a client cannot substitute a key.
  if (principal.kind === 'agent') {
    if (pop.scheme !== 'ecdsa_sha256_secp256k1') return fail(400, 'agent pop.scheme must be ecdsa_sha256_secp256k1');
    if (typeof pop.pubkey !== 'string') return fail(400, 'agent pop.pubkey is required');
    // Normalize to the bare 128-hex form: strip 0x, and the 04 prefix ONLY on the
    // 130-hex form — a bare key whose high byte is 0x04 must not be shortened.
    const norm = (s: string): string => {
      const c = s.toLowerCase().replace(/^0x/, '');
      return c.length === 130 && c.startsWith('04') ? c.slice(2) : c;
    };
    if (principal.publicKeyHex && norm(pop.pubkey) !== norm(principal.publicKeyHex)) {
      return fail(403, 'pop.pubkey does not match the authenticated agent wallet');
    }
  } else if (pop.scheme !== 'eip191_secp256k1') {
    return fail(400, 'human pop.scheme must be eip191_secp256k1');
  }
  return { ok: true, now };
}

/**
 * verify a SIGNED challenge envelope the presenter supplied, before anything is consumed.
 * Returns the verified requester + deadline for a v2 presentation, `null` when no signed envelope
 * was supplied (a v1 presentation, unchanged), or a refusal. The burn is never consumed on refusal,
 * so the presenter can retry with a correct challenge.
 */
async function resolveSignedChallenge(
  deps: ServiceDeps,
  input: ProducePresentationCommon,
  predicates: readonly import('./disclosure').PredicateRequest[] | null,
  disclosures: readonly { request: CanonicalDisclosureRequest }[] | null = null,
): Promise<{ ok: true; signed: { requester: PresentationRequester; chalExp: number } | null } | ProduceFailure> {
  const env = input.challengeEnvelope;
  if (!env) return { ok: true, signed: null };
  if (env.audience !== input.audience || env.challenge !== input.challenge) {
    return fail(400, 'challenge_envelope audience/challenge do not match the presentation', 'challenge_mismatch');
  }
  if (!isSignedChallenge(env)) return { ok: true, signed: null };
  const material = loadCommerceAttestationKeys(deps.env ?? process.env);
  const verdict = await verifyChallengeEnvelope(env, {
    fetchRequesterKeys: deps.fetchRequesterKeys ?? ((d) => fetchRequesterKeysGuarded(d)),
    provianKeys: material.ok ? material.keys : [],
    nowSeconds: input.nowSeconds,
    presenterAddress: input.principal.address,
  });
  if (verdict.status === 'expired') return fail(400, 'the signed challenge has expired', 'challenge_expired');
  if (verdict.status === 'not_addressed') return fail(403, 'the signed challenge names a different presenter', 'presenter_not_addressed');
  if (verdict.status === 'invalid') {
    return verdict.reason === 'requester_key_unreachable'
      ? fail(502, 'the requester key could not be fetched', 'requester_key_unreachable')
      : fail(400, `the challenge signature does not verify (${verdict.reason})`, 'challenge_signature_invalid');
  }
  if (verdict.status !== 'verified') return { ok: true, signed: null };
  const asked = env.predicates ?? [];
  if (predicates === null) {
    if (asked.length > 0) return fail(400, 'a pe_fact presentation cannot answer the challenge predicates', 'predicates_require_reputation_tier');
  } else if (!asked.every((a) => predicates.some((p) => predicateMatchesRequest(p, a)))) {
    return fail(400, 'the disclosure does not answer every predicate the signed challenge asks', 'challenge_predicates_missing');
  }
  // Requester-named disclosures: every request the signed challenge names must be answered — elected
  // disclosed or declined — on the reputation tier (Standing is always beside a disclosure).
  const named = env.disclosures ?? [];
  if (disclosures === null) {
    if (named.length > 0) return fail(400, 'a pe_fact presentation cannot answer the challenge disclosure requests', 'disclosures_require_reputation_tier');
  } else if (!named.every((n) => disclosures.some((d) => disclosureRequestMatches(d.request, n)))) {
    return fail(400, 'the presentation does not answer every disclosure request the signed challenge names (elect disclosed or declined for each)', 'challenge_disclosures_missing');
  }
  return { ok: true, signed: { requester: verdict.requester, chalExp: env.expiresAt as number } };
}

/**
 * Consume the burn + write the presentation record atomically, then return the
 * built presentation. The signed artifact is built by the caller BEFORE this call;
 * if the burn is already spent nothing is emitted.
 */
async function consumeAndRecord(
  deps: ServiceDeps,
  params: {
    principal: PresenterPrincipal;
    burnId: string;
    presentation: Presentation;
    minBurnAtomic: bigint;
    nowMs: number;
  },
): Promise<ProducePresentationResult> {
  const { db } = deps;
  const { principal, burnId, presentation, minBurnAtomic, nowMs } = params;
  const payload = presentation.payload;
  const burnRef = db.collection(PVT_BURN_RECORDS_COLLECTION).doc(burnId);
  const consumptionRef = db.collection(BURN_CONSUMPTIONS_COLLECTION).doc(burnId);
  const presentationRef = db.collection(COMMONS_PRESENTATIONS_COLLECTION).doc(burnId);

  try {
    await db.runTransaction(async (txn) => {
      const [burnSnap, consumptionSnap] = await Promise.all([txn.get(burnRef), txn.get(consumptionRef)]);
      assertBurnRowUsable(
        burnSnap.exists ? (burnSnap.data() as Record<string, unknown>) : undefined,
        principal.walletId,
        minBurnAtomic,
      );
      if (consumptionSnap.exists) throw new BurnConsumptionError(409, BURN_ALREADY_CONSUMED);

      txn.create(presentationRef, {
        presentation_id: payload.jti,
        tier: payload.tier,
        wallet_id: principal.walletId,
        presenter_kind: principal.kind,
        presenter_address: payload.presenter_address,
        audience: payload.aud,
        // Store a digest of the challenge, not the raw requester nonce.
        challenge_sha256: crypto.createHash('sha256').update(payload.chal).digest('hex'),
        burn_id: burnId,
        issued_at: payload.iat,
        expires_at: payload.exp,
        recorded_at: nowMs,
      } as FirebaseFirestore.DocumentData);

      txn.create(
        consumptionRef,
        buildBurnConsumptionMarker({
          burnId,
          product: 'presentation',
          walletId: principal.walletId,
          ref: payload.jti,
          nowMs,
        }) as unknown as FirebaseFirestore.DocumentData,
      );
    });
    return { ok: true, presentation };
  } catch (err) {
    if (err instanceof BurnConsumptionError) return fail(err.status, err.message);
    throw err;
  }
}

/** Parse a `pop` object off an untrusted request body. */
function parsePop(raw: unknown): PresenterPop | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.scheme !== 'ecdsa_sha256_secp256k1' && r.scheme !== 'eip191_secp256k1') return null;
  if (typeof r.signature !== 'string' || r.signature.length === 0) return null;
  const pop: PresenterPop = { scheme: r.scheme, signature: r.signature };
  if (typeof r.pubkey === 'string') return { ...pop, pubkey: r.pubkey };
  return pop;
}

/**
 * Produce a presentation from a raw (untrusted) request body + a server-built
 * principal. The single entry point both the agent route and the human route
 * call, so the two paths are byte-for-byte the same primitive.
 */
export async function producePresentationFromRequest(deps: ServiceDeps, principal: PresenterPrincipal, body: unknown): Promise<ProducePresentationResult> {
  return preparePresentationFromRequest(deps, principal, body);
}

/** Authenticated, read-only validation using issuance's exact proof checks. Never records a burn. */
export async function preflightPresentationFromRequest(deps: ServiceDeps, principal: PresenterPrincipal, body: unknown): Promise<{ok:true} | ProduceFailure> {
  const result = await preparePresentationFromRequest(deps, principal, body, true);
  return !result.ok && result.reason === 'proof_preflight_complete' ? {ok:true} : result as ProduceFailure;
}

async function preparePresentationFromRequest(
  deps: ServiceDeps,
  principal: PresenterPrincipal,
  body: unknown,
  proofPreflight = false,
): Promise<ProducePresentationResult> {
  if (typeof body !== 'object' || body === null) return fail(400, 'a JSON request body is required');
  const b = body as Record<string, unknown>;
  if (proofPreflight && b.burn != null) return fail(400, 'preflight cannot record a burn', 'preflight_burn_forbidden');

  const tier = b.tier;
  if (tier !== 'pe_fact' && tier !== 'reputation') return fail(400, "tier must be 'pe_fact' or 'reputation'");
  const pop = parsePop(b.pop);
  if (!pop) return fail(400, 'pop { scheme, signature, pubkey? } is required');

  let challengeEnvelope: ChallengeEnvelope | undefined;
  if (b.challenge_envelope !== undefined && b.challenge_envelope !== null) {
    const parsed = parseChallengeEnvelope(b.challenge_envelope);
    if (!parsed) return fail(400, 'challenge_envelope is malformed');
    challengeEnvelope = parsed;
  }

  // pipelining: `burn: { tx_hash, amount_atomic, chain? }` names the burn by its tx instead
  // of a burn id recorded beforehand. The burn id is still `sha256(chain:tx_hash)` (the presenter
  // signed it into the binding); the relay records the burn WHILE it prepares the presentation,
  // and issues only once the burn is recorded — mined and accepted at inclusion (`burnGate`,
  // ). Its 12-block finality check follows; a burn that fails it is revoked, and this
  // presentation's relay-held state with it (`burn-finality.ts`).
  let submitted: { txHash: string; chain: string; amountAtomic: string; burnId: string } | null = null;
  if (b.burn !== undefined && b.burn !== null) {
    const raw = b.burn as Record<string, unknown>;
    const chain = raw.chain === undefined ? 'base' : raw.chain;
    if (typeof raw !== 'object' || typeof raw.tx_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.tx_hash)
      || typeof raw.amount_atomic !== 'string' || typeof chain !== 'string') {
      return fail(400, 'burn must be { tx_hash, amount_atomic, chain? }');
    }
    const burnId = burnIdFor(chain, raw.tx_hash);
    if (typeof b.burn_id === 'string' && b.burn_id !== burnId) {
      return fail(400, 'burn_id does not match the burn tx (sha256(chain:tx_hash))');
    }
    submitted = { txHash: raw.tx_hash, chain, amountAtomic: raw.amount_atomic, burnId };
  }

  const common = {
    principal,
    challengeEnvelope,
    burnId: submitted ? submitted.burnId : typeof b.burn_id === 'string' ? b.burn_id : '',
    audience: typeof b.audience === 'string' ? b.audience : '',
    challenge: typeof b.challenge === 'string' ? b.challenge : '',
    iat: typeof b.iat === 'number' ? b.iat : NaN,
    exp: typeof b.exp === 'number' ? b.exp : NaN,
    jti: typeof b.jti === 'string' ? b.jti : '',
    pop,
  };

  let produce: (gate?: () => Promise<ProduceFailure | null>) => Promise<ProducePresentationResult>;
  if (tier === 'reputation') {
    const disclosureRaw = (b.disclosure ?? {}) as Record<string, unknown>;
    const redact = Array.isArray(disclosureRaw.redact)
      ? disclosureRaw.redact.filter((x): x is string => typeof x === 'string')
      : [];
    // §2.6: predicates parse fail-closed (an unknown op / malformed set is a 400, never a no-op).
    const predicates = normalizePredicateRequests(disclosureRaw.predicates);
    if (predicates === null) return fail(400, 'disclosure.predicates is malformed (field, op gte|gt|lte|lt|eq|in, threshold | set)');
    // Share-only mode: present iff the body names `share` (an array of field names; fail-closed on any
    // other shape — a malformed share list must never fall back to reveal-everything).
    let share: string[] | undefined;
    if (disclosureRaw.share !== undefined) {
      if (!Array.isArray(disclosureRaw.share) || !disclosureRaw.share.every((x) => typeof x === 'string')) {
        return fail(400, 'disclosure.share must be an array of field names');
      }
      share = disclosureRaw.share as string[];
    }
    const directive = { redact, predicates, ...(share !== undefined ? { share } : {}) };
    // Requester-named disclosures: `[{ request, election, records?: [{ pe_id, pe_hash, pe, inclusion }] }]`.
    // Parsed fail-closed on the shared shape; the PE + proof ride beside each record identity.
    let disclosures: SuppliedDisclosureAnswer[] | undefined;
    if (b.disclosures !== undefined && b.disclosures !== null) {
      const raw = b.disclosures;
      if (!Array.isArray(raw)) return fail(400, 'disclosures must be a list of { request, election, records? }');
      const identities = parseDisclosureAnswers(raw.map((a) => {
        const r = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
        const recs = Array.isArray(r.records) ? r.records.map((x) => {
          const xr = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
          // Identity + a placeholder floor; the relay derives the real record from the proven PE.
          return { pe_id: xr.pe_id, pe_hash: xr.pe_hash, action_type: '-', timestamp: 0, witness: { kind: 'device' } };
        }) : r.records;
        return { request: r.request, election: r.election, ...(recs !== undefined ? { records: recs } : {}) };
      }));
      if (identities === null) return fail(400, 'disclosures is malformed ({ request, election: disclosed|declined, records?: [{ pe_id, pe_hash, pe, inclusion }] })');
      disclosures = identities.map((id, i) => {
        const r = raw[i] as Record<string, unknown>;
        const supplied = Array.isArray(r.records) ? (r.records as Record<string, unknown>[]) : [];
        return {
          request: id.request,
          election: id.election,
          ...(id.election === 'disclosed' ? { records: (id.records ?? []).map((rec) => {
            const s = supplied.find((x) => x.pe_id === rec.pe_id) ?? {};
            return { pe_id: rec.pe_id, pe_hash: rec.pe_hash, ...(s.pe !== undefined ? { pe: s.pe } : {}), ...(s.inclusion !== undefined ? { inclusion: s.inclusion } : {}) };
          }) } : {}),
        };
      });
    }
    produce = (burnGate) => produceReputationPresentation(deps, { ...common, burnGate, directive, ...(disclosures !== undefined ? { disclosures } : {}) });
  } else {
    const peFacts = Array.isArray(b.pe_facts)
      ? b.pe_facts
          .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
          .map((p) => ({
            pe_id: typeof p.pe_id === 'string' ? p.pe_id : '',
            envelope_hash: typeof p.envelope_hash === 'string' ? p.envelope_hash : '',
            ...(p.pe !== undefined ? { pe: p.pe } : {}),
            ...(p.inclusion !== undefined ? { inclusion: p.inclusion } : {}),
          }))
      : [];
    produce = (burnGate) => producePeFactPresentation(deps, { ...common, burnGate, peFacts });
  }

  // The read-only preflight exits at the SAME boundary after every proof and PoP check,
  // before recording/consuming a burn, reading vocabulary, signing, or persisting anything.
  if (proofPreflight) return produce(async () => fail(200, 'proof preflight complete', 'proof_preflight_complete'));
  if (!submitted) return produce();

  // The SAME recorder `burn/record` uses, holding until the burn is mined (inclusion).
  const burn = submitted;
  const recording: Promise<ProduceFailure | null> = recordFirstPartyBurn({ ...deps.burnRecord, db: deps.db }, {
    walletId: principal.walletId,
    address: principal.address,
    ownerKind: principal.kind,
    ownerId: principal.peOwnerUserId,
    txHash: burn.txHash,
    chain: burn.chain,
    amountAtomic: burn.amountAtomic,
    waitMs: BURN_RECORD_MAX_WAIT_MS,
  }).then(
    (r) => (r.ok ? null : fail(r.status, r.error, r.reason)),
    (err: unknown) => fail(503, 'the burn could not be recorded', `burn_record_error: ${err instanceof Error ? err.message : String(err)}`),
  );
  const result = await produce(() => recording);
  if (result.ok) return result;
  // A refusal (before or after the gate) is answered only once the burn's own outcome is known,
  // so a recorded burn is reported back and a retry presents it instead of burning again.
  const burnOutcome = await recording;
  return burnOutcome === null ? { ...result, burnId: burn.burnId } : result;
}

/**
 * Produce a REPUTATION-tier presentation: Provian-attested (JWS), selective
 * disclosure, requester-bound, fresh, single-use.
 */
export async function produceReputationPresentation(
  deps: ServiceDeps,
  input: ProduceReputationInput,
): Promise<ProducePresentationResult> {
  const common = validateCommon(input);
  if (common.ok !== true) return common;
  const { principal, burnId, audience, challenge, iat, exp, jti, pop } = input;

  const directive: DisclosureDirective = {
    redact: input.directive?.redact ?? [],
    predicates: input.directive?.predicates ?? [],
    ...(input.directive?.share !== undefined ? { share: input.directive.share } : {}),
  };
  const supplied = input.disclosures ?? [];
  const signedChallenge = await resolveSignedChallenge(deps, input, directive.predicates, supplied);
  if (signedChallenge.ok !== true) return signedChallenge;
  const v2 = signedChallenge.signed;

  // Requester-named disclosures: every record the presenter put forward is PROVEN (identity, hop 1,
  // ownership, hop 2 on chain) and derived from the complete PE — before the burn gate, so a refusal
  // never consumes the burn. The presenter's PoP commits to the elections and record identities only;
  // the derived facts are covered by the Provian signature and re-checked by every verifier against
  // the anchored act record.
  const answers: DisclosureAnswer[] = [];
  const disclosureProofs: PeFactProof[] = [];
  for (const a of supplied) {
    if (a.election === 'declined') { answers.push({ request: a.request, election: 'declined' }); continue; }
    const records: DisclosedRecord[] = [];
    for (const r of a.records ?? []) {
      const proven = await proveMeterFact({
        claim: { pe_id: r.pe_id, envelope_hash: r.pe_hash },
        pe: r.pe,
        inclusion: r.inclusion,
        presenterOwnerId: principal.peOwnerUserId,
        anchorContract: deps.peAnchor === undefined ? canonicalPeAnchorReadContract() : deps.peAnchor,
      });
      if (proven.status === 'refused') return fail(proven.http, `disclosure ${r.pe_id}: ${proven.reason}`, proven.reason);
      const leaf = proven.proof.leaf as { batch?: { device_id?: string } };
      const built = await buildDisclosedRecord({
        pe: r.pe as import('../meter/meter-wire').PeV2,
        peHash: proven.proof.envelope_hash,
        batchDeviceId: leaf.batch?.device_id ?? '',
        request: a.request,
        ...(deps.hardware ? { hardware: deps.hardware } : {}),
      });
      if (!built.ok) return fail(400, `disclosure ${r.pe_id}: ${built.reason}`, built.reason);
      records.push(built.record);
      disclosureProofs.push(proven.proof);
    }
    answers.push({ request: a.request, election: 'disclosed', records });
  }
  const disclosures = canonicalDisclosureAnswers(answers);

  // Bind: the presenter committed to the DISCLOSURE DIRECTIVE (not the values) and to its disclosure
  // elections + record identities, so the proof of possession is checked before the live facts are
  // read (and,, before the burn gate).
  const digest = claimsDigest({
    tier: 'reputation',
    reputation_directive: canonicalReputationDirective(directive),
    ...(disclosures.length > 0 ? { disclosures } : {}),
  });
  const binding = presentationBindingString({
    tier: 'reputation',
    presenter_address: principal.address,
    aud: audience,
    chal: challenge,
    iat,
    exp,
    jti,
    burn_id: burnId,
    claims_digest: digest,
    ...(v2 ? { requester: v2.requester, chal_exp: v2.chalExp } : {}),
  });
  if (!verifyPresenterPop(binding, pop, principal.address)) {
    return fail(400, 'presenter proof-of-possession did not verify', 'bad_presenter_pop');
  }

  // the facts are read at ISSUANCE, so they are read after the burn was recorded.
  const gated = await passBurnGate(deps, input, v2 ? v2.chalExp : null);
  if (gated) return gated;

  // §2.5: the disclosable set IS the live vocabulary — computed now, server-authenticated, never
  // client-supplied. `principal.standing` is no longer a source (governance_score is gone).
  // item 2: STANDING FAILS CLOSED. Every vocabulary source must be read; a source that cannot
  // be read refuses the presentation (503, burn NOT consumed — the presenter retries) instead of
  // issuing a fact that says 0 because the read failed. A 0 in a presentation is an OBSERVED zero.
  let facts: Readonly<Record<string, number>>;
  try {
    facts = deps.vocabulary
      ? await deps.vocabulary(principal)
      : await computeActorVocabulary({ db: deps.db }, {
        kind: principal.kind, walletId: principal.walletId, peOwnerUserId: principal.peOwnerUserId, address: principal.address,
      });
  } catch (err) {
    if (err instanceof VocabularyUnavailableError) {
      return fail(503, 'a vocabulary source could not be read; no presentation was issued and the burn was not consumed', 'vocabulary_source_unavailable');
    }
    throw err;
  }
  const applied = applyReputationDisclosure(facts, directive);
  if (!applied.ok) return fail(400, applied.error);

  const signingKey = loadPresentationSigningKey(deps.env);
  if (!signingKey.ok) {
    return fail(503, 'presentation signing key is not configured', `signing_key_${signingKey.reason}`);
  }

  const payload: PresentationPayload = {
    v: v2 ? PRESENTATION_VERSION_SIGNED_CHALLENGE : PRESENTATION_VERSION,
    tier: 'reputation',
    iss: PRESENTATION_ISSUER,
    sub: principal.walletId,
    presenter_address: principal.address.toLowerCase(),
    aud: audience,
    chal: challenge,
    iat,
    exp,
    jti,
    burn_id: burnId,
    presenter_pop: pop,
    reputation: applied.disclosure,
    ...(disclosures.length > 0 ? { disclosures } : {}),
    ...(v2 ? { chal_exp: v2.chalExp, requester: normalizeRequester(v2.requester) } : {}),
  };
  const provianJws = signReputationPresentation(payload, signingKey.key);
  const presentation: Presentation = {
    tier: 'reputation',
    payload,
    provian_jws: provianJws,
    ...(disclosureProofs.length > 0 ? { disclosure_proofs: disclosureProofs } : {}),
  };

  const minBurnAtomic = await resolvePresentationFloorAtomic(deps.db, 'reputation');
  return consumeAndRecord(deps, {
    principal,
    burnId,
    presentation,
    minBurnAtomic,
    nowMs: (input.nowSeconds ?? Math.floor(Date.now() / 1000)) * 1000,
  });
}

/**
 * Produce a PE-FACT-tier presentation: presenter-signed, embedding the on-chain
 * anchor inclusion proof for every claimed PE (so a counterparty verifies the PEs
 * against Base directly), AND Provian-co-signed over {presenter, burn, pe_facts,
 * jti, iat, exp} so the counterparty can require proof of the two facts the chain
 * cannot show — the burn was consumed and the PEs are owned. Every claimed PE must
 * be (a) owned by the presenter and (b) already anchored on-chain.
 */
export async function producePeFactPresentation(
  deps: ServiceDeps,
  input: ProducePeFactInput,
): Promise<ProducePresentationResult> {
  const common = validateCommon(input);
  if (common.ok !== true) return common;
  const { principal, burnId, audience, challenge, iat, exp, jti, pop } = input;
  const signedChallenge = await resolveSignedChallenge(deps, input, null);
  if (signedChallenge.ok !== true) return signedChallenge;
  const v2 = signedChallenge.signed;

  // Dedupe by pe_id, keeping the caller's claimed envelope_hash for the cross-check.
  const byId = new Map<string, string>();
  const supplied = new Map<string, { pe: unknown; inclusion: unknown }>();
  for (const f of input.peFacts ?? []) {
    if (!f || typeof f.pe_id !== 'string' || f.pe_id.length === 0) return fail(400, 'each pe_fact needs a non-empty pe_id');
    if (typeof f.envelope_hash !== 'string' || f.envelope_hash.length === 0) return fail(400, 'each pe_fact needs an envelope_hash');
    byId.set(f.pe_id, f.envelope_hash.toLowerCase());
    if (f.pe !== undefined || f.inclusion !== undefined) supplied.set(f.pe_id, { pe: f.pe, inclusion: f.inclusion });
  }
  if (byId.size === 0) return fail(400, 'at least one pe_fact is required');
  if (byId.size > MAX_PE_FACT_CLAIMS) return fail(400, `at most ${MAX_PE_FACT_CLAIMS} pe_facts per presentation`);

  const claims: PeFactClaim[] = [];
  const proofs: PeFactProof[] = [];
  for (const [peId, claimedHash] of byId) {
    // PE METER: the presenter holds the PE; Provian proves it against the anchored root on Base.
    const held = supplied.get(peId);
    if (held !== undefined) {
      const proven = await proveMeterFact({
        claim: { pe_id: peId, envelope_hash: claimedHash },
        pe: held.pe,
        inclusion: held.inclusion,
        presenterOwnerId: principal.peOwnerUserId,
        anchorContract: deps.peAnchor === undefined ? canonicalPeAnchorReadContract() : deps.peAnchor,
      });
      if (proven.status === 'refused') return fail(proven.http, `pe ${peId}: ${proven.reason}`, proven.reason);
      claims.push({ pe_id: peId, envelope_hash: proven.proof.envelope_hash });
      proofs.push(proven.proof);
      continue;
    }
    // No PE supplied: the relay has nothing to prove it from. It keeps no PEs (the standing rule
    // 2026-10-03) — the pre-meter path that resolved a pe id against the relay's own record is
    // gone with that record. The presenter supplies the PE and its batch inclusion proof
    // (`GET /v1/meter/proofs`), which `proveMeterFact` checks above. Refused before the burn.
    return fail(
      410,
      `pe ${peId}: the relay keeps no PEs — supply the PE and its batch inclusion proof (GET /v1/meter/proofs)`,
      'pe_kept_by_owner',
    );
  }

  const digest = claimsDigest({ tier: 'pe_fact', pe_facts: claims });
  const binding = presentationBindingString({
    tier: 'pe_fact',
    presenter_address: principal.address,
    aud: audience,
    chal: challenge,
    iat,
    exp,
    jti,
    burn_id: burnId,
    claims_digest: digest,
    ...(v2 ? { requester: v2.requester, chal_exp: v2.chalExp } : {}),
  });
  if (!verifyPresenterPop(binding, pop, principal.address)) {
    return fail(400, 'presenter proof-of-possession did not verify', 'bad_presenter_pop');
  }

  // the anchor proofs and the proof of possession above overlapped the chain wait; the
  // co-sign attests a CONSUMED burn, so nothing below runs until the burn was recorded.
  const gated = await passBurnGate(deps, input, v2 ? v2.chalExp : null);
  if (gated) return gated;

  // Provian CO-SIGNS the pe_fact. Ownership (line ~411) and, transactionally
  // below, the burn are enforced HERE — the only place they can be. The co-sign
  // carries those two facts off the server so every verifier can require them;
  // without it a self-issued pe_fact citing anyone's public anchored PEs verifies
  // (F4/F61). Load the SAME key the reputation tier signs with; fail closed if
  // unconfigured so an unconfigured deployment cannot emit an un-co-signed pe_fact.
  const signingKey = loadPresentationSigningKey(deps.env);
  if (!signingKey.ok) {
    return fail(503, 'presentation signing key is not configured', `signing_key_${signingKey.reason}`);
  }
  const provianJws = signPeFactCosign(
    buildPeFactCosignPayload({
      presenter_address: principal.address,
      burn_id: burnId,
      pe_facts: claims,
      jti,
      iat,
      exp,
      sub: principal.walletId,
      ...(v2 ? { requester: v2.requester, chal_exp: v2.chalExp } : {}),
    }),
    signingKey.key,
  );

  const payload: PresentationPayload = {
    v: v2 ? PRESENTATION_VERSION_SIGNED_CHALLENGE : PRESENTATION_VERSION,
    tier: 'pe_fact',
    // The presenter's own address is the binding subject; the Provian co-sign
    // (provian_jws) is the outer attestation, mirroring the reputation tier.
    iss: principal.address.toLowerCase(),
    sub: principal.walletId,
    presenter_address: principal.address.toLowerCase(),
    aud: audience,
    chal: challenge,
    iat,
    exp,
    jti,
    burn_id: burnId,
    presenter_pop: pop,
    pe_facts: claims,
    ...(v2 ? { chal_exp: v2.chalExp, requester: normalizeRequester(v2.requester) } : {}),
  };
  const presentation: Presentation = { tier: 'pe_fact', payload, proofs, provian_jws: provianJws };

  const minBurnAtomic = await resolvePresentationFloorAtomic(deps.db, 'pe_fact');
  return consumeAndRecord(deps, {
    principal,
    burnId,
    presentation,
    minBurnAtomic,
    nowMs: (input.nowSeconds ?? Math.floor(Date.now() / 1000)) * 1000,
  });
}
