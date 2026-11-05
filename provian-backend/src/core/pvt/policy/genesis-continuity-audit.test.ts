import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  GENESIS_CONTINUITY_ARTIFACT_COMMITMENT_DOMAIN,
  deriveGenesisContinuity,
  genesisContinuityArtifactCommitment,
  ownerCommitment,
  parseGenesisContinuityV2Row,
  resolveGenesisContinuityCollisions,
  type GenesisContinuityV2Documents,
  type GenesisContinuityRowInput,
} from '../../../../scripts/audit-genesis-continuity';
import {
  installArmedGenesisPolicyForTest,
  restoreCheckedInGenesisPolicyAfterTest,
} from '../__test-helpers__/armed-genesis-policy';
import { buildGenesisQualification } from '../genesis-award-state-machine';
import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisCampaignActivation,
} from './genesis-policy-engine';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
} from './monetary-accounting';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY } from './proposed-genesis-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './pvt9-approval-manifest.generated';
import {
  hashProposedMonetaryPolicyTemplate,
  materializeProposedMonetaryPolicy,
} from './runtime-monetary-policy';

const TEST_GENESIS_CAMPAIGN_POLICY = installArmedGenesisPolicyForTest();
afterAll(restoreCheckedInGenesisPolicyAfterTest);

function row(overrides: Partial<GenesisContinuityRowInput> = {}): GenesisContinuityRowInput {
  return {
    sourceKind: 'legacy_pe',
    rowId: 'pe_1',
    peId: 'pe_1',
    ownerId: 'owner_1',
    walletId: 'wallet_1',
    actionType: 'genesis_human_signup',
    timestamp: 1,
    mintStatus: 'eligible',
    estimatedPvt: 75,
    reservedPvt: 75,
    reservationId: null,
    reservationAtomic: null,
    reservationValid: false,
    peHash: 'hash_1',
    reservationEvidence: null,
    reservationValidationErrors: ['v2_reservation_evidence_absent'],
    ...overrides,
  };
}

function validV2Fixture(
  state: 'reserved' | 'pe_recorded' | 'ready_for_settlement' = 'ready_for_settlement',
): GenesisContinuityV2Documents {
  const observedAt = TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms + 1_000;
  const qualificationBase = buildGenesisQualification({
    actionType: 'genesis_human_signup',
    walletId: 'wallet_continuity_v2',
    economicActorId: 'owner_continuity_v2',
    actorAddress: '0x1111111111111111111111111111111111111111',
    immutableAnchorId: 'wallet_continuity_v2',
    qualifyingActEvidenceId: 'human-wallet:wallet_continuity_v2',
    qualifyingActAtMs: observedAt,
    walletCreatedAtMs: observedAt,
    walletCreatedEvidenceId: 'human-wallet:wallet_continuity_v2',
  });
  const activation: GenesisCampaignActivation = {
    approval_status: 'approved_by_frank',
    approval_manifest_sha256: PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256,
    approval_signature: {
      scheme: 'sshsig-ed25519',
      signer_identity: 'frank',
      namespace: 'provian-pvt-policy',
      public_key_sha256: `sha256:${'e'.repeat(64)}`,
      armored_signature: 'test-only-structured-signature',
    },
    frank_approval_audit_id: 'continuity-fixture-approval',
    approved_policy_version: PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version,
    approved_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
    ),
    approved_monetary_policy_template_hash: hashProposedMonetaryPolicyTemplate(),
    effective_at_ms: TEST_GENESIS_CAMPAIGN_POLICY.window.start_ms,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
    grants_enabled: true,
    genesis_kill_switch_active: false,
    canonical_pvt_manifest_id: 'continuity-fixture-manifest',
    ledger_namespace: 'continuity-fixture-ledger',
    prior_reservations_reconciled: true,
    operator_activation_audit_id: 'continuity-fixture-operator',
  };
  const reservationResult = reserveGenesisCampaignGrant({
    manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
    activation,
    state: createEmptyGenesisLedgerState(activation.ledger_namespace!),
    input: {
      pe_id: qualificationBase.pe_id,
      action_type: qualificationBase.action_type,
      wallet_id: qualificationBase.wallet_id,
      economic_actor_id: qualificationBase.economic_actor_id,
      immutable_anchor: qualificationBase.immutable_anchor,
      qualifying_act_evidence: qualificationBase.qualifying_act_evidence,
    },
    observation_context: qualificationBase.observation_context,
    activation_approval_verifier: () => true,
  });
  if (!reservationResult.allowed) throw new Error(reservationResult.reason);
  const reservation = reservationResult.reservation;
  const policy = materializeProposedMonetaryPolicy(activation.effective_at_ms!);
  const snapshot = computeRecordSnapshot(policy, {
    peId: qualificationBase.pe_id,
    economicActorId: qualificationBase.economic_actor_id,
    actionType: qualificationBase.action_type,
    recordedAtMs: reservation.reserved_at_ms,
    occurrenceOrdinal: 1,
    dailyOrdinal: 1,
    exactDuplicate: false,
    uniqueArtifact: false,
    attestationTier: 'software',
    linkageState: 'unlinked',
    evidenceState: 'verified',
    canonicalEventId: reservation.reservation_id,
    selfReferencing: false,
    sharedBeneficialOwnership: false,
    pairChurnDetected: false,
    sessionLineageId: null,
    genesisReservation: reservation,
    beneficiaryAgentShareBps: 10_000,
    operationalDispositionOverride: null,
  });
  const snapshotHash = hashRecordEconomicSnapshot(snapshot);
  const peHash = 'a'.repeat(64);
  const qualificationStatus = state === 'reserved'
    ? 'reserved'
    : state === 'pe_recorded'
      ? 'pe_recorded'
      : 'complete';
  const persistedPeHash = state === 'reserved' ? null : peHash;
  const qualification = {
    ...qualificationBase,
    status: qualificationStatus,
    reservation_id: reservation.reservation_id,
    reserved_atomic: reservation.reserved_atomic,
    economic_snapshot: snapshot,
    economic_snapshot_hash: snapshotHash,
    pe_hash: persistedPeHash,
  };
  const dedupeKey = reservation.dedupe_key;
  const reservationDocumentId = `reservation_${crypto.createHash('sha256')
    .update(dedupeKey, 'utf8').digest('hex')}`;
  const provenanceData = state === 'reserved' ? null : {
    id: qualification.pe_id,
    wallet_id: qualification.wallet_id,
    user_id: qualification.economic_actor_id,
    action_type: qualification.action_type,
    hash: peHash,
  };
  const historyData = state !== 'ready_for_settlement' ? null : {
    peId: qualification.pe_id,
    peHash,
    userId: qualification.economic_actor_id,
    actionType: qualification.action_type,
    estimatedPVT: Number(BigInt(reservation.reserved_atomic)) / 1e18,
    economic_snapshot: snapshot,
    economic_snapshot_hash: snapshotHash,
    record_points_atomic: reservation.reserved_atomic,
    mint_disposition: 'eligible',
  };
  return {
    reservationDocumentId,
    reservationData: {
      schema_version: 'pvt-genesis-reservation/v2',
      qualification_id: qualification.qualification_id,
      dedupe_key: dedupeKey,
      reservation,
      economic_snapshot: snapshot,
      economic_snapshot_hash: snapshotHash,
      state,
      pe_hash: persistedPeHash,
      created_at_ms: observedAt,
      updated_at_ms: observedAt,
    },
    qualificationDocumentId: qualification.qualification_id,
    qualificationData: qualification,
    provenanceData,
    historyData,
  };
}

function mutateFixture(
  fixture: GenesisContinuityV2Documents,
  mutate: (copy: Record<string, unknown>) => void,
): GenesisContinuityV2Documents {
  const copy = JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
  mutate(copy);
  return copy as unknown as GenesisContinuityV2Documents;
}

function legacyRepresentationFor(fixture: GenesisContinuityV2Documents): GenesisContinuityRowInput {
  const parsed = parseGenesisContinuityV2Row(validV2Fixture());
  const qualification = fixture.qualificationData as Record<string, unknown>;
  const history = fixture.historyData as Record<string, unknown>;
  return row({
    rowId: parsed.peId!,
    peId: parsed.peId,
    ownerId: history.userId as string,
    walletId: qualification.wallet_id as string,
    actionType: history.actionType as string,
    estimatedPvt: history.estimatedPVT as number,
    reservedPvt: history.estimatedPVT as number,
    reservationId: parsed.reservationId,
    reservationAtomic: parsed.reservationAtomic,
    peHash: history.peHash as string,
  });
}

describe('sanitized Genesis row/owner continuity derivation', () => {

  it('binds every row to an owner commitment without disclosing either identifier', () => {
    const input = row();
    const result = deriveGenesisContinuity([input], []);
    expect(JSON.stringify(result.rows[0])).not.toContain(input.rowId);
    expect(JSON.stringify(result.rows[0])).not.toContain(input.ownerId);
    expect(result.rows[0]).toMatchObject({
      row_commitment_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      owner_commitment_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      row_owner_binding_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it('changes commitments when either the row or owner binding mutates', () => {
    const base = deriveGenesisContinuity([row()], []).rows[0];
    const changedRow = deriveGenesisContinuity([row({ estimatedPvt: 74 })], []).rows[0];
    const changedOwner = deriveGenesisContinuity([row({ ownerId: 'owner_2' })], []).rows[0];
    expect(changedRow.row_commitment_sha256).not.toBe(base.row_commitment_sha256);
    expect(changedOwner.owner_commitment_sha256).not.toBe(base.owner_commitment_sha256);
    expect(changedOwner.row_owner_binding_sha256).not.toBe(base.row_owner_binding_sha256);
  });

  it('marks the audit derivation incomplete when a row-owner commitment is unclassified', () => {
    const derived = deriveGenesisContinuity([row()], []);
    expect(derived.reconciliation).toMatchObject({
      unclassified_row_count: 1,
      derivation_complete: false,
      conclusion: 'blocked_unclassified_owner_commitments',
    });
  });

  it('derives audit-only zero from exact controlled-test commitment entries', () => {
    const input = row();
    const derived = deriveGenesisContinuity([input], [{
      owner_commitment_sha256: ownerCommitment(input),
      classification: 'controlled_test',
      evidence_reference: 'candidate-owner-attestation:entry-1',
    }]);
    expect(derived.reconciliation).toMatchObject({
      controlled_test_row_count: 1,
      unclassified_row_count: 0,
      carry_forward_atomic: '0',
      conclusion: 'audit_only_zero_carry_consistent_with_controlling_no_migration_policy',
      independent_review_status: 'not_applicable_non_gating_audit',
    });
  });

  it('rejects an unknown owner-classification enum at runtime', () => {
    const input = row();
    expect(() => deriveGenesisContinuity([input], [{
      owner_commitment_sha256: ownerCommitment(input),
      classification: 'controlled_typo',
      evidence_reference: 'candidate-owner-attestation:entry-1',
    } as never])).toThrow('invalid or duplicate owner classification entry');
  });

  it('does not let a legacy boolean claim substitute for nested v2 reservation evidence', () => {
    const input = row({ reservationAtomic: '75000000000000000000', reservationValid: true });
    const derived = deriveGenesisContinuity([input], [{
      owner_commitment_sha256: ownerCommitment(input),
      classification: 'valid_non_test',
      evidence_reference: 'independent-review:entry-1',
    }]);
    expect(derived.reconciliation).toMatchObject({
      carry_forward_reservations: 0,
      carry_forward_atomic: '0',
      derivation_complete: false,
      conclusion: 'blocked_invalid_non_test_reservation_evidence',
    });
  });

  it.each(['reserved', 'pe_recorded', 'ready_for_settlement'] as const)(
    'parses and binds a valid_non_test nested v2 %s reservation whose exact atomic amount contributes to carry',
    (state) => {
      const input = parseGenesisContinuityV2Row(validV2Fixture(state));
      expect(input.reservationValid).toBe(true);
      expect(input.reservationValidationErrors).toEqual([]);
      expect(input.reservationAtomic).toBe('75000000000000000000');
      const derived = deriveGenesisContinuity([input], [{
        owner_commitment_sha256: ownerCommitment(input),
        classification: 'valid_non_test',
        evidence_reference: `independent-v2-fixture:${state}`,
      }]);
      expect(derived.rows[0]).toMatchObject({
        source_kind: 'v2_reservation',
        reservation_state: state,
        valid_reservation_evidence: true,
        carry_atomic: '75000000000000000000',
        reservation_evidence_commitment_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      });
      expect(derived.reconciliation).toMatchObject({
        evidence_proven_valid_non_test_reservations: 1,
        carry_forward_reservations: 1,
        carry_forward_atomic: '75000000000000000000',
        conclusion: 'nonzero_carry_required',
      });
    },
  );

  it.each([
    ['malformed schema', (copy: Record<string, unknown>) => {
      ((copy.reservationData as Record<string, unknown>).schema_version) = 'wrong';
    }],
    ['nested amount mutation', (copy: Record<string, unknown>) => {
      const outer = copy.reservationData as Record<string, unknown>;
      (outer.reservation as Record<string, unknown>).reserved_atomic = '74000000000000000000';
    }],
    ['state mutation', (copy: Record<string, unknown>) => {
      (copy.reservationData as Record<string, unknown>).state = 'reserved';
    }],
    ['owner mutation', (copy: Record<string, unknown>) => {
      (copy.qualificationData as Record<string, unknown>).economic_actor_id = 'different-owner';
    }],
    ['wallet evidence mutation', (copy: Record<string, unknown>) => {
      const qualification = copy.qualificationData as Record<string, unknown>;
      const observation = qualification.observation_context as Record<string, unknown>;
      const wallet = observation.wallet_created as Record<string, unknown>;
      wallet.evidence_hash = `sha256:${'f'.repeat(64)}`;
    }],
    ['PE row mutation', (copy: Record<string, unknown>) => {
      (copy.historyData as Record<string, unknown>).record_points_atomic = '1';
    }],
  ] as const)(
    'rejects %s and contributes zero carry',
    (_label, mutate) => {
      const fixture = mutateFixture(validV2Fixture(), mutate);
      const input = parseGenesisContinuityV2Row(fixture);
      expect(input.reservationValid).toBe(false);
      expect(input.reservationValidationErrors.length).toBeGreaterThan(0);
      const derived = deriveGenesisContinuity([input], [{
        owner_commitment_sha256: ownerCommitment(input),
        classification: 'valid_non_test',
        evidence_reference: 'mutation-fixture',
      }]);
      expect(derived.rows[0].carry_atomic).toBe('0');
      expect(derived.reconciliation).toMatchObject({
        carry_forward_atomic: '0',
        derivation_complete: false,
        conclusion: 'blocked_invalid_v2_reservation_evidence',
      });
    },
  );

  it('requires verified qualifying-act and authoritative-wallet observation states', () => {
    const fixture = mutateFixture(validV2Fixture(), (copy) => {
      const qualification = copy.qualificationData as Record<string, unknown>;
      const evidence = qualification.qualifying_act_evidence as Record<string, unknown>;
      const observation = qualification.observation_context as Record<string, unknown>;
      evidence.verification_status = 'unverified';
      observation.verification_status = 'unverified';
    });
    const input = parseGenesisContinuityV2Row(fixture);
    expect(input.reservationValid).toBe(false);
    expect(input.reservationValidationErrors).toEqual(expect.arrayContaining([
      'qualifying_evidence_verification_status_invalid',
      'wallet_created_verification_status_invalid',
    ]));
  });

  it('rejects paired copied-hash substitutions by recomputing both evidence recipes', () => {
    const fixture = mutateFixture(validV2Fixture(), (copy) => {
      const reservation = (copy.reservationData as Record<string, unknown>)
        .reservation as Record<string, unknown>;
      const qualification = copy.qualificationData as Record<string, unknown>;
      const evidence = qualification.qualifying_act_evidence as Record<string, unknown>;
      const observation = qualification.observation_context as Record<string, unknown>;
      const wallet = observation.wallet_created as Record<string, unknown>;
      const substitutedQualifyingHash = `sha256:${'e'.repeat(64)}`;
      const substitutedWalletHash = `sha256:${'f'.repeat(64)}`;
      evidence.evidence_hash = substitutedQualifyingHash;
      reservation.evidence_hash = substitutedQualifyingHash;
      wallet.evidence_hash = substitutedWalletHash;
      reservation.wallet_created_evidence_hash = substitutedWalletHash;
    });
    const input = parseGenesisContinuityV2Row(fixture);
    expect(input.reservationValid).toBe(false);
    expect(input.reservationValidationErrors).toEqual(expect.arrayContaining([
      'qualifying_evidence_hash_mismatch',
      'wallet_created_evidence_hash_mismatch',
    ]));
  });

  it('invalidates duplicate v2 reservation/dedupe/qualification identities globally', () => {
    const first = parseGenesisContinuityV2Row(validV2Fixture());
    const second = {
      ...first,
      rowId: `${first.rowId}-duplicate`,
      reservationEvidence: {
        ...first.reservationEvidence!,
        reservationDocumentId: `${first.rowId}-duplicate`,
      },
    };
    const classification = {
      owner_commitment_sha256: ownerCommitment(first),
      classification: 'valid_non_test' as const,
      evidence_reference: 'duplicate-fixture',
    };
    const derived = deriveGenesisContinuity([first, second], [classification]);
    expect(derived.rows.every((entry) => entry.carry_atomic === '0')).toBe(true);
    expect(derived.rows.every((entry) =>
      entry.reservation_validation_error_codes.some((code) => code.startsWith('duplicate_')),
    )).toBe(true);
  });

  it('suppresses a legacy representation only after one exact valid v2 replacement parses', () => {
    const fixture = validV2Fixture();
    const legacy = legacyRepresentationFor(fixture);
    const replacement = parseGenesisContinuityV2Row(fixture);
    const resolved = resolveGenesisContinuityCollisions([legacy], [replacement]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      sourceKind: 'v2_reservation',
      peId: legacy.peId,
      reservationValid: true,
      reservationValidationErrors: [],
    });
  });

  it.each([
    ['qualification', (copy: Record<string, unknown>) => {
      (copy.qualificationData as Record<string, unknown>).schema_version = 'wrong';
    }],
    ['dedupe key', (copy: Record<string, unknown>) => {
      (copy.reservationData as Record<string, unknown>).dedupe_key = 'wrong-dedupe';
    }],
    ['reservation amount', (copy: Record<string, unknown>) => {
      const reservation = (copy.reservationData as Record<string, unknown>)
        .reservation as Record<string, unknown>;
      reservation.reserved_atomic = '1';
    }],
    ['economic snapshot/hash', (copy: Record<string, unknown>) => {
      (copy.reservationData as Record<string, unknown>).economic_snapshot_hash =
        `sha256:${'f'.repeat(64)}`;
    }],
    ['PE hash', (copy: Record<string, unknown>) => {
      (copy.provenanceData as Record<string, unknown>).hash = 'different-pe-hash';
    }],
    ['owner', (copy: Record<string, unknown>) => {
      (copy.qualificationData as Record<string, unknown>).economic_actor_id = 'wrong-owner';
    }],
    ['wallet', (copy: Record<string, unknown>) => {
      (copy.qualificationData as Record<string, unknown>).wallet_id = 'wrong-wallet';
    }],
    ['evidence', (copy: Record<string, unknown>) => {
      const qualification = copy.qualificationData as Record<string, unknown>;
      const evidence = qualification.qualifying_act_evidence as Record<string, unknown>;
      evidence.evidence_hash = `sha256:${'e'.repeat(64)}`;
    }],
    ['copied commitments', (copy: Record<string, unknown>) => {
      const reservation = (copy.reservationData as Record<string, unknown>)
        .reservation as Record<string, unknown>;
      reservation.wallet_created_evidence_hash = `sha256:${'e'.repeat(64)}`;
    }],
  ] as const)(
    'an invalid v2 %s mutation cannot shadow the genuine legacy PE or manufacture zero carry',
    (_label, mutate) => {
      const original = validV2Fixture();
      const legacy = legacyRepresentationFor(original);
      const malformed = parseGenesisContinuityV2Row(mutateFixture(original, mutate));
      const resolved = resolveGenesisContinuityCollisions([legacy], [malformed]);
      expect(resolved).toHaveLength(2);
      expect(resolved.some((entry) =>
        entry.sourceKind === 'legacy_pe' && entry.peId === legacy.peId)).toBe(true);
      const invalid = resolved.find((entry) => entry.sourceKind === 'v2_reservation')!;
      expect(invalid.reservationValid).toBe(false);
      expect(invalid.reservationValidationErrors).toContain('legacy_replacement_invalid');

      const classifications = [...new Map(resolved.map((entry) => [
        ownerCommitment(entry),
        {
          owner_commitment_sha256: ownerCommitment(entry),
          classification: 'controlled_test' as const,
          evidence_reference: 'controlled-test-cannot-hide-collision',
        },
      ])).values()];
      const derived = deriveGenesisContinuity(resolved, classifications);
      expect(derived.reconciliation).toMatchObject({
        controlled_test_row_count: 2,
        invalid_v2_row_count: 1,
        unresolved_replacement_collision_count: 1,
        carry_forward_atomic: '0',
        derivation_complete: false,
        conclusion: 'blocked_unresolved_replacement_collision',
      });
      expect(derived.reconciliation.conclusion).not.toBe(
        'audit_only_zero_carry_consistent_with_controlling_no_migration_policy',
      );
    },
  );

  it('keeps legacy evidence for duplicate/ambiguous v2 replacements', () => {
    const fixture = validV2Fixture();
    const legacy = legacyRepresentationFor(fixture);
    const replacement = parseGenesisContinuityV2Row(fixture);
    const duplicate = {
      ...replacement,
      rowId: `${replacement.rowId}-duplicate`,
      reservationEvidence: {
        ...replacement.reservationEvidence!,
        reservationDocumentId: `${replacement.rowId}-duplicate`,
      },
    };
    const resolved = resolveGenesisContinuityCollisions([legacy], [replacement, duplicate]);
    expect(resolved).toHaveLength(3);
    expect(resolved[0].sourceKind).toBe('legacy_pe');
    for (const candidate of resolved.slice(1)) {
      expect(candidate.reservationValid).toBe(false);
      expect(candidate.reservationValidationErrors).toEqual(expect.arrayContaining([
        'duplicate_pe_id',
        'legacy_replacement_ambiguous',
      ]));
    }
  });
});
