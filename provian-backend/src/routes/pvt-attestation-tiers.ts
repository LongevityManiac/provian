/**
 * The public attestation-tier reference served at `GET /v1/pvt/attestation-tiers`
 * (routes/pvt-public-reads.ts). Moved here, byte-identical, from the unmounted
 * legacy `routes/pvt.ts` router when that router was deleted (PE meter, 2026-10-03).
 */

import type { getEffectiveAttestationMultipliers } from '../core/pvt/pe-weight-framework';

type EffectiveAttestationMultipliers = Awaited<
  ReturnType<typeof getEffectiveAttestationMultipliers>
>;

/**
 * Public attestation reference derived from the frozen runtime table. Keep the
 * owner/linkage policy beside the numbers so clients cannot mistake a hardware
 * label for human linkage or agent-device hardware eligibility.
 */
export function buildAttestationTierReference(
  effective: EffectiveAttestationMultipliers,
): Record<string, unknown> {
  const m = effective.multipliers;
  const tier = (key: string, fallback: number) => m[key] ?? fallback;
  return {
    description: 'For a non-financial act of work, stronger verified evidence may apply the separate attestation factor. The complete configured attestation range is 0.5x-2.5x. Attestation never establishes human linkage or turns an unknown-action fallback or non-work event into a separately minting act.',
    tiers: [
      {
        tier: 'social',
        multiplier: tier('social', 0.5),
        description: 'Social or lowest-evidence attestation.',
        how_to_achieve: 'A relay-recognized social evidence path; eligibility remains separate.',
      },
      {
        tier: 'software',
        multiplier: tier('software', 0.8),
        description: 'Software-only attestation and the mandatory base tier for agent-owned devices.',
        how_to_achieve: 'Any PE the registered device\'s observation lanes record without a recognized evidence upgrade.',
      },
      {
        tier: 'corroborated',
        multiplier: tier('corroborated', 1.1),
        description: 'A third party independently confirms the PE through recognized evidence such as an on-chain event, merchant signal, or counterparty confirmation.',
        how_to_achieve: 'Supply a valid corroboration signal for an existing PE. Invalid signals are rejected, never treated as an upgrade.',
      },
      {
        tier: 'software_verified',
        multiplier: tier('software_verified', 1.2),
        description: 'Software evidence with a valid Replication Pack. This PE-level upgrade is separate from device ownership.',
        how_to_achieve: 'Include the complete required Replication Pack hashes and model evidence on the PE.',
      },
      {
        tier: 'hardware_partial',
        multiplier: tier('hardware_partial', 1.2),
        description: 'Historical hardware factor retained for sealed snapshots. Current non-App-Attest hardware evidence is a presentation fact at the normal lane price.',
        how_to_achieve: 'Hardware alone does not select this factor; the verified witness lane determines current pricing.',
      },
      {
        tier: 'compute_tee',
        multiplier: tier('compute_tee', 1.4),
        description: 'Historical TEE factor; verified GPU and cloud attestations currently disclose facts at the normal witness-lane price.',
        how_to_achieve: 'Submit through the program’s witness lane; a bare attested-machine submission prices at device tier.',
      },
      {
        tier: 'full_stack',
        multiplier: tier('full_stack', 2.0),
        description: 'Reserved full-stack evidence tier combining all required verification layers.',
        how_to_achieve: 'Reserved; no current device claim can select it.',
      },
      {
        tier: 'hardware_full',
        multiplier: tier('hardware_full', 2.5),
        description: 'Verified Apple App Attest on a human-owned mobile device. Only App Attest selects hardware pricing.',
        how_to_achieve: 'Present an App Attest evidence chain that the relay verifies. StrongBox and other hardware evidence retain the normal lane price.',
      },
    ],
    policy_context: {
      human_trust_factor: 'Separate 2.0x factor only after verified direct-human identity or an agent human-beneficiary relationship.',
      agent_owned_devices: 'Server-capped at software before signing-method tier selection; hardware eligibility has not been approved.',
      agent_device_register: 'Carries no device anchor and mints zero PVT.',
      attestation_mutability: 'Frozen code table; no Foundation Safe or runtime attestation override.',
    },
    // Compatibility fields retained for existing clients. The former runtime
    // override is removed, so this value is always false.
    foundation_override_active: false,
    last_changed_at: effective.last_changed_at,
    tip: 'A valid Replication Pack can raise the attestation factor from software 0.8x to software_verified 1.2x for the work it supports. It does not establish linkage or turn a non-work or mint-once event into a separate mint.',
    full_weight_config: '/v1/pvt/weights',
  };
}
