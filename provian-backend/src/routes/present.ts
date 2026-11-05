import {relayPrivacyCapability} from '../core/meter/relay-private-request';
/**
 * Public presentation VERIFICATION surface (burn-to-present).
 *
 *   GET  /v1/present/jwks    - Provian Ed25519 public JWKS. A counterparty fetches
 *                              it once and verifies a REPUTATION-tier presentation
 *                              JWS offline — no Provian account.
 *   POST /v1/present/verify  - verify a presentation (either tier). PE-fact requires
 *                              ALL of: the presenter signature, the embedded anchor
 *                              proofs against Base, AND the Provian co-sign JWS
 *                              (Provian attests the burn + PE ownership the chain
 *                              cannot). Reputation verifies the Provian JWS. Both are
 *                              checked against the Provian JWKS — no account needed —
 *                              as a convenience for counterparties who would rather
 *                              POST than verify locally.
 *
 * REACHABLE AT LAUNCH, NO ACCOUNT, NO FLIP (decided requirement). This router is
 * mounted OUTSIDE the pre-launch closed-prefix set and carries NO discovery gate:
 * a presentation is meant to be handed to an external counterparty who has no
 * Provian account, so its verification surface must be publicly reachable. This is
 * a purpose-built verification endpoint, not the broad network-discovery surface —
 * the leaderboard/directory/agent-record discovery stays gated.
 *
 * READ-ONLY. No handler writes; nothing here mints or moves value.
 */

import { Router, type Request, type Response } from 'express';
import type { ethers } from 'ethers';
import { loadCommerceAttestationKeys } from '../core/presentation/jws-key-material';
import {
  decodePresentationToken,
  type Presentation,
} from '../core/presentation/types';
import { verifyPresentation } from '../core/presentation/verify';
import { normalizePredicateRequests, predicateMatchesRequest, type PredicateRequest } from '../core/presentation/disclosure';
import { normalizeDisclosureRequests, disclosureRequestMatches, type CanonicalDisclosureRequest } from '../core/presentation/disclosure-request';
import { parseChallengeEnvelope, isSignedChallenge, checkSignedStructure } from '../core/presentation/challenge';
import type { PresentationRequester } from '../core/presentation/types';
import {
  resolvePresentationFloorAtomic,
  PRESENTATION_FLOOR_BY_TIER,
} from '../core/commons/burn-consumption';
import type { Firestore } from 'firebase-admin/firestore';

/** Minimal rate-limiter surface (the RedisCache method the middleware uses). */
export interface PresentRateLimiter {
  checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfter?: number }>;
}

/**
 * Per-IP ceiling for POST /verify (F5/F52/F58). The route is public and
 * unauthenticated by design (a counterparty with no Provian account must verify),
 * and each request can fan out one PEAnchor eth_call per DISTINCT proof against
 * the shared Base provider. The proof-count cap in verifyPresentation bounds the
 * fan-out PER request; this per-IP bucket bounds requests PER caller so an
 * anonymous flood cannot exhaust the RPC quota / starve settlement. HIGH per
 * the invariant: . Fails OPEN on
 * a Redis outage, the tree convention.
 */
export const PRESENT_VERIFY_IP_LIMIT_PER_MIN = 60;

export interface PresentRouterDeps {
  /** Optional on-chain PEAnchor read contract (provider-only). When present,
   *  pe_fact proofs are additionally checked against Base as a convenience. */
  readonly peAnchorContract?: ethers.Contract | null;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Rate-limiter backend for the per-IP bound on POST /verify. When absent the
   *  limiter is skipped (unit tests that omit it exercise verification only). */
  readonly cache?: PresentRateLimiter | null;
  /** Firestore, for the public GET /floor read. When absent, /floor answers the
   *  per-tier launch literals (never fails — a presenter can always learn the fee). */
  readonly db?: Pick<Firestore, 'collection'> | null;
}

export function createPresentRouter(deps: PresentRouterDeps = {}): Router {
  const router = Router();

  router.get('/privacy-key', (_req:Request,res:Response):void=>{
    try {res.setHeader('Cache-Control','no-store');res.json(relayPrivacyCapability(deps.env??process.env));}
    catch {res.status(503).json({error:'relay_privacy_key_unavailable'});}
  });

  // GET /jwks — the Provian Ed25519 public keys (same key material the reputation
  // presentation is signed with). Read per REQUEST so rotation takes effect
  // without a redeploy; 503 fail-closed when unconfigured (never an empty set).
  router.get('/jwks', (_req: Request, res: Response): void => {
    const material = loadCommerceAttestationKeys(deps.env ?? process.env);
    if (!material.ok) {
      res.status(503).json({ error: 'presentation_signing_unconfigured', reason: material.reason });
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.json({ keys: material.keys });
  });

  // GET /floor — the effective per-tier minimum burn a PRESENTER must burn before
  // POSTing /present, so it burns exactly the fee and never wastes real PVT on an
  // under-burn the relay would reject AFTER the on-chain burn is irreversible.
  // Public + read-only (a presenter may have no Provian account yet). Answers the
  // scheduled override when db is present, else the per-tier launch literal — it
  // never fails closed, because not knowing the fee must never block presenting.
  router.get('/floor', async (req: Request, res: Response): Promise<void> => {
    const wantTier = typeof req.query.tier === 'string' ? req.query.tier : '';
    const tiers: ('pe_fact' | 'reputation')[] =
      wantTier === 'pe_fact' || wantTier === 'reputation' ? [wantTier] : ['pe_fact', 'reputation'];
    const out: Record<string, { floor_atomic: string; floor_pvt: string }> = {};
    for (const tier of tiers) {
      let atomic = PRESENTATION_FLOOR_BY_TIER[tier];
      if (deps.db) {
        try {
          atomic = await resolvePresentationFloorAtomic(deps.db, tier);
        } catch {
          atomic = PRESENTATION_FLOOR_BY_TIER[tier];
        }
      }
      // 18-decimal atomic → whole-PVT string (floors are whole-PVT literals/bounds).
      out[tier] = { floor_atomic: atomic.toString(), floor_pvt: (atomic / 10n ** 18n).toString() };
    }
    res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json({ floors: out });
  });

  // POST /verify — verify a presentation (token or structured object). The
  // requester passes the exact challenge + audience they issued, so binding is
  // checked, not just structure.
  router.post('/verify', async (req: Request, res: Response): Promise<void> => {
    try {
      // F5/F52/F58: per-IP limiter. This public route can fan out on-chain calls
      // per request; bound anonymous callers on their transport IP so a flood
      // cannot exhaust the Base RPC quota that settlement shares. Fails open on a
      // Redis error (tree convention); the proof-count cap in verifyPresentation
      // bounds each request regardless.
      if (deps.cache) {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        try {
          const rl = await deps.cache.checkRateLimit(`rl:present-verify:ip:${ip}`, PRESENT_VERIFY_IP_LIMIT_PER_MIN, 60);
          if (!rl.allowed) {
            res.set('Retry-After', String(rl.retryAfter || 60));
            res.status(429).json({ valid: false, error: 'rate_limited' });
            return;
          }
        } catch (rlErr) {
          console.error('[Present] verify rate-limit check failed (failing open):', rlErr);
        }
      }

      const body = (req.body ?? {}) as Record<string, unknown>;

      // F7: audience + challenge are REQUIRED (directly, or through the requester's own challenge
      // envelope). Without them the verifier would skip binding and return valid:true for any
      // structurally valid, unexpired token — so a leaked token verifies for any third party in-window.
      let audience = typeof body.audience === 'string' ? body.audience : '';
      let challenge = typeof body.challenge === 'string' ? body.challenge : '';
      // §2.6: the predicates the requester named in its challenge envelope.
      let expectedPredicates: PredicateRequest[] | null = normalizePredicateRequests(body.predicates);
      if (expectedPredicates === null) {
        res.status(400).json({ valid: false, error: 'predicates is malformed (field, op gte|gt|lte|lt|eq|in, threshold | set)' });
        return;
      }
      // 2026-10-10: the disclosure requests the requester named (explicit list or from its envelope).
      let expectedDisclosures: CanonicalDisclosureRequest[] | null = normalizeDisclosureRequests(body.disclosures);
      if (expectedDisclosures === null) {
        res.status(400).json({ valid: false, error: 'disclosures is malformed ({kind:pe, output_digest, issuer?, fields?, content?} | {kind:witness, issuer?|signer?, limit?, fields?, content?})' });
        return;
      }
      // the presenter the requester addressed (address or wallet id); mismatch is refused.
      let expectedPresenter = typeof body.expected_presenter === 'string' ? body.expected_presenter.trim() : '';
      let challengeDeadline: number | undefined;
      let expectedRequester: PresentationRequester | undefined;

      // `challenge_envelope` the requester's own (signed or unsigned) challenge. It carries
      // every expectation (audience, challenge, predicates, presenter, deadline). Verify stays
      // stateless and fetches nothing off-relay: the envelope here is the requester's statement of
      // what it issued; its signature was for the PRESENTER, and the relay already verified it at
      // issuance for a v2 presentation (whose requester block the relay then signed).
      if (body.challenge_envelope !== undefined) {
        const env = parseChallengeEnvelope(body.challenge_envelope);
        if (!env) {
          res.status(400).json({ valid: false, error: 'challenge_envelope is malformed' });
          return;
        }
        if (isSignedChallenge(env)) {
          const structural = checkSignedStructure(env);
          if (structural) {
            res.status(400).json({ valid: false, error: `challenge_envelope is not a valid signed challenge (${structural})` });
            return;
          }
          const r = env.requester!;
          expectedRequester = r.type === 'wallet' ? { type: 'wallet', id: r.id, address: r.address } : { type: 'domain', id: r.id };
        }
        const envPredicates = env.predicates ?? [];
        const envDisclosures = env.disclosures ?? [];
        const disagree = (audience && audience !== env.audience)
          || (expectedDisclosures.length > 0 && (expectedDisclosures.length !== envDisclosures.length
            || !expectedDisclosures.every((d) => envDisclosures.some((e) => disclosureRequestMatches(e, d)))))
          || (challenge && challenge !== env.challenge)
          || (expectedPredicates.length > 0 && (expectedPredicates.length !== envPredicates.length
            || !expectedPredicates.every((p) => envPredicates.some((e) => predicateMatchesRequest(e, p)))))
          || (expectedPresenter && env.presenter && expectedPresenter.toLowerCase() !== env.presenter);
        if (disagree) {
          res.status(400).json({ valid: false, error: 'explicit audience/challenge/predicates/expected_presenter disagree with challenge_envelope' });
          return;
        }
        audience = env.audience;
        challenge = env.challenge;
        expectedPredicates = [...envPredicates];
        expectedDisclosures = [...envDisclosures];
        if (!expectedPresenter && env.presenter) expectedPresenter = env.presenter;
        if (typeof env.expiresAt === 'number' && Number.isFinite(env.expiresAt)) challengeDeadline = env.expiresAt;
      }
      if (audience.length === 0 || challenge.length === 0) {
        res.status(400).json({ valid: false, error: 'audience and challenge are required' });
        return;
      }

      let presentation: Presentation | null = null;
      if (typeof body.token === 'string') {
        presentation = decodePresentationToken(body.token);
      } else if (typeof body.presentation === 'object' && body.presentation !== null) {
        presentation = body.presentation as Presentation;
      }
      if (!presentation) {
        res.status(400).json({ valid: false, error: 'a presentation `token` or `presentation` object is required' });
        return;
      }

      const material = loadCommerceAttestationKeys(deps.env ?? process.env);
      const publicKeys = material.ok ? material.keys : [];

      const result = await verifyPresentation(presentation, {
        publicKeys,
        expectedAudience: audience,
        expectedChallenge: challenge,
        expectedPredicates,
        ...(expectedDisclosures.length > 0 ? { expectedDisclosures } : {}),
        ...(expectedPresenter ? { expectedPresenter } : {}),
        ...(challengeDeadline !== undefined ? { challengeDeadline } : {}),
        ...(expectedRequester ? { expectedRequester } : {}),
        // ethers.Contract exposes methods dynamically; the read-only PEAnchor
        // contract has verifyPE (the same call pe-verify makes).
        peAnchorContract: (deps.peAnchorContract as unknown as {
          verifyPE(batchId: string, peHash: string, proof: string[]): Promise<boolean>;
        } | null) ?? null,
      });

      if (result.valid && result.tier === 'reputation') {
        // §2.6/§2.7: the verifier returns the predicate results and the standing — never the chain,
        // never a payload to re-mine — and records nothing (verify is stateless).
        res.json({
          valid: true,
          tier: 'reputation',
          onchain_checked: result.onchain_checked,
          // the dedupe key (the burn id — one burn backs one presentation, globally). The relay
          // records nothing; a gate that grants a benefit accepts each presentation_id once.
          presentation_id: result.presentation_id,
          presenter_address: result.payload.presenter_address,
          sub: result.sub,
          requester: result.requester,
          challenge_expires_at: result.challenge_expires_at,
          predicates: result.predicates ?? [],
          standing: result.standing ?? {},
          disclosed: result.disclosed ?? {},
          redacted: result.payload.reputation?.redacted ?? [],
          // 2026-10-10: the requester-named disclosure answers (each record checked against its proof).
          disclosures: result.disclosures ?? [],
        });
      } else if (result.valid) {
        res.json({
          valid: true,
          tier: result.tier,
          onchain_checked: result.onchain_checked,
          presentation_id: result.presentation_id,
          presenter_address: result.payload.presenter_address,
          sub: result.sub,
          requester: result.requester,
          challenge_expires_at: result.challenge_expires_at,
          payload: result.payload,
        });
      } else {
        res.json({ valid: false, reason: result.reason });
      }
    } catch (error) {
      console.error('[Present] verify error:', error);
      res.status(500).json({ valid: false, error: 'Internal server error' });
    }
  });

  return router;
}
