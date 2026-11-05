import { describe, it, expect } from 'vitest';
import {
    JARGON_BLOCKLIST,
    containsJargon,
    assertJargonFree,
} from '../jargonBlocklist';

describe('JARGON_BLOCKLIST', () => {
    it('contains at least 30 forbidden terms', () => {
        expect(JARGON_BLOCKLIST.length).toBeGreaterThanOrEqual(30);
    });

    it('includes all critical security engine terms', () => {
        const critical = [
            'anomaly score',
            'reclassification',
            'egress',
            'allowlist',
            'provenance',
            'attestation',
            'baseline',
            'entropy',
            'payload',
            'parameter',
        ];
        for (const term of critical) {
            expect(JARGON_BLOCKLIST).toContain(term);
        }
    });

    it('includes internal field name formats', () => {
        const fieldNames = [
            'anomalyScore',
            'anomaly_score',
            'riskPoints',
            'risk_points',
            'temporalAnomaly',
            'temporal_anomaly',
        ];
        for (const name of fieldNames) {
            expect(JARGON_BLOCKLIST).toContain(name);
        }
    });
});

describe('containsJargon', () => {
    it('returns clean=true for normal user-facing text', () => {
        const result = containsJargon('Your bot wants to use notion.so');
        expect(result.clean).toBe(true);
        expect(result.violations).toHaveLength(0);
    });

    it('detects "anomaly score" in text', () => {
        const result = containsJargon('The anomaly score is 85');
        expect(result.clean).toBe(false);
        expect(result.violations).toContain('anomaly score');
    });

    it('detects multiple violations', () => {
        const result = containsJargon('The egress payload has high entropy');
        expect(result.clean).toBe(false);
        expect(result.violations).toContain('egress');
        expect(result.violations).toContain('entropy');
    });

    it('is case-insensitive', () => {
        const result = containsJargon('ANOMALY SCORE detected');
        expect(result.clean).toBe(false);
    });

    it('detects jargon embedded in sentences', () => {
        const result = containsJargon('We found a provenance envelope issue');
        expect(result.clean).toBe(false);
        expect(result.violations).toContain('provenance envelope');
    });

    it('allows the word "allow" even though "allowlist" is blocked', () => {
        const result = containsJargon('Would you like to allow this?');
        expect(result.clean).toBe(true);
    });

    it('allows "score" standalone without "anomaly" or "risk" prefix', () => {
        const result = containsJargon('Your trust score is great');
        expect(result.clean).toBe(true);
    });
});

describe('assertJargonFree', () => {
    it('does not throw for clean text', () => {
        expect(() => assertJargonFree('Your bot wants to send a message')).not.toThrow();
    });

    it('throws for jargon text with violation details', () => {
        expect(() => assertJargonFree('The attestation failed'))
            .toThrow('attestation');
    });

    it('includes context in error message', () => {
        expect(() => assertJargonFree('High entropy detected', 'headline'))
            .toThrow('[headline]');
    });
});
