/**
 * Financial PEs mint at FULL WEIGHT: no hardware-attestation tier, so a native
 * (device) and a mapped (chain-observed) financial PE of the same type + amount +
 * identity mint IDENTICALLY. Proven at the calculatePEWeight boundary (the exact
 * inputs recordPEAccrual passes for a financial type) + the type-set contract.
 */

import { FINANCIAL_FULL_WEIGHT_TYPES } from '../../pvt-accrual';
import { calculatePEWeight, type PEWeightInput } from './pe-weight-framework';

describe('FINANCIAL_FULL_WEIGHT_TYPES', () => {
  it('covers every financial movement type', () => {
    for (const t of ['send', 'receive', 'swap', 'stake', 'unstake', 'x402_payment', 'onramp', 'onramp_order']) {
      expect(FINANCIAL_FULL_WEIGHT_TYPES.has(t)).toBe(true);
    }
  });
  it('excludes non-financial + setup types (they keep the attestation tier)', () => {
    for (const t of ['wallet_created', 'device_register', 'coding_session', 'agent_authorization', 'promise_created']) {
      expect(FINANCIAL_FULL_WEIGHT_TYPES.has(t)).toBe(false);
    }
  });
});

describe('financial full weight is attestation-independent', () => {
  // The inputs recordPEAccrual builds for a financial type: attestation multiplier
  // forced to 1.0, human-trust from linkage only. Vary ONLY attestationDepth.
  const financialInput = (attestationDepth: string, linked: boolean): PEWeightInput => ({
    userId: 'agent1',
    actionType: 'send',
    attestationDepth,
    category: 'wallet_transaction',
    isHumanLinked: linked, // linkage-derived, NOT attestation-derived (financial rule)
    dailyPECount: 0,
    occurrenceCount: 1,
    isDuplicate: false,
    isUniqueArtifact: false,
    attestationMultiplierOverride: 1.0, // full weight - forced for financial types
  });

  it('a software-attested send mints the SAME as a hardware-attested send (same identity)', () => {
    const software = calculatePEWeight(financialInput('software', false));
    const hardware = calculatePEWeight(financialInput('hardware', false));
    expect(software.estimatedPVT).toBeGreaterThan(0);
    expect(software.estimatedPVT).toBe(hardware.estimatedPVT);
    // And the attestation contribution is the neutral 1.0 (no software discount).
    expect(software.attestationMultiplier).toBe(1.0);
    expect(hardware.attestationMultiplier).toBe(1.0);
  });

  it('a linked-agent send still splits/bonuses identically native vs mapped', () => {
    const nativeLinked = calculatePEWeight(financialInput('hardware', true));
    const mappedLinked = calculatePEWeight(financialInput('software', true));
    expect(nativeLinked.estimatedPVT).toBe(mappedLinked.estimatedPVT);
  });
});
