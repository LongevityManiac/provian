/**
 * Read-only Genesis continuity inventory. Firestore is queried only; the sole
 * write is a local evidence JSON artifact. Row and owner identifiers are never
 * emitted. Domain-separated commitments let an authorized independent reviewer
 * recompute each binding from source rows without exposing those identifiers.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import {
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  hashRecordEconomicSnapshot,
  type RecordEconomicSnapshot,
} from '../src/core/pvt/policy/monetary-accounting';
import { hashGenesisEvidence } from '../src/core/pvt/genesis-award-state-machine';
import { buildGenesisDedupeKey } from '../src/core/pvt/policy/genesis-policy-engine';
import { scriptDb } from './lib/script-db';

type OwnerClassification = 'controlled_test' | 'valid_non_test' | 'unclassified';

interface OwnerClassificationEntry {
  owner_commitment_sha256: string;
  classification: Exclude<OwnerClassification, 'unclassified'>;
  evidence_reference: string;
}

interface OwnerClassificationFile {
  schema_version: 'pvt-genesis-owner-classifications/v1';
  status: 'audit_only_non_gating_controlling_no_migration';
  authority_statement: string;
  entries: OwnerClassificationEntry[];
}

export interface GenesisContinuityRowInput {
  sourceKind: 'legacy_pe' | 'v2_reservation';
  rowId: string;
  peId: string | null;
  ownerId: string | null;
  walletId: string | null;
  actionType: string;
  timestamp: number;
  mintStatus: string;
  estimatedPvt: number;
  reservedPvt: number;
  reservationId: string | null;
  reservationAtomic: string | null;
  reservationValid: boolean;
  peHash: string | null;
  reservationEvidence: GenesisContinuityReservationEvidence | null;
  reservationValidationErrors: readonly string[];
}

export interface GenesisContinuityReservationEvidence {
  schemaVersion: 'pvt-genesis-reservation/v2';
  reservationDocumentId: string;
  qualificationDocumentId: string | null;
  qualificationId: string | null;
  dedupeKey: string | null;
  reservationId: string | null;
  reservationAtomic: string | null;
  state: 'reserved' | 'pe_recorded' | 'ready_for_settlement' | null;
  economicSnapshotHash: string | null;
  peHash: string | null;
  qualifyingEvidenceHash: string | null;
  walletCreatedEvidenceHash: string | null;
}

export interface SanitizedGenesisRowCommitment {
  ordinal: number;
  row_commitment_sha256: string;
  owner_commitment_sha256: string;
  row_owner_binding_sha256: string;
  source_kind: GenesisContinuityRowInput['sourceKind'];
  action_type: string;
  mint_status: string;
  estimated_pvt: number;
  reserved_pvt: number;
  valid_reservation_evidence: boolean;
  classification: OwnerClassification;
  classification_evidence_reference: string | null;
  carry_atomic: string;
  reservation_state: GenesisContinuityReservationEvidence['state'];
  reservation_evidence_commitment_sha256: string | null;
  reservation_validation_error_codes: readonly string[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function commitment(domain: string, value: unknown): string {
  return `sha256:${crypto.createHash('sha256')
    .update(`${domain}\n${canonical(value)}`)
    .digest('hex')}`;
}

export const GENESIS_CONTINUITY_ARTIFACT_COMMITMENT_DOMAIN =
  'provian/genesis-continuity-artifact/v2' as const;

export function genesisContinuityArtifactCommitment(value: unknown): string {
  return commitment(GENESIS_CONTINUITY_ARTIFACT_COMMITMENT_DOMAIN, value);
}

export function ownerCommitment(row: GenesisContinuityRowInput): string {
  return commitment('provian/genesis-owner/v1', {
    owner_id: row.ownerId,
    wallet_id: row.walletId,
  });
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalAtomic(value: unknown): string | null {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value)
    ? value
    : null;
}

function exactObjectMatch(left: unknown, right: unknown): boolean {
  try {
    return canonical(left) === canonical(right);
  } catch {
    return false;
  }
}

function reservationDocumentId(dedupeKey: string): string {
  return `reservation_${crypto.createHash('sha256').update(dedupeKey, 'utf8').digest('hex')}`;
}

export interface GenesisContinuityV2Documents {
  reservationDocumentId: string;
  reservationData: unknown;
  qualificationDocumentId: string | null;
  qualificationData: unknown;
  provenanceData: unknown;
  historyData: unknown;
}

/**
 * Parse and cross-bind the actual nested pvt-genesis-reservation/v2 shape.
 * Every mismatch stays in the row commitment and forces carry to zero.
 */
export function parseGenesisContinuityV2Row(
  documents: GenesisContinuityV2Documents,
): GenesisContinuityRowInput {
  const errors = new Set<string>();
  const fail = (condition: boolean, code: string): void => {
    if (!condition) errors.add(code);
  };
  const outer = recordValue(documents.reservationData);
  const receipt = recordValue(outer?.reservation);
  const qualification = recordValue(documents.qualificationData);
  const qualifyingEvidence = recordValue(qualification?.qualifying_act_evidence);
  const immutableAnchor = recordValue(qualification?.immutable_anchor);
  const observation = recordValue(qualification?.observation_context);
  const walletCreated = recordValue(observation?.wallet_created);
  const snapshot = recordValue(outer?.economic_snapshot);
  const snapshotFactors = recordValue(snapshot?.recordTimeFactors);
  const qualificationSnapshot = recordValue(qualification?.economic_snapshot);
  const provenance = recordValue(documents.provenanceData);
  const history = recordValue(documents.historyData);
  const historySnapshot = recordValue(history?.economic_snapshot);

  const qualificationId = stringValue(outer?.qualification_id);
  const dedupeKey = stringValue(outer?.dedupe_key);
  const reservationId = stringValue(receipt?.reservation_id);
  const reservationAtomic = canonicalAtomic(receipt?.reserved_atomic);
  const state = outer?.state === 'reserved'
    || outer?.state === 'pe_recorded'
    || outer?.state === 'ready_for_settlement'
    ? outer.state
    : null;
  const economicSnapshotHash = stringValue(outer?.economic_snapshot_hash);
  const peHash = stringValue(outer?.pe_hash);
  const ownerId = stringValue(qualification?.economic_actor_id);
  const walletId = stringValue(qualification?.wallet_id);
  const actionType = stringValue(receipt?.emitted_action_type)
    ?? stringValue(qualification?.action_type)
    ?? '(missing)';
  const peId = stringValue(receipt?.pe_id) ?? stringValue(qualification?.pe_id);
  const observedAt = finiteNumber(observation?.observed_at_ms);

  fail(outer?.schema_version === 'pvt-genesis-reservation/v2', 'reservation_schema_invalid');
  fail(receipt !== null, 'reservation_nested_receipt_missing');
  fail(state !== null, 'reservation_state_invalid');
  fail(qualification?.schema_version === 'pvt-genesis-qualification/v2', 'qualification_schema_invalid');
  fail(qualificationId !== null
    && documents.qualificationDocumentId === qualificationId
    && qualification?.qualification_id === qualificationId,
  'qualification_id_mismatch');
  fail(dedupeKey !== null && receipt?.dedupe_key === dedupeKey, 'dedupe_key_mismatch');
  if (dedupeKey !== null) {
    fail(
      documents.reservationDocumentId === reservationDocumentId(dedupeKey),
      'reservation_document_id_mismatch',
    );
  }
  fail(reservationId !== null, 'reservation_id_missing');
  fail(reservationAtomic !== null && BigInt(reservationAtomic) > 0n, 'reservation_atomic_invalid');
  fail(ownerId !== null, 'owner_missing');
  fail(walletId !== null, 'wallet_missing');
  fail(peId !== null, 'pe_id_missing');
  fail(qualifyingEvidence?.verification_status === 'verified',
    'qualifying_evidence_verification_status_invalid');
  fail(observation?.verification_status === 'verified',
    'wallet_created_verification_status_invalid');

  let recomputedQualifyingEvidenceHash: string | null = null;
  if (qualification && qualifyingEvidence && immutableAnchor) {
    try {
      recomputedQualifyingEvidenceHash = hashGenesisEvidence({
        action_type: qualification.action_type,
        evidence_id: qualifyingEvidence.evidence_id,
        wallet_id: qualification.wallet_id,
        economic_actor_id: qualification.economic_actor_id,
        anchor: {
          anchor_kind: immutableAnchor.anchor_kind,
          anchor_id: immutableAnchor.anchor_id,
        },
        qualifying_act_at_ms: qualifyingEvidence.qualifying_act_at_ms,
      });
    } catch {
      errors.add('qualifying_evidence_hash_input_malformed');
    }
  } else {
    errors.add('qualifying_evidence_hash_input_malformed');
  }
  fail(recomputedQualifyingEvidenceHash !== null
    && recomputedQualifyingEvidenceHash === qualifyingEvidence?.evidence_hash,
  'qualifying_evidence_hash_mismatch');

  let recomputedWalletCreatedEvidenceHash: string | null = null;
  if (qualification && walletCreated) {
    try {
      recomputedWalletCreatedEvidenceHash = hashGenesisEvidence({
        wallet_id: qualification.wallet_id,
        evidence_id: walletCreated.evidence_id,
        created_at_ms: walletCreated.created_at_ms,
      });
    } catch {
      errors.add('wallet_created_evidence_hash_input_malformed');
    }
  } else {
    errors.add('wallet_created_evidence_hash_input_malformed');
  }
  fail(recomputedWalletCreatedEvidenceHash !== null
    && recomputedWalletCreatedEvidenceHash === walletCreated?.evidence_hash,
  'wallet_created_evidence_hash_mismatch');

  if (qualification && receipt) {
    fail(receipt.pe_id === qualification.pe_id, 'qualification_pe_id_mismatch');
    fail(receipt.wallet_id === qualification.wallet_id, 'qualification_wallet_mismatch');
    fail(receipt.economic_actor_id === qualification.economic_actor_id,
      'qualification_economic_actor_mismatch');
    fail(receipt.emitted_action_type === qualification.action_type, 'qualification_action_mismatch');
    fail(receipt.reservation_id === qualification.reservation_id, 'qualification_reservation_id_mismatch');
    fail(receipt.reserved_atomic === qualification.reserved_atomic, 'qualification_reservation_amount_mismatch');
    fail(receipt.evidence_id === qualifyingEvidence?.evidence_id
      && receipt.evidence_hash === qualifyingEvidence?.evidence_hash,
    'qualifying_evidence_mismatch');
    fail(receipt.canonical_bounty_key === qualifyingEvidence?.canonical_bounty_key,
      'qualifying_bounty_mismatch');
    fail(qualifyingEvidence?.subject_wallet_id === qualification.wallet_id,
      'qualifying_subject_wallet_mismatch');
    fail(qualifyingEvidence?.canonical_bounty_key === qualification.action_type,
      'qualifying_action_mismatch');
    fail(receipt.immutable_anchor_kind === immutableAnchor?.anchor_kind
      && receipt.immutable_anchor_id === immutableAnchor?.anchor_id
      && qualifyingEvidence?.immutable_anchor_kind === immutableAnchor?.anchor_kind
      && qualifyingEvidence?.immutable_anchor_id === immutableAnchor?.anchor_id,
    'immutable_anchor_mismatch');
    fail(receipt.qualifying_act_at_ms === qualifyingEvidence?.qualifying_act_at_ms,
      'qualifying_timestamp_mismatch');
    fail(receipt.wallet_id === walletCreated?.wallet_id
      && receipt.wallet_created_at_ms === walletCreated?.created_at_ms
      && receipt.wallet_created_evidence_id === walletCreated?.evidence_id
      && receipt.wallet_created_evidence_hash === walletCreated?.evidence_hash
      && walletCreated?.source === 'authoritative_wallet_record',
    'wallet_created_evidence_mismatch');
    if (dedupeKey && typeof immutableAnchor?.anchor_kind === 'string'
      && typeof immutableAnchor.anchor_id === 'string'
      && typeof qualification.action_type === 'string') {
      try {
        fail(buildGenesisDedupeKey(qualification.action_type, {
          anchor_kind: immutableAnchor.anchor_kind,
          anchor_id: immutableAnchor.anchor_id,
        }) === dedupeKey, 'dedupe_key_recomputation_mismatch');
      } catch {
        errors.add('dedupe_key_recomputation_mismatch');
      }
    } else {
      errors.add('dedupe_key_recomputation_mismatch');
    }
  }

  let computedSnapshotHash: string | null = null;
  if (snapshot !== null) {
    try {
      computedSnapshotHash = hashRecordEconomicSnapshot(
        snapshot as unknown as RecordEconomicSnapshot,
      );
    } catch {
      errors.add('economic_snapshot_malformed');
    }
  } else {
    errors.add('economic_snapshot_missing');
  }
  fail(economicSnapshotHash !== null
    && computedSnapshotHash === economicSnapshotHash,
  'economic_snapshot_hash_mismatch');
  fail(qualification?.economic_snapshot_hash === economicSnapshotHash
    && exactObjectMatch(qualificationSnapshot, snapshot),
  'qualification_snapshot_mismatch');
  if (snapshot && receipt) {
    fail(snapshot.peId === receipt.pe_id, 'snapshot_pe_id_mismatch');
    fail(snapshot.economicActorId === receipt.economic_actor_id,
      'snapshot_economic_actor_mismatch');
    fail(snapshot.actionType === receipt.emitted_action_type, 'snapshot_action_mismatch');
    fail(snapshot.recordedAtMs === receipt.reserved_at_ms, 'snapshot_recorded_at_mismatch');
    fail(snapshot.mintDisposition === 'eligible', 'snapshot_not_eligible');
    fail(snapshot.recordPointsAtomic === receipt.reserved_atomic, 'snapshot_reservation_amount_mismatch');
    fail(snapshotFactors?.genesisReservationId === receipt.reservation_id,
      'snapshot_reservation_id_mismatch');
    fail(snapshotFactors?.genesisDedupeKey === receipt.dedupe_key,
      'snapshot_dedupe_key_mismatch');
    fail(snapshotFactors?.genesisPolicyManifestHash === receipt.policy_manifest_hash,
      'snapshot_policy_hash_mismatch');
    fail(snapshotFactors?.genesisCanonicalBountyKey === receipt.canonical_bounty_key,
      'snapshot_bounty_mismatch');
    fail(snapshotFactors?.genesisStateRevisionAfter === receipt.state_revision_after,
      'snapshot_state_revision_mismatch');
  }

  const validateProvenance = (): void => {
    fail(provenance !== null, 'provenance_pe_missing');
    if (provenance && qualification) {
      fail(provenance.id === qualification.pe_id, 'provenance_pe_id_mismatch');
      fail(provenance.hash === peHash, 'provenance_pe_hash_mismatch');
      fail(provenance.action_type === qualification.action_type, 'provenance_action_mismatch');
      fail(provenance.user_id === qualification.economic_actor_id, 'provenance_owner_mismatch');
      fail(provenance.wallet_id === qualification.wallet_id, 'provenance_wallet_mismatch');
    }
  };
  const validateHistory = (): void => {
    fail(history !== null, 'pe_history_missing');
    if (history && qualification) {
      fail(history.peId === qualification.pe_id, 'pe_history_id_mismatch');
      fail(history.peHash === peHash, 'pe_history_hash_mismatch');
      fail(history.userId === qualification.economic_actor_id, 'pe_history_owner_mismatch');
      fail(history.actionType === qualification.action_type, 'pe_history_action_mismatch');
      fail(history.economic_snapshot_hash === economicSnapshotHash
        && exactObjectMatch(historySnapshot, snapshot),
      'pe_history_snapshot_mismatch');
      fail(history.record_points_atomic === reservationAtomic, 'pe_history_amount_mismatch');
      fail(history.mint_disposition === 'eligible', 'pe_history_not_eligible');
    }
  };

  if (state === 'reserved') {
    fail(qualification?.status === 'reserved' || qualification?.status === 'emitting',
      'reserved_qualification_state_mismatch');
    fail(peHash === null && qualification?.pe_hash === null,
      'reserved_state_has_pe_hash');
    fail(provenance === null && history === null, 'reserved_state_has_pe_records');
  } else if (state === 'pe_recorded') {
    fail(qualification?.status === 'pe_recorded', 'pe_recorded_qualification_state_mismatch');
    fail(peHash !== null && qualification?.pe_hash === peHash, 'pe_recorded_hash_mismatch');
    validateProvenance();
    if (history !== null) validateHistory();
  } else if (state === 'ready_for_settlement') {
    fail(qualification?.status === 'complete', 'ready_qualification_state_mismatch');
    fail(peHash !== null && qualification?.pe_hash === peHash, 'ready_hash_mismatch');
    validateProvenance();
    validateHistory();
  }

  const validationErrors = Object.freeze([...errors].sort());
  const evidence: GenesisContinuityReservationEvidence = {
    schemaVersion: 'pvt-genesis-reservation/v2',
    reservationDocumentId: documents.reservationDocumentId,
    qualificationDocumentId: documents.qualificationDocumentId,
    qualificationId,
    dedupeKey,
    reservationId,
    reservationAtomic,
    state,
    economicSnapshotHash,
    peHash,
    qualifyingEvidenceHash: stringValue(qualifyingEvidence?.evidence_hash),
    walletCreatedEvidenceHash: stringValue(walletCreated?.evidence_hash),
  };
  return {
    sourceKind: 'v2_reservation',
    rowId: documents.reservationDocumentId,
    peId,
    ownerId,
    walletId,
    actionType,
    timestamp: observedAt,
    mintStatus: state ?? '(invalid)',
    estimatedPvt: finiteNumber(history?.estimatedPVT),
    reservedPvt: reservationAtomic === null ? 0 : Number(BigInt(reservationAtomic)) / 1e18,
    reservationId,
    reservationAtomic,
    reservationValid: validationErrors.length === 0,
    peHash,
    reservationEvidence: evidence,
    reservationValidationErrors: validationErrors,
  };
}

function withReservationErrors(
  row: GenesisContinuityRowInput,
  errors: readonly string[],
): GenesisContinuityRowInput {
  if (errors.length === 0) return row;
  return {
    ...row,
    reservationValid: false,
    reservationValidationErrors: Object.freeze([
      ...new Set([...row.reservationValidationErrors, ...errors]),
    ].sort()),
  };
}

/** Duplicate economic identities are ambiguous even when each row is locally
 * well-formed. Invalidate every member before any legacy representation can be
 * suppressed. */
export function invalidateDuplicateGenesisV2Rows(
  inputs: readonly GenesisContinuityRowInput[],
): GenesisContinuityRowInput[] {
  const counts = new Map<string, number>();
  for (const row of inputs) {
    if (row.sourceKind !== 'v2_reservation' || row.reservationEvidence === null) continue;
    for (const [kind, value] of [
      ['pe_id', row.peId],
      ['reservation_id', row.reservationEvidence.reservationId],
      ['dedupe_key', row.reservationEvidence.dedupeKey],
      ['qualification_id', row.reservationEvidence.qualificationId],
    ] as const) {
      if (value !== null) {
        const key = `${kind}:${value}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return inputs.map((row) => {
    if (row.sourceKind !== 'v2_reservation' || row.reservationEvidence === null) return row;
    const errors: string[] = [];
    for (const [kind, value] of [
      ['pe_id', row.peId],
      ['reservation_id', row.reservationEvidence.reservationId],
      ['dedupe_key', row.reservationEvidence.dedupeKey],
      ['qualification_id', row.reservationEvidence.qualificationId],
    ] as const) {
      if (value !== null && (counts.get(`${kind}:${value}`) ?? 0) !== 1) {
        errors.push(`duplicate_${kind}`);
      }
    }
    return withReservationErrors(row, errors);
  });
}

/**
 * Resolve the dual representation of a v2 PE (its legacy pe_history row plus
 * the richer reservation unit). The legacy row disappears only after exactly
 * one complete, globally unique v2 row has passed all nested qualification,
 * reservation, amount, snapshot, PE, owner, wallet, evidence, and copied-field
 * checks performed by parseGenesisContinuityV2Row.
 */
export function resolveGenesisContinuityCollisions(
  legacyInputs: readonly GenesisContinuityRowInput[],
  v2Inputs: readonly GenesisContinuityRowInput[],
): GenesisContinuityRowInput[] {
  const normalizedV2 = invalidateDuplicateGenesisV2Rows(v2Inputs);
  const byPeId = new Map<string, GenesisContinuityRowInput[]>();
  for (const row of normalizedV2) {
    if (row.sourceKind !== 'v2_reservation' || row.peId === null) continue;
    const group = byPeId.get(row.peId) ?? [];
    group.push(row);
    byPeId.set(row.peId, group);
  }

  const retainedLegacy: GenesisContinuityRowInput[] = [];
  const collisionErrors = new Map<GenesisContinuityRowInput, string[]>();
  for (const legacy of legacyInputs) {
    if (legacy.sourceKind !== 'legacy_pe') {
      throw new Error('genesis_continuity_collision_legacy_input_invalid');
    }
    const candidates = legacy.peId === null ? [] : (byPeId.get(legacy.peId) ?? []);
    if (candidates.length === 0) {
      retainedLegacy.push(legacy);
      continue;
    }
    if (candidates.length === 1 && candidates[0].reservationValid) {
      // The parser received this exact pe_history row as historyData and has
      // already cross-bound its id/hash/owner/action/snapshot/amount plus the
      // provenance wallet binding. It is now safe to keep only the v2 unit.
      continue;
    }
    retainedLegacy.push(legacy);
    const code = candidates.length === 1
      ? 'legacy_replacement_invalid'
      : 'legacy_replacement_ambiguous';
    for (const candidate of candidates) {
      const prior = collisionErrors.get(candidate) ?? [];
      prior.push(code);
      collisionErrors.set(candidate, prior);
    }
  }

  const markedV2 = normalizedV2.map((row) => withReservationErrors(
    row,
    collisionErrors.get(row) ?? [],
  ));
  return [...retainedLegacy, ...markedV2];
}

export function deriveGenesisContinuity(
  inputs: readonly GenesisContinuityRowInput[],
  classifications: readonly OwnerClassificationEntry[],
): {
  rows: SanitizedGenesisRowCommitment[];
  reconciliation: Record<string, unknown>;
} {
  const byOwner = new Map<string, OwnerClassificationEntry>();
  for (const entry of classifications) {
    const candidate = recordValue(entry);
    const ownerCommitmentSha256 = candidate?.owner_commitment_sha256;
    const classification = candidate?.classification;
    const evidenceReference = candidate?.evidence_reference;
    if (typeof ownerCommitmentSha256 !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(ownerCommitmentSha256)
      || (classification !== 'controlled_test' && classification !== 'valid_non_test')
      || typeof evidenceReference !== 'string'
      || !evidenceReference.trim()
      || byOwner.has(ownerCommitmentSha256)) {
      throw new Error('invalid or duplicate owner classification entry');
    }
    byOwner.set(ownerCommitmentSha256, {
      owner_commitment_sha256: ownerCommitmentSha256,
      classification,
      evidence_reference: evidenceReference,
    });
  }
  const normalizedInputs = invalidateDuplicateGenesisV2Rows(inputs);
  const rows = normalizedInputs
    .map((row) => {
      const owner = ownerCommitment(row);
      // Preserve the already-captured v1 commitment recipe for legacy rows;
      // v2 reservation units bind the complete nested evidence shape.
      const rowCommitmentPayload = row.sourceKind === 'legacy_pe'
        ? {
          rowId: row.rowId,
          ownerId: row.ownerId,
          walletId: row.walletId,
          actionType: row.actionType,
          timestamp: row.timestamp,
          mintStatus: row.mintStatus,
          estimatedPvt: row.estimatedPvt,
          reservedPvt: row.reservedPvt,
          reservationId: row.reservationId,
          reservationAtomic: row.reservationAtomic,
          reservationValid: row.reservationValid,
          peHash: row.peHash,
        }
        : row;
      const rowCommitment = commitment('provian/genesis-row/v1', rowCommitmentPayload);
      const reservationEvidenceCommitment = row.reservationEvidence === null
        ? null
        : commitment('provian/genesis-reservation-evidence/v2', row.reservationEvidence);
      const validReservationEvidence = row.sourceKind === 'v2_reservation'
        && row.reservationValid;
      const classificationEntry = byOwner.get(owner);
      const classification = classificationEntry?.classification ?? 'unclassified';
      const carryAtomic = classification === 'valid_non_test'
        && validReservationEvidence
        && row.reservationAtomic !== null
        && /^(?:0|[1-9][0-9]*)$/.test(row.reservationAtomic)
        ? row.reservationAtomic
        : '0';
      return {
        rowCommitment,
        value: {
          ordinal: 0,
          row_commitment_sha256: rowCommitment,
          owner_commitment_sha256: owner,
          row_owner_binding_sha256: commitment('provian/genesis-row-owner-binding/v1', {
            row_commitment_sha256: rowCommitment,
            owner_commitment_sha256: owner,
          }),
          source_kind: row.sourceKind,
          action_type: row.actionType,
          mint_status: row.mintStatus,
          estimated_pvt: row.estimatedPvt,
          reserved_pvt: row.reservedPvt,
          valid_reservation_evidence: validReservationEvidence,
          classification,
          classification_evidence_reference: classificationEntry?.evidence_reference ?? null,
          carry_atomic: carryAtomic,
          reservation_state: row.reservationEvidence?.state ?? null,
          reservation_evidence_commitment_sha256: reservationEvidenceCommitment,
          reservation_validation_error_codes: row.reservationValidationErrors,
        } satisfies SanitizedGenesisRowCommitment,
      };
    })
    .sort((a, b) => a.rowCommitment.localeCompare(b.rowCommitment))
    .map((entry, index) => ({ ...entry.value, ordinal: index + 1 }));

  const unclassifiedRows = rows.filter((row) => row.classification === 'unclassified').length;
  const controlledTestRows = rows.filter((row) => row.classification === 'controlled_test').length;
  const validNonTestRows = rows.filter((row) => row.classification === 'valid_non_test').length;
  const validNonTestReservations = rows.filter((row) =>
    row.classification === 'valid_non_test' && row.valid_reservation_evidence).length;
  const unresolvedValidNonTestRows = rows.filter((row) =>
    row.classification === 'valid_non_test' && !row.valid_reservation_evidence).length;
  const invalidV2Rows = rows.filter((row) =>
    row.source_kind === 'v2_reservation' && !row.valid_reservation_evidence).length;
  const unresolvedReplacementCollisions = rows.filter((row) =>
    row.source_kind === 'v2_reservation'
    && row.reservation_validation_error_codes.some((code) =>
      code === 'legacy_replacement_invalid' || code === 'legacy_replacement_ambiguous')).length;
  const carryAtomic = rows.reduce((sum, row) => sum + BigInt(row.carry_atomic), 0n);
  const derivationComplete = unclassifiedRows === 0
    && unresolvedValidNonTestRows === 0
    && invalidV2Rows === 0
    && unresolvedReplacementCollisions === 0;
  return {
    rows,
    reconciliation: {
      migration_rule:
        'zero carry by controlling policy; all legacy Genesis, PVT, and PE state is excluded as controlled test data',
      derivation_rule:
        'audit-only hypothetical sum of row-bound valid_non_test owners with independently recomputable valid reservation evidence; not a migration gate',
      row_commitment_count: rows.length,
      controlled_test_row_count: controlledTestRows,
      valid_non_test_row_count: validNonTestRows,
      unclassified_row_count: unclassifiedRows,
      evidence_proven_valid_non_test_reservations: validNonTestReservations,
      unresolved_valid_non_test_row_count: unresolvedValidNonTestRows,
      invalid_v2_row_count: invalidV2Rows,
      unresolved_replacement_collision_count: unresolvedReplacementCollisions,
      carry_forward_reservations: rows.filter((row) => BigInt(row.carry_atomic) > 0n).length,
      carry_forward_atomic: carryAtomic.toString(),
      derivation_complete: derivationComplete,
      conclusion: !derivationComplete
        ? unclassifiedRows > 0
          ? 'blocked_unclassified_owner_commitments'
          : unresolvedReplacementCollisions > 0
            ? 'blocked_unresolved_replacement_collision'
            : invalidV2Rows > 0
              ? 'blocked_invalid_v2_reservation_evidence'
              : 'blocked_invalid_non_test_reservation_evidence'
        : carryAtomic === 0n
          ? 'audit_only_zero_carry_consistent_with_controlling_no_migration_policy'
          : 'nonzero_carry_required',
      independent_review_status: 'not_applicable_non_gating_audit',
      retired_legs_rearmed: false,
    },
  };
}

function argument(name: string, argv = process.argv): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function summarizeBy(
  docs: readonly QueryDocumentSnapshot[],
  field: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const doc of docs) {
    const raw = doc.get(field);
    const key = typeof raw === 'string' && raw.length > 0 ? raw : '(missing)';
    result[key] = (result[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

async function collectionSummary(db: Firestore, name: string, amountField?: string) {
  const snapshot = await db.collection(name).get();
  const amount = amountField
    ? snapshot.docs.reduce((sum, doc) => sum + finiteNumber(doc.get(amountField)), 0)
    : null;
  return {
    collection: name,
    document_count: snapshot.size,
    amount_field: amountField ?? null,
    amount_total_pvt: amount,
  };
}

function readClassifications(filePath: string | null): {
  metadata: Omit<OwnerClassificationFile, 'entries'> | null;
  entries: OwnerClassificationEntry[];
} {
  if (!filePath) return { metadata: null, entries: [] };
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')) as OwnerClassificationFile;
  if (parsed.schema_version !== 'pvt-genesis-owner-classifications/v1'
    || parsed.status !== 'audit_only_non_gating_controlling_no_migration'
    || !parsed.authority_statement?.trim()
    || !Array.isArray(parsed.entries)) {
    throw new Error('owner classification file is invalid');
  }
  const { entries, ...metadata } = parsed;
  return { metadata, entries };
}

export async function main(argv = process.argv): Promise<void> {
  const projectId = argument('--project', argv);
  const output = argument('--output', argv);
  const classificationPath = argument('--classifications', argv);
  if (!projectId || !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)) {
    throw new Error('Pass an explicit --project PROJECT_ID');
  }
  if (!output) throw new Error('Pass --output LOCAL_JSON_PATH');

  if (getApps().length === 0) initializeApp({ credential: applicationDefault(), projectId });
  const db = scriptDb();
  const [
    configSnap,
    stateSnap,
    genesisPEs,
    legacyWallets,
    legacySources,
    legacyEpochs,
    signupClaims,
    deviceClaims,
    qualificationsV2Snap,
    reservationsV2Snap,
    walletLedgersV2,
    settlementReservationsV2,
  ] = await Promise.all([
    db.collection('pvt_config').doc('genesis_campaign').get(),
    db.collection('genesis_campaign_state').doc('global').get(),
    db.collection('pe_history').where('is_genesis_grant', '==', true).get(),
    collectionSummary(db, 'genesis_wallet_ledger', 'issued_pvt'),
    collectionSummary(db, 'genesis_source_ledger', 'issued_pvt'),
    collectionSummary(db, 'genesis_epoch_mint_ledger', 'minted_pvt'),
    collectionSummary(db, 'genesis_signup_claimed'),
    collectionSummary(db, 'genesis_device_link_claimed'),
    db.collection('genesis_qualification_outbox_v2').get(),
    db.collection('genesis_reservations_v2').get(),
    collectionSummary(db, 'genesis_wallet_ledgers_v2'),
    collectionSummary(db, 'genesis_settlement_reservations_v2'),
  ]);

  const qualificationById = new Map(
    qualificationsV2Snap.docs.map((doc) => [doc.id, doc.data()] as const),
  );
  const historyByPeId = new Map(
    genesisPEs.docs.map((doc) => [doc.id, doc.data()] as const),
  );
  const v2Documents = await Promise.all(reservationsV2Snap.docs.map(async (doc) => {
    const outer = recordValue(doc.data());
    const receipt = recordValue(outer?.reservation);
    const qualificationId = stringValue(outer?.qualification_id);
    const peId = stringValue(receipt?.pe_id);
    const peSnap = peId
      ? await db.collection('provenance_envelopes').doc(peId).get()
      : null;
    return {
      reservationDocumentId: doc.id,
      reservationData: doc.data(),
      qualificationDocumentId: qualificationId,
      qualificationData: qualificationId ? qualificationById.get(qualificationId) : null,
      provenanceData: peSnap?.exists ? peSnap.data() : null,
      historyData: peId ? historyByPeId.get(peId) ?? null : null,
    } satisfies GenesisContinuityV2Documents;
  }));
  const v2Inputs = v2Documents.map(parseGenesisContinuityV2Row);
  const legacyInputs: GenesisContinuityRowInput[] = genesisPEs.docs
    .map((doc) => ({
      sourceKind: 'legacy_pe',
      rowId: doc.id,
      peId: doc.id,
      ownerId: stringValue(doc.get('userId') ?? doc.get('user_id')),
      walletId: stringValue(doc.get('walletId') ?? doc.get('wallet_id')),
      actionType: stringValue(doc.get('actionType') ?? doc.get('action_type')) ?? '(missing)',
      timestamp: finiteNumber(doc.get('timestamp')),
      mintStatus: stringValue(doc.get('mint_status')) ?? '(missing)',
      estimatedPvt: finiteNumber(doc.get('estimatedPVT')),
      reservedPvt: finiteNumber(doc.get('genesis_reserved_pvt')),
      reservationId: stringValue(doc.get('genesis_reservation_id')),
      reservationAtomic: stringValue(doc.get('genesis_reserved_atomic')),
      reservationValid: false,
      peHash: stringValue(doc.get('pe_hash') ?? doc.get('hash')),
      reservationEvidence: null,
      reservationValidationErrors: Object.freeze(['v2_reservation_evidence_absent']),
    }));
  const rowInputs = resolveGenesisContinuityCollisions(legacyInputs, v2Inputs);
  const classifications = readClassifications(classificationPath);
  const derived = deriveGenesisContinuity(rowInputs, classifications.entries);
  const config = configSnap.data() ?? {};
  const state = stateSnap.data() ?? {};

  const artifactWithoutCommitment = {
    schema_version: 'pvt-genesis-continuity-readonly-audit/v3',
    captured_at: new Date().toISOString(),
    project_id: projectId,
    access_mode: 'read_only_firestore_queries_no_production_writes',
    status: 'audit_only_non_gating_controlling_no_migration',
      commitment_recipe: {
      canonicalization: 'recursive lexicographic JSON object keys; arrays retain order',
      row_domain: 'provian/genesis-row/v1',
      owner_domain: 'provian/genesis-owner/v1',
      binding_domain: 'provian/genesis-row-owner-binding/v1',
      v2_reservation_evidence_domain: 'provian/genesis-reservation-evidence/v2',
      identifiers_disclosed: false,
    },
    classification_record: classifications.metadata,
    legacy_runtime_configuration: {
      config_document_exists: configSnap.exists,
      enabled: config.enabled === true,
      window_start_ms: finiteNumber(config.window_start_ms),
      window_end_ms: finiteNumber(config.window_end_ms),
      configured_pool_cap_pvt: finiteNumber(config.pool_cap_pvt),
      configured_per_epoch_mint_cap_pvt: finiteNumber(config.per_epoch_mint_cap_pvt),
      configured_per_wallet_cap_pvt: finiteNumber(config.per_wallet_cap_pvt),
      state_document_exists: stateSnap.exists,
      state_pool_minted_pvt: finiteNumber(state.pool_minted_pvt),
    },
    historical_genesis_pe_inventory: {
      document_count: genesisPEs.size,
      positive_estimated_pvt_document_count: rowInputs.filter((row) => row.estimatedPvt > 0).length,
      action_types: summarizeBy(genesisPEs.docs, 'actionType'),
      mint_statuses: summarizeBy(genesisPEs.docs, 'mint_status'),
      estimated_total_pvt: rowInputs.reduce((sum, row) => sum + row.estimatedPvt, 0),
      reserved_total_pvt_field: rowInputs.reduce((sum, row) => sum + row.reservedPvt, 0),
      sanitized_row_owner_commitments: derived.rows,
    },
    legacy_ledgers_and_claims: {
      wallet_ledger: legacyWallets,
      funding_source_ledger: legacySources,
      epoch_mint_ledger: legacyEpochs,
      signup_claims: signupClaims,
      device_link_claims: deviceClaims,
    },
    undeployed_v2_state_inventory: {
      qualification_outbox: {
        collection: 'genesis_qualification_outbox_v2',
        document_count: qualificationsV2Snap.size,
        amount_field: null,
        amount_total_pvt: null,
      },
      reservations: {
        collection: 'genesis_reservations_v2',
        document_count: reservationsV2Snap.size,
        amount_field: 'reservation.reserved_atomic',
        amount_total_pvt: v2Inputs.reduce((sum, row) => sum + row.reservedPvt, 0),
        schema_valid_document_count: v2Inputs.filter((row) => row.reservationValid).length,
        state_counts: Object.fromEntries(
          ['reserved', 'pe_recorded', 'ready_for_settlement'].map((state) => [
            state,
            v2Inputs.filter((row) => row.reservationEvidence?.state === state).length,
          ]),
        ),
      },
      wallet_ledgers: walletLedgersV2,
      settlement_reservations: settlementReservationsV2,
    },
    reconciliation_result: derived.reconciliation,
  };
  const artifact = {
    ...artifactWithoutCommitment,
    sanitized_inventory_sha256: genesisContinuityArtifactCommitment(
      artifactWithoutCommitment,
    ),
  };
  const outputPath = path.resolve(output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    genesis_pe_count: genesisPEs.size,
    reconciliation: derived.reconciliation,
    sanitized_inventory_sha256: artifact.sanitized_inventory_sha256,
  }, null, 2)}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
