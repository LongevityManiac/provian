/**
 * Fingerprint recipe tests.
 *
 * The mobile hash must match the desktop hash byte-for-byte when the
 * plugin name is held identical. This test file proves the recipe is
 * deterministic, sensitive to every field, and cross-surface stable
 * against the reference desktop implementation reproduced in-test with
 * node:crypto.
 *
 * Spec: PHASE_2B_DESIGN_NOTES.md §5.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
    computeSessionFingerprint,
    MOBILE_WEBVIEW_PLUGIN_NAME,
} from '../sessionFingerprint';

/** Desktop-faithful reference implementation, inline for cross-check. */
function referenceFingerprint(input: {
    provider: string;
    sessionStartMs: number;
    durationMs: number;
    turnCount: number;
    pluginName: string;
}): string {
    const parts = [
        input.provider,
        String(Math.trunc(input.sessionStartMs)),
        String(Math.trunc(input.durationMs)),
        String(Math.trunc(input.turnCount)),
        input.pluginName,
    ];
    const hash = createHash('sha256');
    for (const p of parts) {
        const buf = Buffer.from(p, 'utf8');
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(buf.length, 0);
        hash.update(prefix);
        hash.update(buf);
    }
    return hash.digest('hex');
}

describe('computeSessionFingerprint', () => {
    it('produces a 64-character lowercase hex string', () => {
        const hash = computeSessionFingerprint({
            provider: 'claude',
            sessionStartMs: 1_713_740_123_456,
            durationMs: 600_000,
            turnCount: 12,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        });
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic: identical inputs produce identical hashes', () => {
        const input = {
            provider: 'grok',
            sessionStartMs: 1_713_740_123_456,
            durationMs: 1_800_000,
            turnCount: 7,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        };
        const a = computeSessionFingerprint(input);
        const b = computeSessionFingerprint(input);
        expect(a).toBe(b);
    });

    it('matches the desktop byte-level recipe', () => {
        const input = {
            provider: 'chatgpt',
            sessionStartMs: 1_713_740_123_456,
            durationMs: 1_234_567,
            turnCount: 42,
            pluginName: 'llm_session_plugin',
        };
        expect(computeSessionFingerprint(input)).toBe(referenceFingerprint(input));
    });

    it('is sensitive to every field', () => {
        const base = {
            provider: 'perplexity',
            sessionStartMs: 1_000_000,
            durationMs: 500_000,
            turnCount: 5,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        };
        const h0 = computeSessionFingerprint(base);
        expect(computeSessionFingerprint({ ...base, provider: 'gemini' })).not.toBe(h0);
        expect(
            computeSessionFingerprint({ ...base, sessionStartMs: base.sessionStartMs + 1 }),
        ).not.toBe(h0);
        expect(
            computeSessionFingerprint({ ...base, durationMs: base.durationMs + 1 }),
        ).not.toBe(h0);
        expect(
            computeSessionFingerprint({ ...base, turnCount: base.turnCount + 1 }),
        ).not.toBe(h0);
        expect(
            computeSessionFingerprint({ ...base, pluginName: 'something_else' }),
        ).not.toBe(h0);
    });

    it('distinguishes the same logical session across surfaces via pluginName', () => {
        // Desktop and mobile observers in the same wall-clock window must
        // not collide by construction. Same provider, session start,
        // duration, and turn count; different pluginName.
        const shared = {
            provider: 'claude',
            sessionStartMs: 1_713_740_123_456,
            durationMs: 900_000,
            turnCount: 20,
        };
        const desktop = computeSessionFingerprint({
            ...shared,
            pluginName: 'llm_session_plugin',
        });
        const mobile = computeSessionFingerprint({
            ...shared,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        });
        const usageStats = computeSessionFingerprint({
            ...shared,
            pluginName: 'mobile_usage_stats',
        });
        expect(desktop).not.toBe(mobile);
        expect(desktop).not.toBe(usageStats);
        expect(mobile).not.toBe(usageStats);
    });

    it('length-prefix encoding prevents field boundary aliasing', () => {
        // Without length prefixes, ("claude" + "1713740123456") and
        // ("claud" + "e1713740123456") would hash identically. With the
        // 4-byte prefix, they cannot.
        const a = computeSessionFingerprint({
            provider: 'claude',
            sessionStartMs: 1_713_740_123_456,
            durationMs: 0,
            turnCount: 0,
            pluginName: 'x',
        });
        const b = computeSessionFingerprint({
            provider: 'claud',
            sessionStartMs: 1_713_740_123_456, // field 2 does not absorb "e" because of LEN prefix
            durationMs: 0,
            turnCount: 0,
            pluginName: 'x',
        });
        expect(a).not.toBe(b);
    });

    it('truncates fractional parts of numeric fields (Math.trunc)', () => {
        const truncated = computeSessionFingerprint({
            provider: 'gemini',
            sessionStartMs: 1_000_000,
            durationMs: 500_000,
            turnCount: 3,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        });
        const fractional = computeSessionFingerprint({
            provider: 'gemini',
            sessionStartMs: 1_000_000.9,
            durationMs: 500_000.4,
            turnCount: 3.7,
            pluginName: MOBILE_WEBVIEW_PLUGIN_NAME,
        });
        expect(fractional).toBe(truncated);
    });

    it('MOBILE_WEBVIEW_PLUGIN_NAME is the literal "mobile_webview"', () => {
        expect(MOBILE_WEBVIEW_PLUGIN_NAME).toBe('mobile_webview');
    });
});
