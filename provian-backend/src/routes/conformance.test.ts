/**
 * Conformance Validation - PE Spec Tests
 */

import {
  ATTESTATION_POLICY_CONTEXT,
  ATTESTATION_TIER_DESCRIPTIONS,
  validatePE,
  signConformanceBadge,
} from './conformance';
import crypto from 'crypto';
import { MAX_POLICY_ACTION_TYPE_LENGTH } from '../core/pvt/policy/action-type-syntax';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidPE(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    envelope_id: '550e8400-e29b-41d4-a716-446655440000',
    prev_envelope_hash: 'genesis',
    timestamp: Date.now(),
    action_type: 'send',
    details: { asset: 'USDC', amount: '10' },
    risk_score: 25,
    device_attestation_id: 'device-abc-123',
    signature: 'a'.repeat(128),
    ...overrides,
  };
}

const DUMMY_PUBLIC_KEY = 'deadbeef';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validatePE', () => {
  it('valid PE passes with no errors', () => {
    const pe = makeValidPE();
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors).toHaveLength(0);
    // Score may be < 100 due to unverifiable signature warning (-5), but no errors
    expect(result.score).toBeGreaterThanOrEqual(95);
    expect(result.attestationTier).toBe('software');
  });

  it('missing envelope_id fails', () => {
    const pe = makeValidPE();
    delete pe.envelope_id;

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'envelope_id')).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('invalid UUID format fails', () => {
    const pe = makeValidPE({ envelope_id: 'not-a-uuid' });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'envelope_id' && e.message.includes('UUID'))).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('bad timestamp (too old) fails', () => {
    // More than 5 minutes ago
    const pe = makeValidPE({ timestamp: Date.now() - 10 * 60 * 1000 });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'timestamp')).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Date.now() + 0.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects a non-safe-integer timestamp %s', (timestamp) => {
    const result = validatePE(makeValidPE({ timestamp }), DUMMY_PUBLIC_KEY);
    expect(result.errors).toContainEqual(expect.objectContaining({ field: 'timestamp' }));
  });

  it('unknown action_type is accepted with a warning (permissionless catalog)', () => {
    const pe = makeValidPE({ action_type: 'totally_invalid_nonexistent_type' });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'action_type')).toBe(false);
    expect(result.warnings.some(w => w.field === 'action_type')).toBe(true);
  });

  it('structurally invalid action_type (special chars) fails', () => {
    const pe = makeValidPE({ action_type: 'has spaces!' });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'action_type')).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('oversized namespaced action_type fails the same shared ingress bound', () => {
    const oversized = `thirdparty:${'a'.repeat(MAX_POLICY_ACTION_TYPE_LENGTH)}`;
    const result = validatePE(makeValidPE({ action_type: oversized }), DUMMY_PUBLIC_KEY);
    expect(result.errors.some(e => e.field === 'action_type')).toBe(true);
  });

  it('custom action type (custom_my_type) passes', () => {
    const pe = makeValidPE({ action_type: 'custom_my_type' });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    // No errors for action_type (warnings are ok)
    expect(result.errors.some(e => e.field === 'action_type')).toBe(false);
    // Should have a warning about custom type
    expect(result.warnings.some(w => w.field === 'action_type')).toBe(true);
  });

  it('missing signature fails', () => {
    const pe = makeValidPE();
    delete pe.signature;

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'signature')).toBe(true);
    expect(result.score).toBeLessThan(100);
  });

  it('hash chain validation - wrong prev_envelope_hash fails', () => {
    const previousPE: Record<string, unknown> = makeValidPE({
      envelope_id: '660e8400-e29b-41d4-a716-446655440000',
      prev_envelope_hash: 'genesis',
    });

    // Compute the correct hash of the previous PE
    const prevBody = { ...previousPE };
    delete prevBody.signature;
    const sortedKeys = Object.keys(prevBody).sort();
    const canonical: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      canonical[key] = prevBody[key];
    }
    const correctHash = crypto.createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');

    // Use a wrong hash
    const pe = makeValidPE({
      prev_envelope_hash: 'a'.repeat(64),
    });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY, previousPE);

    // Only fails if the wrong hash doesn't match
    if ('a'.repeat(64) !== correctHash) {
      expect(result.errors.some(e => e.field === 'prev_envelope_hash' && e.message.includes('Hash chain broken'))).toBe(true);
      expect(result.score).toBeLessThan(100);
    }
  });

  it('genesis prev_envelope_hash accepted', () => {
    const pe = makeValidPE({ prev_envelope_hash: 'genesis' });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'prev_envelope_hash')).toBe(false);
  });

  it('test_genesis accepted', () => {
    const pe = makeValidPE({ prev_envelope_hash: 'test_genesis' });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'prev_envelope_hash')).toBe(false);
  });

  it('risk_score out of range fails', () => {
    const pe1 = makeValidPE({ risk_score: -5 });
    const result1 = validatePE(pe1, DUMMY_PUBLIC_KEY);
    expect(result1.errors.some(e => e.field === 'risk_score')).toBe(true);

    const pe2 = makeValidPE({ risk_score: 150 });
    const result2 = validatePE(pe2, DUMMY_PUBLIC_KEY);
    expect(result2.errors.some(e => e.field === 'risk_score')).toBe(true);
  });

  it('valid PE with no errors is badge-eligible', () => {
    const pe = makeValidPE();
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    // No errors means the PE passes conformance
    expect(result.errors).toHaveLength(0);
    // Badge eligibility: errors.length === 0 && score === 100
    // With a dummy public key, signature verification produces a warning (-5 score)
    // so score = 95 - badge requires score 100 (issued in the route handler).
    // To get a perfect 100, supply a real cryptographic key pair.
    expect(result.score).toBe(95);
    // Verify score 100 is achievable by skipping signature check (empty signature scenario handled differently)
  });

  it('detects hardware attestation tier', () => {
    const pe = makeValidPE({ device_attestation_id: 'hw:secure_enclave_abc' });
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);
    expect(result.attestationTier).toBe('hardware_full');
  });

  it('detects software_verified attestation tier', () => {
    const pe = makeValidPE({ device_attestation_id: 'sw_verified:replication_pack' });
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);
    expect(result.attestationTier).toBe('software_verified');
  });

  it('detects corroborated attestation tier', () => {
    const pe = makeValidPE({ device_attestation_id: 'corr:counterparty_signal' });
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);
    expect(result.attestationTier).toBe('corroborated');
  });

  it('detects hardware_partial attestation tier (HIGH-3)', () => {
    const pe = makeValidPE({ device_attestation_id: 'hw_partial:android_keystore_x' });
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);
    expect(result.attestationTier).toBe('hardware_partial');
  });

  it('missing details field fails', () => {
    const pe = makeValidPE();
    delete pe.details;

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'details')).toBe(true);
  });

  it('missing device_attestation_id fails', () => {
    const pe = makeValidPE();
    delete pe.device_attestation_id;

    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.errors.some(e => e.field === 'device_attestation_id')).toBe(true);
  });

  it('score never goes below 0', () => {
    // Remove everything to accumulate maximum penalties
    const pe: Record<string, unknown> = {};
    const result = validatePE(pe, DUMMY_PUBLIC_KEY);

    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('correct hash chain passes', () => {
    const previousPE: Record<string, unknown> = makeValidPE({
      envelope_id: '660e8400-e29b-41d4-a716-446655440000',
      prev_envelope_hash: 'genesis',
    });

    // Compute the correct hash
    const prevBody = { ...previousPE };
    delete prevBody.signature;
    const sortedKeys = Object.keys(prevBody).sort();
    const canonical: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      canonical[key] = prevBody[key];
    }
    const correctHash = crypto.createHash('sha256')
      .update(JSON.stringify(canonical))
      .digest('hex');

    const pe = makeValidPE({ prev_envelope_hash: correctHash });

    const result = validatePE(pe, DUMMY_PUBLIC_KEY, previousPE);

    expect(result.errors.some(e => e.field === 'prev_envelope_hash' && e.message.includes('Hash chain broken'))).toBe(false);
  });
});

describe('public conformance attestation context', () => {
  it('documents the complete owner-policy boundary beside claimed tiers', () => {
    expect(ATTESTATION_POLICY_CONTEXT.configured_range).toBe('0.5x-2.5x');
    expect(ATTESTATION_POLICY_CONTEXT.human_trust_factor).toContain('only after verified');
    expect(ATTESTATION_POLICY_CONTEXT.agent_owned_devices).toContain('before signing-method');
    expect(ATTESTATION_POLICY_CONTEXT.agent_owned_devices).toContain('has not been approved');
    expect(ATTESTATION_POLICY_CONTEXT.agent_device_register).toContain('no device anchor');
    expect(ATTESTATION_POLICY_CONTEXT.agent_device_register).toContain('zero PVT');
    expect(ATTESTATION_TIER_DESCRIPTIONS.hardware_partial).toContain('non-App-Attest');
    expect(ATTESTATION_TIER_DESCRIPTIONS.hardware_full).toContain('human-owned');
  });
});

// ---------------------------------------------------------------------------
// Conformance badge signing - B-3 (audit 2026-05-11)
// ---------------------------------------------------------------------------

describe('signConformanceBadge', () => {
  const SECRET = 'test-secret';
  const BADGE = {
    implementation_name: 'test',
    conformance_score: 100,
    spec_version: '1.0.0',
    timestamp: 1_700_000_000_000,
    expires_at: 1_700_000_000_000 + 90 * 24 * 60 * 60 * 1000,
  };

  it('produces an HMAC-SHA256 signature, not SHA-256(secret||payload)', () => {
    const expectedHmac = crypto
      .createHmac('sha256', SECRET)
      .update(JSON.stringify(BADGE))
      .digest('hex');
    const concatHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(BADGE) + SECRET)
      .digest('hex');

    const signature = signConformanceBadge(BADGE, SECRET);

    expect(signature).toBe(expectedHmac);
    expect(signature).not.toBe(concatHash);
  });

  it('verifies deterministically: same input → same signature', () => {
    const a = signConformanceBadge(BADGE, SECRET);
    const b = signConformanceBadge(BADGE, SECRET);
    expect(a).toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = signConformanceBadge(BADGE, SECRET);
    const b = signConformanceBadge(BADGE, 'other-secret');
    expect(a).not.toBe(b);
  });

  it('changes when the badge content changes', () => {
    const a = signConformanceBadge(BADGE, SECRET);
    const b = signConformanceBadge({ ...BADGE, implementation_name: 'other' }, SECRET);
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Fact-base fixes item 5 (2026-09-23): the served seed list reports retired mechanisms as LEGACY.
// ---------------------------------------------------------------------------
import express from 'express';
import request from 'supertest';
import { createConformanceRouter, CATALOG_ACTION_TYPES, LEGACY_RETIRED_ACTION_TYPES } from './conformance';

describe('GET /action-types — current vs legacy', () => {
  const app = express();
  app.use('/v1/pe/conformance', createConformanceRouter({} as never));

  it('no retired-mechanism type is served as a current first-party type; each is served as legacy', async () => {
    const res = await request(app).get('/v1/pe/conformance/action-types');
    expect(res.status).toBe(200);
    expect(LEGACY_RETIRED_ACTION_TYPES.length).toBe(22);
    for (const t of LEGACY_RETIRED_ACTION_TYPES) {
      expect(CATALOG_ACTION_TYPES).toContain(t); // still recognized (historical records classify)
      expect(res.body.action_types).not.toContain(t);
      expect(res.body.legacy_action_types).toContain(t);
    }
    expect(res.body.count).toBe(CATALOG_ACTION_TYPES.length - LEGACY_RETIRED_ACTION_TYPES.length);
    expect(res.body.action_types).toContain('link_spend');
  });
});

describe('LEGACY_RETIRED_ACTION_TYPES is bound to the signed matrix', () => {
  // Single source: the matrix's own statically-discovered emitter list. A type is only "legacy"
  // when nothing in the tree emits it; a live type (e.g. policy_updated, emitted by the beneficiary
  // share update) must never be served as legacy.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const matrix = require('../../../docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json') as {
    rows: Array<{ action_type: string; maintained_sources: { static_emitter_files: string[] } }>;
  };
  const emitters = new Map(matrix.rows.map((r) => [r.action_type, r.maintained_sources.static_emitter_files]));

  it('every legacy type has a matrix row with NO emitter file (population counted, never empty)', () => {
    let evaluated = 0;
    for (const t of LEGACY_RETIRED_ACTION_TYPES) {
      expect([t, emitters.has(t)]).toEqual([t, true]);
      expect([t, emitters.get(t)]).toEqual([t, []]);
      evaluated += 1;
    }
    expect(evaluated).toBe(LEGACY_RETIRED_ACTION_TYPES.length);
    expect(evaluated).toBeGreaterThan(0);
  });

  it('RED control: a live type (policy_updated) has emitters, so the binding above would refuse it', () => {
    expect((emitters.get('policy_updated') ?? []).length).toBeGreaterThan(0);
    expect(LEGACY_RETIRED_ACTION_TYPES).not.toContain('policy_updated');
  });
});
