/** Canonical PE attestation tiers and display helpers. */
export const PVT_ATTESTATION_FACTORS = Object.freeze({
    social: 0.5,
    software: 0.8,
    corroborated: 1.1,
    software_verified: 1.2,
    hardware_partial: 1.2,
    compute_tee: 1.4,
    full_stack: 2.0,
    hardware_full: 4.0,
} as const);

export type PVTAttestationTier = keyof typeof PVT_ATTESTATION_FACTORS;

/** Normalize current tiers, legacy aliases, and unknown input fail-closed. */
export function normalizePVTAttestationTier(value: unknown): PVTAttestationTier {
    if (value === 'hardware') return 'hardware_full';
    if (value === 'hardware_tpm' || value === 'hardware_limited') return 'hardware_partial';
    if (typeof value === 'string'
        && Object.prototype.hasOwnProperty.call(PVT_ATTESTATION_FACTORS, value)) {
        return value as PVTAttestationTier;
    }
    return 'software';
}

export function isHardwareAttestationTier(value: unknown): boolean {
    const tier = normalizePVTAttestationTier(value);
    return tier === 'hardware_partial' || tier === 'hardware_full';
}

const TIER_CODES: Readonly<Record<PVTAttestationTier, string>> = Object.freeze({
    social: 'SO',
    software: 'SW',
    corroborated: 'CO',
    software_verified: 'SV',
    hardware_partial: 'HP',
    compute_tee: 'TEE',
    full_stack: 'FS',
    hardware_full: 'HF',
});

export function pvtAttestationTierCode(value: unknown): string {
    return TIER_CODES[normalizePVTAttestationTier(value)];
}
