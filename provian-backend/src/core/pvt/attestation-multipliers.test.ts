/**
 * Attestation multiplier table - IMMUTABLE (Component 3; frozen since PVTv5, carried through v8).
 *
 * The prior W6-3 runtime override (setAttestationMultiplier + a Firestore
 * pvt_config/attestation_multipliers doc, set via a bare-ADMIN_API_KEY endpoint)
 * was removed: the table is now a frozen code constant. Tests cover:
 *   - calculatePEWeight still respects attestationMultiplierOverride (the per-PE
 *     stamp captured at anchor time - the stamping mechanism is unchanged).
 *   - getEffectiveAttestationMultipliers / getEffectiveAttestationMultiplier
 *     return the frozen base table with override-inactive flags, always.
 *   - ATTESTATION_MULTIPLIERS is frozen at runtime.
 */

import { describe, it, expect, jest } from '@jest/globals';

// Stub admin.firestore() before importing the module under test.
const stubDocs = new Map<string, Record<string, unknown>>();

jest.mock('firebase-admin', () => {
  const firestoreFn = () => ({
    collection: (col: string) => ({
      doc: (id: string) => {
        const key = `${col}/${id}`;
        return {
          get: async () => ({
            exists: stubDocs.has(key),
            data: () => stubDocs.get(key),
          }),
          set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
            // Approximate Firestore merge with dotted paths used by the
            // setter (`overrides.${tier}` style).
            const existing = stubDocs.get(key) ?? {};
            if (opts?.merge) {
              const merged: Record<string, unknown> = { ...existing };
              for (const [path, value] of Object.entries(data)) {
                if (path.includes('.')) {
                  const [parent, child] = path.split('.');
                  const sub = (merged[parent] as Record<string, unknown>) ?? {};
                  sub[child] = value;
                  merged[parent] = sub;
                } else {
                  merged[path] = value;
                }
              }
              stubDocs.set(key, merged);
            } else {
              stubDocs.set(key, data);
            }
          },
        };
      },
    }),
  });
  return {
    __esModule: true,
    default: { firestore: firestoreFn },
    firestore: firestoreFn,
  };
});

import {
  ATTESTATION_MULTIPLIERS,
  calculatePEWeight,
  getEffectiveAttestationMultiplier,
  getEffectiveAttestationMultipliers,
  type PEWeightInput,
} from './pe-weight-framework';

function baseInput(overrides: Partial<PEWeightInput> = {}): PEWeightInput {
  return {
    userId: 'user_test',
    actionType: 'inference_session',
    attestationDepth: 'software',
    isHumanLinked: false,
    dailyPECount: 0,
    occurrenceCount: 0,
    isDuplicate: false,
    ...overrides,
  };
}

describe('W6-3 attestationMultiplierOverride is honored by calculatePEWeight', () => {
  it('uses the override instead of the live ATTESTATION_MULTIPLIERS lookup', () => {
    const live = calculatePEWeight(baseInput({ attestationDepth: 'software' }));
    const stamped = calculatePEWeight(baseInput({
      attestationDepth: 'software',
      attestationMultiplierOverride: 0.4,
    }));
    expect(live.attestationMultiplier).toBe(ATTESTATION_MULTIPLIERS.software);
    expect(stamped.attestationMultiplier).toBe(0.4);
    // The full estimatedPVT must reflect the override, scaled linearly.
    expect(stamped.estimatedPVT).toBeCloseTo(
      live.estimatedPVT * (0.4 / ATTESTATION_MULTIPLIERS.software),
      6,
    );
  });

  it('falls back to the live table when the override is undefined', () => {
    const r = calculatePEWeight(baseInput({ attestationDepth: 'hardware_full' }));
    expect(r.attestationMultiplier).toBe(ATTESTATION_MULTIPLIERS.hardware_full);
  });

  it('stamping makes historical PVT immutable across governance multiplier changes', () => {
    // Simulate: PE anchored at software=0.8x, then governance bumps the
    // live multiplier to 1.5. The PE was stamped with 0.8 at anchor; mint
    // time recompute must use that stamp, NOT the new 1.5.
    const stamped = 0.8;
    const recomputed = calculatePEWeight(baseInput({
      attestationDepth: 'software',
      attestationMultiplierOverride: stamped,
    }));
    expect(recomputed.attestationMultiplier).toBe(stamped);
  });
});

describe('attestation multipliers are immutable (Component 3 - override removed)', () => {
  it('ATTESTATION_MULTIPLIERS is frozen at runtime', () => {
    expect(Object.isFrozen(ATTESTATION_MULTIPLIERS)).toBe(true);
  });

  it('getEffectiveAttestationMultipliers returns the base table with override-inactive flags, always', async () => {
    const result = await getEffectiveAttestationMultipliers();
    expect(result.foundation_override_active).toBe(false);
    expect(result.last_changed_at).toBeNull();
    expect(result.multipliers.software).toBe(ATTESTATION_MULTIPLIERS.software);
    expect(result.multipliers.hardware_full).toBe(ATTESTATION_MULTIPLIERS.hardware_full);
    expect(result.multipliers.corroborated).toBe(ATTESTATION_MULTIPLIERS.corroborated);
  });

  it('getEffectiveAttestationMultiplier resolves each tier from the frozen base table', async () => {
    expect(await getEffectiveAttestationMultiplier('corroborated')).toBe(ATTESTATION_MULTIPLIERS.corroborated);
    expect(await getEffectiveAttestationMultiplier('hardware_full')).toBe(ATTESTATION_MULTIPLIERS.hardware_full);
    expect(await getEffectiveAttestationMultiplier('software')).toBe(ATTESTATION_MULTIPLIERS.software);
  });

  it('an unknown attestation tier falls back to the software baseline', async () => {
    expect(await getEffectiveAttestationMultiplier('does_not_exist')).toBe(ATTESTATION_MULTIPLIERS.software);
  });

  it('the effective table is a copy - mutating the result cannot reprice the constant', async () => {
    const result = await getEffectiveAttestationMultipliers();
    result.multipliers.software = 99;
    const again = await getEffectiveAttestationMultipliers();
    expect(again.multipliers.software).toBe(ATTESTATION_MULTIPLIERS.software);
  });
});
