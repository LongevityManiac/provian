/**
 * L-24 (Chunk I follow-up) regression tests for DevHostDiscovery.
 *
 * The pre-existing G-3 SECURITY FIX guard at the bottom of
 * resolveRelayBaseUrl was intended to "never return an HTTP URL in
 * production" but only ran for the PRODUCTION_RELAY_URL fallback branch.
 * A misconfigured EXPO_PUBLIC_PROVIAN_RELAY_URL=http://... baked into a
 * release build would have shipped over plain HTTP. Tightened to fire
 * on every non-DEV return path; these tests pin the new contract.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { resolveRelayBaseUrl } from '../DevHostDiscovery';

const ORIGINAL_DEV = (globalThis as { __DEV__?: boolean }).__DEV__;
const ORIGINAL_ENV = process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL;

afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = ORIGINAL_DEV;
    if (ORIGINAL_ENV === undefined) {
        delete process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL;
    } else {
        process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL = ORIGINAL_ENV;
    }
});

beforeEach(() => {
    delete process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL;
});

describe('resolveRelayBaseUrl in production (__DEV__ = false)', () => {
    it('throws on a non-HTTPS env override (L-24 fix)', () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL = 'http://api.example.com';
        expect(() => resolveRelayBaseUrl()).toThrow(/HTTPS/);
    });

    it('accepts an HTTPS env override', () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL = 'https://staging.provian.ai';
        expect(resolveRelayBaseUrl()).toBe('https://staging.provian.ai');
    });

    it('returns the HTTPS production fallback when no env override is set', () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        const url = resolveRelayBaseUrl();
        expect(url).toMatch(/^https:\/\//);
        expect(url).toBe('https://api.provian.ai');
    });

    it('rejects a malformed env override (e.g. ws://)', () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL = 'ws://api.example.com';
        expect(() => resolveRelayBaseUrl()).toThrow(/HTTPS/);
    });
});

describe('resolveRelayBaseUrl in dev (__DEV__ = true)', () => {
    it('accepts a non-HTTPS env override (dev convenience)', () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        process.env.EXPO_PUBLIC_PROVIAN_RELAY_URL = 'http://192.168.1.100:8787';
        expect(resolveRelayBaseUrl()).toBe('http://192.168.1.100:8787');
    });

    // Dev-discovery fallback path is intentionally NOT covered here because
    // exercising it loads expo-constants, which the vitest runtime cannot
    // transform (see DevHostDiscovery.ts header comment). The path is
    // gated on __DEV__ === true, so the L-24 prod-HTTPS guard never
    // applies to it; the env-override and prod-fallback branches above
    // cover the security-relevant cases.
});
