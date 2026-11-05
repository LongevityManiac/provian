/**
 * Build B (unit 2) — the cross-witness commit TAKEOVER, end to end.
 *
 * Driven through the REAL recordPEAccrual against a fake Firestore (the
 * durableOutbox harness), so the whole chain runs: commit-claim prep → base-weight
 * pre-check → snapshot → the specialized takeover transaction in writePEHistory.
 *
 * The the operator-required RED controls, each asserting the mint outcome AND the loser's
 * demotion (never two eligible rows for one commit):
 * - daemon-first → forge: ONE mint, forge wins (2.4×), daemon demoted;
 * - forge-first → daemon: ONE mint, forge wins, daemon is duplicate;
 * - solo daemon: 0.8× (compute base × software);
 * - solo forge: 2.4× (forge base × software);
 * - already-settled fallback: an incumbent registered for settlement is NOT
 * taken over — the new witness is a duplicate (no double-mint);
 * - RED negative control: an EQUAL-base second witness does NOT take over, so
 * the takeover is proven to fire on STRICTLY-higher base, not on every
 * duplicate (the pre-fix behaviour, kept red-visible).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import type { BeneficiaryCacheEntry } from './beneficiary';
import { commitWitnessedVerifiedFields } from './device-witnessed-earning';
import { commitClaimDocId } from './commit-mint-claim';
import { ORDINARY_ACCRUAL_REPLAY_SOURCE } from './wp11/ordinary-accrual-intake';

let mockDb: FakeFirestore;
jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createFakeFirestore: mk } = require('./__test-helpers__/fake-firestore');
  const db = mk();
  mockDb = db;
  const firestore = Object.assign(() => db, {
    FieldValue: { increment: (n: number) => ({ __increment: n }) },
  });
  return { __esModule: true, default: { firestore }, firestore };
});
jest.mock('../../cache', () => ({
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
const mockResolveBeneficiary = jest.fn<(...a: unknown[]) => Promise<BeneficiaryCacheEntry>>(async () => ({
  linked: false, humanWalletId: null, humanUserId: null, humanAddress: null, agentShareBps: null,
}));
jest.mock('./beneficiary', () => ({ resolveBeneficiary: mockResolveBeneficiary }));
jest.mock('../jurisdiction/jurisdiction-policy', () => ({ getJurisdictionPolicy: async () => 'immediate' }));
jest.mock('./delegation-pe', () => ({ isDelegationQualifying: () => false, createDelegationPE: async () => {} }));
jest.mock('../provenance/pe-type-catalog', () => ({
  getCategoryForActionType: async () => 'compute',
  recordActionTypeObservation: async () => {},
}));
jest.mock('../foundation-membership/client', () => ({
  loadFoundationMembershipConfig: () => ({ enabled: false }),
  queueInitialMembershipGrants: async () => {},
}));

// eslint-disable-next-line import/first
import { recordPEAccrual, type RecordPEAccrualParams } from '../../pvt-accrual';
// eslint-disable-next-line import/first
import {
  ORDINARY_ACCRUAL_INTAKE_COLLECTION,
  buildOrdinaryAccrualIntake,
} from './wp11/ordinary-accrual-intake';
// eslint-disable-next-line import/first
import {
  CLAIM_LEDGER_COLLECTION,
  claimKeyOf,
  registerClaim,
  type NewClaimInput,
  type SettlementDb,
} from './wp4/durable-settlement-store';
// eslint-disable-next-line import/first
import { corroborationLiftedRecordPointsAtomic } from './policy/economic-projection';
// eslint-disable-next-line import/first
import type { PEHistoryDocument } from '../../pe-history';

const TIMESTAMP = Date.UTC(2026, 7, 15, 12, 0);
const USER = 'contributor-1';
const COMMIT = 'deadbeef'.repeat(5); // valid 40-hex git sha
let seq = 0;

interface PeRow {
  mint_status: string;
  mint_disposition: string;
  estimatedPVT: number;
  economic_snapshot: { recordPointsAtomic: string } | null;
}

/** A body-bound daemon coding_session (compute base 1.0×). */
function daemonParams(peId: string, commit = COMMIT): RecordPEAccrualParams {
  const overlay = commitWitnessedVerifiedFields({
    actionType: 'coding_session', bodyBound: true, commitSha: commit,
  });
  return {
    peId,
    userId: USER,
    actionType: 'coding_session',
    integrationSource: 'device_pe_submit',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    isDevicePE: true,
    commitSha: commit,
    ...overlay,
  } as RecordPEAccrualParams;
}

/** A forge webhook service:github_commit (external-service base 3.0×). */
function forgeParams(
  peId: string, commit = COMMIT, over: Record<string, unknown> = {},
): RecordPEAccrualParams {
  return {
    peId,
    userId: USER,
    actionType: 'service:github_commit',
    integrationSource: 'agent_bank_generate_pe',
    attestationDepth: 'software',
    peHash: `h_${peId}`,
    timestamp: TIMESTAMP,
    commitSha: commit,
    durableReplaySource: ORDINARY_ACCRUAL_REPLAY_SOURCE,
    economicEvidenceState: 'verified',
    ...over,
  } as RecordPEAccrualParams;
}

function commitIntake(params: RecordPEAccrualParams): void {
  const doc = buildOrdinaryAccrualIntake({
    prevHash: `prev_${params.peId}`, peHash: params.peHash, accrualParams: params,
  });
  mockDb.store.set(`${ORDINARY_ACCRUAL_INTAKE_COLLECTION}/${params.peId}`, { ...doc });
}
function row(peId: string): PeRow {
  const r = mockDb.store.get(`pe_history/${peId}`) as PeRow | undefined;
  if (!r) throw new Error(`no pe_history row for ${peId}`);
  return r;
}
function claimOwner(commit = COMMIT): string | undefined {
  const claim = mockDb.store.get(`commit_mint_claims/${commitClaimDocId(USER, commit)}`);
  return claim ? (claim.owner_pe_id as string) : undefined;
}
async function seal(params: RecordPEAccrualParams): Promise<PeRow> {
  commitIntake(params);
  await recordPEAccrual(params);
  return row(params.peId);
}
function points(r: PeRow): bigint {
  return BigInt(r.economic_snapshot?.recordPointsAtomic ?? '0');
}
/** The raw pe_history doc, for the corroboration-lift read. */
function fullRow(peId: string): PEHistoryDocument {
  return mockDb.store.get(`pe_history/${peId}`) as unknown as PEHistoryDocument;
}
/** The settleable value the LIVE inlet would register (corroboration-lifted). */
function settleable(peId: string): bigint {
  return BigInt(corroborationLiftedRecordPointsAtomic(fullRow(peId)));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.store.clear();
  mockDb.ops.length = 0;
  seq = 0;
});

describe(' commit takeover — one commit, one mint, forge wins, arrival-independent across RECORD-time orders (scopes the guarantee to the 72h window; the post-window settlement-interleaved case is pinned in commit-takeover-settlement-order.test.ts)', () => {
  it('DAEMON-FIRST → FORGE: forge takes over, daemon demoted (one eligible)', async () => {
    const daemon = await seal(daemonParams('pe-daemon'));
    expect(daemon.mint_status).toBe('eligible'); // owned the slot while alone
    expect(claimOwner()).toBe('pe-daemon');

    const forge = await seal(forgeParams('pe-forge'));
    // Forge wins.
    expect(forge.mint_status).toBe('eligible');
    expect(points(forge)).toBeGreaterThan(0n);
    expect(claimOwner()).toBe('pe-forge');
    // Daemon demoted — mutable mint_status only; its sealed snapshot survives.
    const daemonAfter = row('pe-daemon');
    expect(daemonAfter.mint_status).toBe('corroborated_duplicate');
    expect(daemonAfter.economic_snapshot).not.toBeNull();
    // Forge (base 3.0×) prices strictly above the daemon (base 1.0×).
    expect(points(forge)).toBeGreaterThan(points(daemonAfter));
    // Exactly ONE eligible for this commit.
    expect([daemonAfter.mint_status, forge.mint_status].filter((s) => s === 'eligible'))
      .toHaveLength(1);

    // NEED 2 — the lift lands on the forge WINNER: the takeover sealed the
    // demoted daemon's corroboration onto the forge, so the LIVE settleable value
    // is the corroborated 3.0× (record 2.4× × software→corroborated 10000/8000).
    expect(fullRow('pe-forge').corroboration_status).toBe('service_grant_attested');
    const forgeRaw = points(forge);
    expect(settleable('pe-forge')).toBe((forgeRaw * 10_000n) / 8_000n);
    expect(settleable('pe-forge')).toBeGreaterThan(forgeRaw); // strictly lifted
  });

  it('FORGE-FIRST → DAEMON: forge stays owner, daemon is the duplicate (one eligible)', async () => {
    const forge = await seal(forgeParams('pe-forge'));
    expect(forge.mint_status).toBe('eligible');
    expect(claimOwner()).toBe('pe-forge');

    const daemon = await seal(daemonParams('pe-daemon'));
    // Daemon (lower base) never displaces the forge.
    expect(daemon.mint_status).toBe('corroborated_duplicate');
    expect(claimOwner()).toBe('pe-forge');
    expect(row('pe-forge').mint_status).toBe('eligible');
    expect([daemon.mint_status, row('pe-forge').mint_status].filter((s) => s === 'eligible'))
      .toHaveLength(1);

    // NEED 2 — same lift, other order: the arriving daemon corroborated the
    // incumbent forge WINNER, so it settles the corroborated 3.0× here TOO. This
    // is the arrival-order invariant: same commit, same two witnesses, same value.
    expect(fullRow('pe-forge').corroboration_status).toBe('service_grant_attested');
    const forgeRaw = points(row('pe-forge') as PeRow);
    expect(settleable('pe-forge')).toBe((forgeRaw * 10_000n) / 8_000n);
    expect(settleable('pe-forge')).toBeGreaterThan(forgeRaw);
  });

  it('SOLO daemon → eligible at compute base × software 0.8×', async () => {
    const daemon = await seal(daemonParams('pe-daemon'));
    expect(daemon.mint_status).toBe('eligible');
    expect(points(daemon)).toBeGreaterThan(0n);
  });

  it('SOLO forge → eligible at forge base × software (strictly above a solo daemon)', async () => {
    const forge = await seal(forgeParams('pe-forge'));
    expect(forge.mint_status).toBe('eligible');
    const daemon = await seal(daemonParams('pe-daemon-other', 'cafebabe'.repeat(5)));
    // Different commit → independent claim; the forge's base prices strictly above.
    expect(points(forge)).toBeGreaterThan(points(daemon));

    // NEED 2 RED CONTROL: a SOLO forge (one witness, no cross-witness) is NOT
    // corroborated and NOT lifted — it settles its verbatim record 2.4×. This is
    // what proves the lift above is the SECOND witness earning it, not the base.
    expect(fullRow('pe-forge').corroboration_status).toBe('none');
    expect(settleable('pe-forge')).toBe(points(forge));
  });

  it('ALREADY-SETTLED FALLBACK: an incumbent registered for settlement is NOT taken over', async () => {
    const daemon = await seal(daemonParams('pe-daemon'));
    expect(daemon.mint_status).toBe('eligible');
    // The daemon's claim has entered the settlement ledger (it is committed to mint).
    const ledgerRow: NewClaimInput = {
      leg: 'sole',
      pe_id: 'pe-daemon',
      claim_id: `0x${'1'.padStart(64, '0')}`,
      lane: 'standard',
      contributor: `0x${'a'.repeat(40)}`,
      beneficiary_class: 1,
      record_points_atomic: '1000000000000000000',
    };
    await registerClaim(mockDb as unknown as SettlementDb, ledgerRow, TIMESTAMP);
    expect(
      (await mockDb.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf('pe-daemon', 'sole')).get()).exists,
    ).toBe(true);

    const forge = await seal(forgeParams('pe-forge'));
    // No takeover: the forge is the duplicate; the daemon keeps the settleable slot.
    expect(forge.mint_status).toBe('corroborated_duplicate');
    expect(claimOwner()).toBe('pe-daemon');
    expect(row('pe-daemon').mint_status).toBe('eligible');
  });

  it('RED NEGATIVE CONTROL: an EQUAL-base second witness does NOT take over', async () => {
    // Two daemons (both compute base 1.0×) for one commit. The second is a plain
    // duplicate — the takeover fires on STRICTLY-higher base, not on every
    // duplicate. Without that strict test, this second row would wrongly win.
    const first = await seal(daemonParams('pe-daemon-1'));
    expect(first.mint_status).toBe('eligible');
    const second = await seal(daemonParams('pe-daemon-2'));
    expect(second.mint_status).toBe('corroborated_duplicate');
    expect(claimOwner()).toBe('pe-daemon-1');
    expect(row('pe-daemon-1').mint_status).toBe('eligible');
  });

  it('RED NEGATIVE CONTROL: a higher-base taker that seals TERMINAL does NOT demote the eligible incumbent', async () => {
    // Invariant 5: a would-be taker that WINS the base-weight + eligibility
    // pre-check (forge 30000 > daemon 10000, daemon eligible + unregistered →
    // evaluateCommitWitness = 'takeover') but then seals a TERMINAL disposition
    // must NOT demote the good incumbent. This pins the `newPeSealedMintable`
    // guard: the mutation that drops it (push the takeover plan unconditionally)
    // would demote the eligible daemon and re-own the (user, commit_sha) slot to a
    // PE that mints 0 — a valid mint destroyed, the slot stranded on a zero.
    const daemon = await seal(daemonParams('pe-daemon'));
    expect(daemon.mint_status).toBe('eligible');
    expect(daemon.estimatedPVT).toBeGreaterThan(0);
    expect(claimOwner()).toBe('pe-daemon');

    // A forge that self-references → record_only (terminal), yet out-weighs the daemon.
    const forge = await seal(forgeParams('pe-forge', COMMIT, { economicSelfReferencing: true }));
    expect(forge.mint_status).toBe('record_only'); // sealed terminal, mints 0
    expect(forge.estimatedPVT).toBe(0);
    // The guard held: NO takeover. The daemon keeps the slot and its eligibility;
    // the terminal forge reserved nothing and re-owned nothing.
    expect(claimOwner()).toBe('pe-daemon');
    expect(row('pe-daemon').mint_status).toBe('eligible');
    expect(row('pe-daemon').estimatedPVT).toBeGreaterThan(0);
  });
});
