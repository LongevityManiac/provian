/**
 * Tests for server-side attestation depth verification.
 *
 * Closes the "claim hardware from software" attack vector by verifying
 * attestation_capability against device/wallet registration data.
 *
 * Test cases:
 * 1. Agent-owned device claiming hardware → downgraded to software
 * 2. Agent-owned device claiming software → no change
 * 3. Human-owned device claiming hardware with software wallet → downgraded
 * 4. Human-owned device claiming hardware with hardware wallet → no change
 * 5. Human-owned device claiming hardware with no wallet data → no change
 * 6. Human-owned device claiming software → no change (no verification needed)
 * 7. All hardware capability variants are caught (hardware_tpm, hardware, hardware_full)
 */

import { verifyAttestationCapability } from './devices';

// =============================================================================
// Agent-owned devices
// =============================================================================

describe('verifyAttestationCapability - agent-owned devices', () => {
  it('downgrades hardware_tpm to software for agent owners', () => {
    const result = verifyAttestationCapability('hardware_tpm', 'agent');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain('agent');
  });

  it('downgrades hardware to software for agent owners', () => {
    const result = verifyAttestationCapability('hardware', 'agent');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });

  it('downgrades hardware_full to software for agent owners', () => {
    const result = verifyAttestationCapability('hardware_full', 'agent');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });

  it('does not downgrade software for agent owners', () => {
    const result = verifyAttestationCapability('software', 'agent');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(false);
  });
});

// =============================================================================
// Human-owned devices
// =============================================================================

describe('verifyAttestationCapability - human-owned devices', () => {
  it('downgrades hardware to software when wallet registered as software', () => {
    const result = verifyAttestationCapability('hardware_tpm', 'human', 'software');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain('software');
  });

  it('downgrades hardware to software when wallet registered as none', () => {
    const result = verifyAttestationCapability('hardware', 'human', 'none');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain('none');
  });

  it('does not downgrade hardware when wallet registered as hardware', () => {
    const result = verifyAttestationCapability('hardware_tpm', 'human', 'hardware');
    expect(result.verifiedCapability).toBe('hardware_tpm');
    expect(result.downgraded).toBe(false);
  });

  // BLOCKER-2 fix (2026-05-06): missing/null/undefined wallet
  // attested_security_level now fails closed. Previously the verifier
  // honoured hardware claims when no level was on file, which let any
  // device claim hardware on freshly created wallets that hadn't yet
  // run the (still-pending mobile-side) wallet-creation attestation
  // upload.
  it('downgrades hardware when wallet security level is null (fail-closed)', () => {
    const result = verifyAttestationCapability('hardware_tpm', 'human', null);
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain('hardware_tpm');
  });

  it('downgrades hardware when wallet security level is undefined (fail-closed)', () => {
    const result = verifyAttestationCapability('hardware', 'human', undefined);
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });

  it('does not downgrade software capability for human owners', () => {
    const result = verifyAttestationCapability('software', 'human', 'software');
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(false);
  });

  it('does not downgrade software_verified capability', () => {
    const result = verifyAttestationCapability('software_verified', 'human', 'software');
    expect(result.verifiedCapability).toBe('software_verified');
    expect(result.downgraded).toBe(false);
  });
});

// =============================================================================
// Integration-style: simulated PE submission with downgrade
// =============================================================================

describe('attestation verification - PE submission simulation', () => {
  it('simulates an agent device registering as hardware_tpm and submitting a PE', () => {
    // Device registered with attestation_capability: 'hardware_tpm'
    // but owner is an agent (software only)
    const claimed = 'hardware_tpm';
    const ownerType = 'agent' as const;

    const result = verifyAttestationCapability(claimed, ownerType);

    // The PE should be recorded with attestation_depth: 'software' (downgraded)
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);

    // Simulate what the PE submission would use for attestation depth
    const replicationPack = undefined; // no replication pack
    const attestationDepth = replicationPack ? 'software_verified' : result.verifiedCapability;
    expect(attestationDepth).toBe('software');
  });

  it('preserves software_verified when replication pack is present even after downgrade', () => {
    // Device claims hardware but is agent - downgraded to software
    const result = verifyAttestationCapability('hardware_tpm', 'agent');
    expect(result.verifiedCapability).toBe('software');

    // But replication pack upgrades to software_verified
    const replicationPack = { input_hash: 'abc', output_hash: 'def' };
    const attestationDepth = replicationPack ? 'software_verified' : result.verifiedCapability;
    expect(attestationDepth).toBe('software_verified');
  });
});
