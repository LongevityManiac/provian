/**
 * item 6 — the in-app requester accepts each presentation_id ONCE. The relay verify is
 * stateless (the same token verifies again inside its window), so this seen-store is what makes an
 * accepted presentation single-use at this requester.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    claimPresentationOnce,
    acceptVerifiedPresentation,
    __resetAcceptedPresentationsForTest,
    ACCEPTED_PRESENTATIONS_KEY,
} from './acceptedPresentations';

function memStorage() {
    const m = new Map<string, string>();
    return {
        map: m,
        getItem: async (k: string) => m.get(k) ?? null,
        setItem: async (k: string, v: string) => { m.set(k, v); },
    };
}

const NOW = 1_790_000_000_000;
const VALID = { valid: true, tier: 'reputation', presentation_id: 'c'.repeat(64), challenge_expires_at: 1_790_000_900 };

beforeEach(() => __resetAcceptedPresentationsForTest());

describe('claimPresentationOnce', () => {
    it('first claim true, second false (RED if the store forgets)', async () => {
        const s = memStorage();
        expect(await claimPresentationOnce('pres-1', 1_790_000_900, { storage: s, nowMs: NOW })).toBe(true);
        expect(await claimPresentationOnce('pres-1', 1_790_000_900, { storage: s, nowMs: NOW + 1000 })).toBe(false);
        expect(JSON.parse(s.map.get(ACCEPTED_PRESENTATIONS_KEY)!)).toHaveProperty('pres-1');
    });

    it('survives an app restart (in-memory set cleared, storage keeps the id)', async () => {
        const s = memStorage();
        expect(await claimPresentationOnce('pres-2', 1_790_000_900, { storage: s, nowMs: NOW })).toBe(true);
        __resetAcceptedPresentationsForTest();
        expect(await claimPresentationOnce('pres-2', 1_790_000_900, { storage: s, nowMs: NOW + 1000 })).toBe(false);
    });

    it('a storage failure still refuses the second acceptance in this session', async () => {
        const broken = { getItem: async () => { throw new Error('disk'); }, setItem: async () => { throw new Error('disk'); } };
        expect(await claimPresentationOnce('pres-3', 1_790_000_900, { storage: broken, nowMs: NOW })).toBe(true);
        expect(await claimPresentationOnce('pres-3', 1_790_000_900, { storage: broken, nowMs: NOW })).toBe(false);
    });

    it('ids are pruned after the challenge deadline + skew', async () => {
        const s = memStorage();
        await claimPresentationOnce('old', 1_790_000_000, { storage: s, nowMs: NOW });
        await claimPresentationOnce('new', 1_790_000_900, { storage: s, nowMs: NOW + 61_000 });
        expect(Object.keys(JSON.parse(s.map.get(ACCEPTED_PRESENTATIONS_KEY)!))).toEqual(['new']);
    });

    it('RED: an empty id is never accepted', async () => {
        expect(await claimPresentationOnce('  ', 1_790_000_900, { storage: memStorage(), nowMs: NOW })).toBe(false);
    });
});

describe('acceptVerifiedPresentation', () => {
    it('accepts a valid reputation presentation once; the second time is already_accepted', async () => {
        const s = memStorage();
        const ctx = { predicatesAsked: 1, presenterMatches: true, storage: s, nowMs: NOW };
        expect(await acceptVerifiedPresentation(VALID, ctx)).toEqual({ accepted: true });
        expect(await acceptVerifiedPresentation(VALID, ctx)).toEqual({ accepted: false, reason: 'already_accepted' });
    });

    it('RED: predicates asked + a pe_fact tier is refused — and does not burn the id', async () => {
        const s = memStorage();
        const ctx = { predicatesAsked: 2, presenterMatches: true, storage: s, nowMs: NOW };
        expect(await acceptVerifiedPresentation({ ...VALID, tier: 'pe_fact' }, ctx)).toEqual({ accepted: false, reason: 'predicates_require_reputation_tier' });
        expect(s.map.size).toBe(0);
        // No predicates asked: a pe_fact presentation is acceptable.
        expect(await acceptVerifiedPresentation({ ...VALID, tier: 'pe_fact' }, { ...ctx, predicatesAsked: 0 })).toEqual({ accepted: true });
    });

    it('RED: not valid, wrong presenter, or no presentation_id is refused', async () => {
        const ctx = { predicatesAsked: 0, presenterMatches: true, storage: memStorage(), nowMs: NOW };
        expect(await acceptVerifiedPresentation({ ...VALID, valid: false }, ctx)).toEqual({ accepted: false, reason: 'not_valid' });
        expect(await acceptVerifiedPresentation(VALID, { ...ctx, presenterMatches: false })).toEqual({ accepted: false, reason: 'presenter_mismatch' });
        expect(await acceptVerifiedPresentation({ ...VALID, presentation_id: undefined }, ctx)).toEqual({ accepted: false, reason: 'presentation_id_missing' });
    });
});
