/**
 * Attestation tier and registration policy tests.
 *
 * Fix 1: resolveAttestationTierFromSigning must NEVER return hardware_full
 *        for desktop secure_enclave_p256 - every variant caps at hardware_partial
 *        until a real Apple App Attest / DeviceCheck chain ships.
 *
 * Fix 2: verifyAttestationCapability must be applied at registration time.
 *        An agent claiming hardware_tpm verifies to software, and there is no
 *        agent-device hardware event or attestation-count path.
 */

import { describe, it, expect } from '@jest/globals';
import {
  canonicalDeviceEconomicAttestationTier,
  resolveAttestationTierFromSigning,
  verifyAttestationCapability,
} from './devices';

describe('canonical device economic tier', () => {
  it(' hardware labels without App Attest retain software economics', () => {
    expect(canonicalDeviceEconomicAttestationTier('hardware_full')).toBe('software');
    expect(canonicalDeviceEconomicAttestationTier('hardware_partial')).toBe('software');
    expect(canonicalDeviceEconomicAttestationTier('hardware_tpm')).toBe('software');
    expect(canonicalDeviceEconomicAttestationTier('hardware')).toBe('software');
  });

  it('fails closed for software, upgrade labels, and unknown capabilities', () => {
    for (const capability of ['software', 'software_verified', 'corroborated', '', 'unknown']) {
      expect(canonicalDeviceEconomicAttestationTier(capability)).toBe('software');
    }
  });
});

// ===========================================================================
// Fix 1 - desktop secure_enclave_p256 caps at hardware_partial
// ===========================================================================

describe('Audit Pass 2 / Fix 1: resolveAttestationTierFromSigning', () => {
  it('rejects malformed ownership instead of selecting the human path', () => {
    for (const ownerType of [undefined, null, '', 'Human', 'unknown', {}, ['human'], Object('human')]) {
      expect(() => resolveAttestationTierFromSigning({
        signingMethod: 'secure_enclave_p256',
        ownerType: ownerType as never,
        platform: 'macOS',
        claimedCapability: 'hardware_full',
        walletSecurityLevel: 'hardware_full',
      })).toThrow('invalid_device_owner_type');
    }
  });

  it('keeps every agent-owned device combination software-only before signing selection', () => {
    const signingMethods = [undefined, 'bearer', 'secure_enclave_p256'] as const;
    const claimedCapabilities = [
      'software',
      'software_verified',
      'hardware_partial',
      'hardware_tpm',
      'hardware',
      'hardware_full',
    ] as const;
    const attestedLevels = [null, 'hardware_tpm', 'hardware_full'] as const;

    for (const signingMethod of signingMethods) {
      for (const claimedCapability of claimedCapabilities) {
        for (const attestedSecurityLevel of attestedLevels) {
          const result = resolveAttestationTierFromSigning({
            signingMethod,
            ownerType: 'agent',
            platform: 'attacker-controlled-platform-label',
            claimedCapability,
            walletSecurityLevel: 'hardware_full',
            attestedSecurityLevel,
          });
          expect(result.verifiedCapability).toBe('software');
        }
      }
    }
  });

  it('caps a human + macOS-platform + secure_enclave_p256 at hardware_partial', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'human',
      platform: 'macOS',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: 'hardware_full',
    });
    expect(result.verifiedCapability).toBe('hardware_partial');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toBe('se_platform_attestation_unverified');
  });

  it('caps a human + darwin platform string at hardware_partial', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'human',
      platform: 'darwin-arm64',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: 'hardware_full',
    });
    expect(result.verifiedCapability).toBe('hardware_partial');
  });

  it('caps a human + iOS-ish platform string at hardware_partial', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'human',
      platform: 'iOS-17',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: 'hardware_full',
    });
    expect(result.verifiedCapability).toBe('hardware_partial');
  });

  it('enforces software-only for an agent before secure_enclave_p256 tier selection', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'agent',
      platform: 'macOS',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: null,
    });
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toBe('agent_device_software_only');
  });

  it('falls through to verifyAttestationCapability for bearer signing_method', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'bearer',
      ownerType: 'agent',
      platform: 'macOS',
      claimedCapability: 'hardware_tpm',
      walletSecurityLevel: null,
    });
    // Agent + hardware claim downgrades to software via verifyAttestationCapability.
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
  });

  it('falls through to verifyAttestationCapability for undefined signing_method', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: undefined,
      ownerType: 'human',
      platform: 'linux',
      claimedCapability: 'software',
    });
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(false);
  });
});

// ===========================================================================
// Android Key Attestation - a verified chain LIFTS the secure_enclave_p256 cap
// ===========================================================================

describe('Android Key Attestation promotion in resolveAttestationTierFromSigning', () => {
  it('promotes a human SE device to hardware_full when attested as StrongBox', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'human',
      platform: 'android',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: null,
      attestedSecurityLevel: 'hardware_full',
    });
    expect(result.verifiedCapability).toBe('hardware_full');
    expect(result.downgraded).toBe(false);
    expect(result.reason).toBe('android_key_attestation_verified');
  });

  it('promotes a human SE device to hardware_tpm when attested as TEE', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'human',
      platform: 'android',
      claimedCapability: 'hardware_tpm',
      walletSecurityLevel: null,
      attestedSecurityLevel: 'hardware_tpm',
    });
    expect(result.verifiedCapability).toBe('hardware_tpm');
    expect(result.downgraded).toBe(false);
  });

  it('does NOT promote an agent device even with an attested level (hardware is human-only)', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'agent',
      platform: 'android',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: null,
      attestedSecurityLevel: 'hardware_full',
    });
    expect(result.verifiedCapability).toBe('software');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toBe('agent_device_software_only');
  });

  it('caps at hardware_partial when no attested level is present (unchanged default)', () => {
    const result = resolveAttestationTierFromSigning({
      signingMethod: 'secure_enclave_p256',
      ownerType: 'human',
      platform: 'android',
      claimedCapability: 'hardware_full',
      walletSecurityLevel: null,
      attestedSecurityLevel: null,
    });
    expect(result.verifiedCapability).toBe('hardware_partial');
  });
});

// ===========================================================================
// Fix 2 - registration uses verified capability and has no agent-hardware path
// ===========================================================================

describe('Audit Pass 2 / Fix 2: verifyAttestationCapability at registration', () => {
  it('agent claiming hardware_tpm verifies to software', () => {
    const verified = verifyAttestationCapability('hardware_tpm', 'agent', null);
    expect(verified.verifiedCapability).toBe('software');
    expect(verified.downgraded).toBe(true);
  });

  it('agent claiming hardware_full verifies to software', () => {
    const verified = verifyAttestationCapability('hardware_full', 'agent', null);
    expect(verified.verifiedCapability).toBe('software');
    expect(verified.downgraded).toBe(true);
  });

  it('agent claiming software stays software', () => {
    const verified = verifyAttestationCapability('software', 'agent', null);
    expect(verified.verifiedCapability).toBe('software');
    expect(verified.downgraded).toBe(false);
  });

  it('human claiming hardware_tpm with attested wallet keeps hardware_tpm', () => {
    const verified = verifyAttestationCapability('hardware_tpm', 'human', 'hardware_tpm');
    expect(verified.verifiedCapability).toBe('hardware_tpm');
    expect(verified.downgraded).toBe(false);
  });

  it('human claiming hardware without an attested wallet downgrades to software', () => {
    const verified = verifyAttestationCapability('hardware_full', 'human', null);
    expect(verified.verifiedCapability).toBe('software');
    expect(verified.downgraded).toBe(true);
  });
});
