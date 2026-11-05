/**
 * Unit tests for the Grok timestamp-gap session boundary detector.
 *
 * M2 ships the detector only; M3 wires it into the full session state
 * machine. Tests cover the six cases called out in the M2 scope:
 * inside gap, at gap, past gap, zero elapsed, negative elapsed (clock
 * skew), and catalog-driven gap value override.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    detectGrokBoundary,
    getGrokGapSeconds,
    GROK_DEFAULT_GAP_SECONDS,
    GROK_PROVIDER_ID,
} from '../GrokSessionBoundary';
import { PROVIDER_CATALOG } from '../catalog';
import type { ProviderCatalog } from '../ProviderCatalog';

describe('detectGrokBoundary', () => {
    it('returns false when elapsed is inside the gap', () => {
        const gap = 300;
        expect(detectGrokBoundary(1_000_000, 1_000_000 + 299_999, gap)).toBe(false);
    });

    it('returns false at the exact gap boundary (strict greater-than)', () => {
        const gap = 300;
        expect(detectGrokBoundary(1_000_000, 1_000_000 + 300_000, gap)).toBe(false);
    });

    it('returns true one millisecond past the gap', () => {
        const gap = 300;
        expect(detectGrokBoundary(1_000_000, 1_000_000 + 300_001, gap)).toBe(true);
    });

    it('returns false when elapsed is exactly zero', () => {
        expect(detectGrokBoundary(1_000_000, 1_000_000, 300)).toBe(false);
    });

    it('returns false on negative elapsed (clock skew) and logs a warning', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = detectGrokBoundary(2_000_000, 1_000_000, 300);
            expect(result).toBe(false);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const message = warnSpy.mock.calls[0][0] as string;
            expect(message).toContain('[GrokSessionBoundary]');
            expect(message).toContain('negative elapsed');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('respects a caller-supplied gap override (catalog-driven, not hardcoded)', () => {
        // Gap override simulates a future governance-tuned value. Same
        // elapsed; the boundary decision flips based on gap alone.
        const elapsed = 90_000;
        expect(detectGrokBoundary(0, elapsed, 60)).toBe(true);
        expect(detectGrokBoundary(0, elapsed, 120)).toBe(false);
    });
});

describe('getGrokGapSeconds', () => {
    it('reads the shipped catalog and returns 300 for Grok', () => {
        expect(getGrokGapSeconds(PROVIDER_CATALOG)).toBe(300);
    });

    it('falls back to GROK_DEFAULT_GAP_SECONDS when the provider is missing', () => {
        const emptyCatalog: ProviderCatalog = { version: '2', providers: [] };
        expect(getGrokGapSeconds(emptyCatalog)).toBe(GROK_DEFAULT_GAP_SECONDS);
    });

    it('falls back to the default when the grok entry has a url_session_id boundary', () => {
        const malformed: ProviderCatalog = {
            version: '2',
            providers: [
                {
                    provider: GROK_PROVIDER_ID,
                    surface_match: {
                        app_bundle_ids: [],
                        process_names: [],
                        browser_url_patterns: [{ host: 'grok.com', path_prefix: '' }],
                    },
                    session_boundary: 'url_session_id',
                    session_id_extraction: { regex: '^https://grok\\.com/(.+)$', group: 1 },
                    timestamp_gap_seconds: null,
                },
            ],
        };
        expect(getGrokGapSeconds(malformed)).toBe(GROK_DEFAULT_GAP_SECONDS);
    });

    it('falls back to the default when timestamp_gap_seconds is non-positive', () => {
        const malformed: ProviderCatalog = {
            version: '2',
            providers: [
                {
                    provider: GROK_PROVIDER_ID,
                    surface_match: {
                        app_bundle_ids: [],
                        process_names: [],
                        browser_url_patterns: [{ host: 'grok.com', path_prefix: '' }],
                    },
                    session_boundary: 'timestamp_gap',
                    session_id_extraction: null,
                    timestamp_gap_seconds: 0,
                },
            ],
        };
        expect(getGrokGapSeconds(malformed)).toBe(GROK_DEFAULT_GAP_SECONDS);
    });

    it('returns the catalog-supplied override when valid', () => {
        const override: ProviderCatalog = {
            version: '2',
            providers: [
                {
                    provider: GROK_PROVIDER_ID,
                    surface_match: {
                        app_bundle_ids: [],
                        process_names: [],
                        browser_url_patterns: [{ host: 'grok.com', path_prefix: '' }],
                    },
                    session_boundary: 'timestamp_gap',
                    session_id_extraction: null,
                    timestamp_gap_seconds: 900,
                },
            ],
        };
        expect(getGrokGapSeconds(override)).toBe(900);
    });
});
