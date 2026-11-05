/**
 * Unknown action types record without minting, queue only from a witnessed
 * class, and earn only from a signed named row. The monetary template, matrix
 * declaration and runtime must all express the same behavior.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import { resolveActionPolicyAtRecordTime } from './action-policy-gate';
import { ACTION_POLICY_COLLECTION, actionPolicyDocumentId } from './pending-policy-queue';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import { PROPOSED_ACTION_POLICY_MANIFEST } from './proposed-action-policy';
import { classAdmittedAction, materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import { WITNESS_CLASSES, WITNESSED_CLASSES } from './evidence-class';
import { shouldObservePendingPolicy } from './new-type-intake';

const NEVER_SEEN = 'binding_probe_never_seen_type';
const declaration = PROPOSED_MONETARY_POLICY_TEMPLATE.unknownActionAdmission;

describe('unknown-action admission: signed declaration == matrix == runtime', () => {
  it('the signed template carries the manifest declaration itself (one source)', () => {
    expect(declaration).toBe(PROPOSED_ACTION_POLICY_MANIFEST.unknown_action_policy);
    expect(declaration.admission).toBe('record_only_until_signed_row');
  });

  it('the generated matrix artifact declares exactly the same object', () => {
    const matrix = JSON.parse(fs.readFileSync(path.resolve(
      __dirname, '../../../../../docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json'), 'utf8'));
    expect(matrix.unknown_action_admission).toEqual(declaration);
  });

  it('runtime records a never-seen type as declared, at every witness class', () => {
    const policy = materializeProposedMonetaryPolicy(1);
    expect(WITNESS_CLASSES.length).toBeGreaterThan(0); // never a pass over zero classes
    for (const witnessClass of WITNESS_CLASSES) {
      const row = classAdmittedAction(policy, NEVER_SEEN, witnessClass);
      expect(row).not.toBeNull();
      expect(row!.mintDisposition).toBe(declaration.mint_disposition);
      expect(row!.baseWeightBps).toBe(0);
      expect(row!.policyReviewState).toBe(declaration.policy_review_state);
      expect(row!.policyReviewReasonCode).toBe(declaration.reason_code);
    }
  });

  it('runtime queues only from a witnessed class, as declared', () => {
    expect(declaration.queued_from).toBe('witnessed_class_only');
    expect(WITNESSED_CLASSES.size).toBeGreaterThan(0); // never a pass over zero witnessed classes
    expect(WITNESSED_CLASSES.size).toBeLessThan(WITNESS_CLASSES.length); // and one class does not queue
    for (const witnessClass of WITNESS_CLASSES) {
      expect(shouldObservePendingPolicy('class_admitted', witnessClass)).toBe(WITNESSED_CLASSES.has(witnessClass));
    }
    expect(shouldObservePendingPolicy('class_admitted', 'actor_declared')).toBe(false);
  });

  it('the record-time gate resolves a never-seen type exactly as declared', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    const fallback = declaration.without_witness_class_or_readable_pointer;
    const expectFallback = (r: Awaited<ReturnType<typeof resolveActionPolicyAtRecordTime>>) => {
      expect(r.status).toBe('pending_policy');
      expect(r.mintDisposition).toBe(fallback.mint_disposition);
      expect(r.policyReviewState).toBe(fallback.policy_review_state);
      expect(r.reasonCode).toBe(fallback.reason_code);
    };
    // With a relay-assigned witness class: admitted for recording, as declared.
    for (const witnessClass of WITNESS_CLASSES) {
      const r = await resolveActionPolicyAtRecordTime(db, { actionType: NEVER_SEEN, recordedAtMs: 2_000, witnessClass });
      expect(r.status).toBe('class_admitted');
      expect(r.policyReviewState).toBe(declaration.policy_review_state);
      expect(r.reasonCode).toBe(declaration.reason_code);
    }
    // Without a witness class: the declared fallback.
    expectFallback(await resolveActionPolicyAtRecordTime(db, { actionType: NEVER_SEEN, recordedAtMs: 2_000 }));
    // An unreadable (invalid) pointer, even with a witness class: the declared fallback.
    fake.store.set(`${ACTION_POLICY_COLLECTION}/${actionPolicyDocumentId(NEVER_SEEN)}`, { action_type: NEVER_SEEN });
    expectFallback(await resolveActionPolicyAtRecordTime(db, {
      actionType: NEVER_SEEN, recordedAtMs: 2_000, witnessClass: 'hardware_rooted',
    }));
  });

  it('earns only from a signed row: an unsigned minting pointer never prices a never-seen type', async () => {
    expect(declaration.earns_from).toBe('signed_row_effective_at');
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;
    // A well-formed eligible pointer, as an operator write would leave it — carrying no signature.
    fake.store.set(`${ACTION_POLICY_COLLECTION}/${actionPolicyDocumentId(NEVER_SEEN)}`, {
      action_type: NEVER_SEEN, policy_review_state: 'classified_prospective',
      effective_policy_version: 'unsigned', effective_at: 1_000, mint_disposition: 'eligible',
      disposition_reason_code: 'VERIFIED_SUBSTANTIVE_OUTCOME', category: 'compute',
      base_action_weight_bps: 10_000, policy_override_bps: null,
      evidence_requirement: 'verified_compute_or_work', financial_attestation_neutral: false,
      allow_verified_attestation_upgrade: true, amount_independent: true, fixed_grant_source: 'none',
      canonical_event_required: true, canonical_event_group: 'verified_work_artifact',
      beneficial_ownership_policy: 'record_only_if_self_shared_or_churn', session_lineage_policy: 'required',
      linkage_treatment: 'record_time_verified_policy_multiplier',
      evidence_resolution_mode: 'projection_with_verified_evidence', created_at: 500,
      created_by: 'operator:test', prospective_only: true,
    });
    for (const witnessClass of WITNESS_CLASSES) {
      const r = await resolveActionPolicyAtRecordTime(db, { actionType: NEVER_SEEN, recordedAtMs: 2_000, witnessClass });
      expect(r.mintDisposition).toBe('record_only');
      expect(r.status).toBe('pending_policy');
    }
  });

  it('RED control: the superseded declaration does not describe runtime', () => {
    // `evidence_class_base` admitted a witnessed never-seen type at its class base (eligible,
    // weight > 0). Runtime must disagree with it at every witnessed class.
    const policy = materializeProposedMonetaryPolicy(1);
    for (const witnessClass of WITNESSED_CLASSES) {
      const row = classAdmittedAction(policy, NEVER_SEEN, witnessClass)!;
      const superseded = { mint_disposition: 'eligible', base_bps: policy.evidenceClassBasesBps?.[witnessClass] };
      expect(row.mintDisposition).not.toBe(superseded.mint_disposition);
      expect(superseded.base_bps).toBeGreaterThan(0);
      expect(row.baseWeightBps).not.toBe(superseded.base_bps);
    }
  });
});
