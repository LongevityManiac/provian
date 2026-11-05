/**
 * The presenter's pre-burn decision (A.3), kept out of the screen so it is testable.
 *
 * Before ANY burn the presenter screen parses the requester's challenge and verifies it
 * (`verifyChallengeEnvelope`). This function turns that verdict — plus what is on the form right
 * now — into one answer: may a burn start, and if so which envelope rides to `/present`.
 *
 * no envelope (typed by hand / a Commons self-challenge) → allowed, unsigned (v1)
 * envelope, verdict not yet computed (or stale) → blocked: checking
 * unverified (unsigned legacy) → allowed, unsigned (v1)
 * verified → allowed, the envelope rides (v2)
 * invalid / expired / not_addressed → REFUSED (Unknown = Block)
 *
 * A verified envelope is re-checked against the clock at tap time (it may have expired while the
 * person read the screen) and against the form (the audience/challenge being signed must be the
 * envelope's). A challenge that names predicates only a reputation presentation answers.
 */

import {
    CHALLENGE_CLOCK_SKEW_SECONDS,
    isSignedChallenge,
    type ChallengeEnvelope,
    type ChallengeVerdict,
} from './challengeEnvelope';
import type { PresentationTier } from './humanPresentation';

export type PresenterRefusal =
    | 'checking'
    | 'invalid'
    | 'key_unreachable'
    | 'expired'
    | 'not_addressed'
    | 'mismatch'
    | 'needs_reputation';

export type PresenterBurnDecision =
    | { readonly allowed: true; readonly signedEnvelope: ChallengeEnvelope | null }
    | { readonly allowed: false; readonly refusal: PresenterRefusal };

export function presenterBurnDecision(input: {
    envelope: ChallengeEnvelope | null;
    verdict: ChallengeVerdict | null;
    audience: string;
    challenge: string;
    tier: PresentationTier;
    nowSeconds: number;
}): PresenterBurnDecision {
    const { envelope, verdict } = input;
    if (envelope === null) return { allowed: true, signedEnvelope: null };
    // A verdict for a different envelope (the person scanned a new one) is no verdict at all.
    if (verdict === null || verdict.envelope !== envelope) return { allowed: false, refusal: 'checking' };
    switch (verdict.status) {
        case 'invalid':
            return { allowed: false, refusal: verdict.reason === 'requester_key_unreachable' ? 'key_unreachable' : 'invalid' };
        case 'expired':
            return { allowed: false, refusal: 'expired' };
        case 'not_addressed':
            return { allowed: false, refusal: 'not_addressed' };
        case 'verified':
        case 'unverified':
            break;
        default:
            return { allowed: false, refusal: 'invalid' };
    }
    if (input.audience.trim() !== envelope.audience || input.challenge.trim() !== envelope.challenge) {
        return { allowed: false, refusal: 'mismatch' };
    }
    if ((envelope.predicates?.length ?? 0) > 0 && input.tier !== 'reputation') {
        return { allowed: false, refusal: 'needs_reputation' };
    }
    if (verdict.status === 'verified') {
        // A verified verdict must be for a signed envelope with a deadline — anything else is Unknown.
        if (!isSignedChallenge(envelope) || typeof envelope.expiresAt !== 'number') return { allowed: false, refusal: 'invalid' };
        if (input.nowSeconds > envelope.expiresAt + CHALLENGE_CLOCK_SKEW_SECONDS) return { allowed: false, refusal: 'expired' };
        return { allowed: true, signedEnvelope: envelope };
    }
    // Unverified: an unsigned envelope never rides to /present (the presentation stays v1).
    if (isSignedChallenge(envelope)) return { allowed: false, refusal: 'invalid' };
    return { allowed: true, signedEnvelope: null };
}
