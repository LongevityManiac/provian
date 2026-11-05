import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import { distributionFor } from './distribution';

describe('which distribution a build is', () => {
    it('every iOS build is a store build', () => {
        expect(distributionFor('ios', undefined)).toBe('store');
        expect(distributionFor('ios', 'website')).toBe('store');
    });
    it('an Android build is a Play build only when built with the play flag', () => {
        expect(distributionFor('android', 'play')).toBe('store');
        // RED: anything else — unset, empty, a near miss — is the website APK, never a store build.
        expect(distributionFor('android', undefined)).toBe('website');
        expect(distributionFor('android', '')).toBe('website');
        expect(distributionFor('android', 'Play')).toBe('website');
        expect(distributionFor('android', 'store')).toBe('website');
    });
});
