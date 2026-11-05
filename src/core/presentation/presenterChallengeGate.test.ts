/**
 * A.3 — the presenter screen can never START a burn for an invalid / expired / not-addressed
 * challenge. `presenterBurnDecision` is the one function the screen's `ready` flag and its
 * `doPresent` both consult, so these cases are the burn gate itself.
 */
import { describe, it, expect } from 'vitest';
import { presenterBurnDecision } from './presenterChallengeGate';
import { parseChallengeEnvelope, verifyChallengeEnvelope, type ChallengeEnvelope, type ChallengeVerdict, type RequesterJwk } from './challengeEnvelope';

const KEYS: RequesterJwk[] = [{ kty: 'OKP', crv: 'Ed25519', x: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg', kid: 'provian-commerce-2026-08a' }];
const SIGNED: ChallengeEnvelope = {
    v: 1,
    audience: 'wallet_aw_test1',
    challenge: 'b'.repeat(64),
    issuedAt: 1790000000,
    expiresAt: 1790003600,
    requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' },
    sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
};
const NOW = 1790000500;

function form(env: ChallengeEnvelope, extra: Partial<{ tier: 'reputation' | 'pe_fact'; nowSeconds: number; audience: string; challenge: string }> = {}) {
    return { audience: env.audience, challenge: env.challenge, tier: 'reputation' as const, nowSeconds: NOW, ...extra };
}

describe('presenterBurnDecision', () => {
    it('verified → allowed, and the signed envelope rides to /present', async () => {
        const verdict = await verifyChallengeEnvelope(SIGNED, { provianKeys: KEYS, nowSeconds: NOW });
        expect(verdict.status).toBe('verified');
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED) })).toEqual({ allowed: true, signedEnvelope: SIGNED });
    });

    it('unverified (unsigned legacy) → allowed, nothing rides (v1)', async () => {
        const env = parseChallengeEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64) })!;
        const verdict = await verifyChallengeEnvelope(env, { nowSeconds: NOW });
        expect(presenterBurnDecision({ envelope: env, verdict, ...form(env) })).toEqual({ allowed: true, signedEnvelope: null });
    });

    it('no envelope (typed by hand / a Commons self-challenge) → allowed, unsigned', () => {
        expect(presenterBurnDecision({ envelope: null, verdict: null, audience: 'provian:commons', challenge: 'c'.repeat(64), tier: 'reputation', nowSeconds: NOW }))
            .toEqual({ allowed: true, signedEnvelope: null });
    });

    it('RED: invalid (bad signature) → no burn', async () => {
        const tampered = { ...SIGNED, challenge: 'c'.repeat(64) };
        const verdict = await verifyChallengeEnvelope(tampered, { provianKeys: KEYS, nowSeconds: NOW });
        expect(verdict.status).toBe('invalid');
        expect(presenterBurnDecision({ envelope: tampered, verdict, ...form(tampered) })).toEqual({ allowed: false, refusal: 'invalid' });
    });

    it('RED: requester key unreachable → no burn, said as such', async () => {
        const verdict = await verifyChallengeEnvelope(SIGNED, { provianKeys: null, nowSeconds: NOW });
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED) })).toEqual({ allowed: false, refusal: 'key_unreachable' });
    });

    it('RED: expired at scan → no burn', async () => {
        const verdict = await verifyChallengeEnvelope(SIGNED, { provianKeys: KEYS, nowSeconds: 1790003600 + 61 });
        expect(verdict.status).toBe('expired');
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED) })).toEqual({ allowed: false, refusal: 'expired' });
    });

    it('RED: verified at scan, expired by the time of the tap → no burn', async () => {
        const verdict = await verifyChallengeEnvelope(SIGNED, { provianKeys: KEYS, nowSeconds: NOW });
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED, { nowSeconds: 1790003600 + 61 }) })).toEqual({ allowed: false, refusal: 'expired' });
    });

    it('RED: not addressed to me → no burn', async () => {
        const addressed = { ...SIGNED, presenter: '0x1111111111111111111111111111111111111111' };
        // Built with a real signature below would need the key; the verdict type is what the gate reads.
        const verdict: ChallengeVerdict = { status: 'not_addressed', requester: { type: 'wallet', id: 'wallet_aw_test1' }, envelope: addressed };
        expect(presenterBurnDecision({ envelope: addressed, verdict, ...form(addressed) })).toEqual({ allowed: false, refusal: 'not_addressed' });
    });

    it('RED: still checking, or a verdict for a different envelope → no burn', async () => {
        expect(presenterBurnDecision({ envelope: SIGNED, verdict: null, ...form(SIGNED) })).toEqual({ allowed: false, refusal: 'checking' });
        const other = { ...SIGNED };
        const verdict = await verifyChallengeEnvelope(other, { provianKeys: KEYS, nowSeconds: NOW });
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED) })).toEqual({ allowed: false, refusal: 'checking' });
    });

    it('RED: the form no longer matches the verified envelope → no burn', async () => {
        const verdict = await verifyChallengeEnvelope(SIGNED, { provianKeys: KEYS, nowSeconds: NOW });
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED, { audience: 'someone-else' }) })).toEqual({ allowed: false, refusal: 'mismatch' });
    });

    it('RED: predicates asked but tier is pe_fact → no burn', async () => {
        const env = parseChallengeEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64), predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] })!;
        const verdict = await verifyChallengeEnvelope(env, { nowSeconds: NOW });
        expect(presenterBurnDecision({ envelope: env, verdict, ...form(env, { tier: 'pe_fact' }) })).toEqual({ allowed: false, refusal: 'needs_reputation' });
        expect(presenterBurnDecision({ envelope: env, verdict, ...form(env, { tier: 'reputation' }) }).allowed).toBe(true);
    });

    it('RED: an "unverified" verdict over a signed envelope is Unknown → no burn', () => {
        const verdict: ChallengeVerdict = { status: 'unverified', envelope: SIGNED };
        expect(presenterBurnDecision({ envelope: SIGNED, verdict, ...form(SIGNED) })).toEqual({ allowed: false, refusal: 'invalid' });
    });
});

describe('HumanPresentmentScreen wiring ', () => {
    it('the burn button and doPresent both consult presenterBurnDecision', async () => {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        const src = readFileSync(resolve(__dirname, '..', '..', 'screens', 'Presentment', 'HumanPresentmentScreen.tsx'), 'utf8');
        // `ready` includes the decision, and doPresent re-decides at tap time before the burn
        // (obtainBroadcastBurn — the burn is broadcast there and recorded inside /present).
        expect(src).toMatch(/const ready = [^;]*gate\.allowed/);
        const present = src.indexOf('const doPresent');
        const decide = src.indexOf('presenterBurnDecision(', present);
        const burn = src.indexOf('obtainBroadcastBurn(', present);
        expect(decide).toBeGreaterThan(present);
        expect(burn).toBeGreaterThan(decide);
    });
});
