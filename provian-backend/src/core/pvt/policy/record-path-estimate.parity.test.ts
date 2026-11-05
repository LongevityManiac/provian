/**
 * THE ACCEPTANCE TEST FOR C-2: what the estimator SHOWS is what the rail PAYS.
 *
 * The claim under test is an equality between two independently-reached
 * numbers, so it is checked three ways, because any one of them alone is a
 * guard that could pass while wrong :
 *
 * (1) AGAINST THE REAL ACCRUAL. `recordPEAccrual` is driven end-to-end over a
 * fake Firestore, and the `economic_snapshot` it SEALS into `pe_history`
 * is compared to `estimateFromRecordPath` for the same inputs, as exact
 * 18-decimal strings. Nothing here re-implements pricing: one side is the
 * shipped money path, the other is the shipped estimator. This is the leg
 * that cannot be satisfied by the estimator mirroring itself.
 *
 * (2) AGAINST AN INDEPENDENT DERIVATION OF THE ARITHMETIC. The bps formula is
 * re-implemented in this file from the factors the snapshot reports, so a
 * wrong PRODUCT is visible even if both sides agree on the inputs. The bps
 * VALUES are read from the live policy, never copied here.
 * **THIS LEG DOES NOT CATCH AN INPUT-CONSTRUCTION BUG** it recomputes
 * from `estimate.factors`, which the snapshot derives from the same input,
 * so a wrong input moves both operands identically. Demonstrated:
 * defaulting `linkageState` to `human_linked` leaves this leg 10/10 GREEN
 * and kills 11 of leg (1). Leg (1) is the guard for inputs; do not trim it
 * on the strength of this one.
 *
 * (3) OVER A COUNTED POPULATION. The action-type list is asserted non-empty
 * and its size pinned, so a filter that silently empties it fails instead
 * of passing vacuously.
 *
 * RED CONTROLS for each leg are recorded in the decision entry; two of them are
 * kept permanently in-suite at the bottom of this file rather than being run
 * once by hand.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from '../beneficiary';

// Singleton fake shared by recordPEAccrual + writePEHistory (both call admin.firestore()).
let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('../__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});

jest.mock('../../../cache', () => ({
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
jest.mock('../beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../../jurisdiction/jurisdiction-policy', () => ({
  getJurisdictionPolicy: async () => 'immediate',
}));
jest.mock('../delegation-pe', () => ({
  isDelegationQualifying: () => false,
  createDelegationPE: async () => {},
}));
jest.mock('../../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'financial',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

import { recordPEAccrual } from '../../../pvt-accrual';
import { estimateFromRecordPath } from './record-path-estimate';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import { BPS_DENOMINATOR, type RecordEconomicSnapshot } from './monetary-accounting';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY as GENESIS } from './proposed-genesis-policy';
import { hashGenesisCampaignPolicyManifest } from './genesis-policy-engine';
import { hashProposedMonetaryPolicyTemplate } from './proposed-monetary-policy';
import { ACTION_TYPE_MINT_RULES } from '../activity-mint-limits';
import { PROVIAN_SERVICE_WALLETS_EVM } from '../provian-service-wallets';

/**
 * Representative action types spanning the disposition classes the kernel can
 * produce. Bound to the live policy below, never to a hand-written expectation.
 */
const ACTION_TYPES = Object.freeze([
  'wallet_created',            // eligible, x10 birth-certificate weight
  'agent_work_product_code',   // session-lineage gated
  'agent_action',              // session-lineage gated
  'commit',                    // institution-lifecycle evidence
  'x402_payment',              // pending_evidence, financial-neutral attestation
  'receive',                   // financial, daily ceiling only
  'badge_earned',              // record-only, zero weight
  'myapp:unknown_thing',       // permissionless, no policy entry
  // EVERY action type carrying a standing anti-farm rule. The original set had
  // only `receive` (whose ceiling is not reached at ordinal 1) and
  // `x402_payment` (whose x402 gate fires BEFORE the cap check, so the cap
  // branch never ran) — so the activity-cap gate was structurally unreachable
  // by this suite, and the estimator shipped without modelling it at all:
  // `send` read pending_evidence / 2.0 PVT against a sealed
  // ineligible_terminal / 0. Adding these three made the suite red.
  'send',                      // verified counterparty + daily ceiling 25
  'swap',                      // daily ceiling 25
  'stake',                     // no cap since (a record_only row)
]);

const TIMESTAMP = Date.UTC(2026, 7, 3, 12, 0);

let seq = 0;

interface PeRow {
  mint_disposition: string;
  estimatedPVT: number;
  economic_snapshot: RecordEconomicSnapshot | null;
}

/**
 * BOTH SIDES MUST BE FED THE SAME SUBMISSION, or the comparison is meaningless.
 * The estimator's defaults are: a device anchor IS present (for the
 * device-rate-limited setup types) and an x402 settlement is NOT chain-verified.
 * The accrual is handed exactly those two facts here — a unique device anchor
 * per case so the 90-day window is genuinely open, and no chain-verified x402
 * witness. `deviceAnchorPresent: false` is covered by its own case below.
 */
async function seal(
  actionType: string,
  durable: boolean,
  over: Record<string, unknown> = {},
): Promise<PeRow> {
  const peId = `pe_parity_${seq++}`;
  await recordPEAccrual({
    peId,
    userId: 'agent1',
    actionType,
    integrationSource: 'record_path_estimate_parity_test',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    throwOnError: durable,
    deviceAttestationId: `device_anchor_${peId}`,
    // a real `receive` PE ALWAYS carries a counterparty (the
    // inbound-USDC watcher stamps the observed fromAddress) - the receive-
    // authorship gate only runs when one is present. Without this default,
    // the generic loop's plain `seal('receive', true)` call never exercises
    // that gate at all, making the estimator's conservative default
    // (assumed unsolicited - see `receiveAuthored` on
    // RecordPathEstimateParams) untestable by this suite. No relationship is
    // seeded for this synthetic address, matching the estimator's own
    // conservative default.
    ...(actionType === 'receive' ? { counterpartyAddress: '0x707070707070707070707070707070707070700f' } : {}),
    ...over,
  } as Parameters<typeof recordPEAccrual>[0]);
  const row = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!row) throw new Error(`no pe_history row sealed for ${actionType}`);
  return row;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveBeneficiary.mockResolvedValue({
    linked: false,
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
  });
  mockDb.store.clear();
  mockDb.ops.length = 0;
});

describe('(3) the population is real', () => {
  it('evaluates a non-empty, pinned set of action types', () => {
    // A universally-quantified claim over zero items proves nothing. If this
    // list is ever filtered to nothing, THIS fails rather than the suite
    // passing green over an empty loop.
    expect(ACTION_TYPES.length).toBe(11);
    expect(ACTION_TYPES.length).toBeGreaterThan(0);
  });

  it('covers EVERY action type carrying a standing anti-farm rule', () => {
    // Bound to the rule table, not to a list copied here: a new capped action
    // type fails this until it is added to the population, so the gate cannot
    // become structurally unreachable by this suite again.
    for (const capped of Object.keys(ACTION_TYPE_MINT_RULES)) {
      expect(ACTION_TYPES).toContain(capped);
    }
    expect(Object.keys(ACTION_TYPE_MINT_RULES).length).toBeGreaterThan(0);
  });
});

describe('(1) the estimator equals what the REAL accrual seals', () => {
  it.each(ACTION_TYPES)(
    '%s — durable inlet: record points and disposition match to the wei',
    async (actionType) => {
      const sealed = await seal(actionType, true);
      const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType,
        durableSubmissionPath: true,
        recordedAtMs: TIMESTAMP,
      });

      expect(sealed.economic_snapshot).not.toBeNull();
      // Exact string equality on 18-decimal atomic units: no float, no rounding.
      expect(estimate.record_points_atomic)
        .toBe(sealed.economic_snapshot!.recordPointsAtomic);
      expect(estimate.mint_disposition).toBe(sealed.mint_disposition);
      // And the PVT figure the user is shown equals what the accrual stamped.
      expect(Number(estimate.estimated_pvt_atomic) / 1e18).toBeCloseTo(sealed.estimatedPVT, 8);
    },
  );

  it.each(ACTION_TYPES)(
    '%s — best-effort inlet (the live relay path): both say record_only and 0 PVT',
    async (actionType) => {
      const sealed = await seal(actionType, false);
      const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType,
        durableSubmissionPath: false,
        recordedAtMs: TIMESTAMP,
      });

      expect(estimate.record_points_atomic)
        .toBe(sealed.economic_snapshot!.recordPointsAtomic);
      expect(estimate.mint_disposition).toBe('record_only');
      expect(sealed.mint_disposition).toBe('record_only');
      expect(estimate.estimated_pvt_atomic).toBe('0');
      expect(sealed.estimatedPVT).toBe(0);
    },
  );
});

describe('(2) an independent derivation of the bps arithmetic agrees', () => {
  it.each(ACTION_TYPES)('%s — recomputed from the reported factors', async (actionType) => {
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType,
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    const f = estimate.factors;

    // The formula, written a second time. Values come from the live policy via
    // the snapshot's own factors — only the ARITHMETIC is duplicated, which is
    // the point: a bug in the shared input builder changes the factors, and
    // this recomputation follows them while the kernel's product would not.
    const product = (
      BigInt(f.base_points_atomic)
      * BigInt(f.effective_action_weight_bps)
      * BigInt(f.novelty_bps)
      * BigInt(f.daily_diminishing_bps)
      * BigInt(f.linkage_multiplier_bps)
      * BigInt(f.attestation_multiplier_bps)
    ) / (BigInt(BPS_DENOMINATOR) ** 5n);
    // A terminal operational verdict zeroes the points OUTRIGHT — the bps
    // product alone does not explain the sealed number. This suite originally
    // asserted only the product and failed on `x402_payment` (expected 2e18,
    // sealed 0), which is the suppression arm being genuinely reachable.
    const expected = f.suppress_record_points ? 0n : product;

    expect(estimate.record_points_atomic).toBe(expected.toString(10));
  });

  it('the suppression arm is exercised by this population, not merely branched on', async () => {
    // Guards against the arm above silently becoming dead: if nothing in the
    // set suppresses, `f.suppress_record_points ? 0n : product` degenerates to
    // the product and the test stops covering the terminal path.
    const flags = await Promise.all(ACTION_TYPES.map(async (actionType) => {
      const e = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType, durableSubmissionPath: true, recordedAtMs: TIMESTAMP,
      });
      return e.factors.suppress_record_points;
    }));
    expect(flags.filter(Boolean).length).toBeGreaterThan(0);
    expect(flags.filter((f) => !f).length).toBeGreaterThan(0);
  });

  it('the pinned action weights are the kernel\'s, not the retired float tiers', async () => {
    // wallet_created is the type the retired framework got most wrong: it
    // quoted 1.6 against a record path of 10. Bind to the policy, not to 10.
    const policy = materializeProposedMonetaryPolicy(0);
    const walletCreated = policy.actions.wallet_created;
    expect(walletCreated).toBeDefined();

    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(estimate.factors.effective_action_weight_bps)
      .toBe(walletCreated.policyOverrideBps ?? walletCreated.baseWeightBps);
    expect(estimate.mint_disposition).toBe('eligible');
    // 1 base point x 10.0x action weight x 1.0 novelty x 1.0 daily
    //   x 1.0 unlinked x 0.8 software = 8.0 record points... unless the action
    // weight says otherwise. Assert the RELATION, not a literal.
    expect(BigInt(estimate.record_points_atomic)).toBeGreaterThan(0n);
  });
});

describe('the two terminal gates the estimator must model, not ignore', () => {
  it('wallet_created with NO device anchor: both sides say 0 (Security Invariant #9)', async () => {
    // The parity suite originally failed here — the estimator quoted 10 PVT
    // against a sealed 0, because it modelled the bps arithmetic but not the
    // device gate. Both directions are now pinned.
    const sealed = await seal('wallet_created', true, { deviceAttestationId: undefined });
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created',
      durableSubmissionPath: true,
      deviceAnchorPresent: false,
      recordedAtMs: TIMESTAMP,
    });
    expect(sealed.economic_snapshot!.recordPointsAtomic).toBe('0');
    expect(estimate.record_points_atomic).toBe('0');
    expect(estimate.mint_disposition).toBe('ineligible_terminal');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('a self-reported x402 mints 0 on both sides; only a chain-verified witness pays', async () => {
    const selfReported = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'x402_payment',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(selfReported.estimated_pvt_atomic).toBe('0');
    expect(selfReported.mint_disposition).toBe('ineligible_terminal');
    expect(selfReported.assumptions.join(' ')).toContain('outbound-USDC watcher');

    // Chain-verified ALONE is still not enough: x402_payment also requires a
    // verified counterparty, so an unidentified counterparty is capped
    // `unverifiable_counterparty` and suppressed. Both facts the watcher
    // supplies are needed before it prices above zero — which is what makes
    // the zeros above real refusals rather than a stuck constant.
    const chainVerifiedOnly = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'x402_payment',
      durableSubmissionPath: true,
      chainVerifiedSettlement: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(chainVerifiedOnly.record_points_atomic).toBe('0');
    expect(chainVerifiedOnly.assumptions.join(' ')).toContain('verified counterparty');

    const watcherEmit = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'x402_payment',
      durableSubmissionPath: true,
      chainVerifiedSettlement: true,
      counterpartyVerified: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(BigInt(watcherEmit.record_points_atomic)).toBeGreaterThan(0n);
    expect(watcherEmit.mint_disposition).not.toBe('ineligible_terminal');
  });

  // (second review pass, defect #3): `seal()`'s generic helper never
  // passes a counterpartyAddress, so `receive` in the main ACTION_TYPES loop
  // above never exercises the receive-authorship gate on the accrual side
  // (pvt-accrual.ts only runs the check when a counterparty is present) -
  // the estimator's default (conservative: assumed unsolicited, see
  // `receiveAuthored` on RecordPathEstimateParams) was therefore
  // structurally unreachable by this suite, exactly the class of defect this
  // describe block exists to catch for the other two terminal gates above.
  it('receive with an unrelated counterparty (no authored relationship): both say record_only / 0 (the realistic default)', async () => {
    const CP = '0x777777777777777777777777777777777777777d';
    const sealed = await seal('receive', true, { counterpartyAddress: CP });
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'receive',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
    expect(estimate.mint_disposition).toBe('record_only');
    expect(estimate.estimated_pvt_atomic).toBe('0');
    expect(estimate.assumptions.join(' ')).toContain('assumed UNSOLICITED');
  });

  it('receive WITH a recipient-authored relationship: both sides mint (receiveAuthored: true matches a real authored seal)', async () => {
    const CP = '0x888888888888888888888888888888888888888e';
    // Seed the SAME prior-outbound-PE relationship resolveReceiveAuthorship
    // checks in production - see receive-authorship.test.ts for the fixture
    // shape this mirrors.
    mockDb.store.set('provenance_envelopes/pe_parity_receive_seed_send', {
      user_id: 'agent1',
      action_type: 'send',
      counterparty_address: CP,
    });
    // receive's policy requires verified evidence to reach `eligible` - an
    // authored relationship alone only clears the gate, not the
    // pre-existing evidence requirement. Both sides need the same fact.
    const sealed = await seal('receive', true, {
      counterpartyAddress: CP,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0xreceiveparity:0',
      tx_hash: 'base:8453:0xreceiveparity:0',
    });
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'receive',
      durableSubmissionPath: true,
      receiveAuthored: true,
      evidenceState: 'verified',
      canonicalEventId: 'base:8453:0xreceiveparity:0',
      recordedAtMs: TIMESTAMP,
    });
    expect(sealed.mint_disposition).not.toBe('record_only');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(estimate.mint_disposition).not.toBe('record_only');
    expect(BigInt(estimate.estimated_pvt_atomic)).toBeGreaterThan(0n);
    expect(estimate.assumptions.join(' ')).not.toContain('assumed UNSOLICITED');
  });

  it('artifact novelty on a NON-compute type is refused, not priced on the unique curve', async () => {
    // pvt-accrual only honours an artifact-novelty claim for `compute` actions;
    // any other type that still prices (not record_only) has the claim REFUSED.
    // Without this mirror, a caller claiming an artifact on a non-compute type
    // got the unique-artifact novelty curve — priced high. F-A7 repriced the
    // relay-draft `commit` to record_only (where the refusal is moot — 0 points
    // regardless), so this exercises the still-pricing `escrow_completed`
    // (institutional, seals pending_evidence in a bare estimate — not compute,
    // not record_only), where the refusal is meaningful.
    const nonCompute = 'escrow_completed';
    expect(materializeProposedMonetaryPolicy(0).actions[nonCompute]?.category)
      .not.toBe('compute');

    const claimed = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: nonCompute,
      durableSubmissionPath: true,
      uniqueArtifact: true,
      occurrenceOrdinal: 15,
      recordedAtMs: TIMESTAMP,
    });
    const plain = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: nonCompute,
      durableSubmissionPath: true,
      occurrenceOrdinal: 15,
      recordedAtMs: TIMESTAMP,
    });
    // At ordinal 15 the two novelty curves differ (unique-artifact 8000 bps vs
    // ordinary 3000), so a refusal that failed to bite would be visible here.
    expect(claimed.factors.novelty_bps).toBe(plain.factors.novelty_bps);
    expect(claimed.record_points_atomic).toBe(plain.record_points_atomic);

    // POSITIVE CONTROL — the unique-artifact curve is reachable, so the
    // equality above is a real refusal and not a curve that never applies.
    const computeType = Object.entries(materializeProposedMonetaryPolicy(0).actions)
      .find(([, p]) => p.category === 'compute')?.[0];
    expect(computeType).toBeDefined();
    const onCompute = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: computeType!,
      durableSubmissionPath: true,
      uniqueArtifact: true,
      occurrenceOrdinal: 15,
      recordedAtMs: TIMESTAMP,
    });
    expect(onCompute.factors.novelty_bps).not.toBe(plain.factors.novelty_bps);
  });

  it('the activity-cap gate: send needs a verified counterparty to price at all', async () => {
    // The defect the reviewer reproduced: `send` estimated pending_evidence /
    // 2.0 PVT against a sealed ineligible_terminal / 0.
    const unidentified = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'send', durableSubmissionPath: true, recordedAtMs: TIMESTAMP,
    });
    expect(unidentified.record_points_atomic).toBe('0');
    expect(unidentified.mint_disposition).toBe('ineligible_terminal');

    const identified = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'send',
      durableSubmissionPath: true,
      counterpartyVerified: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(BigInt(identified.record_points_atomic)).toBeGreaterThan(0n);
  });
});

describe('Genesis prices through the RESERVATION kernel, not a copied constant', () => {
  const GENESIS_TYPES = Object.freeze([
    'genesis_human_signup',
    'genesis_signup',
    'genesis_device_link',
  ]);

  function armActivation(): void {
    mockDb.store.set('pvt_policy_activations/genesis', {
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: `sha256:${'a'.repeat(64)}`,
      approval_signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: `sha256:${'b'.repeat(64)}`,
        armored_signature: 'ARMORED',
      },
      frank_approval_audit_id: 'parity-approval',
      approved_policy_version: GENESIS.policy_version,
      approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(GENESIS),
      approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
      effective_at_ms: GENESIS.window.start_ms,
      admission_closed_at_ms: null,
      admission_close_audit_id: null,
      grants_enabled: true,
      genesis_kill_switch_active: false,
      canonical_pvt_manifest_id: GENESIS.arming.canonical_pvt_manifest_id,
      ledger_namespace: GENESIS.arming.ledger_namespace,
      prior_reservations_reconciled: true,
      operator_activation_audit_id: 'parity-operator',
    });
  }

  it('counts the Genesis population', () => {
    expect(GENESIS_TYPES.length).toBe(3);
    expect(GENESIS.bounties.length).toBe(3);
  });

  it.each(GENESIS_TYPES)('%s reserves exactly its approved fixed grant', async (actionType) => {
    armActivation();
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType,
      recordedAtMs: GENESIS.window.start_ms!,
      genesisApprovalVerifier: () => true,
    });
    // Bound to the manifest the reservation kernel reads, never to 75/75/25.
    const bounty = GENESIS.bounties.find((b) => b.emitted_action_types.includes(actionType))!;
    expect(estimate.record_points_atomic).toBe(bounty.fixed_grant_atomic);
    expect(estimate.estimated_pvt_atomic).toBe(bounty.fixed_grant_atomic);
    expect(estimate.mint_disposition).toBe('eligible');
    expect(estimate.genesis?.reservable).toBe(true);
  });

  it('refuses outside the window and pays nothing, naming the kernel\'s own reason', async () => {
    armActivation();
    const closed = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'genesis_human_signup',
      recordedAtMs: GENESIS.window.end_ms! + 86_400_000,
      genesisApprovalVerifier: () => true,
    });
    expect(closed.genesis?.deny_reason).toBe('campaign_closed');
    expect(closed.record_points_atomic).toBe('0');
    expect(closed.estimated_pvt_atomic).toBe('0');
  });

  it('SHUTDOWN COVERAGE: past the accrual end line Genesis quotes no grant (RED against the in-window CONTROL above)', async () => {
    armActivation();
    const saved = process.env.PVT_ACCRUAL_END_MS;
    process.env.PVT_ACCRUAL_END_MS = '1';
    try {
      const ended = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType: 'genesis_human_signup',
        recordedAtMs: GENESIS.window.start_ms!,
        genesisApprovalVerifier: () => true,
      });
      expect(ended.genesis?.reservable).toBe(false);
      expect(ended.genesis?.deny_reason).toBe('campaign_closed');
      expect(ended.estimated_pvt_atomic).toBe('0');
    } finally {
      if (saved === undefined) delete process.env.PVT_ACCRUAL_END_MS;
      else process.env.PVT_ACCRUAL_END_MS = saved;
    }
  });

  it('an unverified activation signature pays nothing', async () => {
    armActivation();
    const refused = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'genesis_human_signup',
      recordedAtMs: GENESIS.window.start_ms!,
      genesisApprovalVerifier: () => false,
    });
    expect(refused.genesis?.deny_reason).toBe('proposal_not_approved');
    expect(refused.estimated_pvt_atomic).toBe('0');
  });

  it('with NO activation document at all, it pays nothing', async () => {
    const dark = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'genesis_human_signup',
      recordedAtMs: GENESIS.window.start_ms!,
    });
    expect(dark.genesis?.reservable).toBe(false);
    expect(dark.estimated_pvt_atomic).toBe('0');
  });
});

describe('permanent RED controls — these must be able to fail', () => {
  it('a disposition change alone breaks parity, so the disposition IS load-bearing', async () => {
    // Same action type, only the submission path differs. If the estimator
    // ignored durability (the defect: quoting record points as PVT), these two
    // would return the same estimated_pvt and this assertion would fail.
    const durable = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    const bestEffort = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created',
      durableSubmissionPath: false,
      recordedAtMs: TIMESTAMP,
    });
    expect(durable.record_points_atomic).toBe(bestEffort.record_points_atomic);
    expect(durable.estimated_pvt_atomic).not.toBe(bestEffort.estimated_pvt_atomic);
    expect(bestEffort.estimated_pvt_atomic).toBe('0');
  });

  it('a permissionless type prices at ZERO on the actor-declared lane, not at a default tier', async () => {
    // The retired framework fell back to a default tier and quoted 0.8 for any
    // unknown identifier. The kernel has no fallback: absence is zero — and under §2.8
    // an unnamed type on the ACTOR-DECLARED lane (the default) admits at the class
    // base 0 → record_only. The estimate names the lane it quoted.
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'myapp:unknown_thing',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(estimate.record_points_atomic).toBe('0');
    expect(estimate.estimated_pvt_atomic).toBe('0');
    expect(estimate.mint_disposition).toBe('record_only');
    expect(estimate.mint_reason_code).toBe('policy_record_only');
  });

  // The estimator quotes the record path for the selected witness lane. An
  // unnamed type records at weight zero on every lane and earns only after a
  // named row is signed; a class witness alone cannot mint it.
  it('new-type intake: an unnamed type quotes 0 on the device_tier lane too (RED: a named row on the same lane quotes > 0)', async () => {
    const lane = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'myapp:unknown_thing',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
      witnessClass: 'device_tier',
    });
    expect(lane.mint_disposition).toBe('record_only');
    expect(lane.record_points_atomic).toBe('0');
    const noLane = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'myapp:unknown_thing',
      durableSubmissionPath: true,
      recordedAtMs: TIMESTAMP,
    });
    expect(noLane.record_points_atomic).toBe('0');
    // A named row is byte-identical under any non-hardware lane (the class is not a reprice), and
    // it is priced > 0 — the RED control that this estimate can quote a nonzero number at all.
    const namedDefault = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created', durableSubmissionPath: true, recordedAtMs: TIMESTAMP,
    });
    const namedDevice = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created', durableSubmissionPath: true, recordedAtMs: TIMESTAMP, witnessClass: 'device_tier',
    });
    expect(namedDevice.record_points_atomic).toBe(namedDefault.record_points_atomic);
    expect(BigInt(namedDevice.record_points_atomic)).toBeGreaterThan(0n);
  });

  it('the daily ordinal neither zeroes nor disqualifies — the estimate is volume-flat', async () => {
    const inside = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'wallet_created',
      durableSubmissionPath: true,
      dailyOrdinal: 50,
      recordedAtMs: TIMESTAMP,
    });
    expect(BigInt(inside.record_points_atomic)).toBeGreaterThan(0n);

    // Beyond the FORMER bound the estimate is identical: same points,
    // same disposition, at ordinal 51 and at extreme volume.
    for (const dailyOrdinal of [51, 2_001, 1_000_001]) {
      const beyond = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType: 'wallet_created',
        durableSubmissionPath: true,
        dailyOrdinal,
        recordedAtMs: TIMESTAMP,
      });
      expect(beyond.record_points_atomic).toBe(inside.record_points_atomic);
      expect(beyond.mint_disposition).toBe(inside.mint_disposition);
    }
  });
});

// a payment to a Provian service wallet seals record_only `provian_service_fee`.
// The quote must say the same thing the seal does (C-2), and the GREEN twin — the same submission
// to a stranger — must price on BOTH sides, so neither side can pass by returning record_only
// for everything.
describe('the Provian service-fee seal: estimate and accrual agree', () => {
  const STRANGER = '0x5000000000000000000000000000000000000005';
  const fact = (id: string) => ({
    economicEvidenceState: 'verified',
    economicCanonicalEventId: id,
    tx_hash: id,
  });

  it.each([...PROVIAN_SERVICE_WALLETS_EVM.keys()])('a send to %s: both sides record_only provian_service_fee at 0', async (wallet) => {
    const id = `base:8453:0xservicefee${wallet.slice(2, 8)}:0`;
    const sealed = await seal('send', true, { counterpartyAddress: wallet, ...fact(id) });
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'send',
      durableSubmissionPath: true,
      counterpartyVerified: true,
      counterpartyAddress: wallet,
      evidenceState: 'verified',
      canonicalEventId: id,
      recordedAtMs: TIMESTAMP,
    });
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.economic_snapshot?.mintReasonCode).toBe('provian_service_fee');
    expect(sealed.estimatedPVT).toBe(0);
    expect(estimate.mint_disposition).toBe('record_only');
    expect(estimate.mint_reason_code).toBe('provian_service_fee');
    expect(estimate.estimated_pvt_atomic).toBe('0');
  });

  it('GREEN twin: the same send to a stranger prices on both sides', async () => {
    const id = 'base:8453:0xservicefeestranger:0';
    const sealed = await seal('send', true, { counterpartyAddress: STRANGER, ...fact(id) });
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'send',
      durableSubmissionPath: true,
      counterpartyVerified: true,
      counterpartyAddress: STRANGER,
      evidenceState: 'verified',
      canonicalEventId: id,
      recordedAtMs: TIMESTAMP,
    });
    expect(sealed.mint_disposition).toBe('eligible');
    expect(sealed.estimatedPVT).toBeGreaterThan(0);
    expect(estimate.mint_disposition).toBe('eligible');
    expect(BigInt(estimate.estimated_pvt_atomic)).toBeGreaterThan(0n);
  });

  it('the fee is sealed before the activity cap, on both sides: an unasserted counterparty still quotes the fee, not a cap', async () => {
    const [treasury] = [...PROVIAN_SERVICE_WALLETS_EVM.keys()];
    const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
      actionType: 'send',
      durableSubmissionPath: true,
      counterpartyAddress: treasury,
      recordedAtMs: TIMESTAMP,
    });
    expect(estimate.mint_reason_code).toBe('provian_service_fee');
  });
});

describe('SHUTDOWN COVERAGE: past the accrual end line the estimate quotes what the accrual seals', () => {
  it.each(ACTION_TYPES)('%s — durable inlet past the line: both say record_only and 0 PVT', async (actionType) => {
    const saved = process.env.PVT_ACCRUAL_END_MS;
    process.env.PVT_ACCRUAL_END_MS = '1';
    try {
      const sealed = await seal(actionType, true);
      const estimate = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType,
        durableSubmissionPath: true,
        recordedAtMs: TIMESTAMP,
      });
      expect(sealed.mint_disposition).toBe('record_only');
      expect(estimate.mint_disposition).toBe('record_only');
      expect(estimate.record_points_atomic).toBe(sealed.economic_snapshot!.recordPointsAtomic);
      expect(estimate.estimated_pvt_atomic).toBe('0');
      expect(sealed.estimatedPVT).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.PVT_ACCRUAL_END_MS;
      else process.env.PVT_ACCRUAL_END_MS = saved;
    }
  });

  it('the population mints before the line (the durable parity block above), so this is not vacuous', async () => {
    const eligible: string[] = [];
    for (const actionType of ACTION_TYPES) {
      const e = await estimateFromRecordPath(mockDb as unknown as Firestore, {
        actionType, durableSubmissionPath: true, recordedAtMs: TIMESTAMP,
      });
      if (e.mint_disposition === 'eligible' && BigInt(e.estimated_pvt_atomic) > 0n) eligible.push(actionType);
    }
    expect(eligible.length).toBeGreaterThan(0);
  });
});
