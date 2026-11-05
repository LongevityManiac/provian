/**
 * Attestation-capability detection.
 *
 * The detection is SELF-REPORTED: it names the best tier this host can offer,
 * and nothing downstream verifies it. What must hold is the direction of every
 * unknown — a probe that cannot answer must resolve DOWN to `software`, never
 * up. Each case below pairs the tier it claims with the single fact that earns
 * it, and severing that one fact is asserted to drop the tier.
 */

import { describe, it, expect } from 'vitest';
import {
  detectAttestationCapability,
  defaultAttestationProbe,
  type AttestationProbe,
} from './register-device';

function probe(overrides: Partial<AttestationProbe> = {}): AttestationProbe {
  return {
    platform: 'linux',
    arch: () => 'x86_64',
    hasAppleBridge: () => false,
    hasTpmDevice: () => false,
    ...overrides,
  };
}

const THROWS = () => { throw new Error('probe unavailable'); };

describe('detectAttestationCapability', () => {
  it('Apple Silicon -> hardware_tpm (Secure Enclave always present)', () => {
    expect(detectAttestationCapability(probe({ platform: 'darwin', arch: () => 'arm64' })))
      .toBe('hardware_tpm');
  });

  it('RED CONTROL: the same host WITHOUT arm64 and without a T2 bridge -> software', () => {
    expect(detectAttestationCapability(probe({ platform: 'darwin', arch: () => 'x86_64' })))
      .toBe('software');
  });

  it('Intel Mac WITH a T2 bridge -> hardware_tpm (SE lives in the T2)', () => {
    expect(detectAttestationCapability(probe({
      platform: 'darwin',
      arch: () => 'x86_64',
      hasAppleBridge: () => true,
    }))).toBe('hardware_tpm');
  });

  it('RED CONTROL: sever the bridge and the same Intel Mac drops to software', () => {
    expect(detectAttestationCapability(probe({
      platform: 'darwin',
      arch: () => 'x86_64',
      hasAppleBridge: () => false,
    }))).toBe('software');
  });

  it('Linux WITH a TPM 2.0 device node -> hardware_tpm', () => {
    expect(detectAttestationCapability(probe({ platform: 'linux', hasTpmDevice: () => true })))
      .toBe('hardware_tpm');
  });

  it('RED CONTROL: sever the TPM node and the same Linux host drops to software', () => {
    expect(detectAttestationCapability(probe({ platform: 'linux', hasTpmDevice: () => false })))
      .toBe('software');
  });

  it('a TPM node on a NON-Linux platform does not grant the tier', () => {
    expect(detectAttestationCapability(probe({ platform: 'win32', hasTpmDevice: () => true })))
      .toBe('software');
  });

  it('arm64 on a NON-darwin platform does not grant the tier', () => {
    expect(detectAttestationCapability(probe({ platform: 'linux', arch: () => 'arm64' })))
      .toBe('software');
  });

  // ---- unknown resolves DOWN, never up ------------------------------------

  it('a throwing arch probe on darwin falls closed to software', () => {
    expect(detectAttestationCapability(probe({ platform: 'darwin', arch: THROWS })))
      .toBe('software');
  });

  it('a throwing bridge probe on an Intel Mac falls closed to software', () => {
    expect(detectAttestationCapability(probe({
      platform: 'darwin',
      arch: () => 'x86_64',
      hasAppleBridge: THROWS,
    }))).toBe('software');
  });

  it('a throwing TPM probe on Linux falls closed to software', () => {
    expect(detectAttestationCapability(probe({ platform: 'linux', hasTpmDevice: THROWS })))
      .toBe('software');
  });

  it('an unrecognized platform is software, not a guess', () => {
    expect(detectAttestationCapability(probe({ platform: 'plan9', arch: () => 'arm64' })))
      .toBe('software');
  });

  it('every branch is reachable: the suite observed BOTH tiers', () => {
    const observed = new Set([
      detectAttestationCapability(probe({ platform: 'darwin', arch: () => 'arm64' })),
      detectAttestationCapability(probe()),
    ]);
    // Guards against a detector hard-wired to a single answer, which every
    // one-directional assertion above would otherwise still satisfy.
    expect([...observed].sort()).toEqual(['hardware_tpm', 'software']);
  });
});

describe('defaultAttestationProbe', () => {
  it('reads THIS host and answers with a real tier', () => {
    const real = defaultAttestationProbe();
    expect(typeof real.platform).toBe('string');
    expect(real.platform.length).toBeGreaterThan(0);
    expect(['software', 'hardware_tpm']).toContain(detectAttestationCapability(real));
  });
});
