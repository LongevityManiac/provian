/**
 * settlement runtime — the claim inlet.
 *
 * The property under test is the one the whole settlement pipeline was missing: a qualifying
 * act becomes a durable claim, and a non-qualifying one does not.
 *
 * EVERY admission assertion here ships with its RED negative control — the run contract's
 * rule, because a guard observed only green is not evidence. The three named vacuity shapes
 * are covered explicitly: `examined` is asserted non-zero wherever a universal claim is made
 * (the empty population), fixtures bind to the module's own `evaluateEligibility` rather than
 * redeclaring its rules (the self-referential control), and the drift/ineligibility branches
 * are constructed from real rejecting inputs rather than asserted unreachable.
 */

import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { PVT9_ELIGIBILITY_CUT_LINE_MS, type EligibilityCandidate } from '../wp-ev/eligibility';
import { deriveClaimId, deriveLegClaimId } from '../wp-ev/claim-id';
import { BeneficiaryClass } from '../wp-ev/settlement-batch';
import { CLAIM_LEDGER_COLLECTION, PE_HISTORY_COLLECTION, claimKeyOf, registerClaim, type SettlementDb } from './durable-settlement-store';
import { RELAY_STATUS_READY } from './claim-inlet-source';
import {
  MAX_REPORTED_SKIPS,
  loadInletCursor,
  runClaimInlet,
  saveInletCursor,
  type InletCandidate,
  type InletPeSource,
  type StandardInletCandidate,
} from './claim-inlet';
import type { ProposedPeSplit } from './pe-split';

const H = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;
const ADDR = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;
const NOW = 1_800_000_000_000;
const POST_CUT_LINE = PVT9_ELIGIBILITY_CUT_LINE_MS + 1_000;

/**
 * A PE that genuinely passes `evaluateEligibility`. Built once here and mutated by the
 * negative controls, so a fixture can never drift into "eligible by construction" — the
 * module under test is the only thing that decides.
 */
function eligiblePe(n: number): EligibilityCandidate {
  return {
    pe: {
      id: `pe-${n}`,
      prev_hash: H(0xbeef),
      hash: H(0xf00d + n),
      timestamp: POST_CUT_LINE + n,
      action_type: 'agent_task_completed',
      user_id: `user-${n}`,
    },
    attestationTier: 'software',
    chainVerified: true,
    submissionProvenance: 'earner_signed',
    workEvidence: { workProductHash: H(0xabc + n) },
    relayMintStatus: 'eligible',
  };
}

function candidate(n: number, overrides?: Partial<StandardInletCandidate>): InletCandidate {
  return {
    peId: `pe-${n}`,
    leg: 'sole',
    lane: 'standard',
    eligibility: eligiblePe(n),
    contributor: ADDR(0xa000 + n),
    recordPointsAtomic: '1000000000000000000',
    beneficiaryClass: BeneficiaryClass.HumanResolving,
    ...overrides,
  };
}

/**
 * attach ONE split describing exactly these legs (bps from each leg's share of the
 * total) to every leg, the way the production source does. `frozen` marks a split read back
 * from a `pvt9_pe_split_v1` doc.
 */
function withSplit(
  legs: readonly StandardInletCandidate[],
  bps: readonly number[],
  frozen = false,
): StandardInletCandidate[] {
  const total = legs.reduce((sum, leg) => sum + BigInt(leg.recordPointsAtomic), 0n).toString();
  const split: ProposedPeSplit = {
    totalPointsAtomic: total,
    basePointsAtomic: total,
    legs: legs.map((leg, index) => ({
      leg: leg.leg,
      contributor: leg.contributor,
      beneficiary_class: leg.beneficiaryClass,
      bps: bps[index],
      record_points_atomic: leg.recordPointsAtomic,
    })),
    origin: 'inlet_resolution',
    sourceFields: {},
    frozen,
  };
  return legs.map((leg) => ({ ...leg, split }));
}

/**
 * A source over a fixed list, honouring pageSize + cursor exactly as Firestore would.
 *
 * `filter` models the real source's behaviour of dropping already-claimed rows AFTER reading
 * them. That is the distinction the `InletPage` contract exists for, and a fake that offered
 * everything it read could not exercise it.
 */
function sourceOver(
  items: readonly InletCandidate[],
  filter: (c: InletCandidate) => boolean = () => true,
): InletPeSource {
  return {
    async loadPage({ pageSize, startAfterKey }) {
      const start = startAfterKey === undefined
        ? 0
        : items.findIndex((i) => i.peId === startAfterKey) + 1;
      const read = items.slice(start, start + pageSize);
      return {
        candidates: read.filter(filter),
        readCount: read.length,
        lastKey: read.length === 0 ? undefined : read[read.length - 1].peId,
      };
    },
  };
}

const CONFIG = { pageSize: 10, maxPesPerRun: 1000, maxRunMs: 60_000 };

/**
 * The production standard source reads each candidate's `pe_history` row to BUILD it, so that
 * row (mint_status 'eligible') exists by the time the registration re-check reads it back
 *. The mock `sourceOver` fabricates candidates with no such rows, which would make the
 * re-check refuse every standard candidate as `no_longer_settleable`. Wrapping `loadPage` to
 * seed `pe_history[peId] = { mint_status: 'eligible' }` for every standard candidate it offers
 * restores that single production precondition in ONE place — so no individual test carries the
 * seeding, and the `takeover-demotes-it` controls below can flip a specific row on purpose.
 */
function deps(db: SettlementDb, source: InletPeSource) {
  const seedingSource: InletPeSource = {
    async loadPage(options) {
      const page = await source.loadPage(options);
      for (const c of page.candidates) {
        if (c.lane === 'standard') {
          await db.collection(PE_HISTORY_COLLECTION).doc(c.peId)
            .set({ peId: c.peId, mint_status: RELAY_STATUS_READY }, { merge: true });
        }
      }
      return page;
    },
  };
  return { db, source: seedingSource, now: () => NOW };
}

async function legRow(
  db: SettlementDb, peId: string, leg: 'sole' | 'agent' | 'beneficiary',
): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(peId, leg)).get();
  return snap.exists ? snap.data() : undefined;
}

async function ledgerRow(db: SettlementDb, peId: string): Promise<Record<string, unknown> | undefined> {
  const snap = await db.collection(CLAIM_LEDGER_COLLECTION).doc(claimKeyOf(peId, 'sole')).get();
  return snap.exists ? snap.data() : undefined;
}

describe('claim inlet — the qualifying act becomes a claim', () => {
  it('registers an eligible standard PE under its DERIVED claim id', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const report = await runClaimInlet(deps(db, sourceOver([candidate(1)])), CONFIG);

    expect(report.examined).toBe(1); // empty-population guard
    expect(report.registered).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.pointsRegisteredAtomic).toBe('1000000000000000000');

    const row = await ledgerRow(db, 'pe-1');
    expect(row).toBeDefined();
    // Bound to the real derivation, not a literal copied into the test.
    const derived = deriveClaimId(eligiblePe(1).pe);
    expect(derived.kind).toBe('derived');
    expect(row!.claim_id).toBe(derived.kind === 'derived' ? derived.claimId : '');
    expect(row!.lane).toBe('standard');
    expect(row!.contributor).toBe(ADDR(0xa001));
    expect(row!.beneficiary_class).toBe(BeneficiaryClass.HumanResolving);
    expect(row!.settled).toBe(false);
  });

  it('RED CONTROL: a PE at or before the cut line is examined and NOT registered', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const stale = candidate(2, {
      eligibility: { ...eligiblePe(2), pe: { ...eligiblePe(2).pe, timestamp: PVT9_ELIGIBILITY_CUT_LINE_MS } },
    });
    const report = await runClaimInlet(deps(db, sourceOver([stale])), CONFIG);

    expect(report.examined).toBe(1);
    expect(report.registered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.skips[0].reason).toBe('ineligible');
    expect(report.skips[0].detail).toContain('pre_cut_line');
    expect(await ledgerRow(db, 'pe-2')).toBeUndefined();
  });

  it('RED CONTROL: an unverified hash chain is not admitted', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const unlinked = candidate(3, { eligibility: { ...eligiblePe(3), chainVerified: false } });
    const report = await runClaimInlet(deps(db, sourceOver([unlinked])), CONFIG);

    expect(report.examined).toBe(1);
    expect(report.registered).toBe(0);
    expect(report.skips[0].detail).toContain('chain_not_verified');
    expect(await ledgerRow(db, 'pe-3')).toBeUndefined();
  });

  it('RED CONTROL: a reserved attestation tier cannot buy its way in', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const reserved = candidate(4, { eligibility: { ...eligiblePe(4), attestationTier: 'compute_tee' } });
    const report = await runClaimInlet(deps(db, sourceOver([reserved])), CONFIG);

    expect(report.registered).toBe(0);
    expect(report.skips[0].detail).toContain('reserved_attestation_tier');
  });

  it('RED CONTROL: a ghost PE with no work evidence is refused', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const ghost = candidate(5, { eligibility: { ...eligiblePe(5), workEvidence: {} } });
    const report = await runClaimInlet(deps(db, sourceOver([ghost])), CONFIG);

    expect(report.registered).toBe(0);
    expect(report.skips[0].detail).toContain('ghost_pe_no_work_evidence');
  });

  it('is IDEMPOTENT: a second run registers nothing new and mints no second row', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const items = [candidate(6), candidate(7)];
    const first = await runClaimInlet(deps(db, sourceOver(items)), CONFIG);
    const second = await runClaimInlet(deps(db, sourceOver(items)), CONFIG);

    expect(first.registered).toBe(2);
    expect(second.examined).toBe(2);
    expect(second.registered).toBe(0);
    expect(second.alreadyRegistered).toBe(2);
    expect(second.pointsRegisteredAtomic).toBe('0');
  });

  it('REFUSES a PE already on record under a different claim id (the double-mint vector)', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    // Seed the ledger with a DIFFERENT claim id for the same PE.
    await registerClaim(db, {
      pe_id: 'pe-8',
      leg: 'sole',
      claim_id: H(0xdead),
      lane: 'standard',
      contributor: ADDR(0xa008),
      beneficiary_class: BeneficiaryClass.HumanResolving,
      record_points_atomic: '1000000000000000000',
    }, NOW);

    const report = await runClaimInlet(deps(db, sourceOver([candidate(8)])), CONFIG);

    expect(report.examined).toBe(1);
    expect(report.registered).toBe(0);
    expect(report.skips[0].reason).toBe('registration_rejected');
    // a PE with an act row and no frozen split is a pre-freeze leg set, and the act
    // registration refuses to add to it at all — a stricter refusal than per-row drift.
    expect(report.skips[0].detail).toContain('legacy_leg_set_unfrozen');
    // The seeded identity is untouched — drift is never silently overwritten.
    expect((await ledgerRow(db, 'pe-8'))!.claim_id).toBe(H(0xdead));
  });

  it('registers a Genesis claim with its full on-chain payload', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const genesis: InletCandidate = {
      peId: 'pe-9',
      leg: 'sole',
      lane: 'genesis',
      eligibility: { ...eligiblePe(9), workEvidence: { oneTimeAnchor: H(0x5150) } },
      contributor: ADDR(0xa009),
      genesis: {
        genesisAnchorKey: H(0x9001),
        walletId: H(0x9002),
        oneTimeAnchor: H(0x5150),
        grantType: 0,
        qualifiedAt: 1_785_200_000,
        reservedGrossAtomic: '75000000000000000000',
      },
    };
    const report = await runClaimInlet(deps(db, sourceOver([genesis])), CONFIG);

    expect(report.examined).toBe(1);
    expect(report.registered).toBe(1);
    expect(report.pointsRegisteredAtomic).toBe('75000000000000000000');

    const row = await ledgerRow(db, 'pe-9');
    expect(row).toBeDefined();
    expect(row!.lane).toBe('genesis');
    expect(row!.genesis_anchor_key).toBe(H(0x9001));
    expect(row!.one_time_anchor).toBe(H(0x5150));
    expect(row!.grant_type).toBe(0);
    expect(row!.reserved_gross_atomic).toBe('75000000000000000000');
    // Genesis rows carry NO standard-lane payload; the ledger validator refuses a mixture.
    expect(row!.record_points_atomic).toBeUndefined();
    expect(row!.beneficiary_class).toBeUndefined();
  });

  it('RED CONTROL: a Genesis candidate with a zero anchor is refused, not written', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const broken: InletCandidate = {
      peId: 'pe-91',
      leg: 'sole',
      lane: 'genesis',
      eligibility: { ...eligiblePe(91), workEvidence: { oneTimeAnchor: H(0) } },
      contributor: ADDR(0xa091),
      genesis: {
        genesisAnchorKey: H(0x9101),
        walletId: H(0x9102),
        oneTimeAnchor: H(0),
        grantType: 0,
        qualifiedAt: 1_785_200_000,
        reservedGrossAtomic: '75000000000000000000',
      },
    };
    const report = await runClaimInlet(deps(db, sourceOver([broken])), CONFIG);

    expect(report.registered).toBe(0);
    expect(report.skips[0].reason).toBe('registration_rejected');
    expect(report.skips[0].detail).toContain('invalid_one_time_anchor');
    expect(await ledgerRow(db, 'pe-91')).toBeUndefined();
  });

  it('RED CONTROL: a PE with no resolvable payee is not paid to a default address', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const report = await runClaimInlet(
      deps(db, sourceOver([candidate(10, { contributor: '' })])), CONFIG,
    );

    expect(report.registered).toBe(0);
    expect(report.skips[0].reason).toBe('invalid_contributor');
    expect(await ledgerRow(db, 'pe-10')).toBeUndefined();
  });

  it('RED CONTROL: an identity naming a different PE than the row is refused', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const mismatched = candidate(11, { eligibility: eligiblePe(999) });
    const report = await runClaimInlet(deps(db, sourceOver([mismatched])), CONFIG);

    expect(report.registered).toBe(0);
    expect(report.skips[0].reason).toBe('pe_id_mismatch');
  });

  it('reports an EMPTY population as examined=0, never as a silent pass', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const report = await runClaimInlet(deps(db, sourceOver([])), CONFIG);

    expect(report.examined).toBe(0);
    expect(report.registered).toBe(0);
    expect(report.outcome).toBe('completed');
    expect(report.stopReason).toBe('source_exhausted');
  });

  it('pages across the source and stops at maxPesPerRun', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const items = Array.from({ length: 25 }, (_, i) => candidate(100 + i));
    const report = await runClaimInlet(
      deps(db, sourceOver(items)), { pageSize: 4, maxPesPerRun: 10, maxRunMs: 60_000 },
    );

    expect(report.examined).toBe(10);
    expect(report.registered).toBe(10);
    expect(report.stopReason).toBe('pe_limit');
    expect(report.outcome).toBe('stopped');
    expect(await ledgerRow(db, 'pe-109')).toBeDefined();
    expect(await ledgerRow(db, 'pe-110')).toBeUndefined();
  });

  it('drains a multi-page population completely', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const items = Array.from({ length: 13 }, (_, i) => candidate(200 + i));
    const report = await runClaimInlet(
      deps(db, sourceOver(items)), { pageSize: 5, maxPesPerRun: 1000, maxRunMs: 60_000 },
    );

    expect(report.examined).toBe(13);
    expect(report.registered).toBe(13);
    expect(report.stopReason).toBe('source_exhausted');
  });

  it('caps the reported skip array without losing the skip COUNT', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const items = Array.from({ length: MAX_REPORTED_SKIPS + 20 }, (_, i) =>
      candidate(300 + i, { contributor: '', contributorRefusal: 'payee_wallet_not_found' }));
    const report = await runClaimInlet(
      deps(db, sourceOver(items)), { pageSize: 50, maxPesPerRun: 1000, maxRunMs: 60_000 },
    );

    expect(report.skipped).toBe(MAX_REPORTED_SKIPS + 20);
    expect(report.skips.length).toBe(MAX_REPORTED_SKIPS);
  });

  it('sums points over REGISTERED rows only', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const report = await runClaimInlet(deps(db, sourceOver([
      candidate(400, { recordPointsAtomic: '2000000000000000000' }),
      candidate(401, { recordPointsAtomic: '3000000000000000000' }),
      candidate(402, { recordPointsAtomic: '0' }),
    ])), CONFIG);

    expect(report.registered).toBe(2);
    expect(report.pointsRegisteredAtomic).toBe('5000000000000000000');
  });

  it('refuses a ZERO-point row rather than letting it wedge the queue head', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const report = await runClaimInlet(
      deps(db, sourceOver([candidate(410, { recordPointsAtomic: '0' })])), CONFIG,
    );

    expect(report.examined).toBe(1);
    expect(report.registered).toBe(0);
    expect(report.skips[0].reason).toBe('zero_record_points');
    expect(await ledgerRow(db, 'pe-410')).toBeUndefined();

    // RED CONTROL: the identical row with one atomic unit IS registered, so the refusal is
    // about the value being zero and not about anything else in the fixture. `_validateStandardInputs`
    // reverts the whole batch on `recordPointsAtomic == 0`, which is what makes the zero row a wedge.
    const ok = await runClaimInlet(
      deps(db, sourceOver([candidate(411, { recordPointsAtomic: '1' })])), CONFIG,
    );
    expect(ok.registered).toBe(1);
    expect(await ledgerRow(db, 'pe-411')).toBeDefined();
  });

  it('reports a payee refusal REASON, not just an empty address', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const report = await runClaimInlet(deps(db, sourceOver([
      candidate(420, { contributor: '', contributorRefusal: 'linked_agent_split_unwired' }),
    ])), CONFIG);

    expect(report.skips[0].reason).toBe('invalid_contributor');
    expect(report.skips[0].detail).toEqual(['linked_agent_split_unwired']);
  });

  it('does NOT read a filtered page as an exhausted one', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    // 12 rows, pageSize 5. Everything on page ONE is filtered out by the source, exactly as a
    // steady-state run where page one is already claimed. The old contract compared the
    // OFFERED length against the page size, read 0 < 5 as "backlog exhausted", and stopped —
    // permanently under-paying every earner past page one.
    const items = Array.from({ length: 12 }, (_, i) => candidate(500 + i));
    const filteredOut = new Set(items.slice(0, 5).map((c) => c.peId));
    const report = await runClaimInlet(
      deps(db, sourceOver(items, (c) => !filteredOut.has(c.peId))),
      { pageSize: 5, maxPesPerRun: 1000, maxRunMs: 60_000 },
    );

    expect(report.scanned).toBe(12);
    expect(report.examined).toBe(7);
    expect(report.registered).toBe(7);
    expect(report.stopReason).toBe('source_exhausted');
    expect(await ledgerRow(db, 'pe-511')).toBeDefined();

    // RED CONTROL: if exhaustion were judged on the OFFERED count, the run would have stopped
    // after page one with 0 registered. Assert the shape that would have produced.
    expect(report.registered).not.toBe(0);
  });

  it('advances the cursor past FILTERED rows, so it cannot loop on one page', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const items = Array.from({ length: 6 }, (_, i) => candidate(600 + i));
    // Every row filtered: the run must still terminate, having scanned all six.
    const report = await runClaimInlet(
      deps(db, sourceOver(items, () => false)),
      { pageSize: 2, maxPesPerRun: 1000, maxRunMs: 60_000 },
    );

    expect(report.scanned).toBe(6);
    expect(report.examined).toBe(0);
    expect(report.stopReason).toBe('source_exhausted');
  });

  it('REFUSES a source that reads rows but reports no cursor', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    // Bounded, not infinite — `scanned` still climbs to the budget — which is precisely what
    // makes it the quiet kind of wrong: the run would report progress while re-reading one
    // page forever. Refusing loudly is the only honest answer.
    const cursorless: InletPeSource = {
      async loadPage() {
        return { candidates: [], readCount: 3, lastKey: undefined };
      },
    };
    await expect(runClaimInlet(deps(db, cursorless), CONFIG))
      .rejects.toThrow('returned no cursor');

    // RED CONTROL: the identical source WITH a cursor pages normally and terminates, so the
    // refusal is about the missing cursor and not about the empty candidate list.
    const withCursor: InletPeSource = {
      async loadPage({ startAfterKey }) {
        return startAfterKey === undefined
          ? { candidates: [], readCount: 3, lastKey: 'k3' }
          : { candidates: [], readCount: 0, lastKey: undefined };
      },
    };
    const ok = await runClaimInlet(deps(db, withCursor), CONFIG);
    expect(ok.scanned).toBe(3);
    expect(ok.stopReason).toBe('source_exhausted');
  });

  it('registers BOTH legs of a split act, under two DISTINCT claim ids', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const agentLeg: InletCandidate = {
      ...candidate(700) as StandardInletCandidate,
      leg: 'agent',
      contributor: ADDR(0xaa01),
      recordPointsAtomic: '200000000000000000',
    };
    const humanLeg: InletCandidate = {
      ...candidate(700) as StandardInletCandidate,
      leg: 'beneficiary',
      contributor: ADDR(0xbb02),
      recordPointsAtomic: '800000000000000000',
    };
    const report = await runClaimInlet(deps(db, sourceOver(withSplit(
      [agentLeg as StandardInletCandidate, humanLeg as StandardInletCandidate], [2000, 8000],
    ))), CONFIG);

    expect(report.examined).toBe(2);
    expect(report.registered).toBe(2);
    expect(report.pointsRegisteredAtomic).toBe('1000000000000000000');

    const agentRow = await legRow(db, 'pe-700', 'agent');
    const humanRow = await legRow(db, 'pe-700', 'beneficiary');
    expect(agentRow).toBeDefined();
    expect(humanRow).toBeDefined();
    // THE PROPERTY: one PE, two rows, two claim ids. A shared id would make the second leg
    // revert `ClaimAlreadySettled` on chain and that payee would never be paid.
    expect(agentRow!.claim_id).not.toBe(humanRow!.claim_id);
    expect(agentRow!.contributor).toBe(ADDR(0xaa01));
    expect(humanRow!.contributor).toBe(ADDR(0xbb02));
    expect(agentRow!.pe_key).toBe(humanRow!.pe_key);
    expect(agentRow!.claim_key).not.toBe(humanRow!.claim_key);

    // Bound to the real derivation rather than a literal.
    const derivedAgent = deriveLegClaimId(eligiblePe(700).pe, 'agent');
    expect(agentRow!.claim_id).toBe(derivedAgent.kind === 'derived' ? derivedAgent.claimId : '');
  });

  it('REFUSES A REPLAY of either leg, independently', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const agentLeg: InletCandidate = {
      ...candidate(710) as StandardInletCandidate,
      leg: 'agent', contributor: ADDR(0xaa11), recordPointsAtomic: '200000000000000000',
    };
    const humanLeg: InletCandidate = {
      ...candidate(710) as StandardInletCandidate,
      leg: 'beneficiary', contributor: ADDR(0xbb12), recordPointsAtomic: '800000000000000000',
    };
    const legs = withSplit(
      [agentLeg as StandardInletCandidate, humanLeg as StandardInletCandidate], [2000, 8000],
    );
    const first = await runClaimInlet(deps(db, sourceOver(legs)), CONFIG);
    expect(first.registered).toBe(2);

    // Re-offering both legs registers nothing new: each is idempotent under its own identity.
    const replay = await runClaimInlet(deps(db, sourceOver(legs)), CONFIG);
    expect(replay.registered).toBe(0);
    expect(replay.alreadyRegistered).toBe(2);

    // And a leg offered under a DIFFERENT claim id is refused as drift rather than written —
    // the double-mint vector, per leg. (the frozen split carries each leg's claim id,
    // so the drift is caught against the split before any row is touched.)
    const [frozenAgent] = withSplit(
      [agentLeg as StandardInletCandidate, humanLeg as StandardInletCandidate], [2000, 8000], true,
    );
    const drifted: InletCandidate = {
      ...frozenAgent,
      eligibility: { ...eligiblePe(710), pe: { ...eligiblePe(710).pe, hash: H(0xdead) } },
    };
    const drift = await runClaimInlet(deps(db, sourceOver([drifted])), CONFIG);
    expect(drift.registered).toBe(0);
    expect(drift.skips[0].reason).toBe('registration_rejected');
    expect(drift.skips[0].detail).toContain('frozen_split_claim_id_mismatch');
  });

  it('SKIPS a standard PE demoted out from under selection, as no_longer_settleable', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    // The incumbent was demoted by a dual-witness takeover between selection and here: its
    // pe_history row reads corroborated_duplicate. Use the RAW source (NOT the seeding `deps`
    // wrap) and seed the demoted row directly, so the re-check sees real production state.
    await db.collection(PE_HISTORY_COLLECTION).doc('pe-950')
      .set({ peId: 'pe-950', mint_status: 'corroborated_duplicate' });
    const report = await runClaimInlet(
      { db, source: sourceOver([candidate(950)]), now: () => NOW }, CONFIG,
    );

    expect(report.examined).toBe(1); // empty-population guard
    expect(report.registered).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.skips[0].reason).toBe('no_longer_settleable'); // NOT registration_rejected
    expect(await ledgerRow(db, 'pe-950')).toBeUndefined();

    // GREEN CONTROL: the identical PE whose pe_history still reads 'eligible' IS registered, so
    // the skip is about the demoted status and not about anything else in the fixture. (This also
    // proves the `deps` seeding wrap is load-bearing: with the eligible row present, it admits.)
    const okDb = createFakeFirestore() as unknown as SettlementDb;
    await okDb.collection(PE_HISTORY_COLLECTION).doc('pe-951')
      .set({ peId: 'pe-951', mint_status: RELAY_STATUS_READY });
    const okReport = await runClaimInlet(
      { db: okDb, source: sourceOver([candidate(951)]), now: () => NOW }, CONFIG,
    );
    expect(okReport.registered).toBe(1);
    expect(await ledgerRow(okDb, 'pe-951')).toBeDefined();
  });

  it('rejects a non-positive page size rather than looping', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    await expect(runClaimInlet(deps(db, sourceOver([])), { ...CONFIG, pageSize: 0 }))
      .rejects.toThrow('pageSize');
  });
});

describe('claim inlet — durable scan cursor (, Finding B C4)', () => {
  const pool = Array.from({ length: 30 }, (_, index) => candidate(800 + index));
  const BUDGET_10 = { pageSize: 10, maxPesPerRun: 10, maxRunMs: 60_000 };

  it('reports the stop position on a budget stop and null on exhaustion', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const stopped = await runClaimInlet(deps(db, sourceOver(pool)), BUDGET_10);
    expect(stopped.stopReason).toBe('pe_limit');
    expect(stopped.nextStartAfterKey).toBe('pe-809');

    const exhausted = await runClaimInlet(deps(db, sourceOver(pool)), CONFIG);
    expect(exhausted.stopReason).toBe('source_exhausted');
    expect(exhausted.nextStartAfterKey).toBeNull();
  });

  it('STARVATION CLOSED: successive budget-bounded runs sweep the whole pool via the cursor', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    let cursor: string | undefined;
    let totalRegistered = 0;
    for (let run = 0; run < 3; run += 1) {
      const report = await runClaimInlet(
        deps(db, sourceOver(pool)),
        { ...BUDGET_10, ...(cursor === undefined ? {} : { startAfterKey: cursor }) },
      );
      expect(report.examined).toBeGreaterThan(0); // empty-population guard
      totalRegistered += report.registered;
      cursor = report.nextStartAfterKey ?? undefined;
    }
    // Every one of the 30 PEs registered within ceil(pool / budget) runs.
    expect(totalRegistered).toBe(30);
    for (const item of pool) {
      expect(await ledgerRow(db, item.peId)).toBeDefined();
    }
  });

  it('NEGATIVE CONTROL — without the cursor the same three runs re-scan the head and starve the tail', async () => {
    // The pre- behavior, demonstrated live: this is the defect the
    // cursor closes, kept red-visible so the closure cannot go vacuous.
    const db = createFakeFirestore() as unknown as SettlementDb;
    let totalRegistered = 0;
    for (let run = 0; run < 3; run += 1) {
      const report = await runClaimInlet(deps(db, sourceOver(pool)), BUDGET_10);
      totalRegistered += report.registered;
    }
    expect(totalRegistered).toBe(10);
    expect(await ledgerRow(db, 'pe-829')).toBeUndefined(); // the starved tail
  });

  it('a run resumed at the cursor wraps to the top on exhaustion (null), so a skipped head is reached next run', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    const tail = await runClaimInlet(
      deps(db, sourceOver(pool)),
      { ...CONFIG, startAfterKey: 'pe-819' },
    );
    expect(tail.scanned).toBe(10);
    expect(tail.nextStartAfterKey).toBeNull();

    const wrapped = await runClaimInlet(deps(db, sourceOver(pool)), CONFIG);
    expect(wrapped.scanned).toBe(30);
    for (const item of pool) {
      expect(await ledgerRow(db, item.peId)).toBeDefined();
    }
  });

  it('persists and loads the per-lane cursor; every failure mode fails OPEN to a top scan', async () => {
    const db = createFakeFirestore() as unknown as SettlementDb;
    expect(await loadInletCursor(db, 'standard')).toBeUndefined();

    await saveInletCursor(db, 'standard', 'pe-810', NOW);
    expect(await loadInletCursor(db, 'standard')).toBe('pe-810');
    expect(await loadInletCursor(db, 'genesis')).toBeUndefined(); // lanes are independent

    await saveInletCursor(db, 'standard', null, NOW);
    expect(await loadInletCursor(db, 'standard')).toBeUndefined();

    const broken = {
      collection: () => { throw new Error('firestore down'); },
    } as unknown as SettlementDb;
    expect(await loadInletCursor(broken, 'standard')).toBeUndefined();
    await expect(saveInletCursor(broken, 'standard', 'pe-810', NOW)).resolves.toBeUndefined();
  });
});
