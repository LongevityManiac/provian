import { NOVELTY_COUNTERS_COLLECTION } from './core/meter/batch-pricing-counters';
/**
 * ACCEPTANCE REPLAY (2a) + x402 RE-MINT TRANSITION (2b).
 *
 * Exercises the REAL recordPEAccrual end-to-end against a fake Firestore + mocked
 * externals (cache / beneficiary / jurisdiction). This is the standard mint path
 * a mapped PE from the watchers takes (generatePE → recordPEAccrual → pe_history →
 * settlement reads mint_status=='eligible'). We assert the resulting
 * pe_history record: action_type category, mint_status (eligibility for the
 * engine), and estimatedPVT.
 *
 * 2a: inbound receive, ordinary send, gasless-x402 (CHAIN-VERIFIED via the
 *     watcher), DEX swap each land a full-weight, standard-path,
 *     correctly-categorized ELIGIBLE PE. A self-report x402 — even carrying a
 *     client-supplied settlement hash — is x402_unverified (0), never mints.
 * 2b: Option B (x402 watcher-only mint). A self-report x402 mints 0
 *     (x402_unverified); when the CHAIN-VERIFIED watcher witnesses the real
 *     settlement the SAME payment mints exactly once (eligible), and a second
 *     chain-verified source is a corroborated_duplicate (0) - never
 *     double-minted, and the reputation count moves exactly once.
 */

import { jest } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';
import { DEFAULT_AGENT_BENEFICIARY_SHARE_BPS } from './core/agent-wallet/beneficiary-relationship';

// Singleton fake shared by recordPEAccrual + writePEHistory (both call admin.firestore()).
let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./core/pvt/__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

jest.mock('./cache', () => ({
  cache: {
    getUserDailyPECountStrict: jest.fn(async () => 0),
    getUserActionTypeCountStrict: jest.fn(async () => 0),
    isArtifactHashSeen: async () => false,
    recordArtifactHash: async () => {},
    incrementUserActionTypeCount: jest.fn(async () => 1),
    incrementHourlyPECount: jest.fn(async () => {}),
    commitPEAccountingCountersOnce: jest.fn(async () => ({ idempotent: false })),
  },
  CacheUnavailableError: class CacheUnavailableError extends Error {},
}));

const mockResolveBeneficiary = jest.fn<
  (...args: unknown[]) => Promise<BeneficiaryCacheEntry>
>(async () => ({
  linked: false,
  humanWalletId: null,
  humanUserId: null,
  humanAddress: null,
  agentShareBps: null,
}));
jest.mock('./core/pvt/beneficiary', () => ({
  resolveBeneficiary: mockResolveBeneficiary,
}));

jest.mock('./core/jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));

jest.mock('./core/pvt/delegation-pe', () => ({
  isDelegationQualifying: () => false,
  createDelegationPE: async () => {},
}));

jest.mock('./core/provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));

jest.mock('./core/foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual } from './pvt-accrual';
import { cache } from './cache';
import { prepareArtifactNoveltyClaim } from './core/pvt/artifact-novelty-claim';

const PAYER = '0x1111111111111111111111111111111111111111';
const CP = '0x2222222222222222222222222222222222222222';
const SETTLEMENT_A = `0x${'a'.repeat(64)}`;
const SETTLEMENT_B = `0x${'b'.repeat(64)}`;
const SETTLEMENT_C = `0x${'c'.repeat(64)}`;
const COMMIT_SHA = 'd'.repeat(40);

function verifiedEvidence(canonicalEventId: string): Record<string, unknown> {
  return {
    economicEvidenceState: 'verified',
    economicCanonicalEventId: canonicalEventId,
    tx_hash: canonicalEventId,
  };
}

interface PeHistoryRow {
  actionType: string;
  category: string;
  mint_status: string;
  mint_disposition: string;
  disposition_reason_code: string;
  policy_review_state: string;
  policy_review_reason_code: string;
  estimatedPVT: number;
  farm_cap_reason?: string | null;
  activity_mint_reservation?: { decision?: string } | null;
  activity_mint_reservation_hash?: string | null;
}

function peHistory(peId: string): PeHistoryRow | undefined {
  return mockDb.store.get(`pe_history/${peId}`) as PeHistoryRow | undefined;
}
function x402Count(): unknown {
  return (mockDb.store.get('agent_wallets/aw1') as { x402_payment_count?: unknown } | undefined)?.x402_payment_count;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveBeneficiary.mockReset();
  mockResolveBeneficiary.mockResolvedValue({
    linked: false,
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
  });
  mockDb.store.clear();
  mockDb.ops.length = 0;
  // A sovereign agent wallet whose address is the x402 payer (for reputation count).
  mockDb.store.set('agent_wallets/aw1', {
    id: 'aw1',
    agent_id: 'agent1',
    address: PAYER.toLowerCase(),
    platform: 'live',
  });
});

let seq = 0;
const nextPeId = () => `pe_acc_${seq++}`;

async function record(over: Record<string, unknown>): Promise<PeHistoryRow> {
  const peId = (over.peId as string) ?? nextPeId();
  await recordPEAccrual({
    peId,
    userId: 'agent1',
    integrationSource: 'pvt_accrual_acceptance_test',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: Date.UTC(2026, 6, 4, 12, 0),
    jurisdiction_context: 'US',
    // This helper models the watcher/durable-source path. Individual tests
    // explicitly set false when exercising a best-effort emitter.
    throwOnError: true,
    ...over,
  } as Parameters<typeof recordPEAccrual>[0]);
  const row = peHistory(peId);
  if (!row) throw new Error(`no pe_history for ${peId}`);
  return row;
}

// `receive` now requires a recipient-authored relationship to its
// counterparty. Seeds a prior outbound `send` PE from the standard test
// actor ('agent1') to `counterparty`, satisfying `resolveReceiveAuthorship`'s
// check the same way a real prior send would, so tests whose actual concern
// is unrelated to authorship (beneficiary routing, category/weight, etc.)
// can exercise an ordinary already-authored receive rather than incidentally
// landing on the new unsolicited-receive path.
function seedPriorSendTo(counterparty: string): void {
  mockDb.store.set(`provenance_envelopes/pe_seed_prior_send_${counterparty}`, {
    user_id: 'agent1',
    action_type: 'send',
    counterparty_address: counterparty,
  });
}

describe('2a — acceptance replay: financial PEs land eligible + full weight on the standard path', () => {
  it('seals a best-effort emitter record-only without consuming economic authority', async () => {
    const eligible = await record({
      peId: 'pe_durable_snapshot_source',
      actionType: 'send',
      counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xdurable-source:0'),
    });
    expect(eligible.mint_status).toBe('eligible');
    const suppliedSnapshot = mockDb.store.get('pe_history/pe_durable_snapshot_source')!
      .economic_snapshot;
    jest.clearAllMocks();

    const row = await record({
      peId: 'pe_best_effort_record_only',
      actionType: 'send',
      counterpartyAddress: '0x3333333333333333333333333333333333333333',
      ...verifiedEvidence('base:8453:0xbest-effort:0'),
      // A copied eligible snapshot must not bypass the durability gate.
      economicSnapshot: suppliedSnapshot,
      throwOnError: false,
    });

    expect(row).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      disposition_reason_code: 'policy_record_only',
      estimatedPVT: 0,
      activity_mint_reservation: null,
      activity_mint_reservation_hash: null,
    });
    expect([...mockDb.store.keys()].filter((key) =>
      key.startsWith('activity_mint_reservations/pe_best_effort_record_only'))).toHaveLength(0);

    const x402 = await record({
      peId: 'pe_best_effort_x402',
      actionType: 'x402_payment',
      counterpartyAddress: CP,
      x402PayerAddress: PAYER,
      x402SettlementTxHash: SETTLEMENT_C,
      x402ChainVerified: true,
      ...verifiedEvidence(`base:8453:${SETTLEMENT_C}:0`),
      throwOnError: false,
    });
    expect(x402).toMatchObject({ mint_status: 'record_only', estimatedPVT: 0 });
    expect([...mockDb.store.keys()].filter((key) => key.startsWith('x402_tx_mint_claims/')))
      .toHaveLength(0);
    expect(x402Count()).toBeUndefined();
    expect(cache.getUserDailyPECountStrict).not.toHaveBeenCalled();
    expect(cache.getUserActionTypeCountStrict).not.toHaveBeenCalled();
    expect(cache.incrementUserActionTypeCount).not.toHaveBeenCalled();
    expect(cache.commitPEAccountingCountersOnce).not.toHaveBeenCalled();
  });

  it('does not let best-effort setup provenance consume the physical-device slot', async () => {
    const deviceAttestationId = 'secure-enclave-best-effort-slot-test';
    const limiterKey = `device_pe_rate_limits/${deviceAttestationId}_wallet_created`;

    const bestEffort = await record({
      peId: 'pe_best_effort_wallet_created',
      actionType: 'wallet_created',
      deviceAttestationId,
      ...verifiedEvidence('device:best-effort-wallet-created'),
      throwOnError: false,
    });
    expect(bestEffort).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      estimatedPVT: 0,
    });
    expect(mockDb.store.has(limiterKey)).toBe(false);
    expect(cache.incrementUserActionTypeCount).not.toHaveBeenCalled();

    const firstDurable = await record({
      peId: 'pe_durable_wallet_created_first',
      actionType: 'wallet_created',
      deviceAttestationId,
      ...verifiedEvidence('device:durable-wallet-created:first'),
    });
    expect(firstDurable.mint_status).toBe('eligible');
    expect(mockDb.store.get(limiterKey)).toMatchObject({
      recorded_pe_ids: { pe_durable_wallet_created_first: expect.any(Number) },
    });

    const secondDurable = await record({
      peId: 'pe_durable_wallet_created_second',
      actionType: 'wallet_created',
      deviceAttestationId,
      ...verifiedEvidence('device:durable-wallet-created:second'),
    });
    expect(secondDurable).toMatchObject({
      mint_status: 'ineligible',
      mint_disposition: 'ineligible_terminal',
      estimatedPVT: 0,
    });
    expect(mockDb.store.get(limiterKey)).toMatchObject({
      recorded_pe_ids: { pe_durable_wallet_created_first: expect.any(Number) },
    });
    expect((mockDb.store.get(limiterKey) as { recorded_pe_ids?: Record<string, number> })
      .recorded_pe_ids?.pe_best_effort_wallet_created).toBeUndefined();
    expect((mockDb.store.get(limiterKey) as { recorded_pe_ids?: Record<string, number> })
      .recorded_pe_ids?.pe_durable_wallet_created_second).toBeUndefined();
  });

  it.each([
    ['badge_earned', 'policy_record_only'],
    ['pvt_badge_projection_completed', 'system_accounting_record_only'],
  ] as const)(
    'does not let durable record-only badge action %s consume Redis economic counters',
    async (actionType, dispositionReasonCode) => {
    const row = await record({
      peId: `pe_durable_${actionType}`,
      actionType,
    });

    expect(row).toMatchObject({
      mint_status: 'record_only',
      mint_disposition: 'record_only',
      disposition_reason_code: dispositionReasonCode,
      estimatedPVT: 0,
    });
    expect(mockDb.store.get(`pvt_accrual_effects/pe_durable_${actionType}`))
      .toMatchObject({
        state: 'complete',
        payload: { redisCountersRequired: false },
      });
    expect(cache.getUserDailyPECountStrict).not.toHaveBeenCalled();
    expect(cache.getUserActionTypeCountStrict).not.toHaveBeenCalled();
    expect(cache.commitPEAccountingCountersOnce).not.toHaveBeenCalled();
    },
  );

  it('parks an agent PE for review when beneficiary registry identity is unverifiable', async () => {
    seedPriorSendTo(CP); // authored receive - this test's concern is beneficiary routing, not
    mockResolveBeneficiary.mockRejectedValueOnce(new Error('beneficiary registry unavailable'));
    const row = await record({
      actionType: 'receive',
      ownerType: 'agent',
      counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xregistry-unavailable:0'),
    });

    expect(row).toMatchObject({
      mint_status: 'pending_review',
      mint_disposition: 'pending_review',
      disposition_reason_code: 'awaiting_review',
      estimatedPVT: 0,
    });
  });

  it('applies the beneficiary split to a software-attested agent-device PE', async () => {
    mockDb.store.set('wallets/agent-device-wallet', {
      id: 'agent-device-wallet',
      type: 'agent',
      agent_id: 'wallet_aw_agent_device',
      address: '0x5555555555555555555555555555555555555555',
    });
    mockDb.store.set('agent_wallets/agent-device', {
      id: 'agent-device',
      agent_id: 'wallet_aw_agent_device',
      address: '0x5555555555555555555555555555555555555555',
    });
    mockDb.store.set('wallets/human-beneficiary-wallet', {
      id: 'human-beneficiary-wallet',
      type: 'human',
      user_id: 'human-beneficiary',
      address: '0x4444444444444444444444444444444444444444',
    });
    mockResolveBeneficiary.mockResolvedValueOnce({
      linked: true,
      humanWalletId: 'wallet-human-beneficiary',
      humanUserId: 'human-beneficiary',
      humanAddress: '0x4444444444444444444444444444444444444444',
      agentShareBps: DEFAULT_AGENT_BENEFICIARY_SHARE_BPS,
    });
    const peId = 'pe_software_agent_device_split';
    const row = await record({
      peId,
      userId: 'wallet_aw_agent_device',
      actionType: 'send',
      ownerType: 'agent',
      attestationDepth: 'software',
      counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xagent-device:0'),
    });

    expect(row.mint_status).toBe('eligible');
    expect(mockResolveBeneficiary).toHaveBeenCalledWith(
      'wallet_aw_agent_device',
      expect.anything(),
    );
    const stored = mockDb.store.get(`pe_history/${peId}`)!;
    expect(stored.beneficiary_wallet_id).toBe('human-beneficiary');
    expect(stored.pvt_split).toMatchObject({ ratio: 0.2 });
    expect((stored.economic_snapshot as {
      recordTimeFactors: { linkageState: string; beneficiaryAgentShareBps: number };
    }).recordTimeFactors).toMatchObject({
      linkageState: 'beneficiary_linked',
      beneficiaryAgentShareBps: 2_000,
    });
  });

  it('does not apply agent-beneficiary lookup to a human-owned hardware PE', async () => {
    const peId = 'pe_hardware_human_device';
    await record({
      peId,
      userId: 'human-owner',
      actionType: 'send',
      ownerType: 'human',
      attestationDepth: 'hardware',
      counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xhuman-device:0'),
    });

    expect(mockResolveBeneficiary).not.toHaveBeenCalled();
    expect(mockDb.store.get(`pe_history/${peId}`)).toMatchObject({
      beneficiary_wallet_id: null,
      pvt_split: null,
    });
  });

  it.each(['before_pe_history', 'after_pe_history'] as const)(
    'durable retry resumes the same PE exactly once after %s crash',
    async (crashAt) => {
      const peId = `pe_durable_${crashAt}`;
      const base = {
        peId,
        userId: 'agent1',
        integrationSource: 'durable_watcher_test',
        actionType: 'receive',
        attestationDepth: 'software',
        peHash: `h_${peId}`,
        timestamp: Date.UTC(2026, 6, 4, 12, 0),
        jurisdiction_context: 'US',
        counterpartyAddress: CP,
        throwOnError: true,
        ...verifiedEvidence(`base:8453:${peId}:0`),
      } satisfies Parameters<typeof recordPEAccrual>[0];
      await expect(recordPEAccrual({ ...base, durableTestCrashAt: crashAt })).rejects.toThrow(
        `injected_durable_accrual_crash:${crashAt}`,
      );
      if (crashAt === 'before_pe_history') {
        expect(mockDb.store.get(`pe_history/${peId}`)).toBeUndefined();
      } else {
        expect(mockDb.store.get(`pe_history/${peId}`)).toBeDefined();
      }

      await recordPEAccrual(base);
      await recordPEAccrual(base);
      expect(mockDb.store.get(`pvt_accrual/${base.userId}`)).toMatchObject({ totalPEs: 1 });
      expect(mockDb.store.get(`pvt_accrual_effects/${peId}`)).toMatchObject({ state: 'complete' });
      const network = [...mockDb.store.entries()].filter(([key]) =>
        key.startsWith('pvt_network_stats/global/shards/'));
      expect(network).toHaveLength(1);
      expect(network[0][1]).toMatchObject({ totalPEs: 1 });
    },
  );

  it('wallet_created resumes the original device-rate slot after a pre-PE crash', async () => {
    const peId = 'pe_wallet_created_original';
    const base = {
      peId,
      userId: 'human1',
      integrationSource: 'human_wallet_registration',
      actionType: 'wallet_created',
      attestationDepth: 'hardware',
      peHash: `h_${peId}`,
      timestamp: Date.UTC(2026, 6, 4, 12, 0),
      jurisdiction_context: 'US',
      deviceAttestationId: 'secure-enclave-device-a',
      ownerType: 'human' as const,
      walletAddress: PAYER,
      throwOnError: true,
    } satisfies Parameters<typeof recordPEAccrual>[0];
    await expect(recordPEAccrual({
      ...base,
      durableTestCrashAt: 'before_pe_history',
    })).rejects.toThrow('injected_durable_accrual_crash:before_pe_history');
    await recordPEAccrual(base);
    expect(peHistory(peId)).toMatchObject({ mint_status: 'eligible' });

    await recordPEAccrual({
      ...base,
      peId: 'pe_wallet_created_different',
      peHash: 'h_pe_wallet_created_different',
    });
    expect(peHistory('pe_wallet_created_different')).toMatchObject({
      mint_status: 'ineligible',
      estimatedPVT: 0,
    });
  });

  it('inbound receive with a recipient-authored relationship → category wallet, mint_status eligible, PVT > 0', async () => {
    seedPriorSendTo(CP); // receive now requires an authored relationship to mint
    const r = await record({
      actionType: 'receive', counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xreceive:0'),
    });
    expect(r.category).toBe('wallet');
    expect(r.mint_status).toBe('eligible');
    expect(r.estimatedPVT).toBeGreaterThan(0);
  });

  // the defect this closes. A `receive` with NO recipient-authored
  // relationship to its counterparty - the unsolicited-dust-transfer shape -
  // must seal record_only (fully witnessed, zero mint), never eligible.
  it('unsolicited inbound receive (no authored relationship) → record_only, zero PVT', async () => {
    const strangerAddress = '0x9999999999999999999999999999999999999999';
    const r = await record({
      actionType: 'receive', counterpartyAddress: strangerAddress,
      ...verifiedEvidence('base:8453:0xunsolicited:0'),
    });
    expect(r.category).toBe('wallet');
    expect(r.mint_status).toBe('record_only');
    expect(r.mint_disposition).toBe('record_only');
    expect(r.disposition_reason_code).toBe('unsolicited_receive_record_only');
    expect(r.estimatedPVT).toBe(0);
  });

  // wiring check: an UNRESOLVABLE authorship check (a registry read
  // failure) must route to the recoverable `pending_review` hold, NEVER to
  // the terminal `record_only` seal a genuinely-unsolicited receive gets.
  // Collapsing the two would let a transient Firestore outage permanently
  // strip mint eligibility from what might be a real, authored relationship
  // - see the RED CONTROL in receive-authorship.test.ts for the unit-level
  // proof; this proves the SAME distinction survives real wiring through
  // recordPEAccrual's precedence chain, not just the detector in isolation.
  // Only the `provenance_envelopes` QUERY path is broken (not `.doc()`
  // writes, which pe-utils/recordPEAccrual still need to succeed) so this
  // isolates the authorship check specifically, not same-owner detection or
  // the PE write itself.
  it('receive with an unresolvable authorship check → pending_review, never record_only', async () => {
    const strangerAddress = '0x8888888888888888888888888888888888888888';
    const realCollection = mockDb.collection.bind(mockDb);
    const spy = jest.spyOn(mockDb, 'collection').mockImplementation(((name: string) => {
      if (name === 'provenance_envelopes') {
        const real = realCollection(name);
        return { ...real, where: () => { throw new Error('firestore_unavailable_test'); } };
      }
      return realCollection(name);
    }) as never);
    let r;
    try {
      r = await record({
        actionType: 'receive', counterpartyAddress: strangerAddress,
        ...verifiedEvidence('base:8453:0xunresolvable:0'),
      });
    } finally {
      spy.mockRestore();
    }
    expect(r.mint_status).toBe('pending_review');
    expect(r.mint_disposition).toBe('pending_review');
    // ops-dashboard build: the granular hold reason for a thrown receive-authorship check.
    expect(r.disposition_reason_code).toBe('receive_authorship_unresolvable');
    expect(r.estimatedPVT).toBe(0);
  });

  it('ordinary send → wallet, eligible, PVT > 0', async () => {
    const r = await record({
      actionType: 'send', counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xsend:0'),
    });
    expect(r.category).toBe('wallet');
    expect(r.mint_status).toBe('eligible');
    expect(r.estimatedPVT).toBeGreaterThan(0);
    expect(r.activity_mint_reservation).toMatchObject({ decision: 'reserved' });
    expect(r.activity_mint_reservation_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('DEX swap → wallet, eligible, PVT > 0', async () => {
    const r = await record({
      actionType: 'swap', counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xswap:0'),
    });
    expect(r.category).toBe('wallet');
    expect(r.mint_status).toBe('eligible');
    expect(r.estimatedPVT).toBeGreaterThan(0);
  });

  it('an unverified swap record (the app\'s own record) seals pending_evidence and holds NO daily swap slot', async () => {
    const held = await record({ peId: 'pe_app_swap_record', actionType: 'swap' });
    expect(held.mint_disposition).toBe('pending_evidence');
    expect(held.estimatedPVT).toBe(0);
    expect(held.activity_mint_reservation ?? null).toBeNull();
    expect([...mockDb.store.keys()].filter((key) =>
      key.startsWith('activity_mint_reservations/pe_app_swap_record'))).toHaveLength(0);
    // RED pair: the chain-verified swap of the same actor still reserves its slot,
    // so the exclusion is reachable and narrow.
    const verified = await record({
      peId: 'pe_chain_swap', actionType: 'swap', counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xswapverified:0'),
    });
    expect(verified.mint_status).toBe('eligible');
    expect(verified.activity_mint_reservation).toMatchObject({ decision: 'reserved' });
  });

  it('gasless x402 CHAIN-VERIFIED (watcher) → x402, eligible, PVT > 0, counts reputation once', async () => {
    const r = await record({
      actionType: 'x402_payment',
      counterpartyAddress: CP,
      x402PayerAddress: PAYER,
      x402SettlementTxHash: SETTLEMENT_A,
      x402ChainVerified: true, // Option B: only a chain-verified watcher emit mints
      ...verifiedEvidence(`base:8453:${SETTLEMENT_A}:0`),
    });
    expect(r.category).toBe('x402');
    expect(r.mint_status).toBe('eligible');
    expect(r.estimatedPVT).toBeGreaterThan(0);
    expect(x402Count()).toBe(1);
  });

  it('x402 with a settlement tx but NOT chain-verified (self-report) → x402_unverified, 0 PVT, no reputation count', async () => {
    // The faucet Option B closes: a self-report can carry ANY client-supplied
    // settlement hash, but without chain verification it can never mint or count.
    const r = await record({
      actionType: 'x402_payment',
      counterpartyAddress: CP,
      x402PayerAddress: PAYER,
      x402SettlementTxHash: '0xclient_fabricated_tx',
      // no x402ChainVerified
    });
    expect(r.category).toBe('x402');
    expect(r.mint_status).toBe('x402_unverified');
    expect(r.estimatedPVT).toBe(0);
    expect(x402Count()).toBeUndefined(); // reputation NOT counted for a self-report
  });

  it('financial full weight: a software-attested send == a hardware-attested send (same PVT)', async () => {
    const soft = await record({
      actionType: 'send', counterpartyAddress: CP,
      attestationDepth: 'software', ...verifiedEvidence('base:8453:0xsoft:0'),
    });
    // Compare tiers in independent counter windows at the same occurrence ordinal.
    for (const k of mockDb.store.keys()) if (k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')) mockDb.store.delete(k);
    const hard = await record({
      actionType: 'send',
      counterpartyAddress: '0x3333333333333333333333333333333333333333',
      attestationDepth: 'hardware', ...verifiedEvidence('base:8453:0xhard:0'),
    });
    expect(soft.estimatedPVT).toBe(hard.estimatedPVT);
  });

  it('amount, fiat, exchange, and token-quote extras cannot change economics', async () => {
    const low = await record({
      actionType: 'send',
      counterpartyAddress: CP,
      amount: '1', fiatQuote: 0.01, exchangeRatio: 1, tokenQuote: 2,
      ...verifiedEvidence('base:8453:0xvalue-invariant-low:0'),
    });
    // Metadata neutrality compares equal ordinals, not successive acts' novelty decay.
    for (const k of mockDb.store.keys()) if (k.startsWith(NOVELTY_COUNTERS_COLLECTION + '/')) mockDb.store.delete(k);
    const high = await record({
      actionType: 'send',
      counterpartyAddress: '0x3333333333333333333333333333333333333333',
      amount: '999999999999', fiatQuote: 999, exchangeRatio: 888, tokenQuote: 777,
      ...verifiedEvidence('base:8453:0xvalue-invariant-high:0'),
    });
    expect(high.mint_status).toBe(low.mint_status);
    expect(high.estimatedPVT).toBe(low.estimatedPVT);
  });

  it('invalid counterparty identity fails closed', async () => {
    const invalidCounterparty = await record({
      actionType: 'send',
      counterpartyAddress: 'not-an-evm-address',
      ...verifiedEvidence('base:8453:0xinvalid-counterparty:0'),
    });
    expect(invalidCounterparty).toMatchObject({
      mint_status: 'farm_capped',
      farm_cap_reason: 'unverifiable_counterparty',
      estimatedPVT: 0,
    });
  });
});

describe('atomic mint-once and artifact-novelty evidence', () => {
  const ARTIFACT = '9'.repeat(64);
  const SECOND_COMMIT = 'e'.repeat(40);

  function verifiedWork(
    peId: string,
    commitSha: string,
    artifactHash = ARTIFACT,
  ): Record<string, unknown> {
    return {
      peId,
      actionType: 'service:github_commit',
      commitSha,
      artifact_hash: artifactHash,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: `github:commit:${commitSha}`,
      economicSessionLineageId: `session:github-app:${commitSha}`,
      // service:* self-attested software now EARNS 2.4x (eligible), but
      // this block pins the mint-once/novelty CLAIM machinery on the proven
      // variant (a chain-corroborated forge event at the flat 3.0x) so the
      // claim/novelty assertions ride a stable full-value witness. The
      // self-attested earning is pinned in the dedicated block below.
      attestationDepth: 'on_chain_verified',
    };
  }

  it('commits event and novelty ownership with history and reuses artifact novelty exactly', async () => {
    const first = await record(verifiedWork('pe_claim_first', COMMIT_SHA));
    expect(first.mint_status).toBe('eligible');
    const firstStored = mockDb.store.get('pe_history/pe_claim_first')!;
    expect(firstStored.mint_once_claim_evidence).toMatchObject([
      { relation: 'owner', claim: { claim_kind: 'artifact', owner_pe_id: 'pe_claim_first' } },
      { relation: 'owner', claim: { claim_kind: 'commit', owner_pe_id: 'pe_claim_first' } },
    ]);
    expect(firstStored.mint_once_claim_evidence_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect((firstStored.economic_snapshot as {
      recordTimeFactors: { uniqueArtifact: boolean; exactDuplicate: boolean };
    }).recordTimeFactors).toMatchObject({ uniqueArtifact: true, exactDuplicate: false });

    const second = await record(verifiedWork('pe_claim_second', SECOND_COMMIT));
    expect(second.mint_status).toBe('eligible');
    const secondStored = mockDb.store.get('pe_history/pe_claim_second')!;
    expect(secondStored.mint_once_claim_evidence).toMatchObject([
      { relation: 'duplicate', claim: { claim_kind: 'artifact', owner_pe_id: 'pe_claim_first' } },
      { relation: 'owner', claim: { claim_kind: 'commit', owner_pe_id: 'pe_claim_second' } },
    ]);
    expect((secondStored.economic_snapshot as {
      recordTimeFactors: { uniqueArtifact: boolean; exactDuplicate: boolean };
    }).recordTimeFactors).toMatchObject({ uniqueArtifact: false, exactDuplicate: false });
    expect([...mockDb.store.keys()].filter((key) => key.startsWith('artifact_novelty_claims/')))
      .toHaveLength(1);
  });

  it('leaves no event or novelty claim after a crash before pe_history, then converges', async () => {
    const peId = 'pe_claim_crash';
    // The commit-claim atomicity this test pins is exercised by a MINTABLE
    // witness. a software-tier service:github_commit is itself
    // mintable (2.4x), but this test uses the proof-tier (on_chain_verified)
    // variant — the same one `verifiedWork` above uses — as a stable full-value
    // witness that creates the claim atomically with pe_history.
    const base: Parameters<typeof recordPEAccrual>[0] = {
      peId,
      userId: 'agent1',
      integrationSource: 'claim_crash_acceptance',
      actionType: 'service:github_commit',
      attestationDepth: 'on_chain_verified',
      peHash: `h_${peId}`,
      timestamp: Date.UTC(2026, 6, 4, 12, 0),
      jurisdiction_context: 'US',
      throwOnError: true,
      commitSha: COMMIT_SHA,
      artifact_hash: ARTIFACT,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: `github:commit:${COMMIT_SHA}`,
      economicSessionLineageId: `session:github-app:${COMMIT_SHA}`,
    };
    await expect(recordPEAccrual({
      ...base,
      durableTestCrashAt: 'before_pe_history',
    })).rejects.toThrow('injected_durable_accrual_crash:before_pe_history');
    expect([...mockDb.store.keys()].filter((key) =>
      key.startsWith('commit_mint_claims/') || key.startsWith('artifact_novelty_claims/')))
      .toHaveLength(0);
    expect(mockDb.store.get(`pe_history/${peId}`)).toBeUndefined();

    await recordPEAccrual(base);
    expect(mockDb.store.get(`pe_history/${peId}`)).toBeDefined();
    expect([...mockDb.store.keys()].filter((key) => key.startsWith('commit_mint_claims/')))
      .toHaveLength(1);
    expect([...mockDb.store.keys()].filter((key) => key.startsWith('artifact_novelty_claims/')))
      .toHaveLength(1);
  });

  it('does not let a financial PE smuggle artifact novelty into its economics', async () => {
    const row = await record({
      peId: 'pe_artifact_smuggled',
      actionType: 'send',
      artifact_hash: ARTIFACT,
      counterpartyAddress: CP,
      ...verifiedEvidence('base:8453:0xartifact-smuggled:0'),
    });
    expect(row).toMatchObject({ mint_status: 'pending_review', estimatedPVT: 0 });
    expect([...mockDb.store.keys()].filter((key) => key.startsWith('artifact_novelty_claims/')))
      .toHaveLength(0);
  });

  it('holds for review and preserves a malformed novelty claim byte-for-byte', async () => {
    const plan = await prepareArtifactNoveltyClaim(
      mockDb as unknown as Firestore,
      'agent1',
      ARTIFACT,
      'prospective-only',
      Date.UTC(2026, 6, 4, 12, 0),
      1,
    );
    const key = `artifact_novelty_claims/${plan.evidence.claim.claim_id}`;
    const malformed = { schema_version: 'unknown', owner_pe_id: 'attacker' };
    mockDb.store.set(key, malformed);

    const row = await record(verifiedWork('pe_artifact_malformed', COMMIT_SHA));
    expect(row).toMatchObject({ mint_status: 'pending_review', estimatedPVT: 0 });
    expect(mockDb.store.get(key)).toEqual(malformed);
  });
});

describe('the forge witness earns base weight (service:* self-attested software = 0.8x)', () => {
  // The LIVE webhook shape: HMAC-verified, evidence verified, software tier by
  // construction (github-webhook.ts step 9 — no device key on this path). The
  // webhook proves the push is AUTHENTIC and is OBSERVED work, so under it
  // EARNS the family's base weight at the software discount: 3.0x weight × 0.8
  // software = 2.4x. A chain-corroborated variant lifts it to the flat 3.0x.
  // reversed 's terminal-zero floor on the evidence axis.
  it('the software-tier HMAC webhook witness records ELIGIBLE and earns 2.4x (3.0 weight × 0.8 software)', async () => {
    const r = await record({
      peId: 'pe_forge_earn',
      actionType: 'service:github_commit',
      commitSha: 'f'.repeat(40),
      economicEvidenceState: 'verified',
      economicCanonicalEventId: `github:commit:${'f'.repeat(40)}`,
      // attestationDepth 'software' is the record() default — the live webhook tier
    });
    expect(r.mint_status).toBe('eligible');
    expect(r.estimatedPVT).toBeGreaterThan(0);
    const stored = mockDb.store.get('pe_history/pe_forge_earn') as Record<string, unknown>;
    const snap = stored.economic_snapshot as {
      mintReasonCode: string;
      recordPointsAtomic: string;
      recordTimeFactors: { attestationMultiplierBps: number; effectiveActionWeightBps: number };
    };
    expect(snap.mintReasonCode).toBe('policy_eligible');
    // 1e18 × 3.0 weight × 1.0 novelty × 1.0 daily × 1.0 linkage × 0.8 software
    expect(snap.recordPointsAtomic).toBe('2400000000000000000');
    expect(snap.recordTimeFactors.attestationMultiplierBps).toBe(8_000);
    // Weight untouched — 30,000 bps (3.0x) stays sealed; the software discount lifts to proof.
    expect(snap.recordTimeFactors.effectiveActionWeightBps).toBe(30_000);
  });

  it('a scripted-commit swarm of distinct SHAs each EARNS — volume never zeroes it; the per-device daemon + real inference cost is the Sybil bound', async () => {
    for (const i of [1, 2, 3]) {
      const sha = `${i}`.repeat(40).slice(0, 40);
      const r = await record({
        peId: `pe_forge_swarm_${i}`,
        actionType: 'service:gitlab_push',
        commitSha: sha,
        economicEvidenceState: 'verified',
        economicCanonicalEventId: `gitlab:push:${sha}`,
      });
      expect(r.mint_status).toBe('eligible');
      expect(r.estimatedPVT).toBeGreaterThan(0);
    }
  });
});

describe('/the (user, commit_sha) mint-once claim: the BEST-VALUE witness owns it, arrival-independent (both RECORD-time orders; scopes the guarantee to the 72h window)', () => {
  // The flagship interaction: a self-attested GitHub webhook
  // (service:github_commit, software tier → eligible at 2.4x) and a
  // hardware-proven Mac-SE device PE (coding_session, hardware_partial → the
  // family's flat 1.0x) for the SAME commit. mint-once means the WORK mints
  // ONCE, and the commit mints exactly once regardless of arrival order. Under
  // both are mintable; then decides the WINNER by BASE WEIGHT rather
  // than arrival order — the forge webhook (base 3.0x) out-weighs the device
  // coding_session (base 1.0x), so it owns the slot in BOTH orders, TAKING OVER a
  // device that landed first. The release branch stays live: a TERMINAL
  // witness (record_only / ineligible_terminal) still reserves nothing — pinned
  // in the last test with a reachable same-owner webhook.
  const SHA = 'a1'.repeat(20); // 40 hex, distinct from COMMIT_SHA
  const webhook = (peId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    peId,
    actionType: 'service:github_commit',
    attestationDepth: 'software', // the live HMAC webhook tier
    commitSha: SHA,
    economicEvidenceState: 'verified',
    economicCanonicalEventId: `github:commit:${SHA}`,
    ...over,
  });
  const device = (peId: string): Record<string, unknown> => ({
    peId,
    actionType: 'coding_session',
    attestationDepth: 'hardware_partial', // human Mac Secure Enclave CLI
    commitSha: SHA,
    economicEvidenceState: 'verified',
    economicCanonicalEventId: `coding:session:${SHA}`,
  });
  // The commit_mint_claims ledger, as (owner_pe_id) — the ONE mintable owner.
  const commitClaimOwners = (): string[] => [...mockDb.store.entries()]
    .filter(([key]) => key.startsWith('commit_mint_claims/'))
    .map(([, v]) => (v as { owner_pe_id: string }).owner_pe_id);

  it('webhook-first: the higher-base webhook owns the slot; the later device is the duplicate and corroborates the webhook', async () => {
    const w = await record(webhook('pe_d341_wh_first'));
    expect(w.mint_status).toBe('eligible');
    expect(w.estimatedPVT).toBeGreaterThan(0);
    // The mintable webhook owns the slot (reverses the era where a
    // zero-priced webhook released it).
    expect(commitClaimOwners()).toEqual(['pe_d341_wh_first']);

    const d = await record(device('pe_d341_dev_second'));
    // The device (base 1.0x) never displaces the higher-base webhook.
    expect(d.mint_status).toBe('corroborated_duplicate');
    expect(d.estimatedPVT).toBe(0);
    expect(commitClaimOwners()).toEqual(['pe_d341_wh_first']); // still one owner, no double-mint
    // Case 2: the lower-base cross-witness corroborates the WINNER, so the
    // webhook carries the cross-witness corroboration that lifts it at settlement.
    expect((mockDb.store.get('pe_history/pe_d341_wh_first') as Record<string, unknown>)
      .corroboration_status).toBe('service_grant_attested');
  });

  it('device-first: the higher-base webhook TAKES OVER and mints; the device is demoted, never double-minted ', async () => {
    const d = await record(device('pe_d341_dev_first'));
    expect(d.mint_status).toBe('eligible');
    expect(d.estimatedPVT).toBeGreaterThan(0);
    expect(commitClaimOwners()).toEqual(['pe_d341_dev_first']);

    const w = await record(webhook('pe_d341_wh_second'));
    // best-value takeover: the forge webhook (base 3.0x) out-weighs the
    // device coding_session (base 1.0x), so it CLAIMS the not-yet-settled slot —
    // arrival order no longer decides. The webhook mints; the device is demoted.
    expect(w.mint_status).toBe('eligible');
    expect(w.estimatedPVT).toBeGreaterThan(0);
    // The webhook owns as a NON-duplicate (it re-owned the claim; exactDuplicate false).
    const stored = mockDb.store.get('pe_history/pe_d341_wh_second') as Record<string, unknown>;
    expect(stored.mint_once_claim_evidence).toMatchObject([
      { relation: 'owner', claim: { claim_kind: 'commit', owner_pe_id: 'pe_d341_wh_second' } },
    ]);
    expect((stored.economic_snapshot as { recordTimeFactors: { exactDuplicate: boolean } })
      .recordTimeFactors.exactDuplicate).toBe(false);
    // The winner carries the cross-witness corroboration sealed by the takeover.
    expect(stored.corroboration_status).toBe('service_grant_attested');
    // The claim was RE-OWNED — still exactly one owner, no double-mint.
    expect(commitClaimOwners()).toEqual(['pe_d341_wh_second']);
    // The device is demoted (mutable mint_status only; its sealed snapshot survives).
    const devAfter = mockDb.store.get('pe_history/pe_d341_dev_first') as Record<string, unknown>;
    expect(devAfter.mint_status).toBe('corroborated_duplicate');
    expect(devAfter.economic_snapshot).toBeDefined();
  });

  it(' release branch (reachable under): a TERMINAL same-owner webhook (record_only) reserves NOTHING, so a later clean device mints once', async () => {
    // Un-zeroing the software tier did not remove the release branch — it
    // fires on ANY terminal-zero disposition. A same-owner webhook seals
    // record_only (self_or_shared_beneficial_ownership), which is terminal, so it
    // reserves nothing and the first MINTABLE witness still owns the slot.
    const w = await record(webhook('pe_d341_wh_sameowner', { economicSelfReferencing: true }));
    expect(w.mint_status).toBe('record_only');
    expect(w.estimatedPVT).toBe(0);
    expect(commitClaimOwners()).toEqual([]); // terminal witness reserves nothing

    const d = await record(device('pe_d341_dev_after_terminal'));
    expect(d.mint_status).toBe('eligible');
    expect(d.estimatedPVT).toBeGreaterThan(0);
    expect(commitClaimOwners()).toEqual(['pe_d341_dev_after_terminal']);
  });
});

describe('2b — x402 re-mint transition: verifiable-only, exactly once, no double-count', () => {
  it('no-tx self-report mints 0 (x402_unverified) and does NOT count reputation', async () => {
    const r = await record({
      actionType: 'x402_payment',
      counterpartyAddress: CP,
      x402PayerAddress: PAYER,
      // no x402SettlementTxHash
    });
    expect(r.mint_status).toBe('x402_unverified');
    expect(r.estimatedPVT).toBe(0);
    expect(x402Count()).toBeUndefined(); // reputation NOT counted yet
  });

  it('the SAME payment mints exactly once when the CHAIN-VERIFIED watcher witnesses it; a 2nd source is a duplicate', async () => {
    // 1) self-report with no settlement: recorded, minted 0, not counted.
    const unverified = await record({
      peId: 'pe_x_self', actionType: 'x402_payment',
      counterpartyAddress: CP, x402PayerAddress: PAYER,
    });
    expect(unverified.mint_status).toBe('x402_unverified');
    expect(x402Count()).toBeUndefined();

    // 2) the chain-verified watcher witnesses the real on-chain settlement: SAME
    //    payment now mints exactly once and counts reputation exactly once.
    const verified = await record({
      peId: 'pe_x_chain', actionType: 'x402_payment',
      counterpartyAddress: CP, x402PayerAddress: PAYER, x402SettlementTxHash: SETTLEMENT_B,
      x402ChainVerified: true,
      ...verifiedEvidence(`base:8453:${SETTLEMENT_B}:0`),
    });
    expect(verified.mint_status).toBe('eligible');
    expect(verified.estimatedPVT).toBeGreaterThan(0);
    expect(x402Count()).toBe(1); // counted exactly once now

    // 3) a second chain-verified source witnesses the SAME (payer, settlement):
    //    duplicate, mints 0, does NOT re-count. Not stuck at 0 for the payment
    //    (step 2 minted); not doubled.
    const dup = await record({
      peId: 'pe_x_dup', actionType: 'x402_payment',
      counterpartyAddress: CP, x402PayerAddress: PAYER, x402SettlementTxHash: SETTLEMENT_B,
      x402ChainVerified: true,
      ...verifiedEvidence(`base:8453:${SETTLEMENT_B}:0`),
    });
    expect(dup.mint_status).toBe('corroborated_duplicate');
    expect(dup.estimatedPVT).toBe(0);
    expect(x402Count()).toBe(1); // STILL exactly one - not double-counted
  });

  it('two x402s side by side: the chain-verified one mints; the self-report is x402_unverified (0)', async () => {
    // Focused Option-B gate check: chain verification, not settlement-hash presence,
    // is what mints. The self-report even carries a (client) settlement tx and is
    // still 0.
    const verified = await record({
      peId: 'pe_x_cv', actionType: 'x402_payment',
      counterpartyAddress: CP, x402PayerAddress: PAYER,
      x402SettlementTxHash: SETTLEMENT_C, x402ChainVerified: true,
      ...verifiedEvidence(`base:8453:${SETTLEMENT_C}:0`),
    });
    expect(verified.mint_status).toBe('eligible');
    expect(verified.estimatedPVT).toBeGreaterThan(0);

    const selfReport = await record({
      peId: 'pe_x_sr', actionType: 'x402_payment',
      counterpartyAddress: '0x4444444444444444444444444444444444444444',
      x402PayerAddress: PAYER, x402SettlementTxHash: '0xsettle_sr',
      // no x402ChainVerified → self-report, cannot mint
    });
    expect(selfReport.mint_status).toBe('x402_unverified');
    expect(selfReport.estimatedPVT).toBe(0);
  });
});

describe('atomic accounting — genuinely unseen action identifiers fail closed', () => {
  it('records zero, creates one visible pending-policy item, and cannot use Tier-2 fallback', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // RED for the next case: with no witness at all (actor_declared) the same unseen type
      // records at zero and NEVER reaches the queue (new-type intake,, A3).
      const bare = await record({
        peId: 'pe_wp1_bare',
        actionType: 'thirdparty:wp1_never_seen_action',
        integrationSource: 'acceptance_test_connector',
      });
      expect(bare).toMatchObject({ mint_disposition: 'record_only', estimatedPVT: 0, witness_class: 'actor_declared' });
      expect([...mockDb.store.keys()].filter((key) => key.startsWith('pvt_pending_policy_queue/'))).toEqual([]);

      const row = await record({
        actionType: 'thirdparty:wp1_never_seen_action',
        integrationSource: 'acceptance_test_connector',
        witnessClass: 'device_tier',
      });
      // an unseen type on a WITNESS lane is
      // class-admitted for recording only — record_only at zero at every class — and is queued
      // for the policy setter signature (the signing-proposal surface, never an admission gate).
      expect(row).toMatchObject({
        mint_status: 'record_only',
        mint_disposition: 'record_only',
        disposition_reason_code: 'policy_record_only',
        policy_review_state: 'class_admitted',
        policy_review_reason_code: 'witness_class_admitted',
        estimatedPVT: 0,
      });

      const queueRows = [...mockDb.store.entries()]
        .filter(([key]) => key.startsWith('pvt_pending_policy_queue/'))
        .map(([, value]) => value as Record<string, unknown>);
      expect(queueRows).toHaveLength(1);
      expect(queueRows[0]).toMatchObject({
        action_type: 'thirdparty:wp1_never_seen_action',
        observation_count: 1,
        integration_sources: ['acceptance_test_connector'],
        mint_disposition: 'record_only',
        policy_review_state: 'pending_policy',
        alert_status: 'pending',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not let an unseen record-only type consume a known commit witness claim', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const unknown = await record({
        peId: 'pe_unknown_commit',
        actionType: 'thirdparty:unknown_commit_wrapper',
        integrationSource: 'device_pe_submit',
        commitSha: COMMIT_SHA,
      });
      expect(unknown.mint_status).toBe('record_only');
      expect(
        [...mockDb.store.keys()].filter((key) => key.startsWith('commit_mint_claims/')),
      ).toHaveLength(0);

      const known = await record({
        peId: 'pe_known_commit',
        actionType: 'service:github_commit',
        integrationSource: 'device_pe_submit',
        commitSha: COMMIT_SHA,
        economicEvidenceState: 'verified',
        economicCanonicalEventId: `github:commit:${COMMIT_SHA}`,
        economicSessionLineageId: `session:github-app:${COMMIT_SHA}`,
        // proven tier — the software-tier witness floors (see the
        // dedicated block); the claim-consumption property needs the
        // minting variant.
        attestationDepth: 'on_chain_verified',
      });
      expect(known.mint_status).toBe('eligible');
      const claims = [...mockDb.store.entries()]
        .filter(([key]) => key.startsWith('commit_mint_claims/'))
        .map(([, value]) => value);
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        schema_version: 'pvt-mint-once-claim/v1',
        owner_pe_id: 'pe_known_commit',
      });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// =============================================================================
// B11 / (nonce-gap control) — the cross-source financial-settlement
// mint-once, exercised through the REAL recordPEAccrual wiring. Every case
// below was previously an empty population: the block, the duplicate flag's
// four consumers, and the id-shape gate had no coverage.
// =============================================================================

import { canonicalLogIdentity } from './core/pvt/institution-funding-watcher';

describe('B11 — financial-settlement cross-source mint-once (accrual wiring,)', () => {
  const TX = `0x${'f'.repeat(64)}`;
  const WATCHED = PAYER; // the watched settling address (agent_wallets/aw1)

  function financialClaims(): Array<Record<string, unknown>> {
    return [...mockDb.store.entries()]
      .filter(([key]) => key.startsWith('financial_settlement_mint_claims/'))
      .map(([, value]) => value as Record<string, unknown>);
  }

  it('a chain-verified send CLAIMS its log identity and mints; the SAME canonical event from a second seal records corroborated_duplicate / 0', async () => {
    const logId = canonicalLogIdentity(8453, TX, 3);
    const first = await record({
      peId: 'pe_watch_send_1',
      actionType: 'send',
      counterpartyAddress: CP,
      walletAddress: WATCHED,
      ...verifiedEvidence(logId),
    });
    expect(first.mint_status).toBe('eligible');
    expect(financialClaims()).toHaveLength(1);
    expect(financialClaims()[0]).toMatchObject({
      claim_kind: 'financial_settlement',
      owner_pe_id: 'pe_watch_send_1',
      subject_id: WATCHED.toLowerCase(),
    });

    // Second source, same canonical event (a hypothetically-durable self-report
    // of the SAME on-chain act, different PE + action type — the exact
    // double-mint scenario). Records for chain integrity; mints 0.
    const dup = await record({
      peId: 'pe_self_report_same_event',
      actionType: 'agent_token_transfer',
      counterpartyAddress: CP,
      walletAddress: WATCHED,
      ...verifiedEvidence(logId),
    });
    expect(dup.mint_status).toBe('corroborated_duplicate');
    expect(financialClaims()).toHaveLength(1); // no second claim doc
  });

  it('[defect-1 regression control] two DISTINCT logs in ONE transaction BOTH mint — the claim is log-granular, never per-transaction', async () => {
    const a = await record({
      peId: 'pe_batch_log3',
      actionType: 'send',
      counterpartyAddress: CP,
      walletAddress: WATCHED,
      ...verifiedEvidence(canonicalLogIdentity(8453, TX, 3)),
    });
    const b = await record({
      peId: 'pe_batch_log7',
      actionType: 'send',
      counterpartyAddress: '0x3333333333333333333333333333333333333333',
      walletAddress: WATCHED,
      ...verifiedEvidence(canonicalLogIdentity(8453, TX, 7)),
    });
    expect(a.mint_status).toBe('eligible');
    expect(b.mint_status).toBe('eligible');
    expect(financialClaims()).toHaveLength(2);
  });

  it('x402_payment is EXCLUDED — it takes its own claim kind, never a financial-settlement claim', async () => {
    await record({
      peId: 'pe_x402_excluded',
      actionType: 'x402_payment',
      counterpartyAddress: CP,
      walletAddress: WATCHED,
      x402PayerAddress: PAYER,
      x402SettlementTxHash: TX,
      x402ChainVerified: true,
      ...verifiedEvidence(TX),
    });
    expect(financialClaims()).toHaveLength(0);
    const x402Claims = [...mockDb.store.keys()].filter((k) => k.startsWith('x402_tx_mint_claims/'));
    expect(x402Claims).toHaveLength(1);
  });

  it('an UNVERIFIED submission prepares NO claim (the evidence gate is load-bearing)', async () => {
    await record({
      peId: 'pe_unverified_send',
      actionType: 'send',
      counterpartyAddress: CP,
      walletAddress: WATCHED,
      economicEvidenceState: undefined,
      economicCanonicalEventId: canonicalLogIdentity(8453, TX, 9),
    });
    expect(financialClaims()).toHaveLength(0);
  });

  it('[shape-binding control] the id form the REAL watcher seals is exactly what the claim gate accepts', async () => {
    // Bound by USAGE to the single production source (canonicalLogIdentity),
    // so a format change on either side fails here instead of silently
    // skipping every claim (the inverse risk).
    const sealed = canonicalLogIdentity(8453, TX, 12);
    expect(sealed).toBe(`8453:${TX}:12`);
    const row = await record({
      peId: 'pe_shape_bind',
      actionType: 'swap',
      counterpartyAddress: CP,
      walletAddress: WATCHED,
      ...verifiedEvidence(sealed),
    });
    expect(row.mint_status).toBe('eligible');
    expect(financialClaims()).toHaveLength(1);
    expect(financialClaims()[0].event_id).toBe(sealed);
  });
});
