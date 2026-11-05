/**
 * Tests for mobileChatConsent. AsyncStorage is mocked to an in-memory
 * Map so we can exercise malformed values and throw-paths without
 * touching a real native module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Storage = { [key: string]: string };
let storage: Storage;
let throwOnGet = false;
let throwOnSet = false;
let throwOnRemove = false;

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        async getItem(key: string): Promise<string | null> {
            if (throwOnGet) throw new Error('get boom');
            return Object.prototype.hasOwnProperty.call(storage, key)
                ? storage[key]
                : null;
        },
        async setItem(key: string, value: string): Promise<void> {
            if (throwOnSet) throw new Error('set boom');
            storage[key] = value;
        },
        async removeItem(key: string): Promise<void> {
            if (throwOnRemove) throw new Error('remove boom');
            delete storage[key];
        },
    },
}));

import {
    CAPTURE_CONSENT_KEY,
    USAGE_STATS_CONSENT_KEY,
    getMobileChatConsent,
    setMobileChatConsent,
    clearMobileChatConsent,
    chatHomeGate,
    shouldRunCapturePipeline,
    getUsageStatsConsent,
    setUsageStatsConsent,
    clearUsageStatsConsent,
    shouldRunUsageStatsPipeline,
} from '../mobileChatConsent';

beforeEach(() => {
    storage = {};
    throwOnGet = false;
    throwOnSet = false;
    throwOnRemove = false;
});

describe('mobileChatConsent: persistence', () => {
    it('returns null when the key has never been set', async () => {
        expect(await getMobileChatConsent()).toBeNull();
    });

    it('round-trips true', async () => {
        await setMobileChatConsent(true);
        expect(await getMobileChatConsent()).toBe(true);
    });

    it('round-trips false', async () => {
        await setMobileChatConsent(false);
        expect(await getMobileChatConsent()).toBe(false);
    });

    it('is idempotent on repeated set', async () => {
        await setMobileChatConsent(true);
        await setMobileChatConsent(true);
        await setMobileChatConsent(true);
        expect(await getMobileChatConsent()).toBe(true);
    });

    it('clearMobileChatConsent returns subsequent reads to null', async () => {
        await setMobileChatConsent(true);
        expect(await getMobileChatConsent()).toBe(true);
        await clearMobileChatConsent();
        expect(await getMobileChatConsent()).toBeNull();
    });

    it('stores under the advertised key', async () => {
        await setMobileChatConsent(true);
        expect(storage[CAPTURE_CONSENT_KEY]).toBe('true');
    });

    it('treats malformed JSON as null rather than throwing', async () => {
        storage[CAPTURE_CONSENT_KEY] = 'not valid json';
        expect(await getMobileChatConsent()).toBeNull();
    });

    it('treats non-boolean parsed values as null', async () => {
        storage[CAPTURE_CONSENT_KEY] = '"yes"';
        expect(await getMobileChatConsent()).toBeNull();
    });

    it('returns null when AsyncStorage.getItem throws', async () => {
        await setMobileChatConsent(true);
        throwOnGet = true;
        expect(await getMobileChatConsent()).toBeNull();
    });

    it('swallows set errors without throwing', async () => {
        throwOnSet = true;
        await expect(setMobileChatConsent(true)).resolves.toBeUndefined();
    });

    it('swallows clear errors without throwing', async () => {
        throwOnRemove = true;
        await expect(clearMobileChatConsent()).resolves.toBeUndefined();
    });
});

describe('mobileChatConsent: gate helpers', () => {
    it('chatHomeGate: loading sentinel maps to loading', () => {
        expect(chatHomeGate('loading')).toBe('loading');
    });

    it('chatHomeGate: null consent maps to decision', () => {
        expect(chatHomeGate(null)).toBe('decision');
    });

    it('chatHomeGate: true consent maps to picker', () => {
        expect(chatHomeGate(true)).toBe('picker');
    });

    it('chatHomeGate: false consent maps to declined', () => {
        expect(chatHomeGate(false)).toBe('declined');
    });

    it('shouldRunCapturePipeline: true only when consent is exactly true', () => {
        expect(shouldRunCapturePipeline(true)).toBe(true);
        expect(shouldRunCapturePipeline(false)).toBe(false);
        expect(shouldRunCapturePipeline(null)).toBe(false);
        expect(shouldRunCapturePipeline('loading')).toBe(false);
    });
});

describe('mobileChatConsent: UsageStats persistence', () => {
    it('returns null when the usage stats key has never been set', async () => {
        expect(await getUsageStatsConsent()).toBeNull();
    });

    it('round-trips UsageStats true', async () => {
        await setUsageStatsConsent(true);
        expect(await getUsageStatsConsent()).toBe(true);
    });

    it('round-trips UsageStats false', async () => {
        await setUsageStatsConsent(false);
        expect(await getUsageStatsConsent()).toBe(false);
    });

    it('is idempotent on repeated UsageStats set', async () => {
        await setUsageStatsConsent(true);
        await setUsageStatsConsent(true);
        expect(await getUsageStatsConsent()).toBe(true);
    });

    it('clearUsageStatsConsent returns subsequent reads to null', async () => {
        await setUsageStatsConsent(true);
        expect(await getUsageStatsConsent()).toBe(true);
        await clearUsageStatsConsent();
        expect(await getUsageStatsConsent()).toBeNull();
    });

    it('stores under the advertised UsageStats key', async () => {
        await setUsageStatsConsent(true);
        expect(storage[USAGE_STATS_CONSENT_KEY]).toBe('true');
    });

    it('Chat capture and UsageStats consent are independent', async () => {
        await setMobileChatConsent(true);
        await setUsageStatsConsent(false);
        expect(await getMobileChatConsent()).toBe(true);
        expect(await getUsageStatsConsent()).toBe(false);
    });

    it('treats malformed UsageStats JSON as null rather than throwing', async () => {
        storage[USAGE_STATS_CONSENT_KEY] = 'not valid json';
        expect(await getUsageStatsConsent()).toBeNull();
    });

    it('returns null when AsyncStorage.getItem throws on UsageStats read', async () => {
        await setUsageStatsConsent(true);
        throwOnGet = true;
        expect(await getUsageStatsConsent()).toBeNull();
    });

    it('swallows UsageStats set errors without throwing', async () => {
        throwOnSet = true;
        await expect(setUsageStatsConsent(true)).resolves.toBeUndefined();
    });

    it('shouldRunUsageStatsPipeline: true only when consent is exactly true', () => {
        expect(shouldRunUsageStatsPipeline(true)).toBe(true);
        expect(shouldRunUsageStatsPipeline(false)).toBe(false);
        expect(shouldRunUsageStatsPipeline(null)).toBe(false);
        expect(shouldRunUsageStatsPipeline('loading')).toBe(false);
    });
});
