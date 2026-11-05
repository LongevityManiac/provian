import { parseChallengeEnvelope, type ChallengeEnvelope } from './challengeEnvelope';

/**
 * The challenge a presentation opens with. A requester's challenge (scanned QR, thread request,
 * forum challenge) wins; otherwise a caller that asks for `selfChallenge` the talking pass, a
 * vouch, a hire handshake, all of which bind on audience + window rather than a requester nonce —
 * gets a fresh random nonce; otherwise the field starts empty for the person to fill.
 *
 * Kept out of the screen so the rule is testable: 's reviewer caught the screen reading a
 * `const` declared below the `useState` initializer (TDZ), which left the challenge EMPTY in the
 * Hermes build and the present button permanently disabled for every selfChallenge caller.
 */
export interface PresentmentChallengeParams {
    challenge?: string;
    selfChallenge?: boolean;
}

export function initialPresentmentChallenge(
    params: PresentmentChallengeParams | undefined,
    randomHex: () => string,
): string {
    if (params?.challenge) return params.challenge;
    return params?.selfChallenge === true ? randomHex() : '';
}

/**
 * the requester's challenge envelope the presenter screen opens with — from a thread /
 * remote request that carries a relay-signed `challengeEnvelope`, else an unsigned envelope built
 * from the route's audience + challenge (+ predicates) so it is SHOWN as unverified. A Commons
 * self-challenge (talking pass, vouch, hire) has no requester envelope at all.
 */
export function initialPresentmentEnvelope(
    params: (PresentmentChallengeParams & { audience?: string; predicates?: unknown; challengeEnvelope?: unknown }) | undefined,
): ChallengeEnvelope | null {
    if (!params || params.selfChallenge === true) return null;
    if (params.challengeEnvelope !== undefined && params.challengeEnvelope !== null) {
        // A present-but-unparseable envelope is never silently downgraded to "unsigned" (Unknown =
        // Block): it becomes a signed-claim envelope with no valid structure, which verifies INVALID
        // and refuses the burn.
        return parseChallengeEnvelope(params.challengeEnvelope)
            ?? { audience: params.audience ?? '', challenge: params.challenge ?? '', sig: '' };
    }
    if (params.audience && params.challenge) {
        return parseChallengeEnvelope({ audience: params.audience, challenge: params.challenge, predicates: params.predicates });
    }
    return null;
}
