/**
 * Trust Layer build §2.10 — the HUMAN APPROVAL PE's metadata-only reference.
 *
 * Privacy sentinel (§3): the approval reference is the ONLY new shape a mobile PE can carry and
 * the parser is the ONLY way it enters a resolvable field — so the sentinel is the parser: an
 * unknown key (the vector for free text / PII), a free-text decision, or a malformed id fails
 * CLOSED, never stripped-and-accepted.
 */
import { describe, it, expect } from '@jest/globals';
import {
  HUMAN_APPROVAL_ACTION_TYPE,
  humanApprovalOriginIdentifier,
  parseHumanApprovalMetadata,
} from './human-approval';
import { PROPOSED_ACTION_POLICY_ENTRIES } from '../pvt/policy/proposed-action-policy';
import { TIER_3_FIELDS } from '../commons/publication';

const OK = { agent_wallet_id: 'aw_atlas_01', decision: 'approved', subject_pe_id: 'pe_abc123', subject_hash: 'SHA256:' + 'ab'.repeat(32) };

describe('parseHumanApprovalMetadata', () => {
  it('accepts the canonical four-field shape and normalizes the subject hash to lower-case sha256:', () => {
    expect(parseHumanApprovalMetadata(OK)).toEqual({
      agent_wallet_id: 'aw_atlas_01', decision: 'approved', subject_pe_id: 'pe_abc123', subject_hash: `sha256:${'ab'.repeat(32)}`, request_id: null,
    });
    expect(parseHumanApprovalMetadata({ agent_wallet_id: 'aw1', decision: 'rejected' })).toEqual({
      agent_wallet_id: 'aw1', decision: 'rejected', subject_pe_id: null, subject_hash: null, request_id: null,
    });
    expect(parseHumanApprovalMetadata({ agent_wallet_id: 'aw1', decision: 'approved', subject_pe_id: null, subject_hash: null }))
      .toMatchObject({ subject_pe_id: null, subject_hash: null });
  });

  it('RED (privacy sentinel): any key outside the allowlist fails CLOSED — free text can never ride an approval', () => {
    expect(parseHumanApprovalMetadata({ ...OK, note: 'please approve the deploy to prod' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, title: 'x' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, description: 'x' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, prompt: 'x' })).toBeNull();
    // every TIER_3 name is outside the allowlist by construction
    for (const k of TIER_3_FIELDS) expect(parseHumanApprovalMetadata({ ...OK, [k]: 'x' })).toBeNull();
  });

  it('RED: a free-text decision, a malformed wallet id, PE id, or hash is refused', () => {
    expect(parseHumanApprovalMetadata({ ...OK, decision: 'approved with caveats' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, decision: 'APPROVED' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, agent_wallet_id: 'has spaces' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, agent_wallet_id: '' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, agent_wallet_id: 'a'.repeat(129) })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, subject_pe_id: 'has spaces in it' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, subject_pe_id: 'x'.repeat(242) })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, subject_pe_id: '' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, subject_pe_id: 42 })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, subject_hash: 'sha256:zz' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, subject_hash: 'ab'.repeat(31) })).toBeNull();
  });

  it('RED: non-object inputs are refused', () => {
    expect(parseHumanApprovalMetadata(null)).toBeNull();
    expect(parseHumanApprovalMetadata(undefined)).toBeNull();
    expect(parseHumanApprovalMetadata('approved')).toBeNull();
    expect(parseHumanApprovalMetadata([OK])).toBeNull();
  });

  it('the origin an agent cites is the `pe:` class over the approval PE id (ONE graph, §2.1)', () => {
    expect(humanApprovalOriginIdentifier('pe_abc')).toBe('pe:pe_abc');
  });

  it('accepts the approval request id (the mint-once anchor) and refuses a malformed one', () => {
    const reqId = `apr_${'a'.repeat(32)}`;
    expect(parseHumanApprovalMetadata({ ...OK, request_id: reqId }))
      .toMatchObject({ request_id: reqId });
    // explicit null is accepted (records without minting)
    expect(parseHumanApprovalMetadata({ ...OK, request_id: null }))
      .toMatchObject({ request_id: null });
    // RED: a shape that is not an apr_<32 hex> id fails closed
    expect(parseHumanApprovalMetadata({ ...OK, request_id: 'apr_short' })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, request_id: `apr_${'a'.repeat(31)}` })).toBeNull();
    expect(parseHumanApprovalMetadata({ ...OK, request_id: `apr_${'A'.repeat(32)}` })).toBeNull(); // uppercase hex
    expect(parseHumanApprovalMetadata({ ...OK, request_id: `req_${'a'.repeat(32)}` })).toBeNull(); // wrong prefix
    expect(parseHumanApprovalMetadata({ ...OK, request_id: 42 })).toBeNull();
  });

  it('human_approval MINTS at its witness-class base — eligible / verified_witness_class / base 10000 (RED control against a record_only re-pin)', () => {
    const row = PROPOSED_ACTION_POLICY_ENTRIES.find((r) => r.action_type === HUMAN_APPROVAL_ACTION_TYPE);
    expect(row).toBeDefined();
    // the operator : a biometric-signed human approval is a first-class WITNESSED act, not a
    // circular incentive. eligible so the hardware-rooted override can lift it to 4.0×; the witness
    // class IS the evidence; the base weight is the compute class base (device_tier 1.0×).
    expect(row?.mint_disposition).toBe('eligible');
    expect(row?.mint_disposition).not.toBe('record_only'); // RED: a regression to the pin fails here
    expect(row?.evidence_requirement).toBe('verified_witness_class');
    expect(row?.base_action_weight_bps).toBe(10000);
    // a one-off biometric approval has no session lineage (class-admission parity)
    expect(row?.session_lineage_policy).toBe('optional');
  });
});
