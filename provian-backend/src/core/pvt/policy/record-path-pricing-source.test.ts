/**
 * PINS THE PRICING SOURCE (rider b).
 *
 * The claim: the standard lane prices from the baked `PROPOSED_MONETARY_POLICY_TEMPLATE`
 * (the ratified 254-row matrix), gated by the live `monetary` activation — NOT from the
 * `pvt_action_policies` Firestore collection. That collection is consulted ONLY to ADD a
 * `classified_prospective` override for a genuinely UNKNOWN identifier; every priceable
 * (eligible) type in the matrix is a known-launch identifier that `resolveActionPolicyAtRecordTime`
 * short-circuits before the collection is ever read.
 *
 * This supersedes the 2026-08-03 framing that "pvt_action_policies is empty, so every action
 * falls to unknown_action_policy → record_only, weight 0." Verified false here and against live
 * Firestore: the collection is empty AND eligible types still price > 0, because the template is
 * the source. See action-policy-gate.ts (known-identifier short-circuit) and
 * runtime-monetary-policy.ts::loadRuntimeMonetaryPolicy (materializes the template).
 *
 * THREE CONTROLS, each with its negative half so none can pass vacuously:
 * (1) GREEN — eligible KNOWN types price > 0 from the template with the collection EMPTY, and the
 * factor weight equals the template weight (read dynamically, never re-declared).
 * (2) GREEN — an UNKNOWN identifier falls to pending-policy record_only with the collection empty.
 * (3) RED — severing the template's `actions` zeroes the SAME eligible type + inputs. This is the
 * load-bearing control: if pricing came from anywhere but the template entry, removing it would
 * not drop the price to 0.
 */

import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore } from '../__test-helpers__/fake-firestore';
import {
  buildOrdinaryEstimateInput,
  estimateFromRecordPath,
} from './record-path-estimate';
import { computeRecordSnapshot } from './monetary-accounting';
import { materializeProposedMonetaryPolicy } from './runtime-monetary-policy';
import { PROPOSED_MONETARY_POLICY_TEMPLATE } from './proposed-monetary-policy';
import { ACTION_POLICY_COLLECTION } from './pending-policy-queue';

const TS = Date.UTC(2026, 7, 4);

// A weight-diverse span of eligible types, derived from the template itself so the population
// cannot silently empty and the expected weights cannot drift from the single source.
const ELIGIBLE_SAMPLE = ['wallet_created', 'escrow_funded', 'agent_token_transfer', 'service:github_commit']
  .filter((t) => PROPOSED_MONETARY_POLICY_TEMPLATE.actions[t]?.mintDisposition === 'eligible');

describe('record-path pricing SOURCE is the monetary template, not pvt_action_policies ', () => {
  it('the sample is the eligible span it claims to be — non-empty and all eligible', () => {
    expect(ELIGIBLE_SAMPLE.length).toBe(4);
    for (const t of ELIGIBLE_SAMPLE) {
      expect(PROPOSED_MONETARY_POLICY_TEMPLATE.actions[t].mintDisposition).toBe('eligible');
    }
  });

  it('GREEN — eligible KNOWN types price > 0 from the template while pvt_action_policies is EMPTY', async () => {
    const fake = createFakeFirestore();
    const db = fake as unknown as Firestore;

    for (const actionType of ELIGIBLE_SAMPLE) {
      // The premise: this collection holds nothing for the type, yet it still prices.
      const pointer = await fake.collection(ACTION_POLICY_COLLECTION).doc(actionType).get();
      expect(pointer.exists).toBe(false);

      // service:* is external_proof_priced — its software tier floors to
      // 0 by POLICY (which would make the >0 probe unable to distinguish "priced
      // from the template" from "not priced at all"), so the gated sample row
      // prices at a proven tier. The floor itself is pinned in the estimate and
      // accrual suites; the weight assertion below still binds to the template
      // either way.
      const gated = PROPOSED_MONETARY_POLICY_TEMPLATE.actions[actionType]
        .attestationPricing === 'external_proof_priced';
      const est = await estimateFromRecordPath(db, {
        actionType,
        durableSubmissionPath: true,
        evidenceState: 'verified',
        canonicalEventId: 'tx_0xabc',
        sessionLineageId: 'sess_1',
        recordedAtMs: TS,
        ...(gated ? { attestationTier: 'corroborated' } : {}),
      });

      expect(BigInt(est.record_points_atomic) > 0n).toBe(true);
      // The weight it priced with IS the template's weight for this type.
      expect(est.factors.base_action_weight_bps)
        .toBe(PROPOSED_MONETARY_POLICY_TEMPLATE.actions[actionType].baseWeightBps);
    }
  });

  it('GREEN — an UNKNOWN identifier falls to pending-policy record_only with the collection empty', async () => {
    const fake = createFakeFirestore();
    const est = await estimateFromRecordPath(fake as unknown as Firestore, {
      actionType: 'totally_unknown_action_zzz',
      durableSubmissionPath: true,
      recordedAtMs: TS,
    });
    expect(est.mint_disposition).toBe('record_only');
    // §2.8 : with the collection empty an unknown identifier is CLASS-ADMITTED at the
    // actor-declared base (0) — record_only, never a pending-policy queue gate.
    expect(est.policy_review_state).toBe('class_admitted');
    expect(est.estimated_pvt_atomic).toBe('0');
  });

  it('RED — severing the template zeroes the SAME eligible type + inputs (the template is load-bearing)', () => {
    const params = {
      actionType: 'wallet_created',
      durableSubmissionPath: true,
      evidenceState: 'verified' as const,
      canonicalEventId: 'tx_0xabc',
      sessionLineageId: 'sess_1',
    };

    const withTemplate = materializeProposedMonetaryPolicy(0);
    const snapWith = computeRecordSnapshot(
      withTemplate,
      buildOrdinaryEstimateInput(withTemplate, params, TS),
    );
    expect(BigInt(snapWith.recordPointsAtomic) > 0n).toBe(true);
    expect(snapWith.mintDisposition).toBe('eligible');

    // Remove the template's action entries and NOTHING ELSE. If the price came from the template,
    // it must now be zero and record_only.
    const severed = Object.freeze({ ...withTemplate, actions: Object.freeze({}) });
    const snapSevered = computeRecordSnapshot(
      severed,
      buildOrdinaryEstimateInput(severed, params, TS),
    );
    expect(snapSevered.recordPointsAtomic).toBe('0');
    expect(snapSevered.mintDisposition).toBe('record_only');
  });
});
