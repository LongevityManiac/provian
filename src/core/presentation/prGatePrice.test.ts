import { describe, expect, it } from 'vitest';
import { provianPrGatePrice } from './prGatePrice';
import type { ChallengeEnvelope, ChallengeVerdict } from './challengeEnvelope';

const envelope: ChallengeEnvelope = { audience: 'provian.ai', challenge: `github-pr:1447355401:1:123:${'a'.repeat(64)}`,
    requester: { type: 'domain', id: 'provian.ai', kid: 'test' } };
const verified: ChallengeVerdict = { status: 'verified', requester: { type: 'domain', id: 'provian.ai' }, envelope };
describe('verified repository gate price', () => {
    it('uses the gate’s 50 PVT price on both repository challenges', () => {
        expect(provianPrGatePrice(envelope, verified)).toBe(50);
        expect(provianPrGatePrice({ ...envelope, challenge: envelope.challenge.replace('1447355401', '1412438684') }, verified)).toBe(50);
    });
    it('RED: unverified, still checking, another requester and unrelated challenges leave tier fees alone', () => {
        expect(provianPrGatePrice(envelope, null)).toBeNull();
        expect(provianPrGatePrice(envelope, { status: 'unverified', envelope })).toBeNull();
        expect(provianPrGatePrice({ ...envelope, audience: 'other.example' }, verified)).toBeNull();
        expect(provianPrGatePrice({ ...envelope, challenge: 'a'.repeat(64) }, verified)).toBeNull();
        expect(provianPrGatePrice({ ...envelope, challenge: envelope.challenge.replace('1447355401', '999') }, verified)).toBeNull();
        // The retired pre-reset repository ID no longer prices a gate.
        expect(provianPrGatePrice({ ...envelope, challenge: envelope.challenge.replace('1447355401', '1413551048') }, verified)).toBeNull();
    });
});

it('blocks the owner flow only for verified Provian PR challenges', async () => {
    const { provianPrGateOwnerExempt } = await import('./prGatePrice');
    const owner = { ...envelope, challenge: envelope.challenge.replace(':123:', ':229043875:') };
    expect(provianPrGateOwnerExempt(owner, verified)).toBe(true);
    expect(provianPrGateOwnerExempt(envelope, verified)).toBe(false);
    expect(provianPrGateOwnerExempt(owner, null)).toBe(false);
    expect(provianPrGateOwnerExempt({ ...owner, audience: 'other.example' }, verified)).toBe(false);
});
