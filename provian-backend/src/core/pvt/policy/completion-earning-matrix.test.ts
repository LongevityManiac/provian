/**
 * the GENERATED action-policy matrix and every pin that must move with
 * it, bound to the one artifact rather than restated.
 *
 * - the five completion rows in the generated JSON are session-lineage
 * OPTIONAL and still eligible / verified_substantive_outcome;
 * - `agreement_settled` (the class's sixth member, outside the ruling) is
 * still REQUIRED — the RED that proves the relief is by name;
 * - the matrix's declared `content_sha256` is exactly what `check:wp2` pins;
 * - the live template digest is exactly what FC-012 pins, and the signing
 * handoff the operator signs carries exactly that digest.
 */

import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { BOUND_ACTIVATION_TEMPLATE_SHA256, ACTIVATION_TEMPLATE_COMPATIBILITY } from '../../decisions/forbidden-constructs';
import { hashProposedMonetaryPolicyTemplate } from './proposed-monetary-policy';
import { monetaryApprovalSigningBytes } from './approved-monetary-activation-approval';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const MATRIX_PATH = path.join(REPO_ROOT, 'docs/audit/pvt-wp0-wp1/pvt-action-policy-matrix.generated.json');
const RUNTIME_BOUNDARY_PIN_PATH = path.join(REPO_ROOT, 'scripts/wp2/generate-pvt9-base-config.mjs');
const HANDOFF_PATH = path.join(REPO_ROOT, 'config/policy/monetary-activation.signing-bytes.txt');

const COMPLETION_TYPES = [
  'promise_fulfilled', 'job_delivered', 'human_job_delivered',
  'goal_envelope_completed', 'human_job_completed',
] as const;

interface MatrixRow {
  readonly action_type: string;
  readonly mint_disposition: string;
  readonly evidence_requirement: string;
  readonly session_lineage_policy: string;
  readonly attestation_pricing: string;
  readonly base_action_weight_bps: number;
  readonly reason_code: string;
  readonly category: string;
}

function readMatrix(): { content_sha256: string; rows: MatrixRow[] } {
  return JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')) as { content_sha256: string; rows: MatrixRow[] };
}

describe('the generated matrix carries the five lineage-optional completion rows', () => {
  it('each of the five is optional, eligible, verified_substantive_outcome, standard-priced at 1.0x', () => {
    const rows = readMatrix().rows;
    let evaluated = 0;
    for (const type of COMPLETION_TYPES) {
      const row = rows.find((r) => r.action_type === type);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        mint_disposition: 'eligible',
        evidence_requirement: 'verified_substantive_outcome',
        session_lineage_policy: 'optional',
        attestation_pricing: 'standard',
        base_action_weight_bps: 10_000,
      });
      evaluated += 1;
    }
    expect(evaluated).toBe(COMPLETION_TYPES.length);
  });

  it('RED: agreement_settled stays session-lineage REQUIRED — the relief is by name, not by reason code', () => {
    const row = readMatrix().rows.find((r) => r.action_type === 'agreement_settled');
    expect(row).toMatchObject({
      mint_disposition: 'eligible',
      evidence_requirement: 'verified_substantive_outcome',
      session_lineage_policy: 'required',
    });
  });

  it('exactly six rows carry the substantive-outcome class, so the five are the whole scope', () => {
    const cls = readMatrix().rows.filter((r) => r.evidence_requirement === 'verified_substantive_outcome');
    expect(cls.map((r) => r.action_type).sort()).toEqual(
      ['agreement_settled', ...COMPLETION_TYPES].sort(),
    );
  });
});

describe('every pin moved with the artifact', () => {
  it('the check:wp2 matrix pin equals the generated matrix\'s declared content_sha256', () => {
    const pinSource = fs.readFileSync(RUNTIME_BOUNDARY_PIN_PATH, 'utf8');
    const match = pinSource.match(
      /const FROZEN_ACTION_POLICY_MATRIX_CONTENT_SHA256 =\s*'(sha256:[a-f0-9]{64})'/,
    );
    expect(match).not.toBeNull();
    expect(match![1]).toBe(readMatrix().content_sha256);
  });

  it('the FC-012 template pin equals the live template digest, and its compatibility binding names the supported predecessor', () => {
    expect(BOUND_ACTIVATION_TEMPLATE_SHA256).toBe(hashProposedMonetaryPolicyTemplate());
    // The current template's compatibility binding names the predecessor
    // without changing the canonical pricing rows or their signed digest.
    expect(ACTIVATION_TEMPLATE_COMPATIBILITY.rule).toBe('source_bound_signed_template_stages');
    expect(ACTIVATION_TEMPLATE_COMPATIBILITY.cause).toContain('Both activation documents');
    expect(ACTIVATION_TEMPLATE_COMPATIBILITY.prior_digest)
      .toBe('sha256:cbe39337418064ba3c7a3ecd490d6e2fc3109570fe518ac41b0ff95a88083530');
  });

  it('three job-settlement records join record_only and no other row lost or changed its price', () => {
    const rows = readMatrix().rows;
    expect(rows).toHaveLength(266);
    expect(rows.filter((r) => r.mint_disposition === 'eligible')).toHaveLength(73);
    expect(rows.filter((r) => r.mint_disposition === 'record_only')).toHaveLength(193);
    // Each is the settlement signal of an escrow event another row mints (09-11 rule); the
    // job_completed sibling is the parity reference. RED: a drift on any of the four fails.
    const peer = rows.find((r) => r.action_type === 'job_completed');
    expect(peer).toBeDefined();
    let evaluated = 0;
    for (const type of ['human_job_payment_released', 'human_job_refunded', 'job_refunded']) {
      const row = rows.find((r) => r.action_type === type);
      expect(row).toMatchObject({
        mint_disposition: 'record_only',
        reason_code: 'SETTLEMENT_SIGNAL_APPLIES_TO_TARGET',
        base_action_weight_bps: 0,
      });
      for (const k of ['mint_disposition', 'reason_code', 'evidence_requirement', 'base_action_weight_bps', 'category'] as const) {
        expect(row![k]).toBe(peer![k]);
      }
      evaluated += 1;
    }
    expect(evaluated).toBe(3);
    // The value each one signals is minted by an eligible row.
    for (const target of ['escrow_completed', 'escrow_resolved', 'human_job_delivered']) {
      expect(rows.find((r) => r.action_type === target)?.mint_disposition).toBe('eligible');
    }
  });

  it('every Commons speech row is eligible at the relay_verified class base 10000 with optional lineage; the Court-escalation row is gone', () => {
    const rows = readMatrix().rows;
    const speech = ['commons_post_created', 'commons_post_replied', 'commons_vote_cast', 'commons_post_flagged',
      'commons_claim_challenged', 'commons_challenge_answered', 'commons_thread_message', 'want_posted', 'job_posted', 'human_job_posted'];
    let evaluated = 0;
    for (const type of speech) {
      const row = rows.find((r) => r.action_type === type);
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        mint_disposition: 'eligible',
        evidence_requirement: 'verified_witness_class',
        session_lineage_policy: 'optional',
        base_action_weight_bps: 10_000,
      });
      evaluated += 1;
    }
    expect(evaluated).toBe(speech.length);
    for (const type of ['commons_featured_placement', 'want_cancelled', 'want_fulfilled']) {
      expect(rows.find((r) => r.action_type === type)?.mint_disposition).toBe('record_only');
    }
    expect(rows.find((r) => r.action_type === 'commons_challenge_escalated')).toBeUndefined();
  });

  it('the link_spend row is eligible at observer-family parity with agent_action (RED: a drift in either fails)', () => {
    const rows = readMatrix().rows;
    const link = rows.find((r) => r.action_type === 'link_spend');
    const peer = rows.find((r) => r.action_type === 'agent_action');
    expect(link).toBeDefined();
    expect(peer).toBeDefined();
    expect(link).toMatchObject({
      mint_disposition: 'eligible',
      evidence_requirement: 'verified_compute_or_work',
      session_lineage_policy: 'optional',
      base_action_weight_bps: 10_000,
    });
    for (const k of ['mint_disposition', 'evidence_requirement', 'session_lineage_policy', 'attestation_pricing', 'base_action_weight_bps'] as const) {
      expect(link![k]).toBe(peer![k]);
    }
    // §2.12: +10 chain-witnessed Standing / Jobs-join rows (all record_only) → 259.
    // §2.10: + human_approval (record_only) → 260.
    // + commons_thread_message, commons_challenge_answered, want_posted,
    // commons_featured_placement, want_cancelled, want_fulfilled; − commons_challenge_escalated → 265.
    // 2026-09-23 (fact-base fixes item 3): − one never-wired record_only row → 264.
    // + three job-settlement record_only rows → 267.
    expect(rows).toHaveLength(266);
  });

  it('the signing handoff the operator signs is byte-identical to the verifier\'s own scope bytes and names the live digest', () => {
    const handoff = fs.readFileSync(HANDOFF_PATH);
    expect(handoff.equals(monetaryApprovalSigningBytes())).toBe(true);
    expect(handoff.toString('utf8')).toContain(`policy_template_sha256=${hashProposedMonetaryPolicyTemplate()}`);
  });
});
