import {
  ATTESTATION_MULTIPLIERS,
  buildWeightConfigResponse,
} from '../core/pvt/pe-weight-framework';
import { buildAttestationTierReference } from './pvt-attestation-tiers';

describe('public PVT attestation-tier reference', () => {
  const response = buildAttestationTierReference({
    multipliers: { ...ATTESTATION_MULTIPLIERS },
    foundation_override_active: false,
    last_changed_at: null,
  }) as {
    description: string;
    tiers: Array<{ tier: string; multiplier: number; description: string }>;
    policy_context: Record<string, string>;
    foundation_override_active: boolean;
  };

  it('publishes the complete frozen 0.5x-2.5x ladder', () => {
    expect(response.tiers.map(({ tier }) => tier)).toEqual([
      'social',
      'software',
      'corroborated',
      'software_verified',
      'hardware_partial',
      'compute_tee',
      'full_stack',
      'hardware_full',
    ]);
    expect(Math.min(...response.tiers.map(({ multiplier }) => multiplier))).toBe(0.5);
    expect(Math.max(...response.tiers.map(({ multiplier }) => multiplier))).toBe(2.5);
    expect(response.foundation_override_active).toBe(false);
  });

  it('keeps linkage and agent-device policy separate from attestation', () => {
    expect(response.description).toContain('Attestation never establishes human linkage');
    expect(response.policy_context.human_trust_factor).toContain('only after verified');
    expect(response.policy_context.agent_owned_devices).toContain('before signing-method');
    expect(response.policy_context.agent_owned_devices).toContain('has not been approved');
    expect(response.policy_context.agent_device_register).toContain('no device anchor');
    expect(response.policy_context.agent_device_register).toContain('zero PVT');
    expect(response.policy_context.attestation_mutability).toContain('no Foundation Safe');
    expect(response.tiers.find(({ tier }) => tier === 'hardware_partial')?.description)
      .toContain('normal lane price');
  });

  it('places the same policy context beside the public weight values', () => {
    const weights = buildWeightConfigResponse();
    expect(weights.human_trust_bonus).toBe(2);
    expect(weights.human_trust_policy).toContain('only after relay-verified');
    expect(weights.human_trust_policy).toContain('attestation never');
    expect(weights.attestation_policy).toContain('0.5x-2.5x');
    expect(weights.attestation_policy).toContain('server-capped at software');
    // the display formula has four factors; the kernel's fifth slot is
    // sealed neutral so its 10000^5 denominator cancels.
    expect(weights.ordinary_formula).toContain('/ 10000^4');
    expect(weights.ordinary_formula).not.toContain('daily_diminishing *');
    expect(weights.ordinary_formula).toContain('occurrence is not a second multiplier');
  });
});
