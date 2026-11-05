/**
 * Agent-owned device attestation-count policy boundary.
 *
 * Agent-owned devices are software-only under the approved policy, so device
 * registration and signing-method selection cannot produce a hardware event
 * that increments agent_wallet.attestation_count. Choosing agent hardware
 * eligibility would require a separate explicit policy decision.
 */

import { describe, it, expect } from '@jest/globals';
import { resolveAttestationTierFromSigning } from './devices';

describe('attestation_count scope (Wave J Step 4.13)', () => {
  it('never produces an agent hardware tier that could increment the count', () => {
    for (const signingMethod of [undefined, 'bearer', 'secure_enclave_p256'] as const) {
      for (const claimedCapability of [
        'software',
        'hardware_partial',
        'hardware_tpm',
        'hardware',
        'hardware_full',
      ]) {
        const result = resolveAttestationTierFromSigning({
          signingMethod,
          ownerType: 'agent',
          platform: 'macOS',
          claimedCapability,
          walletSecurityLevel: 'hardware_full',
          attestedSecurityLevel: 'hardware_full',
        });
        expect(result.verifiedCapability).toBe('software');
      }
    }
  });
});
