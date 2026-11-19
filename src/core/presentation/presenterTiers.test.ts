import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { presenterTierOptions } from './presenterTiers';

describe('presenter tier options', () => {
    it('a hire offers only the reputation tier (its handshake takes the 15 PVT floor); so does a vouch', () => {
        expect(presenterTierOptions('hire')).toEqual(['reputation']);
        expect(presenterTierOptions('vouch')).toEqual(['reputation']);
    });

    it('every other presentation keeps both tiers', () => {
        expect(presenterTierOptions(null)).toEqual(['reputation', 'pe_fact']);
    });

    it('the presenter screen draws its picker from these options and forces reputation for a Commons act', () => {
        const src = readFileSync(resolve(__dirname, '../../screens/Presentment/HumanPresentmentScreen.tsx'), 'utf8');
        expect(src).toContain('presenterTierOptions(commonsAct?.kind ?? null)');
        expect(src).toContain('{tierOptions.length > 1 && (');
        expect(src).toContain('{tierOptions.map((tr) => (');
        expect(src).toContain("if (commonsAct !== null) setTier('reputation');");
        // RED control: the picker's old hard-coded tier list is gone, so pe_fact cannot be drawn for a hire.
        expect(src).not.toContain("(['reputation', 'pe_fact'] as const).map(");
    });
});
