import type { ChallengeEnvelope, ChallengeVerdict } from './challengeEnvelope';

/** Provian's repository price applies only after its domain signature verifies. */
export function provianPrGatePrice(envelope: ChallengeEnvelope | null, verdict: ChallengeVerdict | null): number | null {
    if (verdict?.status !== 'verified' || verdict.requester.type !== 'domain' || verdict.requester.id !== 'provian.ai' ||
        envelope?.audience !== 'provian.ai' || envelope.requester?.type !== 'domain' || envelope.requester.id !== 'provian.ai') return null;
    return /^github-pr:(1447355401|1412438684):[1-9][0-9]*:[1-9][0-9]*:[0-9a-f]{64}$/.test(envelope.challenge) ? 50 : null;
}

/** An old signed owner challenge must never offer a paid presenter flow. */
export function provianPrGateOwnerExempt(envelope: ChallengeEnvelope | null, verdict: ChallengeVerdict | null): boolean {
    return provianPrGatePrice(envelope, verdict) !== null && envelope?.challenge.split(':')[3] === '229043875';
}
