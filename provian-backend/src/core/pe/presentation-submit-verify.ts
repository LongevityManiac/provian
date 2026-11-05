/**
 * verify-at-submit — verify a remote-channel presentation the INSTANT the
 * agent submits it, while the token is still fresh.
 *
 * WHY THIS EXISTS. A presentation token is a short-lived proof of live-key
 * possession + burn: its validity window is capped at PRESENTATION_MAX_TTL_SECONDS
 * (15 min) on BOTH the signer and the verifier, deliberately. That is fine for the
 * in-person burn-to-present flow (the counterparty verifies immediately). But the
 * REMOTE channel is asynchronous — the agent presents to an ABSENT human who
 * returns hours later, by which time the token has expired and a re-verify returns
 * `expired`. So the relay verifies the fresh token here, at submit time, against the
 * request's own audience/challenge/predicates, and stores the resulting verdict on
 * the request. The human then READS that relay-attested fresh verdict rather than
 * re-verifying a stale token. No new tier, no burn-free path, no weakening of the
 * 15-min window — the exact same public `/v1/present/verify` check, run at the only
 * moment it can succeed.
 *
 * Pure w.r.t. Firestore (no DB), so it is unit-testable with injected keys. Never
 * throws — a decode/verify failure yields `verdict: 'invalid'` with a reason, which
 * is the honest, fail-closed record of an unverifiable presentation.
 */

import { decodePresentationToken } from '../presentation/types';
import { verifyPresentation } from '../presentation/verify';
import { normalizePredicateRequests } from '../presentation/disclosure';
import type { CommerceAttestationPublicJwk } from '../presentation/jws-key-material';
import type { ChallengeEnvelope } from '../presentation/challenge';

export interface FreshVerdict {
  readonly verdict: 'valid' | 'invalid';
  readonly predicate_results: unknown[];
  /** true when a pe_fact's anchor proofs were verified against the canonical PEAnchor on Base. */
  readonly onchain_checked?: boolean;
  readonly reason?: string;
  /**
   * WHOSE record the verified presentation describes, read from the co-signed payload (never
   * from the submitter): the presenter identity handle (`sub`), its address, and the burn the
   * presentation consumed. Present only on a `valid` verdict. A caller that lets a THIRD party's
   * token answer for the submitter must compare these to the submitter (nonce-gap control).
   */
  readonly presenter?: { readonly sub: string; readonly presenter_address: string; readonly burn_id: string };
}

export interface VerifyFreshDeps {
  readonly publicKeys: readonly CommerceAttestationPublicJwk[];
  /** pe_fact on-chain proof check; null for reputation-tier (predicate) presentations. */
  readonly peAnchorContract?: {
    verifyPE(batchId: string, peHash: string, proof: string[]): Promise<boolean>;
  } | null;
}

/**
 * Verify a just-submitted presentation token against the request binding it must
 * answer. `audience`/`challenge` are the human's composed challenge; `predicates`
 * are what the human demanded. Returns the fresh verdict + the answered predicate
 * results to persist. Fails closed to `invalid` on any decode/verify failure.
 */
export async function verifyFreshPresentationToken(
  input: {
    token: string;
    audience: string | null;
    challenge: string | null;
    predicates: unknown;
    /** the relay-signed challenge this request carries — its deadline and requester are enforced. */
    challengeEnvelope?: ChallengeEnvelope | null;
  },
  deps: VerifyFreshDeps,
): Promise<FreshVerdict> {
  if (!input.token || !input.audience || !input.challenge) {
    return { verdict: 'invalid', predicate_results: [], reason: 'missing_binding' };
  }
  const presentation = decodePresentationToken(input.token);
  if (!presentation) {
    return { verdict: 'invalid', predicate_results: [], reason: 'malformed_token' };
  }
  // Fail closed: a stored predicate list that does not parse is not "no predicates".
  const expectedPredicates = normalizePredicateRequests(input.predicates);
  if (expectedPredicates === null) {
    return { verdict: 'invalid', predicate_results: [], reason: 'malformed_predicates' };
  }
  const env = input.challengeEnvelope ?? null;
  const r = env?.requester;
  const result = await verifyPresentation(presentation, {
    publicKeys: deps.publicKeys,
    expectedAudience: input.audience,
    expectedChallenge: input.challenge,
    expectedPredicates,
    ...(env && typeof env.expiresAt === 'number' ? { challengeDeadline: env.expiresAt } : {}),
    ...(env?.presenter ? { expectedPresenter: env.presenter } : {}),
    ...(r ? { expectedRequester: r.type === 'wallet' ? { type: 'wallet' as const, id: r.id, address: r.address } : { type: 'domain' as const, id: r.id } } : {}),
    peAnchorContract: deps.peAnchorContract ?? null,
  });
  // item 3: a relay-attested pe_fact verdict is only VALID when the chain was actually checked
  // (the canonical PEAnchor was reachable and every proof verified) — never a structural-only pass.
  if (result.valid && result.tier === 'pe_fact' && !result.onchain_checked) {
    return { verdict: 'invalid', predicate_results: [], reason: 'pe_fact_onchain_unchecked' };
  }
  if (result.valid) {
    return {
      verdict: 'valid',
      onchain_checked: result.onchain_checked,
      predicate_results: result.predicates ?? [],
      presenter: {
        // The SIGNED subject only : the bare pe_fact payload `sub` is unsigned.
        sub: result.sub ?? '',
        presenter_address: String(presentation.payload.presenter_address ?? '').toLowerCase(),
        burn_id: presentation.payload.burn_id,
      },
    };
  }
  return { verdict: 'invalid', predicate_results: [], reason: result.reason };
}
