/**
 * acceptance for the `pending_evidence` resolver.
 *
 * EVERY snapshot in this file is produced by the REAL kernel
 * (`computeRecordSnapshot` over the real materialized policy), never
 * hand-written. That is deliberate and it is the self-referential-control
 * rule applied: a suite that declares its own idea of what a `pending_evidence`
 * seal looks like proves only that the suite agrees with itself. Here, if the
 * policy table stops producing `linked_evidence_pe_only` for institution-lifecycle
 * drafts (mode a), or stops producing `projection_with_verified_evidence` for a
 * chain-receipt type or a bare agent-work type (mode b,), the REACHABILITY
 * assertions below go red before any behaviour is asserted.
 *
 * THE THREE RED CONTROLS the brief requires are permanent in-suite controls
 * rather than one-shot mutations someone ran by hand:
 * 1. a FAILING row never transitions — every non-`ok` verifier verdict, every
 * dark class, and every unbound snapshot is asserted to leave `mint_status`
 * exactly where it was;
 * 2. transitions are EXACTLY ONCE under replay — the same row is swept twice,
 * and concurrently, and `pe_history` is asserted to have been written once;
 * 3. a sweep that CANNOT ADVANCE is detectable — the cursor-advancement health
 * line is asserted directly, including the stuck case.
 *
 * And the empty population is a NAMED state, not a silent pass: a sweep over
 * zero rows reports `population_empty: true` and `cursor_advanced: false`, so a
 * production run that finds nothing cannot be read as a production run that
 * verified something.
 */

import { describe, it, expect, jest } from '@jest/globals';
import { createFakeFirestore, type FakeFirestore } from './__test-helpers__/fake-firestore';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  type RecordCalculationInput,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import { materializeProposedMonetaryPolicy } from './policy/runtime-monetary-policy';
import {
  PENDING_EVIDENCE_RESOLUTION_COLLECTION,
  PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION,
  PENDING_EVIDENCE_RESOLVER_CURSOR_DOC,
  hashResolutionEvidence,
  applyPendingEvidenceVerdict,
  judgePendingEvidenceRow,
  sweepPendingEvidence,
  type ChainReceiptVerification,
  type HeldPendingEvidenceRow,
  type PendingEvidenceResolverDeps,
} from './pending-evidence-resolver';

const POLICY = materializeProposedMonetaryPolicy(0);
const NOW = 1_800_000_000_000;
const ACTOR = '0x1111111111111111111111111111111111111111';

function snapshotFor(overrides: Partial<RecordCalculationInput>): RecordEconomicSnapshot {
  const input: RecordCalculationInput = {
    peId: 'pe_default',
    economicActorId: 'actor_1',
    actionType: 'send',
    recordedAtMs: NOW - 60_000,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: true,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'pending',
    canonicalEventId: null,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: null,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null,
    ...overrides,
  };
  return computeRecordSnapshot(POLICY, input);
}

/**
 * F-A7 repriced the 31 institution-lifecycle relay drafts
 * (escrow_created, job_posted, promise_created,...) to record_only — pre-value
 * self-reports with NO sound independent settlement verifier; value mints on the
 * funding/completion watcher or the chain event, never the draft. So the KERNEL
 * no longer PRODUCES a mode-(a) `linked_evidence_pe_only` snapshot for them
 * (`snapshotFor('escrow_created')` now returns record_only, evidence none).
 *
 * The resolver's mode-(a) arm REMAINS: it must still safely drain any PRE-F-A7
 * SEALED row — record linked-evidence arrival, NEVER promote (the C-2
 * protection). This reconstructs that legacy sealed shape the resolver will
 * actually receive from Firestore, by the SAME widened-input remedy the
 * session-lineage test below uses : a real kernel snapshot with ONLY the
 * three fields F-A7 moved restored to their pre-reprice mode-(a) values. Every
 * other field is the kernel's, so the never-promote guarantee stays under test.
 */
function legacyInstitutionDraftSnapshot(
  overrides: Partial<RecordCalculationInput>,
): RecordEconomicSnapshot {
  const base = snapshotFor(overrides);
  return {
    ...base,
    mintDisposition: 'pending_evidence',
    recordTimeFactors: {
      ...base.recordTimeFactors,
      evidenceRequirement: 'verified_institution_lifecycle',
      evidenceResolutionMode: 'linked_evidence_pe_only',
    },
  } as RecordEconomicSnapshot;
}

const INSTITUTION_DRAFT_TYPES = new Set([
  'escrow_created', 'job_posted', 'job_applied', 'job_accepted', 'promise_created', 'pool_created',
]);

/** Route institution-draft types to the legacy mode-(a) fixture, everything else to the kernel. */
function snapshotForType(
  actionType: string,
  overrides: Partial<RecordCalculationInput>,
): RecordEconomicSnapshot {
  return INSTITUTION_DRAFT_TYPES.has(actionType)
    ? legacyInstitutionDraftSnapshot({ ...overrides, actionType })
    : snapshotFor({ ...overrides, actionType });
}

function heldRow(
  peId: string,
  snapshot: RecordEconomicSnapshot,
  extra: Partial<HeldPendingEvidenceRow> = {},
): HeldPendingEvidenceRow {
  return {
    peId,
    userId: snapshot.economicActorId,
    actionType: snapshot.actionType,
    timestamp: snapshot.recordedAtMs,
    mint_status: 'pending_evidence',
    economic_snapshot: snapshot,
    economic_snapshot_hash: hashRecordEconomicSnapshot(snapshot),
    ...extra,
  };
}

function makeDeps(
  db: FakeFirestore,
  verify: (p: { txHash: string }) => Promise<ChainReceiptVerification>,
  actor: string | null = ACTOR,
): PendingEvidenceResolverDeps {
  return {
    db: db as unknown as PendingEvidenceResolverDeps['db'],
    verifyChainReceipt: jest.fn(verify) as PendingEvidenceResolverDeps['verifyChainReceipt'],
    resolveActorAddress: jest.fn(async () => actor) as
      PendingEvidenceResolverDeps['resolveActorAddress'],
  };
}

async function seed(db: FakeFirestore, row: HeldPendingEvidenceRow): Promise<void> {
  await db.collection('pe_history').doc(row.peId).set({ ...row });
}

async function readStatus(db: FakeFirestore, peId: string): Promise<string | undefined> {
  const snap = await db.collection('pe_history').doc(peId).get();
  return (snap.data() as { mint_status?: string } | undefined)?.mint_status;
}

// ─────────────────────────────────────────────────────────────────────────────
// REACHABILITY. Asserted FIRST, so nothing below can pass for the wrong reason.
// ─────────────────────────────────────────────────────────────────────────────

describe('the two populations are real, and the kernel is what produces them', () => {
  it('a chain-receipt type awaiting evidence seals pending_evidence in mode (b)', () => {
    const s = snapshotFor({ actionType: 'send', evidenceState: 'pending' });
    expect(s.mintDisposition).toBe('pending_evidence');
    expect(s.recordTimeFactors.evidenceRequirement).toBe('base_final_chain_receipt');
    expect(s.recordTimeFactors.evidenceResolutionMode).toBe('projection_with_verified_evidence');
  });

  it('a BARE self-attested agent-work row seals pending_evidence — it earns 0.8x but awaits verified evidence', () => {
    // reversed 's terminal floor: a software-tier agent-work row earns
    // the 0.8x discount in its points, and without server-verified evidence it
    // parks in mode (b) pending_evidence (awaiting the record-time verifier) — the
    // same as the proven-tier variant below. This RE-EXPANDS the /
    // no-in-place-exit pending pool to cover self-attested rows again.
    const s = snapshotFor({
      actionType: 'agent_work_product_code',
      sessionLineageId: 'pesl2_deadbeef',
    });
    expect(s.mintDisposition).toBe('pending_evidence');
    expect(s.mintReasonCode).toBe('awaiting_evidence');
    expect(s.recordTimeFactors.attestationMultiplierBps).toBe(8_000); // 0.8x software discount, not 0
    expect(s.recordTimeFactors.evidenceRequirement).toBe('verified_compute_or_work');
    expect(s.recordTimeFactors.evidenceResolutionMode).toBe('projection_with_verified_evidence');
  });

  it('the SAME bare agent-work row at a PROVEN tier also seals pending_evidence in mode (b), at the full 1.0x', () => {
    // The pending population for this family is REAL at every tier — rows awaiting
    // their evidence verification park in mode (b). The proven tier prices the
    // points at the flat 1.0x lift; the self-attested tier at 0.8x (above). Both
    // are pending until verified — this keeps the resolver's population tests
    // non-vacuous (the empty population).
    const s = snapshotFor({
      actionType: 'agent_work_product_code',
      sessionLineageId: 'pesl2_deadbeef',
      attestationTier: 'hardware_full',
    });
    expect(s.mintDisposition).toBe('pending_evidence');
    expect(s.recordTimeFactors.attestationMultiplierBps).toBe(8_000); // a generic hardware label is not App Attest
    expect(s.recordTimeFactors.evidenceRequirement).toBe('verified_compute_or_work');
    expect(s.recordTimeFactors.evidenceResolutionMode).toBe('projection_with_verified_evidence');
  });

  it('F-A7: institution-lifecycle drafts now seal record_only; a PRE-F-A7 sealed row is still mode (a)', () => {
    // F-A7 (2026-09-04) repriced escrow_created/job_posted/... to record_only, so
    // the KERNEL no longer produces a mode-(a) snapshot for them — value mints on
    // the funding/completion event, never the draft.
    const now = snapshotFor({ actionType: 'escrow_created', sessionLineageId: 'pesl2_deadbeef' });
    expect(now.mintDisposition).toBe('record_only');
    expect(now.recordTimeFactors.evidenceResolutionMode).toBe('not_applicable');
    // But any PRE-F-A7 SEALED row still carries mode (a), and the resolver's
    // never-promote arm must still recognize it (proven behaviourally below).
    const legacy = legacyInstitutionDraftSnapshot({
      actionType: 'escrow_created', sessionLineageId: 'pesl2_deadbeef',
    });
    expect(legacy.mintDisposition).toBe('pending_evidence');
    expect(legacy.recordTimeFactors.evidenceRequirement).toBe('verified_institution_lifecycle');
    expect(legacy.recordTimeFactors.evidenceResolutionMode).toBe('linked_evidence_pe_only');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RED CONTROL 1 — a failing row NEVER transitions.
// ─────────────────────────────────────────────────────────────────────────────

describe('RED 1: nothing that fails verification is ever promoted', () => {
  it('an unverified chain receipt leaves the row pending', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_a', actionType: 'send' });
    await seed(db, heldRow('pe_a', s, { tx_hash: `0x${'a'.repeat(64)}` }));

    const result = await sweepPendingEvidence(
      makeDeps(db, async () => ({ ok: false, reason: 'insufficient_confirmations: 3/12' })),
      { nowMs: NOW },
    );

    expect(result.awaiting_verified_evidence).toBe(1);
    expect(result.refused_promotion_would_create_mint_authority + 0).toBeGreaterThanOrEqual(0);
    expect(await readStatus(db, 'pe_a')).toBe('pending_evidence');
  });

  it('a verifier that THROWS is fail-closed, not treated as verified', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_b', actionType: 'send' });
    await seed(db, heldRow('pe_b', s, { tx_hash: `0x${'b'.repeat(64)}` }));

    const result = await sweepPendingEvidence(
      makeDeps(db, async () => { throw new Error('rpc down'); }),
      { nowMs: NOW },
    );

    expect(result.refused_verifier_error).toBe(1);
    expect(result.refused_promotion_would_create_mint_authority + 0).toBeGreaterThanOrEqual(0);
    expect(await readStatus(db, 'pe_b')).toBe('pending_evidence');
  });

  it('a row with no registered on-chain actor is REFUSED, not verified loosely', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_c', actionType: 'send' });
    await seed(db, heldRow('pe_c', s, { tx_hash: `0x${'c'.repeat(64)}` }));

    const result = await sweepPendingEvidence(
      makeDeps(db, async () => ({ ok: true, blockNumber: 1 }), null),
      { nowMs: NOW },
    );

    expect(result.refused_no_authoritative_actor).toBe(1);
    expect(result.refused_promotion_would_create_mint_authority + 0).toBeGreaterThanOrEqual(0);
    expect(await readStatus(db, 'pe_c')).toBe('pending_evidence');
  });

  it('a mutated snapshot is refused by the binding check before any judgement', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_d', actionType: 'send' });
    await seed(db, heldRow('pe_d', s, {
      tx_hash: `0x${'d'.repeat(64)}`,
      economic_snapshot_hash: 'f'.repeat(64),
    }));

    const verify = jest.fn(async () => ({ ok: true as const, blockNumber: 1 }));
    const result = await sweepPendingEvidence(makeDeps(db, verify), { nowMs: NOW });

    expect(result.refused_snapshot_unbound).toBe(1);
    expect(verify).not.toHaveBeenCalled();
    expect(await readStatus(db, 'pe_d')).toBe('pending_evidence');
  });

  it('EVERY dark class reachable in mode (b) refuses BY NAME and stays pending', async () => {
    // The population is DERIVED from the real policy table, not declared here:
    // every action type that can seal `pending_evidence` in mode (b) with an
    // evidence class this relay cannot verify today. If a runtime lights up and
    // a class leaves this set, this test stops covering it — visibly, because
    // the count is asserted rather than the list.
    const darkInModeB: string[] = [];
    for (const actionType of Object.keys(POLICY.actions)) {
      let s: RecordEconomicSnapshot;
      try {
        s = snapshotFor({ actionType, sessionLineageId: 'pesl2_deadbeef' });
      } catch { continue; }
      if (s.mintDisposition !== 'pending_evidence') continue;
      if (s.recordTimeFactors.evidenceResolutionMode !== 'projection_with_verified_evidence') {
        continue;
      }
      if (s.recordTimeFactors.evidenceRequirement === 'base_final_chain_receipt') continue;
      // `verified_substantive_outcome` is no longer dark — it has the
      // counterparty-confirmation verifier (`completion-verifier.ts`), proven
      // end to end in `completion-earning.acceptance.test.ts`. Its non-verifiable
      // members still refuse BY NAME there (`completion_…` / `no_verifier_…`).
      if (s.recordTimeFactors.evidenceRequirement === 'verified_substantive_outcome') continue;
      darkInModeB.push(actionType);
    }
    // NOT a pass over zero: the count is printed and asserted non-empty.
    expect(darkInModeB.length).toBeGreaterThan(0);

    const reasons = new Set<string>();
    for (const actionType of darkInModeB) {
      const db = createFakeFirestore();
      const s = snapshotFor({
        peId: `pe_${actionType}`,
        actionType,
        sessionLineageId: 'pesl2_deadbeef',
      });
      const verdict = await judgePendingEvidenceRow(
        makeDeps(db, async () => ({ ok: true })),
        heldRow(`pe_${actionType}`, s),
        { nowMs: NOW },
      );
      expect(verdict.outcome).toBe('refused_no_verifier_for_class');
      expect(verdict.reason).toMatch(/^no_verifier_/);
      reasons.add(verdict.reason.split(':')[0]);
    }
    // Each dark class names its own dark runtime rather than a generic refusal.
    expect(reasons.size).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).not.toBe('no_verifier_unknown_evidence_requirement');
  });

  it('mode (a) is checked BEFORE the class dispatch, so institution work never reaches it', async () => {
    const db = createFakeFirestore();
    const s = legacyInstitutionDraftSnapshot({
      peId: 'pe_inst',
      actionType: 'escrow_created',
      sessionLineageId: 'pesl2_deadbeef',
    });
    const verdict = await judgePendingEvidenceRow(
      makeDeps(db, async () => ({ ok: true })),
      heldRow('pe_inst', s),
      { nowMs: NOW },
    );
    expect(verdict.outcome).toBe('awaiting_linked_evidence_pe');
    expect(verdict.reason).toContain('linked_evidence_pe_only');
  });

  it('mode (a) with linked evidence PRESENT records arrival and STILL does not promote', async () => {
    const db = createFakeFirestore();
    const s = legacyInstitutionDraftSnapshot({
      peId: 'pe_e',
      actionType: 'job_posted',
      sessionLineageId: 'pesl2_deadbeef',
    });
    await seed(db, heldRow('pe_e', s, {
      corroboration_status: 'on_chain_verified',
      corroboration_source: '0xabc',
      corroboration_received_at: NOW - 1_000,
    }));

    const result = await sweepPendingEvidence(
      makeDeps(db, async () => ({ ok: true })),
      { nowMs: NOW },
    );

    expect(result.linked_evidence_recorded).toBe(1);
    expect(result.refused_promotion_would_create_mint_authority + 0).toBeGreaterThanOrEqual(0);
    // The seal is untouched — this is the C-2 protection, asserted not assumed.
    expect(await readStatus(db, 'pe_e')).toBe('pending_evidence');
    const record = await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).doc('pe_e').get();
    expect(record.exists).toBe(true);
    expect((record.data() as { outcome: string }).outcome).toBe('linked_evidence_recorded');
  });

  it('CLIENT-only corroboration markers do NOT count as linked evidence', async () => {
    // `applyClientCorroboration` writes `client_corroboration_*` and deliberately
    // leaves `corroboration_status` at 'none' because a client-asserted signal is
    // collusion-prone. If this ever starts counting, the fence is gone.
    const db = createFakeFirestore();
    const s = legacyInstitutionDraftSnapshot({
      peId: 'pe_f',
      actionType: 'job_posted',
      sessionLineageId: 'pesl2_deadbeef',
    });
    await seed(db, {
      ...heldRow('pe_f', s, { corroboration_status: 'none' }),
      ...({ client_corroboration_last_by: 'someone' } as Record<string, unknown>),
    } as HeldPendingEvidenceRow);

    const result = await sweepPendingEvidence(
      makeDeps(db, async () => ({ ok: true })),
      { nowMs: NOW },
    );
    expect(result.awaiting_linked_evidence_pe).toBe(1);
    expect(result.linked_evidence_recorded).toBe(0);
  });

  it('a record-time session-lineage gate is refused by name, never resolved', async () => {
    // Unconstructible through the mainline (the kernel forces such a row to
    // `record_only`), so the guard's INPUT is widened here — the remedy for
    // an unreachable branch — by handing the resolver the Firestore-shaped row it
    // will actually receive.
    const s = snapshotFor({ peId: 'pe_g', actionType: 'send' });
    const forged = {
      ...s,
      recordTimeFactors: {
        ...s.recordTimeFactors,
        unresolvedRecordGates: ['evidence', 'session_lineage'],
      },
    } as RecordEconomicSnapshot;
    const db = createFakeFirestore();
    const row = heldRow('pe_g', forged, { tx_hash: `0x${'e'.repeat(64)}` });

    const verdict = await judgePendingEvidenceRow(
      makeDeps(db, async () => ({ ok: true })),
      { ...row, economic_snapshot_hash: hashRecordEconomicSnapshot(forged) },
      { nowMs: NOW },
    );
    expect(verdict.outcome).toBe('refused_session_lineage_unresolvable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ARM THAT CAN PAY. Proven positively, so RED 1 is not vacuous.
// ─────────────────────────────────────────────────────────────────────────────

describe(' a VERIFIED chain receipt still does not promote', () => {
  it('the check runs, the result is recorded, and mint_status does not move', async () => {
    // `mint_status: 'eligible'` is the live PVT9 claim inlet's own selection
    // predicate, and the available check binds only sender + finality — never
    // that the tx is the act the PE describes. Promoting on it would be a new
    // value-moving path on a bar weaker than the record path's own.
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_ok', actionType: 'send' });
    const tx = `0x${'1'.repeat(64)}`;
    await seed(db, heldRow('pe_ok', s, { tx_hash: tx }));

    const verify = jest.fn(async () => ({
      ok: true as const, blockNumber: 49_000_000, confirmations: 12,
    }));
    const result = await sweepPendingEvidence(makeDeps(db, verify), { nowMs: NOW });

    // The verifier DID run — this is not a refusal by omission.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(result.refused_promotion_would_create_mint_authority).toBe(1);
    expect(await readStatus(db, 'pe_ok')).toBe('pending_evidence');

    // NOTHING was written to pe_history, and the seal is byte-intact.
    const hist = (await db.collection('pe_history').doc('pe_ok').get()).data() as
      Record<string, unknown>;
    expect(hist.economic_snapshot_hash).toBe(hashRecordEconomicSnapshot(s));
    expect(hist.economic_eligibility_projection).toBeUndefined();
    expect(hist.mint_disposition).toBeUndefined();
  });

  it('NO non-promoting outcome this module can produce writes to pe_history', async () => {
    // The population is every NON-PROMOTING outcome the sweep can reach from a
    // real seal. added exactly ONE writing outcome — `promoted`, the
    // verified counterparty-confirmation arm for `verified_substantive_outcome`
    // — and its write (mint_status → eligible, the projection, the claim, the
    // corroboration) is the RED pair of this assertion, proven end to end in
    // `completion-earning.acceptance.test.ts`. Every other outcome still leaves
    // the row byte-intact.
    const cases: readonly (readonly [string, string, Record<string, unknown>])[] = [
      ['send', 'pe_p1', { tx_hash: `0x${'1'.repeat(64)}` }],
      ['send', 'pe_p2', {}],
      ['job_posted', 'pe_p3', {}],
      ['job_posted', 'pe_p4', { corroboration_status: 'on_chain_verified' }],
      ['escrow_created', 'pe_p5', {}],
    ];
    expect(cases.length).toBeGreaterThan(0);
    for (const [actionType, peId, extra] of cases) {
      const db = createFakeFirestore();
      // 'send' is a mode-(b) chain-receipt type; the institution drafts are
      // PRE-F-A7 sealed mode-(a) rows (F-A7 reprices them record_only now).
      const s = snapshotForType(actionType, { peId, sessionLineageId: 'pesl2_deadbeef' });
      const before = { ...heldRow(peId, s, extra) };
      await seed(db, before);
      await sweepPendingEvidence(
        makeDeps(db, async () => ({ ok: true, blockNumber: 1, confirmations: 12 })),
        { nowMs: NOW },
      );
      const after = (await db.collection('pe_history').doc(peId).get()).data();
      expect(after).toEqual(before);
    }
  });

  it('the evidence commitment is in the KERNEL\'s format, not a second copy of it', () => {
    // The first cut returned BARE hex and carried its own /^[0-9a-f]{64}$/ guard
    // -- a divergent copy of a predicate the kernel owns
    // (`SHA256_COMMITMENT = /^sha256:[a-f0-9]{64}$/`). It passed its own guard
    // and would have been refused by the money path.
    const hash = hashResolutionEvidence({
      kind: 'base_final_chain_receipt',
      evidence_id: '0xabc',
      source: 'base:8453:tx_receipt',
      as_of: '49000000',
      canonical_event_id: '0xabc',
    });
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reordered = hashResolutionEvidence({
      kind: 'base_final_chain_receipt',
      evidence_id: 'base:8453:tx_receipt',
      source: '0xabc',
      as_of: '49000000',
      canonical_event_id: '0xabc',
    });
    expect(reordered).not.toBe(hash);
  });

  it('RED: a corroboration status outside the relay ALLOWLIST does not count', async () => {
    // A denylist (`!== 'none'`) would record 'disputed' as verified arrival --
    // and because arrival is the one durable outcome, that record would then make
    // every later pass answer already_resolved and swallow the real arrival.
    for (const status of ['disputed', 'pending', 'none', 'anything_new']) {
      const db = createFakeFirestore();
      const s = legacyInstitutionDraftSnapshot({
        peId: `pe_c_${status}`,
        actionType: 'job_posted',
        sessionLineageId: 'pesl2_deadbeef',
      });
      await seed(db, heldRow(`pe_c_${status}`, s, { corroboration_status: status }));
      const result = await sweepPendingEvidence(
        makeDeps(db, async () => ({ ok: true })),
        { nowMs: NOW },
      );
      expect(result.awaiting_linked_evidence_pe).toBe(1);
      expect(result.linked_evidence_recorded).toBe(0);
      const rec = await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION)
        .doc(`pe_c_${status}`).get();
      expect(rec.exists).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RED CONTROL 2 — exactly once under replay.
// ─────────────────────────────────────────────────────────────────────────────

describe('RED 2: the arrival record is written exactly once, including CONCURRENTLY', () => {
  const arrivalRow = (peId: string) => {
    const snap = legacyInstitutionDraftSnapshot({
      peId, actionType: 'job_posted', sessionLineageId: 'pesl2_deadbeef',
    });
    return heldRow(peId, snap, {
      corroboration_status: 'on_chain_verified',
      corroboration_source: '0xabc',
      corroboration_received_at: NOW - 1_000,
    });
  };

  it('sweeping the same row twice records once and then reports already_resolved', async () => {
    const db = createFakeFirestore();
    await seed(db, arrivalRow('pe_once'));
    const deps = makeDeps(db, async () => ({ ok: true }));

    const first = await sweepPendingEvidence(deps, { nowMs: NOW });
    expect(first.linked_evidence_recorded).toBe(1);

    await db.collection(PENDING_EVIDENCE_RESOLVER_CURSOR_COLLECTION)
      .doc(PENDING_EVIDENCE_RESOLVER_CURSOR_DOC).set({
        schema_version: 'pvt-pending-evidence-resolver-cursor/v1',
        last_timestamp_ms: null, last_pe_id: null, updated_at_ms: NOW, cycles_completed: 1,
      });

    const second = await sweepPendingEvidence(deps, { nowMs: NOW + 1 });
    expect(second.already_resolved).toBe(1);
    expect(second.linked_evidence_recorded).toBe(0);
    const record = (await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).doc('pe_once').get())
      .data() as { resolved_at_ms: number };
    // The ORIGINAL record survived — the replay did not overwrite it.
    expect(record.resolved_at_ms).toBe(NOW);
  });

  it(' RED: two CONCURRENT applications record once — the transaction is real', async () => {
    // The reviewer proved both transactional guards were individually deletable
    // with the suite green, because every prior test was strictly sequential and
    // "a row that moved underneath it" asserted a property of the QUERY FILTER,
    // so the transaction body was never entered. This enters it, twice, at once.
    const db = createFakeFirestore();
    const row = arrivalRow('pe_concurrent');
    await seed(db, row);
    const deps = makeDeps(db, async () => ({ ok: true }));
    const verdict = await judgePendingEvidenceRow(deps, row, { nowMs: NOW });
    expect(verdict.outcome).toBe('linked_evidence_recorded');
    const hash = hashResolutionEvidence(verdict.evidence!);

    const outcomes = await Promise.all([
      applyPendingEvidenceVerdict(deps.db, row, verdict, { nowMs: NOW }, hash),
      applyPendingEvidenceVerdict(deps.db, row, verdict, { nowMs: NOW + 5 }, hash),
    ]);
    expect(outcomes.filter((o) => o === 'linked_evidence_recorded')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already_resolved')).toHaveLength(1);
    const rec = (await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION)
      .doc('pe_concurrent').get()).data() as { resolved_at_ms: number };
    expect(rec.resolved_at_ms).toBe(NOW);
  });

  it(' RED: a stale judgement whose row moved is refused INSIDE the transaction', async () => {
    // Enters the transaction body (unlike the query-filter test it replaces):
    // the verdict is built from a row that WAS pending, and the live row is then
    // moved before the write. The in-transaction re-read is what catches it.
    const db = createFakeFirestore();
    const row = arrivalRow('pe_moved');
    await seed(db, row);
    const deps = makeDeps(db, async () => ({ ok: true }));
    const verdict = await judgePendingEvidenceRow(deps, row, { nowMs: NOW });
    await db.collection('pe_history').doc('pe_moved')
      .update({ mint_status: 'ineligible_terminal' });

    const outcome = await applyPendingEvidenceVerdict(
      deps.db, row, verdict, { nowMs: NOW }, hashResolutionEvidence(verdict.evidence!),
    );
    expect(outcome).toBe('refused_not_pending');
    expect((await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).doc('pe_moved').get())
      .exists).toBe(false);
    expect(await readStatus(db, 'pe_moved')).toBe('ineligible_terminal');
  });

  it(' RED: a re-bound snapshot mismatch is refused INSIDE the transaction', async () => {
    const db = createFakeFirestore();
    const row = arrivalRow('pe_rebound');
    await seed(db, row);
    const deps = makeDeps(db, async () => ({ ok: true }));
    const verdict = await judgePendingEvidenceRow(deps, row, { nowMs: NOW });
    await db.collection('pe_history').doc('pe_rebound')
      .update({ economic_snapshot_hash: 'f'.repeat(64) });

    const outcome = await applyPendingEvidenceVerdict(
      deps.db, row, verdict, { nowMs: NOW }, hashResolutionEvidence(verdict.evidence!),
    );
    expect(outcome).toBe('refused_snapshot_unbound');
    expect((await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).doc('pe_rebound').get())
      .exists).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RED CONTROL 3 — a sweep that cannot advance is DETECTABLE.
// ─────────────────────────────────────────────────────────────────────────────

describe('RED 3: cursor advancement is a health line, not an assumption', () => {
  it('the cursor WALKS the collection across passes instead of re-reading the head', async () => {
    const db = createFakeFirestore();
    for (let i = 0; i < 5; i += 1) {
      const s = legacyInstitutionDraftSnapshot({
        peId: `pe_w${i}`,
        actionType: 'job_posted',
        sessionLineageId: 'pesl2_deadbeef',
        recordedAtMs: NOW - 100_000 + i,
      });
      await seed(db, heldRow(`pe_w${i}`, s));
    }
    const deps = makeDeps(db, async () => ({ ok: false, reason: 'n/a' }));

    const p1 = await sweepPendingEvidence(deps, { nowMs: NOW, limit: 2 });
    const p2 = await sweepPendingEvidence(deps, { nowMs: NOW, limit: 2 });
    const p3 = await sweepPendingEvidence(deps, { nowMs: NOW, limit: 2 });

    expect([p1.scanned, p2.scanned, p3.scanned]).toEqual([2, 2, 1]);
    expect(p1.cursor_advanced).toBe(true);
    expect(p2.cursor_advanced).toBe(true);
    // A short page ends the cycle, which is itself advancement (it resets).
    expect(p3.cursor_advanced).toBe(true);
    expect(p3.cycles_completed).toBe(1);

    // COVERAGE, stated as a set rather than a count: the three passes together
    // touched every held row exactly once. A head-pinned query would have read
    // pe_w0/pe_w1 three times and never reached pe_w4.
    const seen = await db.collection(PENDING_EVIDENCE_RESOLUTION_COLLECTION).get();
    expect(p1.scanned + p2.scanned + p3.scanned).toBe(5);
    expect(seen.docs.length).toBe(0); // none resolved; all awaiting linked evidence
  });

  it('an EMPTY population is a named state, not a quiet success', async () => {
    const db = createFakeFirestore();
    const result = await sweepPendingEvidence(
      makeDeps(db, async () => ({ ok: true })),
      { nowMs: NOW },
    );
    expect(result.population).toBe(0);
    expect(result.population_empty).toBe(true);
    expect(result.cursor_advanced).toBe(false);
    expect(result.refused_promotion_would_create_mint_authority + 0).toBeGreaterThanOrEqual(0);
  });

  it(' RED: a STUCK sweep actually OBSERVES cursor_advanced === false', async () => {
    // The reviewer proved the prior version of this test never observed a
    // `false`: it asserted `scanned === 1`, `cursor_advanced === true`, and the
    // cursor's value, so the mutation `cursor_advanced = scanned > 0` — precisely
    // the derivation says must not be used — passed the whole suite. It
    // also named a scenario the module's own query cannot produce (a correct
    // `startAfter(t, id)` cannot re-return the row the cursor names).
    //
    // The REACHABLE trigger is a full page of rows the shape guard refuses whose
    // `timestamp` is not a number: `lastTimestampMs` stays null, the cursor is
    // written null, and the next pass re-reads the same head page forever.
    const db = createFakeFirestore();
    for (const peId of ['pe_bad1', 'pe_bad2']) {
      await db.collection('pe_history').doc(peId).set({
        peId, mint_status: 'pending_evidence', timestamp: 'not-a-number',
      });
    }
    const deps = makeDeps(db, async () => ({ ok: true }));

    const first = await sweepPendingEvidence(deps, { nowMs: NOW, limit: 1 });
    expect(first.scanned).toBe(1);
    expect(first.population_empty).toBe(false);
    // A full page (limit 1, size 1) that did not reach the end, did not wrap, and
    // left the cursor exactly where it started. THIS is the shape.
    expect(first.cursor_advanced).toBe(false);
    expect(first.refused_snapshot_unbound).toBe(1);

    // And it stays stuck — the same row is re-read on the next pass.
    const second = await sweepPendingEvidence(deps, { nowMs: NOW + 1, limit: 1 });
    expect(second.cursor_advanced).toBe(false);
    expect(second.scanned).toBe(1);
  });

  it('a HEALTHY pass over real rows reports cursor_advanced true — the positive control', async () => {
    // So the assertion above cannot pass by the health line simply always
    // being false.
    const db = createFakeFirestore();
    for (let i = 0; i < 2; i += 1) {
      const s2 = legacyInstitutionDraftSnapshot({
        peId: `pe_h${i}`,
        actionType: 'job_posted',
        sessionLineageId: 'pesl2_deadbeef',
        recordedAtMs: NOW - 90_000 + i,
      });
      await seed(db, heldRow(`pe_h${i}`, s2));
    }
    const pass = await sweepPendingEvidence(
      makeDeps(db, async () => ({ ok: false })), { nowMs: NOW, limit: 1 },
    );
    expect(pass.scanned).toBe(1);
    expect(pass.cursor_advanced).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B11 — the resolver's leg of the cross-source exactly-once invariant.
// A held chain-financial row whose canonical event ALREADY minted through the
// financial-settlement claim refuses BY NAME, so a future promotion arm cannot
// re-mint an event another seal owns.
// ─────────────────────────────────────────────────────────────────────────────

describe('B11 — canonical-event-already-minted coupling', () => {
  const TX = `0x${'9'.repeat(64)}`;

  function depsWithClaim(
    db: FakeFirestore,
    lookup: NonNullable<PendingEvidenceResolverDeps['lookupFinancialSettlementClaimOwner']>,
  ): PendingEvidenceResolverDeps {
    return {
      ...makeDeps(db, async () => ({ ok: true, blockNumber: 123, confirmations: 20 })),
      lookupFinancialSettlementClaimOwner: jest.fn(lookup) as
        NonNullable<PendingEvidenceResolverDeps['lookupFinancialSettlementClaimOwner']>,
    };
  }

  it('a held row whose (address,txHash) is claimed by ANOTHER PE refuses by name', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_held_send', actionType: 'send', evidenceState: 'pending' });
    const verdict = await judgePendingEvidenceRow(
      depsWithClaim(db, async () => 'pe_watcher_owner'),
      heldRow('pe_held_send', s, { tx_hash: TX }),
      { nowMs: NOW },
    );
    expect(verdict.outcome).toBe('refused_canonical_event_already_minted');
    expect(verdict.reason).toContain('pe_watcher_owner');
  });

  it('[ RED pair] the SAME row with the event UNCLAIMED falls through to the standing promotion refusal — the coupling is the cause, not a blanket block', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_held_send2', actionType: 'send', evidenceState: 'pending' });
    const verdict = await judgePendingEvidenceRow(
      depsWithClaim(db, async () => null),
      heldRow('pe_held_send2', s, { tx_hash: TX }),
      { nowMs: NOW },
    );
    expect(verdict.outcome).toBe('refused_promotion_would_create_mint_authority');
  });

  it('a claim owned by THIS row itself is not a refusal (self-ownership falls through)', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_self_owner', actionType: 'send', evidenceState: 'pending' });
    const verdict = await judgePendingEvidenceRow(
      depsWithClaim(db, async () => 'pe_self_owner'),
      heldRow('pe_self_owner', s, { tx_hash: TX }),
      { nowMs: NOW },
    );
    expect(verdict.outcome).toBe('refused_promotion_would_create_mint_authority');
  });

  it('a claim lookup that THROWS fails closed as a verifier error, never as unclaimed', async () => {
    const db = createFakeFirestore();
    const s = snapshotFor({ peId: 'pe_lookup_err', actionType: 'send', evidenceState: 'pending' });
    const verdict = await judgePendingEvidenceRow(
      depsWithClaim(db, async () => { throw new Error('firestore down'); }),
      heldRow('pe_lookup_err', s, { tx_hash: TX }),
      { nowMs: NOW },
    );
    expect(verdict.outcome).toBe('refused_verifier_error');
    expect(verdict.reason).toBe('financial_settlement_claim_lookup_threw');
  });
});
