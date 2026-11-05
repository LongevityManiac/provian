import { describe, expect, it } from 'vitest';

import {
    isHardwareAttestationTier,
    normalizePVTAttestationTier,
    PVT_ATTESTATION_FACTORS,
    pvtAttestationTierCode,
} from './attestationTiers';

describe('canonical PVT attestation tiers', () => {
    it('preserves the complete 0.5x-4.0x ladder', () => {
        expect(Object.keys(PVT_ATTESTATION_FACTORS)).toEqual([
            'social', 'software', 'corroborated', 'software_verified',
            'hardware_partial', 'compute_tee', 'full_stack', 'hardware_full',
        ]);
        expect(Math.min(...Object.values(PVT_ATTESTATION_FACTORS))).toBe(0.5);
        expect(Math.max(...Object.values(PVT_ATTESTATION_FACTORS))).toBe(4.0);
    });

    it('keeps partial distinct from full and fails unknown input closed', () => {
        expect(normalizePVTAttestationTier('hardware_tpm')).toBe('hardware_partial');
        expect(normalizePVTAttestationTier('hardware_partial')).toBe('hardware_partial');
        expect(normalizePVTAttestationTier('hardware_full')).toBe('hardware_full');
        expect(normalizePVTAttestationTier('attacker-tier')).toBe('software');
        expect(isHardwareAttestationTier('hardware_partial')).toBe(true);
        expect(pvtAttestationTierCode('hardware_partial')).toBe('HP');
        expect(pvtAttestationTierCode('hardware_full')).toBe('HF');
    });
});
