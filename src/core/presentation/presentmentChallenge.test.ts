import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initialPresentmentChallenge, initialPresentmentEnvelope } from './presentmentChallenge';
import { verifyChallengeEnvelope } from './challengeEnvelope';

const HEX = 'ab'.repeat(32);

describe('initialPresentmentChallenge', () => {
    it('selfChallenge with no requester challenge → a fresh nonce long enough to present (RED if empty)', () => {
        const c = initialPresentmentChallenge({ selfChallenge: true }, () => HEX);
        expect(c).toBe(HEX);
        // The screen enables Present only at ≥ 16 chars; an empty challenge is the defect.
        expect(c.trim().length).toBeGreaterThanOrEqual(16);
    });

    it("a requester's challenge wins over selfChallenge", () => {
        expect(initialPresentmentChallenge({ challenge: 'req-nonce-123456789', selfChallenge: true }, () => HEX)).toBe('req-nonce-123456789');
    });

    it('no selfChallenge and no challenge → empty (the person types it) and no nonce is drawn', () => {
        let drawn = 0;
        expect(initialPresentmentChallenge({}, () => { drawn++; return HEX; })).toBe('');
        expect(initialPresentmentChallenge(undefined, () => { drawn++; return HEX; })).toBe('');
        expect(drawn).toBe(0);
    });
});

describe('HumanPresentmentScreen wiring', () => {
    it('initialises the challenge through the helper (no screen-local nonce flag read before its declaration)', () => {
        const src = readFileSync(resolve(__dirname, '..', '..', 'screens', 'Presentment', 'HumanPresentmentScreen.tsx'), 'utf8');
        const init = src.indexOf('useState(() => initialPresentmentChallenge(');
        expect(init).toBeGreaterThan(-1);
        expect(src).not.toMatch(/\bgenerateNonce\b/);
    });
});

describe('initialPresentmentEnvelope ', () => {
    const SIGNED = {
        v: 1, audience: 'wallet_aw_test1', challenge: 'b'.repeat(64), issuedAt: 1790000000, expiresAt: 1790003600,
        requester: { type: 'wallet', id: 'wallet_aw_test1', address: '0x5e645329ea23a84d6fb6006376f0b2b5e3b575f5', kid: 'provian-commerce-2026-08a' },
        sig: '3T4r5igsr6mP2cyg34xzcnzFFYu-KOOMp23lJ6YR7wHgQNmTvcOI_7UbcLQDo30-7ld1efnQc2UQXAvMCDapDA',
    };
    it('a thread / remote request carrying a signed envelope opens with it', () => {
        const env = initialPresentmentEnvelope({ audience: 'x', challenge: 'y'.repeat(16), challengeEnvelope: SIGNED });
        expect(env?.requester?.id).toBe('wallet_aw_test1');
        expect(env?.challenge).toBe('b'.repeat(64));
    });
    it('audience + challenge without an envelope → an UNSIGNED envelope (shown unverified)', () => {
        const env = initialPresentmentEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64), predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] });
        expect(env).toEqual({ audience: 'gate.example.com', challenge: 'a'.repeat(64), predicates: [{ field: 'work.total', op: 'gte', threshold: 1 }] });
    });
    it('a Commons self-challenge has no requester envelope', () => {
        expect(initialPresentmentEnvelope({ audience: 'provian:commons', selfChallenge: true })).toBeNull();
        expect(initialPresentmentEnvelope(undefined)).toBeNull();
    });
    it('RED: a malformed envelope is never downgraded to unsigned — it verifies INVALID', async () => {
        const env = initialPresentmentEnvelope({ audience: 'gate.example.com', challenge: 'a'.repeat(64), challengeEnvelope: { garbage: true } });
        expect(env).not.toBeNull();
        const v = await verifyChallengeEnvelope(env!, { nowSeconds: 1790000500 });
        expect(v.status).toBe('invalid');
    });
});
