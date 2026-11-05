import {
  BPS_DENOMINATOR,
  ATTESTATION_ENHANCEMENT_HORIZON_MS,
  ATTESTATION_ENHANCEMENT_WINDOW_MS,
  ATTESTATION_HORIZON_CUT_LINE_MS,
  attestationEnhancementWindowMsFor,
  MONETARY_ACCOUNTING_SCHEMA_VERSION,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V1,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V2,
  MINT_DISPOSITIONS,
  POLICY_REVIEW_STATES,
  PVT_ATOMIC_SCALE,
  type ActionMonetaryPolicy,
  type MintDisposition,
  type MonetaryPolicyVersion,
  type RecordCalculationInput,
  type SettlementContext,
  atomicUnits,
  canTransitionMintDisposition,
  canTransitionPolicyReviewState,
  computeRecordSnapshot,
  computeSettlement as computeSettlementKernel,
  dailyDiminishingBps,
  supersededDailyDiminishingBps,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
  isTerminalMintDisposition,
  noveltyBps,
  ordinaryNoveltyBps,
  recomputeRecordPointsAtCorrectedLinkage,
  uniqueArtifactNoveltyBps,
  unsignedInteger,
} from './monetary-accounting';
import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisReservationLedgerEntry,
} from './genesis-policy-engine';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';
import { createArmedGenesisPolicyForTest } from '../__test-helpers__/armed-genesis-policy';
import { genesisBountyFor } from '../genesis-award-state-machine';

const DEFAULT_ACTION: ActionMonetaryPolicy = {
  category: 'compute',
  baseWeightBps: 10_000,
  policyOverrideBps: null,
  mintDisposition: 'eligible',
  mintReasonCode: 'policy_eligible',
  policyReviewState: 'not_required',
  policyReviewReasonCode: 'known_policy_entry',
  financialAttestationNeutral: false,
  allowVerifiedAttestationUpgrade: true,
  evidenceRequirement: 'verified_compute_or_work',
  canonicalEventRequired: true,
  canonicalEventGroup: 'verified_work_artifact',
  beneficialOwnershipPolicy: 'record_only_if_self_shared_or_churn',
  sessionLineagePolicy: 'required',
  fixedGrantSource: 'none',
  evidenceResolutionMode: 'projection_with_verified_evidence',
};

const DEFAULT_ATTESTATION_TABLE: Readonly<Record<string, number>> = {
  software: 8_000,
  corroborated: 11_000,
  software_verified: 12_000,
  hardware_full: 25_000,
};
const TEST_EVIDENCE_HASH_A = `sha256:${'a'.repeat(64)}`;
const TEST_EVIDENCE_HASH_B = `sha256:${'b'.repeat(64)}`;

function makeAction(
  overrides: Partial<ActionMonetaryPolicy> = {},
): ActionMonetaryPolicy {
  return { ...DEFAULT_ACTION, ...overrides };
}

function makePolicy(options: {
  readonly policyVersion?: string;
  readonly effectiveAtMs?: number;
  readonly effectiveUntilMs?: number | null;
  readonly basePointsAtomic?: ReturnType<typeof atomicUnits>;
  readonly attestationMultipliersBps?: Readonly<Record<string, number>>;
  readonly actions?: Readonly<Record<string, ActionMonetaryPolicy>>;
  readonly linkageMultipliersBps?: MonetaryPolicyVersion['linkageMultipliersBps'];
} = {}): MonetaryPolicyVersion {
  return {
    schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION,
    policyVersion: options.policyVersion ?? 'pvt-policy-v1',
    effectiveAtMs: options.effectiveAtMs ?? 1_000,
    effectiveUntilMs: options.effectiveUntilMs ?? null,
    basePointsAtomic: options.basePointsAtomic ?? atomicUnits(PVT_ATOMIC_SCALE),
    attestationMultipliersBps:
      options.attestationMultipliersBps ?? DEFAULT_ATTESTATION_TABLE,
    linkageMultipliersBps: options.linkageMultipliersBps ?? {
      unlinked: 10_000,
      human_linked: 20_000,
      beneficiary_linked: 20_000,
      unverifiable: 10_000,
    },
    actions: options.actions ?? { work_product: DEFAULT_ACTION },
  };
}

function makeRecordInput(
  overrides: Partial<RecordCalculationInput> = {},
): RecordCalculationInput {
  return {
    peId: 'pe-1',
    economicActorId: 'actor-1',
    actionType: 'work_product',
    recordedAtMs: 1_500,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: 'artifact:sha256:test',
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: 'session:root',
    genesisReservation: null,
    ...overrides,
  };
}

function makeGenesisReservationReceipt(): GenesisReservationLedgerEntry {
  const manifest = createArmedGenesisPolicyForTest();
  const now = manifest.window.start_ms;
  const walletId = 'agent-wallet-1';
  const anchor = {
    anchor_kind: 'agent_id',
    anchor_id: walletId,
  };
  const result = reserveGenesisCampaignGrant({
    manifest,
    activation: {
      approval_status: 'approved_by_frank',
      approval_manifest_sha256: `sha256:${'c'.repeat(64)}`,
      approval_signature: {
        scheme: 'sshsig-ed25519',
        signer_identity: 'frank',
        namespace: 'provian-pvt-policy',
        public_key_sha256: `sha256:${'e'.repeat(64)}`,
        armored_signature: 'test-only-structured-signature',
      },
      frank_approval_audit_id: 'frank-test-approval',
      approved_policy_version: manifest.policy_version,
      approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(manifest),
      approved_monetary_policy_template_hash: `sha256:${'d'.repeat(64)}`,
      effective_at_ms: now,
      admission_closed_at_ms: null,
      admission_close_audit_id: null,
      grants_enabled: true,
      genesis_kill_switch_active: false,
      canonical_pvt_manifest_id: 'successor-test-manifest',
      ledger_namespace: 'genesis-test-ledger',
      prior_reservations_reconciled: true,
      operator_activation_audit_id: 'operator-test-activation',
    },
    state: createEmptyGenesisLedgerState('genesis-test-ledger'),
    input: {
      pe_id: 'pe-genesis-agent-signup-1',
      action_type: 'genesis_signup',
      wallet_id: walletId,
      economic_actor_id: walletId,
      immutable_anchor: anchor,
      qualifying_act_evidence: {
        verification_status: 'verified',
        evidence_id: 'agent-signup-proof',
        evidence_hash: `sha256:${'a'.repeat(64)}`,
        subject_wallet_id: walletId,
        canonical_bounty_key: 'genesis_signup',
        qualifying_act: genesisBountyFor('genesis_signup').qualifying_act,
        immutable_anchor_kind: anchor.anchor_kind,
        immutable_anchor_id: anchor.anchor_id,
        qualifying_act_at_ms: now,
      },
    },
    observation_context: {
      verification_status: 'verified',
      observed_at_ms: now,
      wallet_created: {
        wallet_id: walletId,
        created_at_ms: now,
        evidence_id: 'authoritative-agent-wallet-record',
        evidence_hash: `sha256:${'b'.repeat(64)}`,
        source: 'authoritative_wallet_record',
      },
    },
    activation_approval_verifier: () => true,
  });
  if (!result.allowed) throw new Error(result.reason);
  return result.reservation;
}

type UncommittedSettlementContext = Omit<SettlementContext, 'authorizedRecordSnapshotHash'>;

function makeSettlementContext(
  overrides: Partial<UncommittedSettlementContext> = {},
): UncommittedSettlementContext {
  return {
    settlementAtMs: 10_000,
    verifiedAttestationTier: 'software',
    globalMintRate: disclosedRationalFactor(1n, 1n, 'PVT.effectiveMintRate', 'block:100'),
    ...overrides,
  };
}

function computeSettlement(
  snapshot: Parameters<typeof computeSettlementKernel>[0],
  context: UncommittedSettlementContext,
) {
  return computeSettlementKernel(snapshot, {
    ...context,
    authorizedRecordSnapshotHash: hashRecordEconomicSnapshot(snapshot),
  });
}

describe('proposed record-time factor boundaries', () => {
  test('ordinary occurrence ordinals are explicit at 1/2/3/4+', () => {
    expect([1, 2, 3, 4, 400].map(ordinaryNoveltyBps)).toEqual([
      10_000,
      7_000,
      4_000,
      3_000,
      3_000,
    ]);
  });

  test('unique-artifact boundaries are explicit at 10/11/20/21/50/51', () => {
    expect([10, 11, 20, 21, 50, 51].map(uniqueArtifactNoveltyBps)).toEqual([
      10_000,
      8_000,
      8_000,
      6_000,
      6_000,
      3_000,
    ]);
  });

  test('exact duplicate is always zero, including for a unique artifact', () => {
    expect(
      noveltyBps({ occurrenceOrdinal: 1, exactDuplicate: true, uniqueArtifact: true }),
    ).toBe(0);
    expect(
      noveltyBps({ occurrenceOrdinal: 51, exactDuplicate: true, uniqueArtifact: false }),
    ).toBe(0);
  });

  test('the live daily factor is CONSTANT — every ordinal prices at 10000 bps', () => {
    expect([1, 49, 50, 51, 52, 53, 59, 60, 10_000].map(dailyDiminishingBps)).toEqual([
      10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000,
    ]);
  });

  test('the SUPERSEDED curve is preserved for sealed history only — 50/51/52 were 10000/5000/2500, floor 10', () => {
    // This is the retired pre- curve, byte-for-byte. It must stay
    // re-derivable so rows sealed under it validate without repricing — and
    // it is the permanent negative control that the live constant above is a
    // real change, not a test that cannot fail.
    expect([49, 50, 51, 52, 53, 59, 60, 10_000].map(supersededDailyDiminishingBps)).toEqual([
      10_000,
      10_000,
      5_000,
      2_500,
      1_250,
      19,
      10,
      10,
    ]);
  });

  test('a row SEALED under the superseded curve still validates and settles at its sealed points — and only the two values pass', () => {
    // The load-bearing sealed-history guarantee: a pre- production row
    // (ordinal 51 sealed at 5000 bps) must neither wedge nor reprice, a new
    // row seals the constant, and NO third value validates. Deleting the
    // superseded clause from validateSnapshot turns the first expectation RED
    // — that is this test's reason to exist.
    const policy = makePolicy({
      actions: { work_product: makeAction({ baseWeightBps: 20_000 }) },
    });
    const currentRow = computeRecordSnapshot(
      policy,
      makeRecordInput({
        occurrenceOrdinal: 2,
        dailyOrdinal: 51,
        linkageState: 'human_linked',
      }),
    );
    const supersededNumerator = PVT_ATOMIC_SCALE
      * 20_000n * 7_000n * 5_000n * 20_000n * 8_000n;
    const denominator = BigInt(BPS_DENOMINATOR) ** 5n;
    const supersededRow = {
      ...currentRow,
      // A superseded-daily-curve row is a v1-era seal; validateSnapshot re-derives it under the v1
      // (unmultiplied) formula, so its BPS^5 recordCalculation reconciles exactly as it was sealed.
      schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION_V1,
      recordPointsAtomic: '1120000000000000000' as typeof currentRow.recordPointsAtomic,
      recordCalculation: {
        numerator: supersededNumerator.toString(),
        denominator: denominator.toString(),
        floorRemainder: (supersededNumerator % denominator).toString(),
      } as typeof currentRow.recordCalculation,
      recordTimeFactors: {
        ...currentRow.recordTimeFactors,
        dailyDiminishingBps: supersededDailyDiminishingBps(51), // 5_000
      },
    };

    // Sealed history validates and settles from its SEALED points…
    const supersededSettled = computeSettlement(supersededRow, makeSettlementContext());
    const currentSettled = computeSettlement(currentRow, makeSettlementContext());
    // …and is NOT repriced: through the identical settlement context the
    // superseded row pays exactly its sealed half, not the current full.
    expect(BigInt(supersededSettled.finalPvtAtomic) * 2n)
      .toBe(BigInt(currentSettled.finalPvtAtomic));

    // A forged THIRD value — neither the constant nor the superseded
    // re-derivation — refuses.
    const forgedRow = {
      ...supersededRow,
      recordTimeFactors: {
        ...supersededRow.recordTimeFactors,
        dailyDiminishingBps: 7_000,
      },
    };
    expect(() => computeSettlement(forgedRow, makeSettlementContext()))
      .toThrow('Snapshot daily diminishing factor is inconsistent');
  });
});

describe('record-time calculation', () => {
  test('multiplies all rational record factors and floors exactly once', () => {
    const policy = makePolicy({
      actions: {
        work_product: makeAction({ baseWeightBps: 20_000 }),
      },
    });
    const snapshot = computeRecordSnapshot(
      policy,
      makeRecordInput({
        occurrenceOrdinal: 2,
        dailyOrdinal: 51,
        linkageState: 'human_linked',
      }),
    );

    // dailyOrdinal 51 no longer halves — the daily slot seals the
    // neutral 10000 bps and the act pays its full rate (this figure was
    // 1120000000000000000 under the retired curve; it is now exactly 2x).
    // PIECE 5 (v2): the record-points QUOTIENT is unchanged at count 0 / tokens 0
    // (2240000000000000000), but the exact recordCalculation now carries the two
    // folded multiplier factors — numerator ×(BPS_DENOMINATOR)×(VOLUME_TOKENS_DENOMINATOR)
    // and denominator likewise — both = identity at 0/0, so the floor is unchanged.
    const expectedNumerator = PVT_ATOMIC_SCALE
      * 20_000n
      * 7_000n
      * 10_000n
      * 20_000n
      * 8_000n
      * 10_000n;  // volume multiplier numerator at 0 tokens: VOLUME_TOKENS_DENOMINATOR + 0
    const expectedDenominator = BigInt(BPS_DENOMINATOR) ** 5n
      * BigInt(BPS_DENOMINATOR);                 // volume multiplier denominator

    expect(snapshot.recordPointsAtomic).toBe('2240000000000000000');
    expect(snapshot.recordCalculation).toEqual({
      numerator: expectedNumerator.toString(),
      denominator: expectedDenominator.toString(),
      floorRemainder: (expectedNumerator % expectedDenominator).toString(),
    });
    expect(snapshot.recordTimeFactors).toMatchObject({
      baseActionWeightBps: 20_000,
      effectiveActionWeightBps: 20_000,
      noveltyBps: 7_000,
      dailyDiminishingBps: 10_000,
      linkageMultiplierBps: 20_000,
      attestationMultiplierBps: 8_000,
    });
  });

  test('ops-dashboard: captureLane is sealed informational and changes NO price (byte-identical)', () => {
    const policy = makePolicy({ actions: { work_product: makeAction({ baseWeightBps: 20_000 }) } });
    const base = makeRecordInput({ occurrenceOrdinal: 2, dailyOrdinal: 51, linkageState: 'human_linked' });
    const withoutLane = computeRecordSnapshot(policy, base);
    const withLane = computeRecordSnapshot(policy, { ...base, captureLane: 'proxy' });
    // Pricing is byte-identical with vs without the lane — the field never enters the formula.
    expect(withLane.recordPointsAtomic).toBe(withoutLane.recordPointsAtomic);
    expect(withLane.recordCalculation).toEqual(withoutLane.recordCalculation);
    // The lane IS sealed (informational) — 'other' when absent, verbatim when a valid lane is given.
    expect(withoutLane.recordTimeFactors.captureLane).toBe('other');
    expect(withLane.recordTimeFactors.captureLane).toBe('proxy');
    // RED control: an invalid lane is normalized to 'other', never sealed verbatim, and still no reprice.
    const withGarbage = computeRecordSnapshot(policy, { ...base, captureLane: 'not_a_lane' });
    expect(withGarbage.recordTimeFactors.captureLane).toBe('other');
    expect(withGarbage.recordPointsAtomic).toBe(withoutLane.recordPointsAtomic);
  });

  test('uses the versioned policy override instead of an inferred fallback', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({
            baseWeightBps: 10_000,
            policyOverrideBps: 15_000,
          }),
        },
      }),
      makeRecordInput(),
    );

    expect(snapshot.recordTimeFactors.baseActionWeightBps).toBe(10_000);
    expect(snapshot.recordTimeFactors.policyOverrideBps).toBe(15_000);
    expect(snapshot.recordTimeFactors.effectiveActionWeightBps).toBe(15_000);
    expect(snapshot.recordPointsAtomic).toBe('1200000000000000000');
  });

  test('fails closed for an unknown action with a stable prospective-review state', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy({ actions: {} }),
      makeRecordInput({ actionType: 'new_integration:new_action' }),
    );

    expect(snapshot.recordPointsAtomic).toBe('0');
    expect(snapshot.mintDisposition).toBe('record_only');
    expect(snapshot.mintReasonCode).toBe('unknown_action_type');
    expect(snapshot.policyReviewState).toBe('pending_policy');
    expect(snapshot.policyReviewReasonCode).toBe('unknown_action_type');
    expect(() =>
      computeSettlement(snapshot, makeSettlementContext({
        eligibilityProjection: {
          mintDisposition: 'eligible',
          mintReasonCode: 'policy_eligible',
        },
      })),
    ).toThrow('Invalid mint disposition transition');
  });

  test('keeps an unknown duplicate record_only so policy review remains separate', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy({ actions: {} }),
      makeRecordInput({ actionType: 'new_integration:duplicate', exactDuplicate: true }),
    );

    expect(snapshot.recordPointsAtomic).toBe('0');
    expect(snapshot.mintDisposition).toBe('record_only');
    expect(snapshot.mintReasonCode).toBe('unknown_action_type');
    expect(snapshot.policyReviewState).toBe('pending_policy');
  });

  test('marks an exact duplicate terminal and assigns zero record points', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ exactDuplicate: true }),
    );

    expect(snapshot.recordPointsAtomic).toBe('0');
    expect(snapshot.mintDisposition).toBe('ineligible_terminal');
    expect(snapshot.mintReasonCode).toBe('exact_duplicate');
  });

  test('enforces evidence, canonical-event, session, and registry gates before eligibility', () => {
    const policy = makePolicy();
    expect(computeRecordSnapshot(
      policy,
      makeRecordInput({ evidenceState: 'pending' }),
    )).toMatchObject({ mintDisposition: 'pending_evidence', mintReasonCode: 'awaiting_evidence' });
    expect(computeRecordSnapshot(
      policy,
      makeRecordInput({ evidenceState: 'unverifiable' }),
    )).toMatchObject({
      mintDisposition: 'record_only',
      mintReasonCode: 'unverifiable_evidence_record_only',
    });
    expect(computeRecordSnapshot(
      policy,
      makeRecordInput({ canonicalEventId: null }),
    )).toMatchObject({ mintDisposition: 'pending_evidence', mintReasonCode: 'awaiting_evidence' });
    expect(computeRecordSnapshot(
      policy,
      makeRecordInput({ sessionLineageId: null }),
    )).toMatchObject({
      mintDisposition: 'record_only',
      mintReasonCode: 'missing_session_lineage_record_only',
    });
    expect(computeRecordSnapshot(
      policy,
      makeRecordInput({ linkageState: 'unverifiable' }),
    )).toMatchObject({ mintDisposition: 'pending_review', mintReasonCode: 'awaiting_review' });
  });

  test.each([
    ['self reference', { selfReferencing: true }, 'self_or_shared_beneficial_ownership'],
    ['shared ownership', { sharedBeneficialOwnership: true }, 'self_or_shared_beneficial_ownership'],
    ['pair churn', { pairChurnDetected: true }, 'pair_churn_record_only'],
  ] as const)('%s is record-only under the approved anti-circularity rule', (_label, override, reason) => {
    const snapshot = computeRecordSnapshot(makePolicy(), makeRecordInput(override));
    expect(snapshot.mintDisposition).toBe('record_only');
    expect(snapshot.mintReasonCode).toBe(reason);
    expect(snapshot.recordPointsAtomic).not.toBe('0');
    expect(computeSettlement(snapshot, makeSettlementContext()).finalPvtAtomic).toBe('0');
  });

  test('derives the linkage multiplier from the record policy instead of caller input', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ linkageState: 'human_linked' }),
    );
    expect(snapshot.recordTimeFactors.linkageMultiplierBps).toBe(20_000);
    expect(snapshot.recordPointsAtomic).toBe('1600000000000000000');
  });

  test('rejects all non-integer authoritative inputs', () => {
    expect(() => atomicUnits('1.25')).toThrow('canonical non-negative integer');
    expect(() => atomicUnits('01')).toThrow('canonical non-negative integer');
    expect(() => unsignedInteger('2e18')).toThrow('canonical non-negative integer');
    expect(() => disclosedRationalFactor(1n, 0n, 'source', 'block:1')).toThrow(
      'denominator must be greater than zero',
    );

    const fractionalPolicy = makePolicy({
      actions: {
        work_product: makeAction({ baseWeightBps: 10_000.5 }),
      },
    });
    expect(() => computeRecordSnapshot(fractionalPolicy, makeRecordInput())).toThrow(
      'must be a safe integer',
    );
    expect(() =>
      computeRecordSnapshot(makePolicy(), makeRecordInput({ occurrenceOrdinal: 1.5 })),
    ).toThrow('must be a safe integer');
  });

  test('missing duplicate facts and unknown evidence/linkage states block', () => {
    expect(() => computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ exactDuplicate: undefined as unknown as boolean }),
    )).toThrow('exactDuplicate must be a boolean');
    expect(() => computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ uniqueArtifact: 'unknown' as unknown as boolean }),
    )).toThrow('uniqueArtifact must be a boolean');
    expect(() => computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ evidenceState: 'unknown' as RecordCalculationInput['evidenceState'] }),
    )).toThrow('evidenceState is not a recognized state');
    expect(() => computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ linkageState: 'unknown' as RecordCalculationInput['linkageState'] }),
    )).toThrow('linkageState is not a recognized state');
  });

  test('snapshot is JSON-serializable and contains no authoritative floating amount', () => {
    const snapshot = computeRecordSnapshot(makePolicy(), makeRecordInput());
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot.recordPointsAtomic).toMatch(/^[0-9]+$/);
    expect(snapshot.recordCalculation.numerator).toMatch(/^[0-9]+$/);
    expect(snapshot.recordCalculation.denominator).toMatch(/^[0-9]+$/);
  });
});

describe('prospective policy versions', () => {
  test('a future action policy cannot reprice an earlier record snapshot', () => {
    const mutableV1Attestation = {
      software: 8_000,
      corroborated: 11_000,
      hardware_full: 25_000,
    };
    const v1 = makePolicy({
      policyVersion: 'pvt-policy-v1',
      effectiveAtMs: 1_000,
      effectiveUntilMs: 2_000,
      attestationMultipliersBps: mutableV1Attestation,
      actions: { work_product: makeAction({ baseWeightBps: 10_000 }) },
    });
    const oldSnapshot = computeRecordSnapshot(v1, makeRecordInput({ recordedAtMs: 1_500 }));

    const v2 = makePolicy({
      policyVersion: 'pvt-policy-v2',
      effectiveAtMs: 2_000,
      actions: { work_product: makeAction({ baseWeightBps: 30_000 }) },
      attestationMultipliersBps: {
        software: 8_000,
        corroborated: 20_000,
        hardware_full: 30_000,
      },
    });
    mutableV1Attestation.corroborated = 99_000;

    const oldSettlement = computeSettlement(
      oldSnapshot,
      makeSettlementContext({
        settlementAtMs: 3_000,
        verifiedAttestationTier: 'corroborated',
        verifiedAttestationObservedAtMs: 2_000,
      }),
    );
    const newSnapshot = computeRecordSnapshot(
      v2,
      makeRecordInput({ peId: 'pe-2', recordedAtMs: 2_500 }),
    );

    expect(oldSnapshot.policyVersion).toBe('pvt-policy-v1');
    expect(oldSnapshot.recordTimeFactors.attestationMultipliersAtRecordPolicyBps.corroborated).toBe(
      11_000,
    );
    expect(oldSettlement.finalPvtAtomic).toBe('1100000000000000000');
    expect(newSnapshot.recordPointsAtomic).toBe('2400000000000000000');
    expect(() =>
      computeRecordSnapshot(v2, makeRecordInput({ recordedAtMs: 1_500 })),
    ).toThrow('not yet effective');
    expect(() =>
      computeRecordSnapshot(v1, makeRecordInput({ recordedAtMs: 2_000 })),
    ).toThrow('no longer effective');
  });
});

describe('settlement-time calculation', () => {
  test('requires the independently sealed record commitment before using snapshot points', () => {
    const snapshot = computeRecordSnapshot(makePolicy(), makeRecordInput());
    const authorizedRecordSnapshotHash = hashRecordEconomicSnapshot(snapshot);
    const tampered = {
      ...snapshot,
      recordPointsAtomic: '999999999999999999999999999999' as typeof snapshot.recordPointsAtomic,
    };
    expect(() => computeSettlementKernel(tampered, {
      ...makeSettlementContext(),
      authorizedRecordSnapshotHash,
    })).toThrow('does not match the independently sealed commitment');
    expect(() => computeSettlementKernel(snapshot, {
      ...makeSettlementContext(),
      authorizedRecordSnapshotHash: 'sha256:missing',
    })).toThrow('commitment is missing or invalid');
  });

  test('materializes committed snapshot bytes once before any settlement read', () => {
    const snapshot = computeRecordSnapshot(makePolicy(), makeRecordInput());
    let reads = 0;
    const accessorSnapshot = { ...snapshot };
    Object.defineProperty(accessorSnapshot, 'recordPointsAtomic', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads <= 2
          ? snapshot.recordPointsAtomic
          : '999999999999999999999999999999';
      },
    });
    const authorizedRecordSnapshotHash = hashRecordEconomicSnapshot(accessorSnapshot);
    const settlement = computeSettlementKernel(accessorSnapshot, {
      ...makeSettlementContext(),
      authorizedRecordSnapshotHash,
    });
    expect(reads).toBe(2);
    expect(settlement.finalPvtAtomic).toBe(snapshot.recordPointsAtomic);
  });

  test('materializes eligibility projection once before state-machine validation', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ selfReferencing: true }),
    );
    let reads = 0;
    const projection = {
      mintReasonCode: snapshot.mintReasonCode,
    } as Record<string, unknown>;
    Object.defineProperty(projection, 'mintDisposition', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'record_only' : 'eligible';
      },
    });
    const settlement = computeSettlementKernel(snapshot, {
      ...makeSettlementContext(),
      authorizedRecordSnapshotHash: hashRecordEconomicSnapshot(snapshot),
      eligibilityProjection: projection as unknown as SettlementContext['eligibilityProjection'],
    });
    expect(reads).toBe(1);
    expect(settlement.effectiveMintDisposition).toBe('record_only');
    expect(settlement.finalPvtAtomic).toBe('0');
  });

  test('applies only a verified upgrade from the record policy table and disclosed globals', () => {
    const snapshot = computeRecordSnapshot(makePolicy(), makeRecordInput());
    const context = makeSettlementContext({
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs: 2_000,
      globalMintRate: disclosedRationalFactor(
        3n,
        2n,
        'PVT.effectiveMintRate',
        'block:200',
      ),
    });

    const settlement = computeSettlement(snapshot, context);

    // Parity: finalPvt = contractInput x globalMintRate only (no supply scaler).
    expect(settlement.finalPvtAtomic).toBe('1650000000000000000');
    expect(settlement.settlementTimeFactors).toMatchObject({
      recordAttestationMultiplierBps: 8_000,
      settlementAttestationMultiplierBps: 11_000,
      attestationAdjustmentNumerator: '11000',
      attestationAdjustmentDenominator: '8000',
      globalMintRate: context.globalMintRate,
    });
    const expectedContractInput = (BigInt(snapshot.recordPointsAtomic) * 11_000n) / 8_000n;
    const expectedNumerator = expectedContractInput * 3n;
    const expectedDenominator = 2n;
    expect(settlement.finalCalculation).toEqual({
      numerator: expectedNumerator.toString(),
      denominator: expectedDenominator.toString(),
      floorRemainder: (expectedNumerator % expectedDenominator).toString(),
    });
  });

  test('matches floor order for non-unit rate and a 72-hour upgrade', () => {
    const policy = makePolicy({
      basePointsAtomic: atomicUnits(34n),
      attestationMultipliersBps: {
        software: 3_000,
        corroborated: 4_000,
      },
    });
    const snapshot = computeRecordSnapshot(
      policy,
      makeRecordInput({ recordedAtMs: 1_500 }),
    );
    expect(snapshot.recordPointsAtomic).toBe('10');

    const atBoundary = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs:
        snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS,
      globalMintRate: disclosedRationalFactor(3n, 2n, 'PVT.effectiveMintRate', 'block:floor'),
    }));
    expect(atBoundary.contractInputPointsAtomic).toBe('13');
    expect(atBoundary.contractInputCalculation).toEqual({
      numerator: '40000',
      denominator: '3000',
      floorRemainder: '1000',
    });
    expect(atBoundary.finalPvtAtomic).toBe('19');
    expect(atBoundary.finalCalculation).toEqual({
      numerator: '39',
      denominator: '2',
      floorRemainder: '1',
    });

    // Parity: a unit rate with no supply scaler yields exactly the
    // attestation-floored contract input (13), unchanged.
    const unitRate = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs:
        snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS,
      globalMintRate: disclosedRationalFactor(1n, 1n, 'unit-rate', 'block:scaler'),
    }));
    expect(unitRate.contractInputPointsAtomic).toBe('13');
    expect(unitRate.finalPvtAtomic).toBe('13');

    const oneMillisecondLate = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 2,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs:
        snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1,
      globalMintRate: disclosedRationalFactor(3n, 2n, 'PVT.effectiveMintRate', 'block:late'),
    }));
    expect(oneMillisecondLate.contractInputPointsAtomic).toBe('10');
    expect(oneMillisecondLate.finalPvtAtomic).toBe('15');
    expect(oneMillisecondLate.settlementTimeFactors.enhancementApplied).toBe(false);
  });

  test('applies an enhancement at the 72-hour boundary and freezes economics one millisecond later', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ recordedAtMs: 1_500 }),
    );
    const atBoundary = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 10_000,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs:
        snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS,
    }));
    expect(atBoundary.finalPvtAtomic).toBe('1100000000000000000');
    expect(atBoundary.settlementTimeFactors.enhancementApplied).toBe(true);

    const late = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 10_000,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs:
        snapshot.recordedAtMs + ATTESTATION_ENHANCEMENT_WINDOW_MS + 1,
    }));
    expect(late.finalPvtAtomic).toBe('800000000000000000');
    expect(late.settlementTimeFactors.enhancementApplied).toBe(false);
    expect(late.settlementTimeFactors.verifiedAttestationTier).toBe('software');
  });

  test('rejects future-relative attestation observations and enhancement-window overflow', () => {
    const snapshot = computeRecordSnapshot(makePolicy(), makeRecordInput());
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: 2_000,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs: 2_001,
    }))).toThrow('cannot postdate settlement');

    const nearLimit = Number.MAX_SAFE_INTEGER - ATTESTATION_ENHANCEMENT_WINDOW_MS + 1;
    const nearLimitSnapshot = computeRecordSnapshot(
      makePolicy({ effectiveAtMs: nearLimit }),
      makeRecordInput({ recordedAtMs: nearLimit }),
    );
    expect(() => computeSettlement(nearLimitSnapshot, makeSettlementContext({
      settlementAtMs: nearLimit,
    }))).toThrow('enhancementWindowExpiresAtMs must be a safe integer');
  });

  test('rejects a downgrade and any upgrade not authorized in the record snapshot', () => {
    const upgradedRecord = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ attestationTier: 'corroborated' }),
    );
    expect(() =>
      computeSettlement(
        upgradedRecord,
        makeSettlementContext({ verifiedAttestationTier: 'software' }),
      ),
    ).toThrow('cannot downgrade');

    const noUpgrade = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({ allowVerifiedAttestationUpgrade: false }),
        },
      }),
      makeRecordInput(),
    );
    expect(() =>
      computeSettlement(
        noUpgrade,
        makeSettlementContext({ verifiedAttestationTier: 'corroborated' }),
      ),
    ).toThrow('not authorized');
  });

  test('financial actions are attestation-neutral at record and settlement', () => {
    const policy = makePolicy({
      actions: {
        base_send: makeAction({
          category: 'financial',
          financialAttestationNeutral: true,
          allowVerifiedAttestationUpgrade: false,
          evidenceRequirement: 'base_final_chain_receipt',
        }),
      },
    });
    const snapshot = computeRecordSnapshot(
      policy,
      makeRecordInput({ actionType: 'base_send', attestationTier: 'software' }),
    );
    const settlement = computeSettlement(
      snapshot,
      makeSettlementContext({ verifiedAttestationTier: 'hardware_full' }),
    );

    expect(snapshot.recordTimeFactors.attestationMultiplierBps).toBe(10_000);
    expect(snapshot.allowedSettlementAdjustments.verifiedAttestationUpgrade).toBe(false);
    expect(snapshot.recordPointsAtomic).toBe(PVT_ATOMIC_SCALE.toString());
    expect(settlement.settlementTimeFactors.settlementAttestationMultiplierBps).toBe(10_000);
    expect(settlement.finalPvtAtomic).toBe(PVT_ATOMIC_SCALE.toString());
    expect(() =>
      computeSettlement(
        snapshot,
        makeSettlementContext({ verifiedAttestationTier: 'unrecognized_tier' }),
      ),
    ).toThrow('absent from record policy');
  });

  test('same snapshot and disclosed context always produce the same output', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ occurrenceOrdinal: 3, dailyOrdinal: 52 }),
    );
    const context = makeSettlementContext({
      verifiedAttestationTier: 'software_verified',
      verifiedAttestationObservedAtMs: 2_000,
      globalMintRate: disclosedRationalFactor(
        987_654_321n,
        1_000_000_000n,
        'PVT.effectiveMintRate',
        'block:300',
      ),
    });

    expect(computeSettlement(snapshot, context)).toEqual(computeSettlement(snapshot, context));
  });

  test('rejects a Genesis reservation on every non-Genesis action, including unknown types', () => {
    const genesisReservation = makeGenesisReservationReceipt();
    expect(() => computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ genesisReservation }),
    )).toThrow('Non-Genesis action cannot carry a Genesis reservation');
    expect(() => computeRecordSnapshot(
      makePolicy({ actions: {} }),
      makeRecordInput({
        actionType: 'thirdparty:fixed_grant_attempt',
        genesisReservation,
      }),
    )).toThrow('Non-Genesis action cannot carry a Genesis reservation');
  });

  test('one authentic Genesis reservation funds only its bound PE and economic actor', () => {
    const genesisReservation = makeGenesisReservationReceipt();
    const genesisPolicy = makePolicy({
      effectiveAtMs: genesisReservation.reserved_at_ms,
      actions: {
        genesis_signup: makeAction({
          category: 'genesis_campaign',
          baseWeightBps: 0,
          allowVerifiedAttestationUpgrade: false,
          evidenceRequirement: 'valid_genesis_reservation',
          canonicalEventRequired: true,
          canonicalEventGroup: 'genesis_campaign_reservation:genesis_signup',
          beneficialOwnershipPolicy: 'not_applicable',
          sessionLineagePolicy: 'not_applicable',
          financialAttestationNeutral: true,
          fixedGrantSource: 'genesis_campaign_reservation',
          evidenceResolutionMode: 'linked_evidence_pe_only',
        }),
      },
    });
    const boundInput = makeRecordInput({
      peId: genesisReservation.pe_id,
      economicActorId: genesisReservation.economic_actor_id,
      actionType: 'genesis_signup',
      recordedAtMs: genesisReservation.reserved_at_ms,
      canonicalEventId: genesisReservation.reservation_id,
      sessionLineageId: null,
      genesisReservation,
    });
    const snapshot = computeRecordSnapshot(genesisPolicy, boundInput);
    expect(snapshot.recordPointsAtomic).toBe('75000000000000000000');
    expect(computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: genesisReservation.reserved_at_ms,
    })).finalPvtAtomic)
      .toBe('75000000000000000000');
    expect(() => computeRecordSnapshot(
      genesisPolicy,
      { ...boundInput, peId: 'different-pe' },
    )).toThrow('bound to a different PE');
    expect(() => computeRecordSnapshot(
      genesisPolicy,
      { ...boundInput, economicActorId: 'different-actor' },
    )).toThrow('bound to a different economic actor');
  });

  test('non-eligible dispositions remain zero until an allowed non-economic transition', () => {
    const pendingSnapshot = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({
            mintDisposition: 'pending_evidence',
            mintReasonCode: 'awaiting_evidence',
          }),
        },
      }),
      makeRecordInput({ evidenceState: 'pending' }),
    );

    expect(computeSettlement(pendingSnapshot, makeSettlementContext()).finalPvtAtomic).toBe('0');
    expect(
      computeSettlement(
        pendingSnapshot,
        makeSettlementContext({
          eligibilityProjection: {
            mintDisposition: 'eligible',
            mintReasonCode: 'policy_eligible',
            resolutionEvidence: [{
              resolutionType: 'evidence',
              evidenceId: 'evidence-pe-1',
              evidenceHash: TEST_EVIDENCE_HASH_A,
              source: 'pe_history/evidence-pe-1',
              asOf: 'block:301',
              canonicalEventId: 'artifact:sha256:test',
            }],
          },
        }),
      ).finalPvtAtomic,
    ).toBe('800000000000000000');
  });

  test('cannot turn a held record eligible without matching immutable evidence', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({
            mintDisposition: 'pending_evidence',
            mintReasonCode: 'awaiting_evidence',
          }),
        },
      }),
      makeRecordInput({ evidenceState: 'pending' }),
    );
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
      },
    }))).toThrow('requires immutable resolution evidence');
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
        resolutionEvidence: [{
          resolutionType: 'evidence',
          evidenceId: 'evidence-pe-2',
          evidenceHash: TEST_EVIDENCE_HASH_B,
          source: 'pe_history/evidence-pe-2',
          asOf: 'block:302',
          canonicalEventId: 'artifact:sha256:other',
        }],
      },
    }))).toThrow('does not match the recorded canonical event');
  });

  test('composes evidence and registry holds so resolving only one cannot mint', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ evidenceState: 'pending', linkageState: 'unverifiable' }),
    );
    expect(snapshot).toMatchObject({
      mintDisposition: 'pending_review',
      mintReasonCode: 'awaiting_review',
      recordTimeFactors: {
        unresolvedRecordGates: expect.arrayContaining(['evidence', 'registry']),
      },
    });
    const evidence = {
      resolutionType: 'evidence' as const,
      evidenceId: 'work-proof',
      evidenceHash: TEST_EVIDENCE_HASH_A,
      source: 'pe_history/work-proof',
      asOf: 'block:304',
      canonicalEventId: 'artifact:sha256:test',
    };
    const registry = {
      resolutionType: 'registry' as const,
      evidenceId: 'registry-proof',
      evidenceHash: TEST_EVIDENCE_HASH_B,
      source: 'registry/snapshot',
      asOf: 'block:304',
      canonicalEventId: null,
    };
    const projection = (resolutionEvidence: readonly (typeof evidence | typeof registry)[]) =>
      makeSettlementContext({
        eligibilityProjection: {
          mintDisposition: 'eligible',
          mintReasonCode: 'policy_eligible',
          resolutionEvidence,
        },
      });
    expect(() => computeSettlement(snapshot, projection([registry])))
      .toThrow('requires evidence resolution evidence');
    expect(() => computeSettlement(snapshot, projection([evidence])))
      .toThrow('requires registry resolution evidence');
    expect(computeSettlement(snapshot, projection([evidence, registry])).finalPvtAtomic)
      .toBe('800000000000000000');
  });

  test('missing record-time session lineage is terminal and cannot be supplied later', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy(),
      makeRecordInput({ sessionLineageId: null }),
    );
    expect(snapshot).toMatchObject({
      mintDisposition: 'record_only',
      mintReasonCode: 'missing_session_lineage_record_only',
    });
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
        resolutionEvidence: [],
      },
    }))).toThrow('Invalid mint disposition transition');
  });

  test('draft PEs requiring a distinct evidence PE can never resolve in place', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({
            mintDisposition: 'pending_evidence',
            mintReasonCode: 'awaiting_evidence',
            evidenceResolutionMode: 'linked_evidence_pe_only',
          }),
        },
      }),
      makeRecordInput({ evidenceState: 'pending' }),
    );
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
        resolutionEvidence: [{
          resolutionType: 'evidence',
          evidenceId: 'evidence-pe-3',
          evidenceHash: TEST_EVIDENCE_HASH_A,
          source: 'pe_history/evidence-pe-3',
          asOf: 'block:303',
          canonicalEventId: 'artifact:sha256:test',
        }],
      },
    }))).toThrow('separately linked evidence PE');
  });

  test('rejects non-canonical projection and evidence schemas', () => {
    const snapshot = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({
            mintDisposition: 'pending_evidence',
            mintReasonCode: 'awaiting_evidence',
          }),
        },
      }),
      makeRecordInput({ evidenceState: 'pending' }),
    );
    const evidence = {
      resolutionType: 'evidence' as const,
      evidenceId: 'evidence-pe-exact',
      evidenceHash: TEST_EVIDENCE_HASH_A,
      source: 'pe_history/evidence-pe-exact',
      asOf: 'block:305',
      canonicalEventId: 'artifact:sha256:test',
    };
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
        resolutionEvidence: [evidence],
        unexpected: true,
      } as unknown as SettlementContext['eligibilityProjection'],
    }))).toThrow('eligibilityProjection contains unknown field');
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
        resolutionEvidence: [{ ...evidence, unexpected: true }],
      } as unknown as SettlementContext['eligibilityProjection'],
    }))).toThrow('resolutionEvidence item contains unknown field');
    expect(() => computeSettlement(snapshot, makeSettlementContext({
      eligibilityProjection: {
        mintDisposition: 'eligible',
        mintReasonCode: 'policy_eligible',
        resolutionEvidence: [{ ...evidence, evidenceHash: 'sha256:not-a-hash' }],
      },
    }))).toThrow('must be a SHA-256 commitment');
  });
});

describe('stable state machines', () => {
  test('exports every required disposition and review state', () => {
    expect(MINT_DISPOSITIONS).toEqual([
      'eligible',
      'pending_evidence',
      'pending_review',
      'record_only',
      'ineligible_terminal',
      'pending_cache',
      'pending_compliance',
      'beneficiary_pending',
      'jurisdiction_deferred',
    ]);
    expect(POLICY_REVIEW_STATES).toEqual([
      'not_required',
      'pending_policy',
      'classified_prospective',
      'class_admitted',
      'rejected',
    ]);
  });

  test('prospective classification closes review but cannot revalue record_only history', () => {
    expect(canTransitionPolicyReviewState('pending_policy', 'classified_prospective')).toBe(true);
    expect(canTransitionPolicyReviewState('pending_policy', 'rejected')).toBe(true);
    expect(canTransitionPolicyReviewState('classified_prospective', 'pending_policy')).toBe(false);
    expect(canTransitionMintDisposition('record_only', 'eligible')).toBe(false);
    expect(canTransitionMintDisposition('pending_evidence', 'eligible')).toBe(true);
    expect(canTransitionMintDisposition('ineligible_terminal', 'eligible')).toBe(false);
  });

  test('isTerminalMintDisposition marks exactly the no-exit dispositions (claim-release gate)', () => {
    // Iterate the FULL enum so a newly-added disposition cannot slip past
    // unclassified (empty-population guard), and cross-check each verdict against
    // the transition-table property it derives from: terminal ⟺ no exit to any
    // OTHER disposition. The two must agree for every disposition, and the
    // terminal set is exactly {record_only, ineligible_terminal}.
    const terminalByTable = (d: MintDisposition): boolean =>
      MINT_DISPOSITIONS.every((to) => to === d || !canTransitionMintDisposition(d, to));
    const terminal = MINT_DISPOSITIONS.filter(isTerminalMintDisposition);
    expect(terminal).toEqual(['record_only', 'ineligible_terminal']);
    for (const d of MINT_DISPOSITIONS) {
      expect(isTerminalMintDisposition(d)).toBe(terminalByTable(d));
    }
    // Non-terminal must include every recoverable/deferred state — releasing a
    // commit claim for any of these would risk a double-mint (they can reach eligible).
    for (const d of ['eligible', 'pending_evidence', 'pending_review', 'pending_cache',
      'beneficiary_pending', 'jurisdiction_deferred'] as const) {
      expect(isTerminalMintDisposition(d)).toBe(false);
    }
  });
});

describe('external-proof corroboration lift (digest-neutral carve-out)', () => {
  // The flat evidence-priced table: proof tiers at 1.0×, software at 0.8×.
  const EVIDENCE_TABLE: Readonly<Record<string, number>> = {
    software: 8_000,
    corroborated: 10_000,
    software_verified: 10_000,
    hardware_full: 10_000,
  };
  function externalProofSnapshot() {
    const policy: MonetaryPolicyVersion = {
      ...makePolicy({
        actions: {
          work_product: makeAction({
            attestationPricing: 'external_proof_priced',
            // external_proof_priced FORCES the flag false (validateActionPolicy
            // throws otherwise) — which is exactly why the carve-out is needed.
            allowVerifiedAttestationUpgrade: false,
            sessionLineagePolicy: 'optional',
          }),
        },
      }),
      evidencePricedAttestationMultipliersBps: EVIDENCE_TABLE,
    };
    return computeRecordSnapshot(policy, makeRecordInput({ attestationTier: 'software' }));
  }

  it('AUTHORIZES the software→corroborated upgrade on an external-proof-priced row', () => {
    const snapshot = externalProofSnapshot();
    // The sealed class rides the snapshot, so the settlement carve-out can key on it.
    expect(snapshot.recordTimeFactors.attestationPricing).toBe('external_proof_priced');
    const settled = computeSettlement(snapshot, makeSettlementContext({
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs: snapshot.recordedAtMs,
    }));
    // software 8000 → corroborated 10000: contract input lifts ×10000/8000.
    expect(BigInt(settled.contractInputPointsAtomic))
      .toBe((BigInt(snapshot.recordPointsAtomic) * 10_000n) / 8_000n);
    expect(settled.settlementTimeFactors.enhancementApplied).toBe(true);
  });

  it('RED: self-claimable software tiers cannot buy the lift', () => {
    const snapshot = externalProofSnapshot();
    for (const tier of ['software_verified'] as const) {
      expect(() => computeSettlement(snapshot, makeSettlementContext({
        verifiedAttestationTier: tier,
        verifiedAttestationObservedAtMs: snapshot.recordedAtMs,
      }))).toThrow('Verified attestation upgrade is not authorized');
    }
  });

  it('RED legacy hardware premium changes the amount; new non-App hardware tiers change neither record nor settlement pricing', () => {
    const policy=makePolicy(),ordinary=computeRecordSnapshot(policy,makeRecordInput({attestationTier:'software'}));
    for(const tier of ['hardware_full','hardware_partial','compute_tee','full_stack']){
      const record=computeRecordSnapshot(policy,makeRecordInput({attestationTier:tier}));
      expect(record.recordPointsAtomic).toBe(ordinary.recordPointsAtomic);
      const unchanged=computeSettlement(ordinary,makeSettlementContext({verifiedAttestationTier:tier,verifiedAttestationObservedAtMs:ordinary.recordedAtMs}));
      expect(unchanged.finalPvtAtomic).toBe(computeSettlement(ordinary,makeSettlementContext()).finalPvtAtomic);
    }
    // RED control uses the actual old configured factor rather than a second pricing literal.
    const oldHardwareFactor=policy.attestationMultipliersBps.hardware_full;
    expect(oldHardwareFactor).toBeGreaterThan(ordinary.recordTimeFactors.attestationMultiplierBps);

  });

  it('RED: a STANDARD-priced row is unaffected — the carve-out keys on the class, not the tier', () => {
    const standardSnap = computeRecordSnapshot(
      makePolicy({
        actions: {
          work_product: makeAction({
            allowVerifiedAttestationUpgrade: false,
            sessionLineagePolicy: 'optional',
          }),
        },
      }),
      makeRecordInput({ attestationTier: 'software' }),
    );
    expect(standardSnap.recordTimeFactors.attestationPricing).toBeUndefined();
    expect(() => computeSettlement(standardSnap, makeSettlementContext({
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs: standardSnap.recordedAtMs,
    }))).toThrow('Verified attestation upgrade is not authorized');
  });
});

describe('recomputeRecordPointsAtCorrectedLinkage — registry-hold re-price', () => {
  // A registry-held row was sealed at linkageState 'unverifiable' (1.0x). The resolver
  // re-prices a genuinely-linked one to its true live value. The recompute must equal EXACTLY
  // what computeRecordSnapshot would have produced natively at the corrected linkage.
  it('EXACTNESS: recompute(unverifiable -> beneficiary_linked) equals the NATIVE beneficiary_linked points', () => {
    const policy = makePolicy();
    const sealed = computeRecordSnapshot(policy, makeRecordInput({ linkageState: 'unverifiable' }));
    const nativeLinked = computeRecordSnapshot(
      policy,
      makeRecordInput({ linkageState: 'beneficiary_linked', beneficiaryAgentShareBps: 2_000 }),
    );
    const recomputed = recomputeRecordPointsAtCorrectedLinkage({
      snapshot: sealed,
      correctedLinkageState: 'beneficiary_linked',
      policy,
    });
    expect(recomputed.recordPointsAtomic).toBe(nativeLinked.recordPointsAtomic);
    expect(recomputed.correctedLinkageMultiplierBps).toBe(20_000);
    // beneficiary_linked is exactly 2x unverifiable here.
    expect(BigInt(recomputed.recordPointsAtomic)).toBe(2n * BigInt(sealed.recordPointsAtomic));
  });

  it('VERBATIM: recompute(unverifiable -> unlinked) equals the sealed points (1.0x)', () => {
    const policy = makePolicy();
    const sealed = computeRecordSnapshot(policy, makeRecordInput({ linkageState: 'unverifiable' }));
    const recomputed = recomputeRecordPointsAtCorrectedLinkage({
      snapshot: sealed,
      correctedLinkageState: 'unlinked',
      policy,
    });
    expect(recomputed.recordPointsAtomic).toBe(sealed.recordPointsAtomic);
  });

  it('RED CONTROL (over-mint cap): a corrected multiplier > 2x the sealed one is rejected', () => {
    // A pathological policy where beneficiary_linked is 3x unverifiable would over-mint.
    const policy = makePolicy({
      linkageMultipliersBps: {
        unlinked: 10_000, human_linked: 20_000, beneficiary_linked: 30_000, unverifiable: 10_000,
      },
    });
    const sealed = computeRecordSnapshot(policy, makeRecordInput({ linkageState: 'unverifiable' }));
    expect(() => recomputeRecordPointsAtCorrectedLinkage({
      snapshot: sealed, correctedLinkageState: 'beneficiary_linked', policy,
    })).toThrow('recompute_corrected_linkage_out_of_bounds');
  });

  it('RED CONTROL: a non-unverifiable seal cannot be re-priced', () => {
    const policy = makePolicy();
    const sealed = computeRecordSnapshot(policy, makeRecordInput({ linkageState: 'unlinked' }));
    expect(() => recomputeRecordPointsAtCorrectedLinkage({
      snapshot: sealed, correctedLinkageState: 'beneficiary_linked', policy,
    })).toThrow('recompute_requires_unverifiable_seal');
  });
});

describe('the attestation-upgrade window is the PE\'s OWN, 30 days from record time', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  test('window selection is by record time against the cut line, fail-closed to legacy on garbage', () => {
    expect(ATTESTATION_HORIZON_CUT_LINE_MS).toBe(Date.UTC(2026, 8, 9));
    expect(ATTESTATION_ENHANCEMENT_HORIZON_MS).toBe(30 * DAY);
    expect(ATTESTATION_ENHANCEMENT_WINDOW_MS).toBe(72 * HOUR);
    expect(attestationEnhancementWindowMsFor(ATTESTATION_HORIZON_CUT_LINE_MS)).toBe(ATTESTATION_ENHANCEMENT_HORIZON_MS);
    expect(attestationEnhancementWindowMsFor(ATTESTATION_HORIZON_CUT_LINE_MS - 1)).toBe(ATTESTATION_ENHANCEMENT_WINDOW_MS);
    expect(attestationEnhancementWindowMsFor(Number.NaN)).toBe(ATTESTATION_ENHANCEMENT_WINDOW_MS);
  });

  function liftAt(recordedAtMs: number, observedOffsetMs: number): boolean {
    const policy = makePolicy({
      basePointsAtomic: atomicUnits(1000n),
      attestationMultipliersBps: { software: 8_000, corroborated: 10_000 },
    });
    const snapshot = computeRecordSnapshot(policy, makeRecordInput({ recordedAtMs }));
    const settlement = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: recordedAtMs + observedOffsetMs + 1,
      verifiedAttestationTier: 'corroborated',
      verifiedAttestationObservedAtMs: recordedAtMs + observedOffsetMs,
    }));
    return settlement.settlementTimeFactors.enhancementApplied;
  }

  test('a post-cut-line PE lifts on a day-20 observation and refuses one past day 30', () => {
    const recordedAt = ATTESTATION_HORIZON_CUT_LINE_MS + 5 * DAY;
    expect(liftAt(recordedAt, 20 * DAY)).toBe(true);
    expect(liftAt(recordedAt, 30 * DAY)).toBe(true); // inclusive boundary
    // RED CONTROL: one millisecond past the horizon, late evidence is a record, not value.
    expect(liftAt(recordedAt, 30 * DAY + 1)).toBe(false);
  });

  test('a pre-cut-line PE keeps the legacy 72 h window: day 20 is refused, 72 h is admitted', () => {
    const recordedAt = ATTESTATION_HORIZON_CUT_LINE_MS - 5 * DAY;
    expect(liftAt(recordedAt, 72 * HOUR)).toBe(true);
    expect(liftAt(recordedAt, 72 * HOUR + 1)).toBe(false);
    expect(liftAt(recordedAt, 20 * DAY)).toBe(false);
  });

  test('the window is measured from RECORD time, never from settlement time', () => {
    // Same observation instant, same PE — settling later cannot change whether it lifted.
    const recordedAt = ATTESTATION_HORIZON_CUT_LINE_MS + DAY;
    const policy = makePolicy({
      basePointsAtomic: atomicUnits(1000n),
      attestationMultipliersBps: { software: 8_000, corroborated: 10_000 },
    });
    const snapshot = computeRecordSnapshot(policy, makeRecordInput({ recordedAtMs: recordedAt }));
    const observed = recordedAt + 10 * DAY;
    const early = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: observed + 1, verifiedAttestationTier: 'corroborated', verifiedAttestationObservedAtMs: observed,
    }));
    const late = computeSettlement(snapshot, makeSettlementContext({
      settlementAtMs: recordedAt + 400 * DAY, verifiedAttestationTier: 'corroborated', verifiedAttestationObservedAtMs: observed,
    }));
    expect(early.contractInputPointsAtomic).toBe(late.contractInputPointsAtomic);
    expect(late.settlementTimeFactors.enhancementApplied).toBe(true);
  });
});

describe(' money layer, PIECE 5 — the origin multipliers price exactly and fail-safe', () => {
  const policy = makePolicy();
  const priced = (independentOriginCount: number, observedComputeTokens: number) =>
    computeRecordSnapshot(policy, makeRecordInput({ independentOriginCount, observedComputeTokens }));
  const base = () => BigInt(priced(0, 0).recordPointsAtomic);

  // The ratified multipliers, exact to the wei:
  //   independence = 1.0 + 0.5*count ; volume = 1.0 + observed_tokens/100000 ; multiplicative.
  it('ARITHMETIC — 0/0 = 1.0x (unchanged base)', () => {
    expect(priced(0, 0).recordPointsAtomic).toBe(base().toString());
  });
  it('ARITHMETIC — 4 independent origins = exactly 3.0x (1 + 0.5*4)', () => {
    expect(BigInt(priced(4, 0).recordPointsAtomic)).toBe(base() * 3n);
  });
  it('ARITHMETIC — 50000 tokens have no price effect', () => {
    expect(BigInt(priced(0, 50_000).recordPointsAtomic)).toBe(base());
  });
  it('ARITHMETIC — 4 origins + 50k tokens = exactly 3x, independence only', () => {
    expect(BigInt(priced(4, 50_000).recordPointsAtomic)).toBe(base() * 3n);
  });
  it('ARITHMETIC — 1 origin = 1.5x, 2 = 2.0x (uncapped, linear in count)', () => {
    expect(BigInt(priced(1, 0).recordPointsAtomic)).toBe(base() * 3n / 2n);
    expect(BigInt(priced(2, 0).recordPointsAtomic)).toBe(base() * 2n);
  });
  it('ARITHMETIC — large volume changes no price', () => {
    expect(BigInt(priced(0, 1_000_000).recordPointsAtomic)).toBe(base());
  });

  it('a v3 seal carries schemaVersion v3 and reconciles at settlement with the multiplied points', () => {
    const s = priced(4, 50_000);
    expect(s.schemaVersion).toBe(MONETARY_ACCOUNTING_SCHEMA_VERSION);
    // computeSettlement runs validateSnapshot (the byte-exact mirror) — it MUST reconcile.
    const settled = computeSettlement(s, makeSettlementContext());
    const zeroSettled = computeSettlement(priced(0, 0), makeSettlementContext());
    // eligible at 1.0x mint rate: the settled value carries the 4.5x through to mint.
    expect(BigInt(settled.finalPvtAtomic)).toBe(BigInt(zeroSettled.finalPvtAtomic) * 3n);
  });

  it('FORWARD ONLY: a historical v2 seal keeps its token multiplier and sealed amount; RED treating it as v3 is refused', () => {
    const current = priced(4, 50_000);
    const numerator = BigInt(current.recordCalculation.numerator) * 150_000n;
    const denominator = BigInt(current.recordCalculation.denominator) * 100_000n;
    const historical = { ...current, schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION_V2,
      recordTimeFactors: { ...current.recordTimeFactors, observedComputeTokens: 50_000 },
      recordPointsAtomic: atomicUnits(numerator / denominator),
      recordCalculation: { numerator: unsignedInteger(numerator), denominator: unsignedInteger(denominator), floorRemainder: unsignedInteger(numerator % denominator) } };
    const before = JSON.stringify(historical);
    expect(BigInt(computeSettlement(historical, makeSettlementContext()).finalPvtAtomic)).toBe(BigInt(computeSettlement(current, makeSettlementContext()).finalPvtAtomic) * 3n / 2n);
    expect(JSON.stringify(historical)).toBe(before);
    expect(() => computeSettlement({ ...historical, schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION }, makeSettlementContext())).toThrow();
  });

  // BACKWARD COMPAT (money-safety): a v1 (pieces-1-4) snapshot that carries a NON-ZERO origin count
  // was sealed UNMULTIPLIED, and the v2 fold must NEVER reprice it — it re-derives under v1 and pays base.
  it('RED — a v1 snapshot with count>0 is re-derived UNMULTIPLIED and never repriced', () => {
    const v2base = priced(0, 0); // v2 at 0/0: recordPointsAtomic == base; recordCalculation is v2-scaled
    const v1Num = BigInt(v2base.recordCalculation.numerator) / 10_000n;
    const v1Den = BigInt(v2base.recordCalculation.denominator) / 10_000n;
    const v1WithCount = {
      ...v2base,
      schemaVersion: MONETARY_ACCOUNTING_SCHEMA_VERSION_V1,
      recordCalculation: {
        numerator: v1Num.toString(),
        denominator: v1Den.toString(),
        floorRemainder: (v1Num % v1Den).toString(),
      } as typeof v2base.recordCalculation,
      recordTimeFactors: {
        ...v2base.recordTimeFactors,
        independentOriginCount: 2,       // a real pieces-1-4 seal (like the live-proof BOUND PE)
        observedComputeTokens: 50_000,
      },
    };
    // validateSnapshot reconciles it under the v1 formula (ignores the count) and settles at BASE.
    const settled = computeSettlement(v1WithCount, makeSettlementContext());
    const zeroSettled = computeSettlement(priced(0, 0), makeSettlementContext());
    expect(BigInt(settled.finalPvtAtomic)).toBe(BigInt(zeroSettled.finalPvtAtomic)); // NOT 2x/1.5x
  });

  // CARVE-OUT SURVIVAL: an operationally-suppressed / record_only row mints 0 whatever the count —
  // the multipliers never resurrect a suppressed row (agent_work_delegated=0, demoted takeover=0).
  it('RED — a suppressRecordPoints override stays 0 even with 4 origins + 50k tokens', () => {
    const s = computeRecordSnapshot(policy, makeRecordInput({
      independentOriginCount: 4,
      observedComputeTokens: 50_000,
      operationalDispositionOverride: {
        mintDisposition: 'record_only',
        mintReasonCode: 'policy_record_only',
        suppressRecordPoints: true,
      },
    }));
    expect(s.recordPointsAtomic).toBe('0');
    expect(s.recordTimeFactors.independentOriginCount).toBe(4); // still SEALED for audit
  });
  it('RED — an exact-duplicate row is 0 even with origins (mint-once survives the multiplier)', () => {
    const s = computeRecordSnapshot(policy, makeRecordInput({
      exactDuplicate: true, independentOriginCount: 4, observedComputeTokens: 50_000,
    }));
    expect(s.recordPointsAtomic).toBe('0');
  });

  // Fixed grants (Genesis) are exact amounts and carry no compute origins — never multiplied.
  it('a Genesis fixed grant is NOT multiplied by origin count (exact 75 grant preserved)', () => {
    const genesisReservation = makeGenesisReservationReceipt();
    const genesisPolicy = makePolicy({
      effectiveAtMs: genesisReservation.reserved_at_ms,
      actions: {
        genesis_signup: makeAction({
          category: 'genesis_campaign', baseWeightBps: 0, allowVerifiedAttestationUpgrade: false,
          evidenceRequirement: 'valid_genesis_reservation', canonicalEventRequired: true,
          canonicalEventGroup: 'genesis_campaign_reservation:genesis_signup',
          beneficialOwnershipPolicy: 'not_applicable', sessionLineagePolicy: 'not_applicable',
          financialAttestationNeutral: true, fixedGrantSource: 'genesis_campaign_reservation',
          evidenceResolutionMode: 'linked_evidence_pe_only',
        }),
      },
    });
    const boundInput = makeRecordInput({
      peId: genesisReservation.pe_id, economicActorId: genesisReservation.economic_actor_id,
      actionType: 'genesis_signup', recordedAtMs: genesisReservation.reserved_at_ms,
      canonicalEventId: genesisReservation.reservation_id, sessionLineageId: null,
      genesisReservation,
      // even with a full origin set, the fixed grant is exact — the multipliers must not touch it
      independentOriginCount: 4, observedComputeTokens: 50_000,
    });
    expect(computeRecordSnapshot(genesisPolicy, boundInput).recordPointsAtomic)
      .toBe('75000000000000000000');
  });

  it('RED — a fractional/negative/NaN count floors to 0 in the kernel (no fractional multiplier)', () => {
    const bad = computeRecordSnapshot(policy, makeRecordInput({
      independentOriginCount: 2.5 as number, observedComputeTokens: -100 as number,
    }));
    expect(bad.recordPointsAtomic).toBe(base().toString()); // == 1.0x, not 2.25x
    expect(bad.recordTimeFactors.independentOriginCount).toBe(0);
  });

  it('seals the two scalars + per-origin detail; distinct counts commit to distinct hashes', () => {
    const s = computeRecordSnapshot(policy, makeRecordInput({
      independentOriginCount: 4, observedComputeTokens: 50_000,
      originReferences: [
        { origin_identifier: 'evm:0xabc', hash: 'sha256:h1', owner: 'evm:0xabc', witnessed: true, counted: true, reason: null },
      ],
    }));
    expect(s.recordTimeFactors.independentOriginCount).toBe(4);
    expect(s.recordTimeFactors.observedComputeTokens).toBeUndefined();
    expect(s.recordTimeFactors.originReferences).toHaveLength(1);
    expect(hashRecordEconomicSnapshot(priced(4, 0))).not.toBe(hashRecordEconomicSnapshot(priced(7, 0)));
  });
});
