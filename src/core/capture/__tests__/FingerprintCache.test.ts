/**
 * FingerprintCache tests. Exercises 24-hour TTL pruning, add/has semantics,
 * persistence through the adapter, size tracking, malformed-payload
 * tolerance, and cap enforcement.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    FingerprintCache,
    FINGERPRINT_CACHE_TTL_MS,
    FINGERPRINT_CACHE_STORAGE_KEY,
    createMemoryStorage,
} from '../FingerprintCache';

type MemoryStorage = ReturnType<typeof createMemoryStorage>;

describe('FingerprintCache', () => {
    let storage: MemoryStorage;
    let cache: FingerprintCache;

    beforeEach(() => {
        storage = createMemoryStorage();
        cache = new FingerprintCache({ storage });
    });

    it('has returns false for a fingerprint that was never added', async () => {
        expect(await cache.has('not-there', 0)).toBe(false);
    });

    it('add then has returns true within the TTL', async () => {
        const now = 1_000_000;
        await cache.add('fp1', now);
        expect(await cache.has('fp1', now)).toBe(true);
        expect(await cache.has('fp1', now + FINGERPRINT_CACHE_TTL_MS - 1)).toBe(true);
    });

    it('prunes an entry when queried after TTL', async () => {
        const now = 1_000_000;
        await cache.add('fp1', now);
        const after = now + FINGERPRINT_CACHE_TTL_MS + 1;
        expect(await cache.has('fp1', after)).toBe(false);
    });

    it('retains entries exactly at the TTL boundary', async () => {
        const now = 1_000_000;
        await cache.add('fp1', now);
        // cutoff = now + TTL - TTL = now. Entry at now is not < cutoff, so retained.
        expect(await cache.has('fp1', now + FINGERPRINT_CACHE_TTL_MS)).toBe(true);
    });

    it('add triggers a write that persists a pruned payload', async () => {
        await cache.add('old', 0);
        await cache.add('new', FINGERPRINT_CACHE_TTL_MS + 5);
        const raw = storage.snapshot()[FINGERPRINT_CACHE_STORAGE_KEY];
        const parsed = JSON.parse(raw);
        expect(parsed).toEqual({ new: FINGERPRINT_CACHE_TTL_MS + 5 });
    });

    it('size reports the number of live entries after pruning', async () => {
        await cache.add('a', 1_000);
        await cache.add('b', 2_000);
        await cache.add('c', 3_000);
        expect(await cache.size(3_000)).toBe(3);
        expect(await cache.size(1_000 + FINGERPRINT_CACHE_TTL_MS + 1)).toBe(2);
    });

    it('ignores malformed storage contents instead of crashing', async () => {
        await storage.setItem(FINGERPRINT_CACHE_STORAGE_KEY, '{ not json');
        expect(await cache.has('fp1', 0)).toBe(false);
        // A subsequent add should still work.
        await cache.add('fp1', 0);
        expect(await cache.has('fp1', 0)).toBe(true);
    });

    it('ignores entries with non-numeric or future timestamps', async () => {
        await storage.setItem(
            FINGERPRINT_CACHE_STORAGE_KEY,
            JSON.stringify({
                valid: 100,
                stringish: 'oops',
                future: 1_000_000, // way past nowMs = 200 below
            }),
        );
        const now = 200;
        expect(await cache.has('valid', now)).toBe(true);
        expect(await cache.has('stringish', now)).toBe(false);
        expect(await cache.has('future', now)).toBe(false);
    });

    it('respects a custom TTL and storage key', async () => {
        const ttl = 60_000;
        const customCache = new FingerprintCache({
            storage,
            ttlMs: ttl,
            storageKey: 'custom-key',
        });
        await customCache.add('fp', 0);
        const snap = storage.snapshot();
        expect(snap['custom-key']).toBeDefined();
        expect(snap[FINGERPRINT_CACHE_STORAGE_KEY]).toBeUndefined();
        expect(await customCache.has('fp', ttl - 1)).toBe(true);
        expect(await customCache.has('fp', ttl + 1)).toBe(false);
    });

    it('enforces maxEntries cap by dropping oldest', async () => {
        const capped = new FingerprintCache({
            storage: createMemoryStorage(),
            maxEntries: 3,
        });
        await capped.add('a', 1_000);
        await capped.add('b', 2_000);
        await capped.add('c', 3_000);
        await capped.add('d', 4_000);
        expect(await capped.has('a', 4_000)).toBe(false);
        expect(await capped.has('b', 4_000)).toBe(true);
        expect(await capped.has('c', 4_000)).toBe(true);
        expect(await capped.has('d', 4_000)).toBe(true);
    });
});
