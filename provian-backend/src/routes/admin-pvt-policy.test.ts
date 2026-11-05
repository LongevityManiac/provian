import express from 'express';
import request from 'supertest';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../core/pvt/__test-helpers__/fake-firestore';
import { observePendingPolicyAction } from '../core/pvt/policy/pending-policy-queue';
import { createAdminPVTPolicyRouter } from './admin-pvt-policy';

function setup(now = 2_000): {
  app: express.Express;
  db: Firestore;
  fake: ReturnType<typeof createFakeFirestore>;
} {
  const fake = createFakeFirestore();
  const db = fake as unknown as Firestore;
  const app = express();
  app.use(express.json());
  app.use('/v1/admin/pvt/policy', createAdminPVTPolicyRouter({ db, now: () => now }));
  return { app, db, fake };
}

async function seed(db: Firestore, actionType = 'thirdparty:new_type'): Promise<void> {
  await observePendingPolicyAction(db, {
    actionType,
    peId: 'pe_1',
    integrationSource: 'sdk',
    now: 1_000,
  }, async () => ({ delivered: true }));
}

describe('admin PVT policy operator API', () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = 'test-admin-secret';
    delete process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
    delete process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED;
    jest.restoreAllMocks();
  });

  it('requires the admin secret for queue reads', async () => {
    const { app } = setup();
    await request(app).get('/v1/admin/pvt/policy/pending').expect(401);
  });

  it('lists and details the durable pending queue while writes stay disabled', async () => {
    const { app, db } = setup();
    await seed(db);
    const list = await request(app)
      .get('/v1/admin/pvt/policy/pending?state=pending_policy')
      .set('x-admin-secret', 'test-admin-secret')
      .expect(200);
    expect(list.body.count).toBe(1);
    expect(list.body.total).toBe(1);
    expect(list.body.next_cursor).toBeNull();
    expect(list.body.classification_writes_enabled).toBe(false);
    expect(list.body.items[0]).toMatchObject({
      action_type: 'thirdparty:new_type',
      mint_disposition: 'record_only',
      policy_review_state: 'pending_policy',
    });

    const detail = await request(app)
      .get(`/v1/admin/pvt/policy/pending/${encodeURIComponent('thirdparty:new_type')}`)
      .set('x-admin-secret', 'test-admin-secret')
      .expect(200);
    expect(detail.body.item.action_type).toBe('thirdparty:new_type');
  });

  it('exposes stable cursor pagination instead of truncating after the page cap', async () => {
    const { app, db } = setup();
    await seed(db, 'page_a');
    await seed(db, 'page_b');
    await seed(db, 'page_c');
    const first = await request(app)
      .get('/v1/admin/pvt/policy/pending?limit=2')
      .set('x-admin-secret', 'test-admin-secret')
      .expect(200);
    expect(first.body.count).toBe(2);
    expect(first.body.total).toBe(3);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await request(app)
      .get(`/v1/admin/pvt/policy/pending?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      .set('x-admin-secret', 'test-admin-secret')
      .expect(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.total).toBe(3);
    expect(second.body.next_cursor).toBeNull();
    await request(app)
      .get('/v1/admin/pvt/policy/pending?cursor=invalid')
      .set('x-admin-secret', 'test-admin-secret')
      .expect(400);
  });

  it('blocks classification until the explicit post-Gate-1 activation flag is enabled', async () => {
    const { app, db } = setup();
    await seed(db);
    const response = await request(app)
      .post(`/v1/admin/pvt/policy/pending/${encodeURIComponent('thirdparty:new_type')}/classify`)
      .set('x-admin-secret', 'test-admin-secret')
      .set('x-operator-id', 'operator:test').set('x-ops-basic-user', 'operator:test')
      .send({
        effective_policy_version: 'policy-v2',
        effective_at: 3_000,
        mint_disposition: 'eligible',
        reason_code: 'VERIFIED_SUBSTANTIVE_OUTCOME',
        category: 'compute',
        base_action_weight_bps: 10_000,
        policy_override_bps: null,
        evidence_requirement: 'verified_compute_or_work',
        financial_attestation_neutral: false,
        allow_verified_attestation_upgrade: true,
        fixed_grant_source: 'none',
        canonical_event_required: true,
        canonical_event_group: 'verified_work_artifact',
        beneficial_ownership_policy: 'record_only_if_self_shared_or_churn',
        session_lineage_policy: 'required',
        linkage_treatment: 'record_time_verified_policy_multiplier',
        evidence_resolution_mode: 'projection_with_verified_evidence',
      })
      .expect(503);
    expect(response.body.code).toBe('pvt_policy_classification_writes_disabled');
  });

  it('REFUSES a mintable disposition at the classify route even with writes enabled', async () => {
    // The classify verb is a one-way decline. An eligible disposition — even
    // with the flag on and a complete, otherwise-valid body — is refused with
    // 403 and writes nothing: no action-policy row, no pe_history. The only path
    // to eligible is the signed matrix path.
    process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED = 'true';
    const { app, db, fake } = setup();
    await seed(db);
    for (const disposition of ['eligible', 'pending_evidence', 'pending_review', 'ineligible_terminal']) {
      const response = await request(app)
        .post(`/v1/admin/pvt/policy/pending/${encodeURIComponent('thirdparty:new_type')}/classify`)
        .set('x-admin-secret', 'test-admin-secret')
        .set('x-operator-id', 'operator:test').set('x-ops-basic-user', 'operator:test')
        .send({
          effective_policy_version: 'policy-v2',
          effective_at: 3_000,
          mint_disposition: disposition,
          reason_code: 'VERIFIED_SUBSTANTIVE_OUTCOME',
          category: 'compute',
          base_action_weight_bps: 10_000,
          policy_override_bps: null,
          evidence_requirement: 'verified_compute_or_work',
          financial_attestation_neutral: false,
          allow_verified_attestation_upgrade: true,
          fixed_grant_source: 'none',
          canonical_event_required: true,
          canonical_event_group: 'verified_work_artifact',
          beneficial_ownership_policy: 'record_only_if_self_shared_or_churn',
          session_lineage_policy: 'required',
          linkage_treatment: 'record_time_verified_policy_multiplier',
          evidence_resolution_mode: 'projection_with_verified_evidence',
        })
        .expect(403);
      expect(response.body.code).toBe('pvt_policy_classify_disposition_forbidden');
    }
    // Nothing mintable was written anywhere.
    expect([...fake.store.keys()].some((key) => key.startsWith('pvt_action_policies/'))).toBe(false);
    expect([...fake.store.keys()].some((key) => key.startsWith('pe_history/'))).toBe(false);
    // The queue row is untouched — still pending_policy, still record_only.
    const detail = await request(app)
      .get(`/v1/admin/pvt/policy/pending/${encodeURIComponent('thirdparty:new_type')}`)
      .set('x-admin-secret', 'test-admin-secret')
      .expect(200);
    expect(detail.body.item.policy_review_state).toBe('pending_policy');
    expect(detail.body.item.mint_disposition).toBe('record_only');
  });

  it('DECLINES a type prospectively as record_only through the enabled operator path', async () => {
    process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED = 'true';
    const { app, db, fake } = setup();
    await seed(db);
    const response = await request(app)
      .post(`/v1/admin/pvt/policy/pending/${encodeURIComponent('thirdparty:new_type')}/classify`)
      .set('x-admin-secret', 'test-admin-secret')
      .set('x-operator-id', 'operator:test').set('x-ops-basic-user', 'operator:test')
      .send({
        effective_policy_version: 'policy-v2',
        effective_at: 3_000,
        mint_disposition: 'record_only',
        reason_code: 'INSUFFICIENT_LAUNCH_JUSTIFICATION_RECORD_ONLY',
        category: 'compute',
        base_action_weight_bps: 0,
        policy_override_bps: null,
        evidence_requirement: 'none',
        financial_attestation_neutral: false,
        allow_verified_attestation_upgrade: false,
        fixed_grant_source: 'none',
        canonical_event_required: false,
        canonical_event_group: 'none',
        beneficial_ownership_policy: 'not_applicable',
        session_lineage_policy: 'not_applicable',
        linkage_treatment: 'none_record_only',
        evidence_resolution_mode: 'not_applicable',
      })
      .expect(201);
    expect(response.body.policy).toMatchObject({
      action_type: 'thirdparty:new_type',
      effective_at: 3_000,
      mint_disposition: 'record_only',
      base_action_weight_bps: 0,
      amount_independent: true,
      created_by: 'operator:test',
      prospective_only: true,
    });
    expect([...fake.store.keys()].some((key) => key.startsWith('pe_history/'))).toBe(false);
  });

  it('requires an auditable operator identity for classification writes', async () => {
    process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED = 'true';
    const { app, db } = setup();
    await seed(db);
    await request(app)
      .post(`/v1/admin/pvt/policy/pending/${encodeURIComponent('thirdparty:new_type')}/classify`)
      .set('x-admin-secret', 'test-admin-secret')
      .send({ mint_disposition: 'record_only' })
      .expect(400);
  });

  it('supports an audited record-only rejection', async () => {
    process.env.PVT_POLICY_CLASSIFICATION_WRITES_ENABLED = '1';
    const { app, db } = setup();
    await seed(db, 'duplicate_action');
    const response = await request(app)
      .post('/v1/admin/pvt/policy/pending/duplicate_action/reject')
      .set('x-admin-secret', 'test-admin-secret')
      .set('x-operator-id', 'operator:test').set('x-ops-basic-user', 'operator:test')
      .send({
        reason_code: 'duplicate_of_existing_type',
        effective_policy_version: 'policy-v2',
        effective_at: 3_000,
      })
      .expect(200);
    expect(response.body).toEqual({
      rejected: true,
      action_type: 'duplicate_action',
      mint_disposition: 'record_only',
      effective_policy_version: 'policy-v2',
      effective_at: 3_000,
    });
  });
});
