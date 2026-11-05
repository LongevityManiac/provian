import {
  assertBeneficiaryRoutingEvidence,
  createBeneficiaryRoutingSnapshot,
  hashBeneficiaryRoutingSnapshot,
} from './beneficiary-routing';
import {
  DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
  MAX_AGENT_BENEFICIARY_SHARE_BPS,
  MIN_AGENT_BENEFICIARY_SHARE_BPS,
  canonicalAgentBeneficiaryShareBps,
} from '../agent-wallet/beneficiary-relationship';

const HUMAN = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function fixture() {
  const routingSnapshot = createBeneficiaryRoutingSnapshot({
    peId: 'pe-split-1',
    economicActorId: 'agent-1',
    recordedAtMs: 1_700_000_000_000,
    beneficiary: {
      linked: true,
      humanWalletId: 'wallet-human-1',
      humanUserId: 'human-1',
      humanAddress: HUMAN,
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    },
  })!;
  return {
    peId: 'pe-split-1',
    economicActorId: 'agent-1',
    recordedAtMs: 1_700_000_000_000,
    linkageState: 'beneficiary_linked',
    beneficiaryAgentShareBps: 2_000,
    fixedGrantSource: 'none',
    routingSnapshot,
    routingSnapshotHash: hashBeneficiaryRoutingSnapshot(routingSnapshot),
    beneficiaryWalletId: 'human-1',
    pvtSplit: { total: 10, agent_share: 2, human_share: 8, ratio: 0.2 },
  };
}

describe('beneficiary routing commitment', () => {
  it('accepts every exact integer agent share from 500 through 5000 BPS', () => {
    expect(DEFAULT_AGENT_BENEFICIARY_SHARE_BPS).toBe(2_000);
    expect(MIN_AGENT_BENEFICIARY_SHARE_BPS).toBe(500);
    expect(MAX_AGENT_BENEFICIARY_SHARE_BPS).toBe(5_000);
    for (let bps = 500; bps <= 5_000; bps += 1) {
      expect(canonicalAgentBeneficiaryShareBps({ bps })).toBe(bps);
      expect(canonicalAgentBeneficiaryShareBps({ legacyRatio: bps / 10_000 })).toBe(bps);
    }
  });

  it.each([
    { bps: 499 },
    { bps: 5_001 },
    { bps: 500.1 },
    { bps: 4_999.999 },
    { bps: Number.NaN },
    { bps: Number.POSITIVE_INFINITY },
    { bps: '2000' },
  ])('rejects invalid exact-BPS input $bps', (input) => {
    expect(canonicalAgentBeneficiaryShareBps(input)).toBeNull();
  });

  it.each([
    {},
    { bps: 2_000, legacyRatio: 0.2 },
    { bps: 2_000, extra: true },
    { legacyRatio: '0.2' },
  ])('rejects ambiguous or malformed helper input %#', (input) => {
    expect(canonicalAgentBeneficiaryShareBps(input as never)).toBeNull();
  });

  it.each([
    0.0499,
    0.5001,
    0.05001,
    0.333333,
    0.20001,
    0.1 + 0.2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects out-of-range or sub-BPS legacy ratio %p without rounding', (legacyRatio) => {
    expect(canonicalAgentBeneficiaryShareBps({ legacyRatio })).toBeNull();
  });

  it('refuses a linked routing snapshot whose share is not canonical BPS', () => {
    expect(() => createBeneficiaryRoutingSnapshot({
      peId: 'pe-noncanonical-ratio',
      economicActorId: 'agent-1',
      recordedAtMs: 1,
      beneficiary: {
        linked: true,
        humanWalletId: 'wallet-human-1',
        humanUserId: 'human-1',
        humanAddress: HUMAN,
        agentShareBps: 3_333.33 as never,
      },
    })).toThrow('beneficiary_routing_bps_invalid');
  });

  it('binds the PE, actor, human wallet/user/address, and exact BPS', () => {
    const input = fixture();
    expect(assertBeneficiaryRoutingEvidence(input)).toEqual(input.routingSnapshot);
  });

  it('rejects recipient, ratio, commitment, and legacy split substitution', () => {
    const input = fixture();
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      beneficiaryWalletId: 'attacker',
    })).toThrow('beneficiary_routing_binding_mismatch');
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      beneficiaryAgentShareBps: 3_000,
    })).toThrow('beneficiary_routing_binding_mismatch');
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      routingSnapshotHash: `sha256:${'f'.repeat(64)}`,
    })).toThrow('beneficiary_routing_binding_mismatch');
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      pvtSplit: { ...input.pvtSplit, agent_share: 8, human_share: 2 },
    })).toThrow('beneficiary_routing_legacy_split_mismatch');
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      pvtSplit: { ...input.pvtSplit, ratio: 0.20001 },
    })).toThrow('beneficiary_routing_legacy_split_invalid');
  });

  it('rejects an injected split on an unlinked or fixed-grant PE', () => {
    const input = fixture();
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      linkageState: 'unlinked',
    })).toThrow('beneficiary_routing_unexpected_split');
    expect(() => assertBeneficiaryRoutingEvidence({
      ...input,
      fixedGrantSource: 'genesis_campaign_reservation',
    })).toThrow('beneficiary_routing_unexpected_split');
  });

  it('accepts a genuinely unsplit PE only with no routing mirrors', () => {
    expect(assertBeneficiaryRoutingEvidence({
      peId: 'pe-unsplit',
      economicActorId: 'agent-2',
      recordedAtMs: 1,
      linkageState: 'unlinked',
      beneficiaryAgentShareBps: 10_000,
      fixedGrantSource: 'none',
      routingSnapshot: null,
      routingSnapshotHash: null,
      beneficiaryWalletId: null,
      pvtSplit: null,
    })).toBeNull();
  });
});
