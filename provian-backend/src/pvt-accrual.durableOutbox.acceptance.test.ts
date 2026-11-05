/**
 * ACCEPTANCE — the mainline agent path is a genuine durable replay source.
 *
 * 's finding: `POST /v1/relay/action` and `/v1/relay/work-product` seal
 * `record_only` and mint 0 PERMANENTLY, because `durableEconomicPath` was
 * computed from `throwOnError` alone and neither passes it — even though both
 * co-commit their exact accrual params with the chain-tip advance.
 *
 * The claim under test is an EQUALITY, so it is checked the way 's parity
 * suite is: against the shipped money path, over a counted population, with the
 * unreachable-branch shape designed out rather than hoped away.
 *
 * (1) WEI-PARITY OF THE TWO DURABLE FORMS. The same submission, sealed once
 * through the intake-backed mainline shape and once through an
 * already-durable `throwOnError` inlet, must produce IDENTICAL record
 * points (exact 18-decimal strings), disposition, reason code and PVT.
 * Neither side is re-implemented here; both are the real `recordPEAccrual`.
 * The population deliberately contains eligible acts, every capped action
 * type, and each terminal gate — because a parity suite that can only
 * reach `record_only` proves nothing about a change whose whole point is
 * that `record_only` stops firing.
 *
 * (2) THE ANTI-FAUCET SWEEP. `action_type` on the relay report route is
 * permissionless, so an agent can post ANY identifier — including
 * `wallet_created`, the one type that prices 10 PVT on a durable inlet.
 * Every action type in the live policy is therefore driven through the
 * exact mainline submission shape (no evidence, no device anchor, no
 * counterparty) and must pay ZERO. This is the guard that makes "the
 * outbox makes eligible acts price, it makes nothing eligible that wasn't"
 * checkable instead of asserted.
 *
 * (3) EVERY REFUSAL ARM OF THE VERIFICATION IS REACHED. A durability claim
 * with no row behind it, a row mutated after commit, a row bound to a
 * different chain commit, params that drifted from the stored payload, an
 * unknown source name, and an unreadable intake all seal `record_only`.
 * Fail-closed in every direction.
 *
 * NOTHING HERE IS RETROACTIVE, and there is no test asserting that it is: a PE
 * sealed `record_only` stays sealed. The change moves what NEW submissions seal.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './core/pvt/__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './core/pvt/beneficiary';

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
jest.mock('./core/pvt/beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
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

import { recordPEAccrual, type RecordPEAccrualParams } from './pvt-accrual';
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  ORDINARY_ACCRUAL_REPLAY_SOURCE,
  buildOrdinaryAccrualIntake,
} from './core/pvt/wp11/ordinary-accrual-intake';
import { ACTION_TYPE_MINT_RULES } from './core/pvt/activity-mint-limits';
import { PROPOSED_ACTION_POLICY_ENTRIES } from './core/pvt/policy/proposed-action-policy';
import { computeSubmitTimeEstimate } from './core/pvt/estimate';

const TIMESTAMP = Date.UTC(2026, 7, 4, 12, 0);
const CP = '0x2222222222222222222222222222222222222222';

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  disposition_reason_code: string;
  estimatedPVT: number;
  economic_snapshot: { recordPointsAtomic: string } | null;
}

let seq = 0;

/**
 * Build the params a mainline site fires. ONE builder, exactly as production
 * has it: the intake row and the live call must come from the same object or
 * the accrual's own digest check refuses the claim.
 */
function mainlineParams(
  actionType: string,
  over: Record<string, unknown> = {},
): RecordPEAccrualParams {
  const peId = `pe_outbox_${seq++}`;
  return {
    peId,
    userId: 'agent1',
    actionType,
    integrationSource: 'relay_action',
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    // a real `receive` PE always carries a counterparty (the watcher
    // stamps the observed fromAddress) - the receive-authorship gate only
    // runs when one is present. Without this default, a bare
    // `sealViaMainline('receive')` never exercises the gate, unlike every
    // real receive submission, and diverges from `computeSubmitTimeEstimate`'s
    // conservative default (record-path-estimate.parity.test.ts hit the same
    // gap). No relationship is seeded for this synthetic address, matching
    // the estimator's own conservative default. `over` still wins when a
    // test seeds its own counterparty.
    ...(actionType === 'receive' ? { counterpartyAddress: '0x707070707070707070707070707070707070700f' } : {}),
    ...over,
  } as RecordPEAccrualParams;
}

/** Commit the intake row the tip transaction would have co-committed. */
function commitIntake(params: RecordPEAccrualParams): void {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`,
    peHash: params.peHash,
    accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
}

function row(peId: string): PeRow {
  const stored = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!stored) throw new Error(`no pe_history row for ${peId}`);
  return stored;
}

/** Seal through the MAINLINE shape: intake co-committed, then a best-effort fire. */
async function sealViaMainline(
  actionType: string,
  over: Record<string, unknown> = {},
): Promise<PeRow> {
  const params = mainlineParams(actionType, over);
  commitIntake(params);
  await recordPEAccrual(params);
  return row(params.peId);
}

const X402_PAYER = '0x1111111111111111111111111111111111111111';

function resetStore(): void {
  mockDb.store.clear();
  mockDb.ops.length = 0;
  // The sovereign agent wallet whose address is the x402 payer; the derived
  // effects resolve it to move the reputation count, and refuse to guess.
  mockDb.store.set('agent_wallets/aw1', {
    id: 'aw1',
    agent_id: 'agent1',
    address: X402_PAYER.toLowerCase(),
    platform: 'live',
  });
}

/**
 * Seal the IDENTICAL submission twice — once through the mainline shape, once
 * through an already-durable `throwOnError` inlet — each against a FRESH world.
 *
 * The reset is not hygiene, it is the point. Several of these acts consume a
 * one-shot uniqueness anchor (the 90-day device slot, the x402 per-settlement
 * mint-once claim). Running both sides against one store made the SECOND side
 * a duplicate of the first, so the comparison was measuring anchor exhaustion
 * rather than the two durable forms — and it showed up as a red parity case
 * with a plausible-looking 0. Same params, same peId, same starting state: the
 * only difference left is HOW durability was established.
 */
async function sealBothForms(
  actionType: string,
  over: Record<string, unknown> = {},
): Promise<{ mainline: PeRow; inlet: PeRow }> {
  const params = mainlineParams(actionType, over);

  resetStore();
  commitIntake(params);
  await recordPEAccrual(params);
  const mainline = row(params.peId);

  resetStore();
  const { durableReplaySource: _drop, ...durable } = params;
  await recordPEAccrual({ ...durable, throwOnError: true } as RecordPEAccrualParams);
  const inlet = row(params.peId);

  return { mainline, inlet };
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
  resetStore();
});

/**
 * The parity population. Each case names the SUBMISSION, not an expected
 * answer — both sides get the identical submission and the kernel decides.
 *
 * Bound to `ACTION_TYPE_MINT_RULES` by the coverage test below, so a new capped
 * action type fails this suite until it is covered. That binding exists because
 * 's acceptance suite passed 39/39 while its cap branch was structurally
 * unreachable.
 */
const PARITY_CASES: ReadonlyArray<{
  readonly name: string;
  readonly actionType: string;
  readonly over?: Record<string, unknown>;
}> = Object.freeze([
  // --- acts that reach ELIGIBLE, so parity is tested where money exists ---
  {
    name: 'send with a verified counterparty and canonical event → eligible',
    actionType: 'send',
    over: {
      counterpartyAddress: CP,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0xsend-parity:0',
      tx_hash: 'base:8453:0xsend-parity:0',
    },
  },
  {
    name: 'receive with a verified canonical event → eligible',
    actionType: 'receive',
    over: {
      counterpartyAddress: CP,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0xrecv-parity:0',
      tx_hash: 'base:8453:0xrecv-parity:0',
    },
  },
  {
    name: 'wallet_created with a device anchor → eligible at x10 weight',
    actionType: 'wallet_created',
    over: { deviceAttestationId: 'secure-enclave-parity', ownerType: 'human' },
  },
  // --- the terminal gates, each reached deliberately ---
  {
    name: 'wallet_created with NO device anchor → ineligible_terminal',
    actionType: 'wallet_created',
  },
  {
    name: 'x402 self-report (no chain-verified witness) → terminal',
    actionType: 'x402_payment',
    over: { counterpartyAddress: CP, x402SettlementTxHash: '0xclient_supplied' },
  },
  {
    name: 'send with an unverifiable counterparty → activity-cap terminal',
    actionType: 'send',
    over: { counterpartyAddress: 'not-an-evm-address' },
  },
  // --- the remaining capped types (the unreachable-branch lesson) ---
  {
    name: 'swap with a verified canonical event',
    actionType: 'swap',
    over: {
      counterpartyAddress: CP,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0xswap-parity:0',
      tx_hash: 'base:8453:0xswap-parity:0',
    },
  },
  {
    name: 'stake with a verified canonical event',
    actionType: 'stake',
    over: {
      counterpartyAddress: CP,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0xstake-parity:0',
      tx_hash: 'base:8453:0xstake-parity:0',
    },
  },
  {
    name: 'x402 with a CHAIN-VERIFIED witness → eligible',
    actionType: 'x402_payment',
    over: {
      counterpartyAddress: CP,
      x402PayerAddress: X402_PAYER,
      x402SettlementTxHash: `0x${'a'.repeat(64)}`,
      x402ChainVerified: true,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: `base:8453:0x${'a'.repeat(64)}:0`,
      tx_hash: `base:8453:0x${'a'.repeat(64)}:0`,
    },
  },
  // --- the policy fences, which the outbox must NOT move ---
  {
    name: 'agent_action (session-lineage required, none supplied) → record_only',
    actionType: 'agent_action',
  },
  {
    name: 'badge_earned (policy record-only) → record_only',
    actionType: 'badge_earned',
  },
  {
    name: 'a permissionless namespaced identifier → record_only, unknown type',
    actionType: 'myapp:unknown_thing',
  },
  {
    name: 'agent_native_transfer without evidence → pending_evidence',
    actionType: 'agent_native_transfer',
  },
]);

describe('(0) the population is real and cannot go structurally blind', () => {
  it('is non-empty and pinned', () => {
    expect(PARITY_CASES.length).toBe(13);
    expect(PARITY_CASES.length).toBeGreaterThan(0);
  });

  it('covers EVERY action type carrying a standing anti-farm rule', () => {
    const covered = new Set(PARITY_CASES.map((c) => c.actionType));
    for (const capped of Object.keys(ACTION_TYPE_MINT_RULES)) {
      expect([...covered]).toContain(capped);
    }
    expect(Object.keys(ACTION_TYPE_MINT_RULES).length).toBeGreaterThan(0);
  });

  it('actually reaches eligible, terminal AND record_only — not one class three ways', async () => {
    // Without this, a regression that made everything `record_only` again would
    // leave leg (1) below perfectly green: two identical wrong answers are
    // still equal. THIS is what makes the parity claim load-bearing.
    const dispositions = new Set<string>();
    for (const c of PARITY_CASES) {
      dispositions.add((await sealViaMainline(c.actionType, c.over)).mint_disposition);
    }
    expect(dispositions).toContain('eligible');
    expect(dispositions).toContain('ineligible_terminal');
    expect(dispositions).toContain('record_only');
    expect(dispositions).toContain('pending_evidence');
  });
});

describe('(1) the intake-backed mainline path prices IDENTICALLY to a durable inlet', () => {
  it.each(PARITY_CASES.map((c) => [c.name, c] as const))(
    '%s',
    async (_name, testCase) => {
      const { mainline, inlet } = await sealBothForms(testCase.actionType, testCase.over);

      // Exact 18-decimal strings: no float, no rounding, no tolerance.
      expect(mainline.economic_snapshot?.recordPointsAtomic)
        .toBe(inlet.economic_snapshot?.recordPointsAtomic);
      expect(mainline.mint_disposition).toBe(inlet.mint_disposition);
      expect(mainline.disposition_reason_code).toBe(inlet.disposition_reason_code);
      expect(mainline.mint_status).toBe(inlet.mint_status);
      expect(mainline.estimatedPVT).toBe(inlet.estimatedPVT);
    },
  );

  it('an ordinary ELIGIBLE act seals eligible through the mainline path', async () => {
    // The acceptance bar in one assertion: the same act that pays through a
    // durable inlet now pays through the mainline shape, to the wei.
    const mainline = await sealViaMainline('send', {
      counterpartyAddress: CP,
      economicEvidenceState: 'verified',
      economicCanonicalEventId: 'base:8453:0xacceptance:0',
      tx_hash: 'base:8453:0xacceptance:0',
    });
    expect(mainline.mint_disposition).toBe('eligible');
    expect(mainline.mint_status).toBe('eligible');
    expect(mainline.estimatedPVT).toBeGreaterThan(0);
    expect(BigInt(mainline.economic_snapshot!.recordPointsAtomic)).toBeGreaterThan(0n);
  });
});

describe('(2) ANTI-FAUCET: no self-report through the mainline shape can pay', () => {
  // The submission shape `sealActionPE` actually produces: no evidence, no
  // device anchor, no counterparty, no chain-verified witness, no session
  // lineage. `action_type` is permissionless on that route, so the sweep runs
  // the WHOLE live policy rather than a chosen sample.
  const ALL_TYPES = PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type);

  it('the swept population is the live policy, and it is not empty', () => {
    expect(ALL_TYPES.length).toBeGreaterThan(200);
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
  });

  it('every action type in the live policy pays 0 as a bare self-report', async () => {
    const paying: Array<{ actionType: string; pvt: number; disposition: string }> = [];
    for (const actionType of ALL_TYPES) {
      // Genesis types are issued by the reservation state machine and the
      // kernel throws without a receipt; they cannot be self-reported and are
      // covered by the Genesis suites.
      if (actionType.startsWith('genesis_')) continue;
      const sealed = await sealViaMainline(actionType);
      if (sealed.estimatedPVT !== 0) {
        paying.push({
          actionType,
          pvt: sealed.estimatedPVT,
          disposition: sealed.mint_disposition,
        });
      }
    }
    expect(paying).toEqual([]);
  });

  it('and the sweep is NOT vacuous: the same shape plus a device anchor DOES pay', async () => {
    // The positive control for the sweep above. If `sealViaMainline` were
    // silently sealing everything record_only (the defect this change removes),
    // the sweep would pass for the wrong reason and this fails.
    const anchored = await sealViaMainline('wallet_created', {
      deviceAttestationId: 'secure-enclave-positive-control',
      ownerType: 'human',
    });
    expect(anchored.mint_disposition).toBe('eligible');
    expect(anchored.estimatedPVT).toBeGreaterThan(0);
  });
});

/**
 * THE BRIDGE THE REVIEWER FOUND MISSING, and the defect it now catches.
 *
 * shipped two halves that never met. This suite SEALS the mainline shape
 * and never quotes; `estimate.test.ts` QUOTES and never seals; the wiring suite
 * only greps for the literal `durableSubmissionPath: true`. So the response an
 * agent developer reads and the disposition their PE actually got were pinned by
 * nothing at all — and were in fact WRONG: `computeSubmitTimeEstimate` inherited
 * the generic estimator's assume-a-device-anchor posture, which is structurally
 * false on both of its callers, and answered `wallet_created` with
 * `{estimated_pvt: 10, mint_disposition: 'eligible'}` against a seal of
 * `ineligible_terminal`/0. Both halves were green throughout.
 *
 * The bridge runs the WHOLE live policy so a new action type cannot slip through,
 * and it compares the two fields that decide whether a reader believes they were
 * paid: the disposition, and the figure.
 */
describe('(2b) ONE PRICING TRUTH: the submit response equals what the submission seals', () => {
  const SWEPT = PROPOSED_ACTION_POLICY_ENTRIES
    .map((e) => e.action_type)
    .filter((t) => !t.startsWith('genesis_'));

  it('population is the live policy and is not empty', () => {
    expect(SWEPT.length).toBeGreaterThan(200);
  });

  it('quoted disposition == sealed disposition, and quoted PVT == sealed PVT, for EVERY type', async () => {
    const mismatches: Array<Record<string, unknown>> = [];
    for (const actionType of SWEPT) {
      const quoted = computeSubmitTimeEstimate(actionType, { durableSubmissionPath: true });
      const sealed = await sealViaMainline(actionType);
      if (quoted.mint_disposition !== sealed.mint_disposition
        || quoted.estimated_pvt !== sealed.estimatedPVT) {
        mismatches.push({
          actionType,
          quoted: [quoted.mint_disposition, quoted.estimated_pvt],
          sealed: [sealed.mint_disposition, sealed.estimatedPVT],
        });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('the comparison is REACHABLE: the swept population spans more than one disposition', async () => {
    // Guards the empty-population / one-class-three-ways shape. If every
    // type quoted and sealed the same single disposition, the assertion above
    // would hold for a reason that says nothing about the coupling.
    const seen = new Set<string>();
    for (const actionType of SWEPT) {
      seen.add(computeSubmitTimeEstimate(actionType, { durableSubmissionPath: true }).mint_disposition);
    }
    expect(seen.has('record_only')).toBe(true);
    expect(seen.has('pending_evidence')).toBe(true);
    expect(seen.has('ineligible_terminal')).toBe(true);
  });

  it('and the quoted figure on these two routes is ALWAYS 0 — stated, not assumed', async () => {
    // The consequence of the device-anchor fact, recorded as an invariant rather
    // than left implicit: no self-report through `/v1/relay/action` or
    // `/v1/relay/work-product` can carry a device anchor, verified evidence, or
    // a canonical event, so none of them can reach `eligible`. If a future
    // change makes one of these routes able to quote a positive number, that is
    // a decision and this test is where it surfaces.
    const positive = SWEPT
      .map((t) => [t, computeSubmitTimeEstimate(t, { durableSubmissionPath: true })] as const)
      .filter(([, q]) => q.estimated_pvt !== 0);
    expect(positive).toEqual([]);
  });
});

describe('(3) every refusal arm of the durable-source verification seals record_only', () => {
  const expectRefused = (sealed: PeRow): void => {
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.disposition_reason_code).toBe('policy_record_only');
    expect(sealed.estimatedPVT).toBe(0);
  };

  const eligibleSubmission = {
    counterpartyAddress: CP,
    economicEvidenceState: 'verified',
    economicCanonicalEventId: 'base:8453:0xrefusal:0',
    tx_hash: 'base:8453:0xrefusal:0',
  };

  it('control: with an intact intake row the SAME submission is eligible', async () => {
    // Without this the six refusals below could all be passing because the
    // submission was unpayable to begin with.
    expect((await sealViaMainline('send', eligibleSubmission)).mint_disposition).toBe('eligible');
  });

  it('intake_missing — a claim with no committed row behind it', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    await recordPEAccrual(params); // no commitIntake
    expectRefused(row(params.peId));
  });

  it('intake_integrity_failed — the row was mutated after commit', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    commitIntake(params);
    const key = `${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`;
    const stored = mockDb.store.get(key) as Record<string, unknown>;
    mockDb.store.set(key, {
      ...stored,
      accrual_params: { ...(stored.accrual_params as object), actionType: 'send' },
      accrual_params_sha256: 'a'.repeat(64),
    });
    await recordPEAccrual(params);
    expectRefused(row(params.peId));
  });

  it('intake_commit_mismatch — the row vouches for a different chain commit', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    commitIntake(params);
    const key = `${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`;
    const stored = mockDb.store.get(key) as Record<string, unknown>;
    // Rebuild a consistent row for a DIFFERENT commit, so integrity passes and
    // only the commit binding fails — otherwise this would retest the arm above.
    const rebuilt = buildOrdinaryAccrualIntake({
      prevHash: `prev_${params.peId}`,
      peHash: `h_other_${params.peId}`,
      accrualParams: { ...params, peHash: `h_other_${params.peId}` },
    });
    mockDb.store.set(key, { ...rebuilt, pe_id: stored.pe_id as string });
    await recordPEAccrual(params);
    expectRefused(row(params.peId));
  });

  it('params_drifted — the live params are not what was committed', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    commitIntake(params);
    // The stored row is intact and bound to this commit; the LIVE call carries
    // an extra economic input that was never persisted, so a replay would price
    // differently. Refused.
    await recordPEAccrual({ ...params, ownerType: 'human' } as RecordPEAccrualParams);
    expectRefused(row(params.peId));
  });

  it('unknown_source — a marker naming something this row cannot vouch for', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    commitIntake(params);
    await recordPEAccrual({
      ...params,
      durableReplaySource: 'some_other_outbox',
    } as unknown as RecordPEAccrualParams);
    expectRefused(row(params.peId));
  });

  it('read_failed — an unreadable intake is an unproven claim', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    commitIntake(params);
    const realCollection = mockDb.collection.bind(mockDb);
    const spy = jest.spyOn(mockDb, 'collection').mockImplementation(((name: string) => {
      if (name === ORDINARY_ACCRUAL_INTAKE_COLLECTION) {
        return {
          doc: () => ({ get: async () => { throw new Error('firestore unavailable'); } }),
        } as never;
      }
      return realCollection(name);
    }) as never);
    try {
      await recordPEAccrual(params);
    } finally {
      spy.mockRestore();
    }
    expectRefused(row(params.peId));
  });

  it('an intake-backed caller cannot smuggle in a precomputed economic snapshot', async () => {
    // The intake proves REPLAYABILITY, not authority to price. A precomputed
    // snapshot is honoured only for an acknowledged `throwOnError` caller (in
    // practice the Genesis reservation state machine). Here a fixed-grant
    // snapshot rides along in the very params the intake row commits — so the
    // digest check passes and this is the ONLY thing standing between a
    // mainline submission and an arbitrary economic verdict.
    const donor = mainlineParams('send', eligibleSubmission);
    commitIntake(donor);
    await recordPEAccrual(donor);
    const donorSnapshot = (mockDb.store.get(`pe_history/${donor.peId}`) as
      { economic_snapshot: unknown }).economic_snapshot;
    expect((donorSnapshot as { mintDisposition: string }).mintDisposition).toBe('eligible');

    const smuggler = mainlineParams('badge_earned', {
      economicSnapshot: donorSnapshot,
    });
    commitIntake(smuggler);
    await recordPEAccrual(smuggler);

    const sealed = row(smuggler.peId);
    expect(sealed.mint_disposition).toBe('record_only');
    expect(sealed.estimatedPVT).toBe(0);
    expect(sealed.economic_snapshot?.recordPointsAtomic).toBe('0');
  });

  it('not_claimed — an ordinary caller with no marker is unchanged', async () => {
    const params = mainlineParams('send', eligibleSubmission);
    const { durableReplaySource: _drop, ...unmarked } = params;
    commitIntake(params);
    await recordPEAccrual(unmarked);
    expectRefused(row(params.peId));
  });
});

/**
 * SESSION LINEAGE: the SECOND fence, and the acceptance bar for lifting it.
 *
 * established that the durable outbox is NECESSARY and NOT SUFFICIENT for
 * the agent's own action types: 80 of 254 policy rows carry
 * `session_lineage_policy: 'required'`, and nothing in the tree produced an
 * `economicSessionLineageId`, so every `agent_*` work type sealed terminal
 * `record_only` on BOTH durability forms. This block is the proof that supplying
 * a VERIFIED lineage moves them off that fence — and only that fence.
 *
 * The lineage id here is what the relay would have produced: a value that
 * survived `verifyEconomicSessionLineage` against an authenticated device. The
 * verifier's own refusals (forged, wrong-device, account-derived, relay-absent)
 * are RED-controlled in `core/pvt/economic-session-lineage.test.ts`; what is
 * proven HERE is what a verified lineage does to the SEAL.
 */
describe('(4) a verified session lineage lifts the lineage fence, and nothing else', () => {
  // The genuinely lineage-fenced population, DERIVED from the policy table rather
  // than hardcoded : every row that is `session_lineage_policy: 'required'`
  // and not already terminal, so the fence actually bites. (3b) deliberately
  // moved the agent-work / compute_or_work family OFF this fence — those types are
  // now `session_lineage_policy: 'optional'` and mint via the sovereign-pe
  // per-occurrence agent-key binding instead (proven in the sovereign-work suite),
  // so they are no longer in this population. The 37 remaining fenced types are the
  // institution/financial lifecycle rows (transfer, spending, jobs, promises,
  // proxied payments, …). If that set ever empties, the reachability guard below
  // fails rather than passing vacuously.
  const FENCED = PROPOSED_ACTION_POLICY_ENTRIES
    .filter((e) => e.session_lineage_policy === 'required'
      && e.mint_disposition !== 'record_only'
      && e.mint_disposition !== 'ineligible_terminal')
    .map((e) => e.action_type);
  const LINEAGE = 'pesl1_' + 'ab'.repeat(20);
  // a completion-family row
  // (`verified_substantive_outcome`) with NO resolvable counterparty now holds
  // `pending_review` — the same-owner fence cannot run, so it is not passed.
  // This block proves the LINEAGE fence alone, so those rows carry a real
  // counterparty (unknown to every registry → distinct owner) and land on the
  // evidence gate exactly as before. Derived from the policy table.
  const COMPLETION_FAMILY = new Set(PROPOSED_ACTION_POLICY_ENTRIES
    .filter((e) => e.evidence_requirement === 'verified_substantive_outcome')
    .map((e) => e.action_type));
  const DISTINCT_COUNTERPARTY = '0x7070707070707070707070707070707070707071';

  it('the population is non-empty and EVERY member is genuinely fenced today', async () => {
    // The reachability guard. If any of these were NOT lineage-fenced,
    // the "moves off the fence" assertion below would pass for the wrong reason.
    for (const actionType of FENCED) {
      const sealed = await sealViaMainline(actionType);
      expect(sealed.mint_disposition).toBe('record_only');
      expect(sealed.disposition_reason_code).toBe('missing_session_lineage_record_only');
    }
    expect(FENCED.length).toBeGreaterThan(0);
  });

  it.each(FENCED)('%s MOVES OFF the lineage fence when the act carries a verified lineage', async (actionType) => {
    const fenced = await sealViaMainline(actionType);
    expect(fenced.mint_disposition).toBe('record_only');

    const withLineage = await sealViaMainline(actionType, {
      economicSessionLineageId: LINEAGE,
      ...(COMPLETION_FAMILY.has(actionType) ? { counterpartyAddress: DISTINCT_COUNTERPARTY } : {}),
    });
    // Off `record_only` (terminal, no exits) and onto a disposition that HAS
    // exits. It does NOT become eligible: evidence and canonical-event gates
    // are untouched, which is the whole point of "only that fence".
    expect(withLineage.mint_disposition).toBe('pending_evidence');
    expect(withLineage.disposition_reason_code).toBe('awaiting_evidence');
    expect(withLineage.estimatedPVT).toBe(0);
  });

  it('RED: the SAME act without lineage stays fenced', async () => {
    // The negative control, in-suite and permanent rather than run once by hand.
    for (const actionType of FENCED) {
      const sealed = await sealViaMainline(actionType, {});
      expect(sealed.mint_disposition).toBe('record_only');
      expect(sealed.disposition_reason_code).toBe('missing_session_lineage_record_only');
    }
  });

  it('prices WEI-IDENTICALLY through both durability forms', async () => {
    // The parity property, carried across the new input: a replay of a
    // lineage-bearing act must price exactly as the live call did, because the
    // lineage rides inside the same stored payload the digest check binds.
    for (const actionType of FENCED) {
      const { mainline, inlet } = await sealBothForms(actionType, {
        economicSessionLineageId: LINEAGE,
      });
      expect(mainline.mint_disposition).toBe(inlet.mint_disposition);
      expect(mainline.disposition_reason_code).toBe(inlet.disposition_reason_code);
      expect(mainline.economic_snapshot?.recordPointsAtomic)
        .toBe(inlet.economic_snapshot?.recordPointsAtomic);
      // Exact 18-decimal strings, not display floats.
      expect(typeof mainline.economic_snapshot?.recordPointsAtomic).toBe('string');
    }
  });

  it('lifts ONLY the lineage fence: a device-gated type is still terminal with lineage', async () => {
    // Proof the change is narrow. `wallet_created` fails Security Invariant #9's
    // device gate on this route; lineage must not rescue it.
    const sealed = await sealViaMainline('wallet_created', {
      economicSessionLineageId: LINEAGE,
    });
    expect(sealed.mint_disposition).toBe('ineligible_terminal');
    expect(sealed.estimatedPVT).toBe(0);
  });

  it('and a record_only-BY-POLICY type is unmoved by lineage', async () => {
    // 160 rows are `record_only` by policy with `session_lineage_policy:
    // 'not_applicable'`. Lineage is not a skeleton key.
    const withLineage = await sealViaMainline('badge_earned', {
      economicSessionLineageId: LINEAGE,
    });
    expect(withLineage.mint_disposition).toBe('record_only');
    expect(withLineage.estimatedPVT).toBe(0);
  });

  it('ANTI-FAUCET still holds with lineage supplied on every type', async () => {
    // The sweep, re-run with the new input present. Lifting a fence must
    // not open a faucet: no type may pay through the bare mainline shape.
    const paying: string[] = [];
    for (const actionType of PROPOSED_ACTION_POLICY_ENTRIES.map((e) => e.action_type)) {
      if (actionType.startsWith('genesis_')) continue;
      const sealed = await sealViaMainline(actionType, { economicSessionLineageId: LINEAGE });
      if (sealed.estimatedPVT !== 0) paying.push(actionType);
    }
    expect(paying).toEqual([]);
  });
});
