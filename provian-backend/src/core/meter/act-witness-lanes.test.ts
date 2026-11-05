/**
 * — the act-type witness table and the single-lane seal guard.
 *
 * The table is the one place that decides which act types keep no per-act document. These tests
 * bind it to the lanes the relay actually runs, so a lane cannot start witnessing a type the table
 * calls single-lane without a test going red, and they pin that the table fails closed.
 */
import { describe, it, expect } from '@jest/globals';
import { ACT_WITNESS_LANES, isSingleLaneActType, witnessLanesOf } from './act-witness-lanes';
import { DEVICE_OBSERVATION_ACTION_TYPES } from '../provenance/device-observation-types';
import {
  assertMintOnceClaimEvidence,
  hashMintOnceClaimEvidence,
  MINT_ONCE_CLAIM_SCHEMA_VERSION,
  MINT_ONCE_EVIDENCE_SCHEMA_VERSION,
  mintOnceClaimDocId,
  type MintOnceClaimEvidence,
} from '../pvt/mint-once-claim';

describe('act-type witness table', () => {
  it('records every type the device batch admits', () => {
    const missing = [...DEVICE_OBSERVATION_ACTION_TYPES].filter((t) => witnessLanesOf(t) === null);
    expect(DEVICE_OBSERVATION_ACTION_TYPES.size).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('keeps every cross-lane family multi-lane (commit, chain-financial, completion, facilitator)', () => {
    for (const t of [
      'coding_session', 'service:github_commit', 'service:github_pr_merged', 'service:gitlab_push',
      'service:bitbucket_push', 'send', 'swap', 'x402_payment', 'agent_token_transfer',
      'agent_native_transfer', 'human_job_delivered', 'escrow_completed', 'promise_fulfilled',
      'receive',
    ]) {
      expect([t, isSingleLaneActType(t)]).toEqual([t, false]);
    }
    expect(witnessLanesOf('x402_payment')).toContain('facilitator');
  });

  it(': the facilitator lane witnesses both sides of a settlement (buyer x402_payment, seller receive)', () => {
    // Both are now multi-lane, so both keep their 31-day act key and mint-once claim: the
    // facilitator lane and the chain watchers can each report the same transfer.
    for (const t of ['x402_payment', 'receive']) {
      expect(witnessLanesOf(t)).toEqual(expect.arrayContaining(['chain', 'facilitator']));
      expect(isSingleLaneActType(t)).toBe(false);
    }
    // RED control (recorded): against the pre-B1 row (`receive: ['chain']`) both assertions above
    // fail — `isSingleLaneActType('receive')` was true.
  });

  it('only facilitator-witnessed types list the facilitator lane', () => {
    const withFacilitator = Object.entries(ACT_WITNESS_LANES)
      .filter(([, e]) => e.witnesses.includes('facilitator'))
      .map(([t]) => t)
      .sort();
    expect(withFacilitator).toEqual(['receive', 'x402_payment']);
  });

  it('fails closed: a type the table does not list is never single-lane', () => {
    expect(witnessLanesOf('some_future_type')).toBeNull();
    expect(isSingleLaneActType('some_future_type')).toBe(false);
    expect(isSingleLaneActType('__proto__')).toBe(false);
    expect(isSingleLaneActType('constructor')).toBe(false);
  });

  it('calls exactly the one-witness rows single-lane', () => {
    const single = Object.entries(ACT_WITNESS_LANES).filter(([, e]) => e.witnesses.length === 1).map(([t]) => t);
    expect(single.length).toBeGreaterThan(0);
    for (const t of single) expect(isSingleLaneActType(t)).toBe(true);
    expect(isSingleLaneActType('ai_conversation')).toBe(true);
    expect(isSingleLaneActType('agent_tool_orchestration')).toBe(true);
  });
});

describe('the single-lane seal guard (assertMintOnceClaimEvidence)', () => {
  const peId = 'pe_m_aaaa';
  const userId = 'agent_x';
  const claim = {
    schema_version: MINT_ONCE_CLAIM_SCHEMA_VERSION,
    claim_id: mintOnceClaimDocId('device_occurrence', userId, 'a'.repeat(64)),
    claim_kind: 'device_occurrence' as const,
    subject_id: userId,
    event_id: 'a'.repeat(64),
    scope_id: null,
    owner_pe_id: peId,
    owner_user_id: userId,
    created_at_ms: 1,
  };
  const evidence: MintOnceClaimEvidence[] = [{ schema_version: MINT_ONCE_EVIDENCE_SCHEMA_VERSION, relation: 'owner', claim }];

  it('accepts a single-lane act whose sealed flags equal its in-batch sighting and that carries no evidence', () => {
    expect(assertMintOnceClaimEvidence({
      peId, userId, evidence: [], evidenceHash: null, exactDuplicate: false, uniqueArtifact: true, eligible: true,
      singleLaneSighting: { exactDuplicate: false, uniqueArtifact: true },
    })).toEqual([]);
  });

  it('RED: refuses a single-lane act that carries claim evidence', () => {
    expect(() => assertMintOnceClaimEvidence({
      peId, userId, evidence, evidenceHash: hashMintOnceClaimEvidence(evidence), exactDuplicate: false, uniqueArtifact: false, eligible: true,
      singleLaneSighting: { exactDuplicate: false, uniqueArtifact: false },
    })).toThrow('mint_once_single_lane_act_has_claim_evidence');
  });

  it('RED: refuses sealed flags that differ from the sighting', () => {
    expect(() => assertMintOnceClaimEvidence({
      peId, userId, evidence: [], evidenceHash: null, exactDuplicate: false, uniqueArtifact: true, eligible: true,
      singleLaneSighting: { exactDuplicate: true, uniqueArtifact: true },
    })).toThrow('mint_once_evidence_economic_binding_mismatch');
  });

  it('RED: refuses an eligible in-batch duplicate', () => {
    expect(() => assertMintOnceClaimEvidence({
      peId, userId, evidence: [], evidenceHash: null, exactDuplicate: true, uniqueArtifact: false, eligible: true,
      singleLaneSighting: { exactDuplicate: true, uniqueArtifact: false },
    })).toThrow('mint_once_evidence_duplicate_eligible');
  });

  it('control: without a sighting, the same unclaimed unique-artifact flag is refused (evidence required)', () => {
    expect(() => assertMintOnceClaimEvidence({
      peId, userId, evidence: [], evidenceHash: null, exactDuplicate: false, uniqueArtifact: true, eligible: true,
    })).toThrow('mint_once_evidence_economic_binding_mismatch');
  });
});
