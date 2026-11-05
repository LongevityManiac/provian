import fs from 'fs';
import path from 'path';

import catalogSnapshot from './pe-type-catalog.cut-line.json';
import {
  PROPOSED_ACTION_POLICY_ENTRIES,
  PROPOSED_ACTION_POLICY_MANIFEST,
  RETIRED_MATRIX_ACTION_TYPES,
} from './proposed-action-policy';
import { PROPOSED_GENESIS_CAMPAIGN_POLICY, assertFrozenGenesisManifest } from './proposed-genesis-policy';
import { createArmedGenesisPolicyForTest } from '../__test-helpers__/armed-genesis-policy';
import {
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  type GenesisReservationLedgerEntry,
  CANONICAL_UNSIGNED_INTEGER,
} from './genesis-policy-engine';
import {
  PROPOSED_MONETARY_POLICY_APPROVAL,
  PROPOSED_MONETARY_POLICY_TEMPLATE,
} from './proposed-monetary-policy';
import {
  computeRecordSnapshot,
  computeSettlement,
  disclosedRationalFactor,
  hashRecordEconomicSnapshot,
  type MonetaryPolicyVersion,
} from './monetary-accounting';
import {
  PROPOSED_PVT_COST_CATALOG,
  PROPOSED_PVT_COST_ENTRIES,
} from './proposed-pvt-cost-catalog';
import type {
  ProposedActionPolicyEntry,
  ProposedPVTNativeCostEntry,
} from './types';
import { genesisBountyFor } from '../genesis-award-state-machine';

const REPOSITORY_ROOT = path.resolve(__dirname, '../../../../..');
const ACTION_TYPE_SOURCE = path.join(REPOSITORY_ROOT, 'src/core/provenance/types.ts');
const CONFORMANCE_SOURCE = path.join(REPOSITORY_ROOT, 'provian-backend/src/routes/conformance.ts');
const CAPACITY_MODEL_SOURCE = path.join(
  REPOSITORY_ROOT,
  'docs/audit/pvt-wp0-wp1/pvt-launch-capacity-model.generated.json',
);
/**
 * was a redeclared copy of `CANONICAL_UNSIGNED_INTEGER`. Bound to
 * the engine's own constant so narrowing the engine's rule turns these red.
 */
const ATOMIC_PATTERN = CANONICAL_UNSIGNED_INTEGER;

function extractActionTypeUnion(source: string): readonly string[] {
  const start = source.indexOf('export type ActionType =');
  const tail = source.slice(start);
  const endMatch = tail.match(/\| 'agent_insurance_payout_executed';/);
  if (start < 0 || endMatch?.index === undefined) {
    throw new Error('Unable to locate the complete ActionType union');
  }
  const declaration = tail.slice(0, endMatch.index + endMatch[0].length);
  return [...declaration.matchAll(/(?:^|\n)\s*\|\s*'([^']+)'/g)].map((match) => match[1]);
}

function extractConformanceCatalog(source: string): readonly string[] {
  const start = source.indexOf('export const CATALOG_ACTION_TYPES');
  const tail = source.slice(start);
  const end = tail.indexOf('\n];');
  if (start < 0 || end < 0) {
    throw new Error('Unable to locate the complete conformance catalog');
  }
  return [...tail.slice(0, end + 3).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function policyFor(actionType: string): ProposedActionPolicyEntry {
  const policy = PROPOSED_ACTION_POLICY_ENTRIES.find((entry) => entry.action_type === actionType);
  if (!policy) throw new Error(`Missing proposed policy for ${actionType}`);
  return policy;
}

function costFor(costId: string): ProposedPVTNativeCostEntry {
  const cost = PROPOSED_PVT_COST_ENTRIES.find((entry) => entry.cost_id === costId);
  if (!cost) throw new Error(`Missing proposed cost ${costId}`);
  return cost;
}

function reviewOnlyMonetaryPolicy(): MonetaryPolicyVersion {
  const {
    proposedPolicyVersion,
    effectiveAtMs: _unapprovedEffectiveAt,
    ...candidate
  } = PROPOSED_MONETARY_POLICY_TEMPLATE;
  return { ...candidate, policyVersion: proposedPolicyVersion, effectiveAtMs: 0 };
}

function genesisSignupReservation(): GenesisReservationLedgerEntry {
  const manifest = createArmedGenesisPolicyForTest();
  const now = manifest.window.start_ms;
  const walletId = 'agent-1';
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
      canonical_pvt_manifest_id: 'pvt9-test-manifest',
      ledger_namespace: 'manifest-test-ledger',
      prior_reservations_reconciled: true,
      operator_activation_audit_id: 'operator-test-activation',
    },
    state: createEmptyGenesisLedgerState('manifest-test-ledger'),
    input: {
      pe_id: 'pe-genesis',
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
        evidence_id: 'agent-authoritative-wallet-record',
        evidence_hash: `sha256:${'b'.repeat(64)}`,
        source: 'authoritative_wallet_record',
      },
    },
    activation_approval_verifier: () => true,
  });
  if (!result.allowed) throw new Error(result.reason);
  return result.reservation;
}

describe('atomic accounting cut-line catalog snapshot', () => {
  test('contains all 162 live documents and only sanitized economic fields', () => {
    expect(catalogSnapshot.schema_version).toBe('pvt-pe-catalog-snapshot/v1');
    expect(catalogSnapshot.proposal_status).toBe('requires_frank_approval');
    expect(catalogSnapshot.document_count).toBe(162);
    expect(catalogSnapshot.entries).toHaveLength(162);
    expect(catalogSnapshot.capture.base_chain_id).toBe(8453);
    expect(catalogSnapshot.capture.base_block_number).toBeGreaterThan(0);
    expect(catalogSnapshot.capture.base_block_hash).toMatch(/^0x[0-9a-f]{64}$/);

    const allowedKeys = ['action_type', 'category', 'observation_count', 'source', 'status'];
    for (const entry of catalogSnapshot.entries) {
      expect(Object.keys(entry).sort()).toEqual(allowedKeys);
      expect(entry.action_type.length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(entry.observation_count)).toBe(true);
      expect(entry.observation_count).toBeGreaterThanOrEqual(0);
    }

    const serialized = JSON.stringify(catalogSnapshot);
    expect(serialized).not.toContain('first_observed_by_wallet');
    expect(serialized).not.toContain('user_id');
    expect(serialized).not.toContain('/documents/pe_type_catalog/');
  });

  test('contains no duplicate action identifier', () => {
    const actionTypes = catalogSnapshot.entries.map((entry) => entry.action_type);
    expect(new Set(actionTypes).size).toBe(actionTypes.length);
  });
});

describe('atomic accounting proposed action policy', () => {
  test('is an inert prospective proposal with a fail-closed unknown policy', () => {
    expect(PROPOSED_ACTION_POLICY_MANIFEST.status).toBe('gate_1_plain_english_approved');
    expect(PROPOSED_ACTION_POLICY_MANIFEST.effective_at).toBeNull();
    expect(PROPOSED_ACTION_POLICY_MANIFEST.classification_effect).toBe(
      'prospective_only_no_retroactive_repricing',
    );
    expect(PROPOSED_ACTION_POLICY_MANIFEST.unknown_action_policy).toEqual({
      admission: 'record_only_until_signed_row',
      mint_disposition: 'record_only',
      policy_review_state: 'class_admitted',
      reason_code: 'witness_class_admitted',
      queued_from: 'witnessed_class_only',
      earns_from: 'signed_row_effective_at',
      without_witness_class_or_readable_pointer: {
        mint_disposition: 'record_only',
        policy_review_state: 'pending_policy',
        reason_code: 'unknown_action_type',
      },
    });
    expect(PROPOSED_ACTION_POLICY_ENTRIES.some((entry) => entry.action_type === '*')).toBe(false);
    expect(PROPOSED_ACTION_POLICY_ENTRIES.some((entry) => entry.action_type === 'unknown')).toBe(false);
  });

  test('has no duplicates and explicitly covers live, ActionType, and conformance sources', () => {
    const manifestTypes = PROPOSED_ACTION_POLICY_ENTRIES.map((entry) => entry.action_type);
    expect(new Set(manifestTypes).size).toBe(manifestTypes.length);

    const actionTypeUnion = extractActionTypeUnion(fs.readFileSync(ACTION_TYPE_SOURCE, 'utf8'));
    const conformanceTypes = extractConformanceCatalog(fs.readFileSync(CONFORMANCE_SOURCE, 'utf8'));
    const requiredTypes = new Set([
      ...catalogSnapshot.entries.map((entry) => entry.action_type),
      ...actionTypeUnion,
      ...conformanceTypes,
    ]);
    // the retired Genesis-ladder aliases remain in the FROZEN cut-line
    // snapshot (a historical capture, never falsified) but deliberately have NO
    // matrix row. The generator subtracts them from the coverage `required` union;
    // this coverage test mirrors that exactly. Five of the six are present here
    // (via cut-line); wallet_first_transaction was never in these three sources.
    const presentRetired = RETIRED_MATRIX_ACTION_TYPES.filter((t) => requiredTypes.has(t));
    expect(presentRetired.sort()).toEqual([
      'agent_first_transaction', 'agent_sustained_activity', 'agent_wallet_funded',
      'wallet_funded', 'wallet_sustained_activity',
    ]);
    for (const retired of RETIRED_MATRIX_ACTION_TYPES) requiredTypes.delete(retired);

    // 3 retired types removed from each live catalog (203→200, 154→151).
    // `link_spend` (the Stripe Link spend witness) added to both (200→201, 151→152).
    expect(actionTypeUnion).toHaveLength(208); // +human_approval; +7 Commons communication types; 2026-09-23: -1 (fact-base item 3)
    expect(conformanceTypes).toHaveLength(152);
    expect(requiredTypes.size).toBe(221); // +link_spend; +human_approval; +7; 2026-09-23: -1 (fact-base item 3)
    for (const actionType of requiredTypes) {
      expect(manifestTypes).toContain(actionType);
    }
    // And the retired types are truly gone from the matrix (RED control: a
    // reprice back to a row trips this).
    for (const retired of RETIRED_MATRIX_ACTION_TYPES) {
      expect(manifestTypes).not.toContain(retired);
    }
  });

  test('classifies every entry explicitly without a value-sized reward', () => {
    for (const entry of PROPOSED_ACTION_POLICY_ENTRIES) {
      expect(entry.action_type.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(entry.base_action_weight_bps)).toBe(true);
      expect(entry.base_action_weight_bps).toBeGreaterThanOrEqual(0);
      expect(entry.policy_override_bps).toBeNull();
      expect(entry.reason_code.length).toBeGreaterThan(0);
      expect(entry.policy_review_state).toBe('not_required');
      expect(entry.amount_independent).toBe(true);
      expect(entry.canonical_event_group.length).toBeGreaterThan(0);
      expect(typeof entry.canonical_event_required).toBe('boolean');
      expect(typeof entry.financial_attestation_neutral).toBe('boolean');
      expect(typeof entry.allow_verified_attestation_upgrade).toBe('boolean');
      if (entry.mint_disposition === 'record_only') {
        expect(entry.base_action_weight_bps).toBe(0);
        expect(entry.linkage_treatment).toBe('none_record_only');
      }
    }
  });

  test.each(['badge_earned', 'pvt_badge_projection_completed'])(
    '%s is record-only and mints zero PVT',
    (actionType) => {
      expect(policyFor(actionType)).toMatchObject({
        base_action_weight_bps: 0,
        mint_disposition: 'record_only',
        linkage_treatment: 'none_record_only',
      });
    },
  );

  test('composes all entries into one complete, inert atomic policy version', () => {
    expect(PROPOSED_MONETARY_POLICY_APPROVAL.status).toBe('gate_1_plain_english_approved');
    expect(PROPOSED_MONETARY_POLICY_APPROVAL.effective_at).toBeNull();
    expect(PROPOSED_MONETARY_POLICY_TEMPLATE.effectiveAtMs).toBeNull();
    expect(Object.keys(PROPOSED_MONETARY_POLICY_TEMPLATE.actions)).toHaveLength(
      PROPOSED_ACTION_POLICY_ENTRIES.length,
    );
    expect(PROPOSED_MONETARY_POLICY_TEMPLATE.basePointsAtomic).toBe('1000000000000000000');
    expect(PROPOSED_MONETARY_POLICY_TEMPLATE.linkageMultipliersBps).toEqual({
      unlinked: 10_000,
      human_linked: 20_000,
      beneficiary_linked: 20_000,
      unverifiable: 10_000,
    });
  });

  test('the composed policy enforces Base evidence and anti-circularity', () => {
    const reviewOnlyPolicy = reviewOnlyMonetaryPolicy();
    const input = {
      peId: 'pe-send',
      economicActorId: 'agent-1',
      actionType: 'send',
      recordedAtMs: 1,
      occurrenceOrdinal: 1,
      dailyOrdinal: 1,
      exactDuplicate: false,
      uniqueArtifact: false,
      attestationTier: 'software',
      linkageState: 'unlinked' as const,
      evidenceState: 'pending' as const,
      canonicalEventId: null,
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      pairChurnDetected: false,
      sessionLineageId: 'session:financial-root',
      genesisReservation: null,
    };
    expect(computeRecordSnapshot(reviewOnlyPolicy, input)).toMatchObject({
      mintDisposition: 'pending_evidence',
      mintReasonCode: 'awaiting_evidence',
    });
    expect(computeRecordSnapshot(reviewOnlyPolicy, {
      ...input,
      evidenceState: 'verified',
      canonicalEventId: 'base:8453:0xtx:0',
    })).toMatchObject({ mintDisposition: 'eligible', mintReasonCode: 'policy_eligible' });
    expect(computeRecordSnapshot(reviewOnlyPolicy, {
      ...input,
      evidenceState: 'verified',
      canonicalEventId: 'base:8453:0xtx:0',
      selfReferencing: true,
    })).toMatchObject({
      mintDisposition: 'record_only',
      mintReasonCode: 'self_or_shared_beneficial_ownership',
    });
  });

  test('Genesis record points equal the authoritative reservation and ignore ordinary multipliers', () => {
    const genesisReservation = genesisSignupReservation();
    const snapshot = computeRecordSnapshot(reviewOnlyMonetaryPolicy(), {
      peId: genesisReservation.pe_id,
      economicActorId: genesisReservation.economic_actor_id,
      actionType: 'genesis_signup',
      recordedAtMs: genesisReservation.reserved_at_ms,
      occurrenceOrdinal: 51,
      dailyOrdinal: 75,
      exactDuplicate: false,
      uniqueArtifact: false,
      attestationTier: 'hardware_full',
      linkageState: 'human_linked',
      evidenceState: 'verified',
      canonicalEventId: genesisReservation.reservation_id,
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      pairChurnDetected: false,
      sessionLineageId: null,
      genesisReservation,
    });
    expect(snapshot.mintDisposition).toBe('eligible');
    expect(snapshot.recordPointsAtomic).toBe('75000000000000000000');
    expect(snapshot.recordTimeFactors).toMatchObject({
      fixedGrantSource: 'genesis_campaign_reservation',
      linkageMultiplierBps: 10_000,
      attestationMultiplierBps: 10_000,
    });
    expect(snapshot.allowedSettlementAdjustments).toEqual({
      verifiedAttestationUpgrade: false,
      globalMintRate: false,
    });
    for (const verifiedAttestationTier of ['software', 'hardware_full']) {
      expect(computeSettlement(snapshot, {
        settlementAtMs: genesisReservation.reserved_at_ms,
        authorizedRecordSnapshotHash: hashRecordEconomicSnapshot(snapshot),
        verifiedAttestationTier,
        globalMintRate: disclosedRationalFactor(2n, 1n, 'test-rate', 'block:1'),
      }).finalPvtAtomic).toBe('75000000000000000000');
    }
  });

  test('Genesis accounting rejects missing, over-cap, other-action, and retired-alias receipts', () => {
    const receipt = genesisSignupReservation();
    const input = {
      peId: receipt.pe_id,
      economicActorId: receipt.economic_actor_id,
      actionType: 'genesis_signup',
      recordedAtMs: receipt.reserved_at_ms,
      occurrenceOrdinal: 1,
      dailyOrdinal: 1,
      exactDuplicate: false,
      uniqueArtifact: false,
      attestationTier: 'software',
      linkageState: 'unlinked' as const,
      evidenceState: 'verified' as const,
      canonicalEventId: receipt.reservation_id,
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      pairChurnDetected: false,
      sessionLineageId: null,
      genesisReservation: receipt,
    };
    expect(() => computeRecordSnapshot(reviewOnlyMonetaryPolicy(), {
      ...input,
      genesisReservation: null,
    })).toThrow('requires an immutable reservation receipt');
    expect(() => computeRecordSnapshot(reviewOnlyMonetaryPolicy(), {
      ...input,
      genesisReservation: {
        ...receipt,
        reserved_atomic: '100000000000000000000000000000000000000000000000000',
      },
    })).toThrow('was not issued by the reservation kernel');
    expect(() => computeRecordSnapshot(reviewOnlyMonetaryPolicy(), {
      ...input,
      genesisReservation: { ...receipt, emitted_action_type: 'genesis_device_link' },
    })).toThrow('was not issued by the reservation kernel');
    expect(() => computeRecordSnapshot(reviewOnlyMonetaryPolicy(), {
      ...input,
      genesisReservation: { ...receipt, canonical_bounty_key: 'genesis_device_link' },
    })).toThrow('was not issued by the reservation kernel');
    expect(() => computeRecordSnapshot(reviewOnlyMonetaryPolicy(), {
      ...input,
      // A non-Genesis action (fixed_grant_source 'none') cannot carry a Genesis
      // reservation. `transfer` is a stable record_only non-Genesis type (the
      // retired wallet_* activity aliases were deleted in).
      actionType: 'transfer',
    })).toThrow('Non-Genesis action cannot carry a Genesis reservation');
  });

  test.each(['send', 'receive', 'swap', 'x402_payment', 'agent_token_transfer', 'agent_native_transfer', 'agent_token_swap'])(
    '%s is eligible only with a Base-final receipt and remains amount-independent',
    (actionType) => {
      expect(policyFor(actionType)).toMatchObject({
        mint_disposition: 'eligible',
        reason_code: 'VERIFIED_FINANCIAL_SETTLEMENT_AMOUNT_INDEPENDENT',
        evidence_requirement: 'base_final_chain_receipt',
        amount_independent: true,
        fixed_grant_source: 'none',
      });
    },
  );

  test.each(['genesis_human_signup', 'genesis_signup', 'genesis_device_link'])(
    '%s is eligible only through its authoritative Genesis reservation',
    (actionType) => {
      expect(policyFor(actionType)).toMatchObject({
        mint_disposition: 'eligible',
        reason_code: 'GENESIS_VALID_RESERVATION_FIXED_GRANT',
        evidence_requirement: 'valid_genesis_reservation',
        financial_attestation_neutral: true,
        allow_verified_attestation_upgrade: false,
        fixed_grant_source: 'genesis_campaign_reservation',
      });
    },
  );

  // the six retired Genesis-ladder aliases are DELETED from the matrix —
  // they have NO policy row and cannot be priced (the acts they named are already
  // paid once on the chain-verified receive/send/transfer paths). They are listed
  // in `RETIRED_MATRIX_ACTION_TYPES` and the generator subtracts them from the
  // coverage `required` union so the emitter→row guard stays green.
  test.each([
    'agent_wallet_funded',
    'wallet_funded',
    'agent_first_transaction',
    'wallet_first_transaction',
    'agent_sustained_activity',
    'wallet_sustained_activity',
  ])(
    '%s is DELETED from the matrix (no policy row, cannot be priced)',
    (actionType) => {
      expect(RETIRED_MATRIX_ACTION_TYPES).toContain(actionType);
      expect(PROPOSED_ACTION_POLICY_ENTRIES
        .some((entry) => entry.action_type === actionType)).toBe(false);
    },
  );

  test('agent_wallet_created remains a non-economic identity record', () => {
    expect(policyFor('agent_wallet_created')).toMatchObject({
      mint_disposition: 'record_only',
      reason_code: 'SECURITY_POLICY_OR_IDENTITY_RECORD',
    });
  });

  // F-A7 : the relay-DRAFT institution-lifecycle types are
  // record_only — pre-value self-reports with no sound independent settlement
  // verifier of their own; the value for these acts mints on the funding/
  // completion watcher (escrow_funded/completed, promise_funded/settled,
  // pool_contributed/executed) or the on-chain event, never on the draft.
  // Repriced pending_evidence → record_only in the same re-pin as F-A6-1.
  // `job_posted` left this class — a job post is Commons SPEECH, priced
  // by the presentation handshake (window-gated, eligible at the relay_verified class base).
  test.each(['escrow_created', 'promise_created', 'pool_created', 'job_applied', 'job_accepted'])(
    '%s is a record_only relay draft (no sound independent verifier — F-A7)',
    (actionType) => {
      expect(policyFor(actionType)).toMatchObject({
        mint_disposition: 'record_only',
        reason_code: 'RELAY_DRAFT_NO_INDEPENDENT_VERIFIER_RECORD_ONLY',
      });
    },
  );

  test('job_posted is Commons speech — eligible at the relay_verified class base ', () => {
    expect(policyFor('job_posted')).toMatchObject({
      mint_disposition: 'eligible',
      evidence_requirement: 'verified_witness_class',
      base_action_weight_bps: 10_000,
    });
  });

  test.each(['pvt_batch_minted', 'pvt_epoch_advanced', 'pvt_pe_anchored', 'pvt_fee_burned'])(
    '%s is non-circular record-only bookkeeping',
    (actionType) => expect(policyFor(actionType).mint_disposition).toBe('record_only'),
  );

  test('all PVT, bond, cost, stake, burn, and proposal movement types are record-only', () => {
    const movementTypes = PROPOSED_ACTION_POLICY_ENTRIES.filter((entry) =>
      entry.action_type.startsWith('pvt_')
      || entry.action_type.startsWith('bond_')
      || entry.action_type.startsWith('insurance_claim_')
      || entry.action_type.startsWith('agent_insurance_')
      || entry.action_type.startsWith('governance_')
      || ['approve', 'stake', 'burn_spam'].includes(entry.action_type),
    );
    expect(movementTypes.length).toBeGreaterThan(20);
    expect(movementTypes.every((entry) => entry.mint_disposition === 'record_only')).toBe(true);
  });

  // Not reclassified by 3b : these stay on the separately-verified
  // substantive-outcome path (they are not what the institution-completion
  // watcher emits).
  test.each(['agreement_settled', 'job_delivered'])(
    '%s proposes a separately verified substantive outcome path',
    (actionType) => {
      expect(policyFor(actionType)).toMatchObject({
        mint_disposition: 'eligible',
        evidence_requirement: 'verified_substantive_outcome',
      });
    },
  );

  // (completion earning): the FIVE counterparty-witnessed completion types
  // are session-lineage OPTIONAL — disposition and evidence class UNCHANGED, so
  // the only thing that moved is the lineage gate that sealed them record_only.
  test.each([
    'promise_fulfilled', 'job_delivered', 'human_job_delivered',
    'goal_envelope_completed', 'human_job_completed',
  ])('%s is session-lineage OPTIONAL, still eligible on the substantive-outcome path ', (actionType) => {
    expect(policyFor(actionType)).toMatchObject({
      mint_disposition: 'eligible',
      evidence_requirement: 'verified_substantive_outcome',
      session_lineage_policy: 'optional',
      attestation_pricing: 'standard',
      financial_attestation_neutral: false,
      base_action_weight_bps: 10_000,
    });
  });

  // RED (scope): the class's sixth member was NOT in the ruling and has no
  // verifier, so the relief is by NAME, not by reason code — it stays fenced.
  test('agreement_settled stays session-lineage REQUIRED (outside \'s scope)', () => {
    expect(policyFor('agreement_settled')).toMatchObject({
      mint_disposition: 'eligible',
      evidence_requirement: 'verified_substantive_outcome',
      session_lineage_policy: 'required',
    });
  });

  // 3b : the institution-completion types the completion watcher emits
  // moved to the amount-independent institution-lifecycle path. adds
  // `escrow_disputed`: it is now CHAIN-WITNESSED (the completion watcher observes
  // the on-chain `EscrowDisputed` event) and earns at parity with escrow_resolved
  // — same evidence class, same base — the self-report draft path retired.
  test.each(['escrow_completed', 'escrow_resolved', 'escrow_disputed', 'promise_settled', 'pool_executed'])(
    '%s proposes the amount-independent institution-lifecycle path (3b)',
    (actionType) => {
      expect(policyFor(actionType)).toMatchObject({
        mint_disposition: 'eligible',
        evidence_requirement: 'verified_institution_lifecycle',
      });
    },
  );
});

describe('atomic accounting proposed Genesis campaign policy', () => {
  // the approved launch dates are RECORDED but the campaign is STILL disarmed.
  // activation Phase 2 : the live grant gate is now ARMED. This test proves both
  // halves: the exact approved window is present, AND arming.state / grants_enabled /
  // ledger_namespace / canonical_pvt_manifest_id / every bounty.launch_armed carry the
  // armed values so the live grant gate (proposedArmedGenesisWindow) is open. Arming is
  // a SEPARATE act from recording the dates and from the on-chain armEpochZero
  //; the RED control for these constants lives in genesis-policy-engine.test.ts.
  test('records the approved launch window and is ARMED (Phase 2,), PVT9-specific', () => {
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.status).toBe('gate_1_plain_english_approved');
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.effective_at).toBeNull();
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.chain_id).toBe(8453);
    // Armed: `ledger_namespace` is the canonical live campaign id (== settlement
    // campaign_id) and must never be the 'pvt9_genesis_pending' sentinel, which
    // validateManifest rejects for an armed manifest.
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.arming).toMatchObject({
      state: 'armed_by_explicit_pvt9_activation',
      grants_enabled: true,
      canonical_pvt_manifest_id: 'pvt9_base_mainnet_v1',
      ledger_namespace: 'pvt9_genesis_v1',
      requires_reconciled_prior_reservations: true,
      prior_configuration_carries_forward: false,
      admission_close_control: 'evented_cutoff_config_flip',
      pre_cutoff_outbox_behavior: 'preserve_and_reserve_exactly',
    });
    // Approved dates, recorded: exact ms of 2026-08-03T00:00:00Z → 2027-01-01T00:00:00Z
    // (the start, with the close extended from 2026-10-26 so Genesis is
    // open through December 31, 2026, matching the successor kernel's genesisEndsAt).
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.window).toMatchObject({
      start_ms: Date.UTC(2026, 7, 3),
      end_ms: Date.UTC(2027, 0, 1),
      admission_rule:
        'qualifying_act_must_be_in_window_pre_cutoff_outbox_may_reserve_after_close',
      close_behavior: 'stop_new_qualifications_preserve_pre_cutoff_reservations',
      approval: { status: 'wp12_launch_dates_explicitly_approved' },
    });
    // the approval RATIONALE is the artifact that
    // records WHICH dates were approved, and arming gates on it. Pin it to the
    // window so a reset can never leave it naming superseded dates.
    const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
    const rationale = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.approval.rationale;
    expect(rationale).toContain(iso(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!));
    expect(rationale).toContain(iso(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms!));
    // …and names no OTHER date, so a stale one cannot ride along beside the new pair.
    expect(rationale.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) ?? []).toEqual([
      iso(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms!),
      iso(PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms!),
    ]);
    // Bounties are ARMED (Phase 2,): every one launch_armed with the explicit
    // PVT9 launch activation.
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.length).toBe(3);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.every(
      (bounty) => bounty.launch_armed === true
        && bounty.activation === 'explicit_pvt9_launch_activation',
    )).toBe(true);
  });

  test('contains exact decided 75/75/25 fixed grants in atomic units', () => {
    const bounty = (key: string) => {
      const found = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.find(
        (entry) => entry.canonical_bounty_key === key,
      );
      if (!found) throw new Error(`Missing bounty ${key}`);
      return found;
    };
    expect(bounty('genesis_human_signup').fixed_grant_atomic).toBe('75000000000000000000');
    expect(bounty('genesis_signup').fixed_grant_atomic).toBe('75000000000000000000');
    expect(bounty('genesis_device_link').fixed_grant_atomic).toBe('25000000000000000000');
  });

  test('has the 500 PVT wallet ceiling and no pool, action, or participant cap', () => {
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.caps.per_wallet_lifetime_atomic)
      .toBe('500000000000000000000');
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.caps.per_wallet_lifetime_atomic)
      .toMatch(ATOMIC_PATTERN);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.caps).toMatchObject({
      admission_total_pool: 'none',
      aggregate_per_action_caps: 'none',
      participant_cap: 'none',
      reservation_rule: 'minimum_of_fixed_grant_and_wallet_lifetime_remaining',
      debit_semantics: 'compare_and_swap_wallet_ledger_dedupe_and_reservation_atomically',
    });
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.caps.approval.per_wallet_lifetime.status)
      .toBe('gate_1_plain_english_approved');
    for (const bounty of PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties) {
      expect(bounty.fixed_grant_atomic).toMatch(ATOMIC_PATTERN);
    }
  });

  test('contains exactly the three decided reward legs and no retired aliases', () => {
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.map(
      (entry) => entry.canonical_bounty_key,
    )).toEqual([
      'genesis_human_signup',
      'genesis_signup',
      'genesis_device_link',
    ]);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.every(
      (entry) => entry.fixed_grant_approval.status === 'gate_1_plain_english_approved',
    )).toBe(true);
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.every(
      (entry) => entry.emitted_action_types.length === 1,
    )).toBe(true);
  });

  test('declares a constant grant multiplier with no time-based reduction ', () => {
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.grant_multiplier).toMatchObject({
      mode: 'fixed_grant_no_time_based_reduction',
      multiplier_bps: 10_000,
      multiplier_formula: 'constant_10000_bps_independent_of_elapsed_time',
      grant_formula: 'fixed_grant_atomic',
      rounding: 'exact_no_rounding',
    });
    // The retired taper's inputs are GONE from the shape, not merely unused, so
    // the curve cannot be restored by flipping a mode on stored config.
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY).not.toHaveProperty('decay');
    const keys = Object.keys(PROPOSED_GENESIS_CAMPAIGN_POLICY.grant_multiplier);
    expect(keys).not.toContain('wallet_age_half_life_ms');
    expect(keys).not.toContain('minimum_multiplier_bps');
    expect(keys).not.toContain('algorithm_version');
  });

  test('uses a registered-device anchor, not hardware or physical attestation', () => {
    const device = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.find(
      (entry) => entry.canonical_bounty_key === 'genesis_device_link',
    );
    expect(device?.dedupe).toMatchObject({
      required_anchor: 'registered_device_id',
      missing_anchor_behavior: 'deny_grant_fail_closed',
    });
  });

  test('declares weekly settlement pacing without turning it into admission', () => {
    expect(PROPOSED_GENESIS_CAMPAIGN_POLICY.settlement).toEqual(expect.objectContaining({
      admission_independent: true,
      epoch_duration_seconds: 604_800,
      initial_genesis_sub_budget_atomic: '7500000000000000000000000',
      initial_combined_system_cap_atomic: '10000000000000000000000000',
      initial_flat_epoch_count: 12,
      post_flat_policy: 'two_times_trailing_average_evented_adjustable',
      genesis_sub_budget_change_control: 'append_only_signed_effective_epoch_policy_events',
      initial_event_binding: 'exact_launch_approval_manifest',
      epoch_snapshot_rule: 'event_id_hash_approval_hash_immutable_per_epoch',
      backlog_behavior: 'durable_until_settled_no_reprice_no_cancel',
    }));
  });

  test('keeps the generated capacity model exact across the post-flat transition', () => {
    const capacity = JSON.parse(fs.readFileSync(CAPACITY_MODEL_SOURCE, 'utf8')) as {
      schema_version: string;
      exact_policy_inputs: Record<string, unknown>;
      interpretation: Record<string, unknown>;
    };
    expect(capacity.schema_version).toBe('pvt-launch-capacity-model/v3');
    expect(capacity.exact_policy_inputs).toMatchObject({
      initial_flat_epoch_count: 12,
      post_flat_combined_epoch_cap_rule: 'exactly_two_times_trailing_average',
      post_flat_trend_tolerance: 'none',
      zero_trailing_average_behavior:
        'zero_combined_epoch_cap_until_authorized_prospective_policy_event',
      post_flat_change_control: 'authorized_prospective_policy_event_only',
    });
    expect(capacity.interpretation).toMatchObject({
      epoch_transition:
        'twelve_flat_epochs_then_exactly_two_times_trailing_average_with_zero_average_equal_to_zero_cap',
      scenario_epoch_estimates_scope:
        'initial_flat_epoch_caps_only_post_flat_capacity_depends_on_actual_trailing_issuance',
    });
  });

  test('contains no external-value or cross-asset quantity surface', () => {
    const serialized = JSON.stringify(PROPOSED_GENESIS_CAMPAIGN_POLICY).toLowerCase();
    expect(serialized).not.toMatch(/\busd\b|dollar|\bprice\b|conversion|external_value|external_asset_amount/);
  });
});

describe('atomic accounting proposed PVT-native cost catalog', () => {
  test('is inert, complete by institution, and has no duplicate cost id', () => {
    expect(PROPOSED_PVT_COST_CATALOG.status).toBe('requires_frank_approval');
    expect(PROPOSED_PVT_COST_CATALOG.effective_at).toBeNull();
    const ids = PROPOSED_PVT_COST_ENTRIES.map((entry) => entry.cost_id);
    expect(ids).toHaveLength(81);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(PROPOSED_PVT_COST_ENTRIES.map((entry) => entry.institution))).toEqual(
      new Set(['escrow', 'promise', 'pool', 'job', 'bond', 'court', 'membership', 'governance']),
    );
  });

  test('defers every proposed cost authority to the separate PVT9 authority table', () => {
    for (const entry of PROPOSED_PVT_COST_ENTRIES) {
      expect(entry.authority.proposed).toBe(
        'deferred_not_gate_1_approved_requires_separate_pvt9_authority_table',
      );
    }
  });

  test('explicitly catalogs every launch cost, lock, slash, lifecycle period, and adjustment bound', () => {
    const requiredByInstitution: Readonly<Record<string, readonly string[]>> = {
      escrow: [
        'escrow.pvt_principal_fee',
        'escrow.pvt_principal_cap',
        'escrow.maximum_auto_release_period',
        'escrow.maximum_agreement_deadline',
        'escrow.dispute_resolution_timeout',
      ],
      promise: [
        'promise.pvt_settlement_fee',
        'promise.pvt_principal_cap',
        'promise.maximum_deadline',
        'promise.default_grace_period',
      ],
      pool: [
        'pool.pvt_execution_fee',
        'pool.pvt_threshold_cap',
        'pool.maximum_deadline',
        'pool.maximum_contributors',
      ],
      job: [
        'job.pvt_settlement_cost',
        'job.pvt_budget_cap',
        'job.maximum_deadline',
        'job.maximum_auto_release_period',
        'job.maximum_applications',
      ],
      bond: [
        'bond.level_2_base_lock',
        'bond.level_3_base_lock',
        'bond.maximum_total_deposit',
        'bond.top_up_collateral_shortfall',
        'bond.trust_discount',
        'bond.deposit_burn',
        'bond.deposit_protocol_fee',
        'bond.renewal_burn',
        'bond.renewal_protocol_fee',
        'bond.claim_filing_fee',
        'bond.claim_processing_fee',
        'bond.slash_burn_share',
        'bond.slash_claimant_share',
        'bond.minimum_slash_amount_share',
        'bond.renewal_period',
        'bond.renewal_grace_period',
        'bond.abandonment_period',
        'bond.claim_resolution_timeout',
        'bond.parameter_change_window',
        'bond.maximum_increase_per_parameter_window',
        'bond.maximum_decrease_per_parameter_window',
        'bond.maximum_pending_claims',
      ],
      court: [
        'court.current_generic_reputation_stake_minimum',
        'court.proposed_arbitrator_case_collateral',
        'court.generic_reputation_slash_burn_share',
        'court.generic_reputation_slash_recipient_share',
        'court.generic_reputation_maximum_slash_share',
        'court.proposed_case_collateral_maximum_slash_share',
        'court.case_collateral_slash_equivocation',
        'court.case_collateral_slash_accepted_duty_nonresponse',
        'court.case_collateral_slash_finalized_ineligible_vote_acceptance',
        'court.case_collateral_slash_rejected_attempt',
        'court.case_collateral_slash_minority_vote',
        'court.case_collateral_slash_adverse_verdict',
        'court.case_collateral_slash_unproven_collusion',
        'court.bootstrap_case_collateral_maximum_slash_share',
        'court.panel_voting_period',
        'court.general_dispute_evidence_period',
        'court.arbitrator_misconduct_notice_period',
        'court.arbitrator_misconduct_appeal_period',
        'court.bootstrap_escrow_result_appeal_period',
        'court.bootstrap_bond_claim_evidence_period',
        'court.panel_size',
        'court.minimum_eligible_arbitrators',
        'court.maximum_open_disputes_per_wallet',
      ],
      membership: [
        'membership.annual_fee',
        'membership.membership_period',
        'membership.grace_period',
        'membership.renewal_window',
        'membership.fee_change_delay',
        'membership.fee_burn_share',
      ],
      governance: [
        'governance.proposal_burn',
        'governance.minimum_proposer_balance',
        'governance.agent_operational_quorum',
        'governance.agent_operational_voter_weight_cap',
        'governance.agent_operational_voting_period',
        'governance.agent_operational_execution_delay',
        'governance.agent_operational_execution_window',
        'governance.human_economic_proposal_cost',
        'governance.human_economic_supermajority',
        'governance.human_economic_voting_period',
        'governance.human_economic_execution_delay',
        'governance.human_economic_execution_window',
      ],
    };

    const required = Object.values(requiredByInstitution).flat().sort();
    const actual = PROPOSED_PVT_COST_ENTRIES.map((entry) => entry.cost_id).sort();
    expect(actual).toEqual(required);
    for (const [institution, ids] of Object.entries(requiredByInstitution)) {
      expect(ids.every((id) => costFor(id).institution === institution)).toBe(true);
    }
  });

  test('contains exact proposed institution costs and inheritance', () => {
    expect(costFor('escrow.pvt_principal_fee').rule).toMatchObject({ kind: 'basis_points', initial_bps: 50 });
    expect(costFor('promise.pvt_settlement_fee').rule).toMatchObject({ kind: 'basis_points', initial_bps: 25 });
    expect(costFor('pool.pvt_execution_fee').rule).toMatchObject({ kind: 'basis_points', initial_bps: 50 });
    expect(costFor('job.pvt_settlement_cost').rule).toEqual({
      kind: 'inherits',
      inherited_cost_id: 'escrow.pvt_principal_fee',
    });
    expect(costFor('membership.annual_fee')).toMatchObject({
      rule: { kind: 'fixed_atomic', initial_atomic: '50000000000000000000' },
    });
    expect(costFor('governance.proposal_burn')).toMatchObject({
      rule: { kind: 'fixed_atomic', initial_atomic: '50000000000000000000' },
    });
  });

  test('declares standalone PVT principal caps as atomic policy values', () => {
    expect(costFor('escrow.pvt_principal_cap').rule).toMatchObject({
      kind: 'fixed_atomic', initial_atomic: '10000000000000000000000',
    });
    expect(costFor('promise.pvt_principal_cap').rule).toMatchObject({
      kind: 'fixed_atomic', initial_atomic: '5000000000000000000000',
    });
    expect(costFor('pool.pvt_threshold_cap').rule).toMatchObject({
      kind: 'fixed_atomic', initial_atomic: '25000000000000000000000',
    });
    expect(costFor('job.pvt_budget_cap').rule).toMatchObject({
      kind: 'fixed_atomic', initial_atomic: '10000000000000000000000',
    });
  });

  test('contains exact proposed bond ladder and fee values', () => {
    expect(costFor('bond.level_2_base_lock').rule).toMatchObject({
      kind: 'fixed_atomic',
      initial_atomic: '750000000000000000000',
    });
    expect(costFor('bond.level_3_base_lock').rule).toMatchObject({
      kind: 'fixed_atomic',
      initial_atomic: '3000000000000000000000',
    });
    expect(costFor('bond.trust_discount')).toMatchObject({
      rule: { kind: 'basis_points', initial_bps: 0, minimum_bps: 0, maximum_bps: 0 },
      approval: { status: 'requires_frank_approval' },
    });
    expect(costFor('bond.deposit_burn').rule).toMatchObject({ kind: 'basis_points', initial_bps: 200 });
    expect(costFor('bond.deposit_protocol_fee').rule).toMatchObject({ kind: 'basis_points', initial_bps: 100 });
    expect(costFor('bond.renewal_burn').rule).toMatchObject({
      kind: 'basis_points',
      initial_bps: 100,
      calculation_basis: 'applicable_required_slashable_collateral_atomic_at_renewal',
      rounding: 'floor_to_atomic_unit',
    });
    expect(costFor('bond.renewal_protocol_fee').rule).toMatchObject({
      kind: 'basis_points',
      initial_bps: 50,
      calculation_basis: 'applicable_required_slashable_collateral_atomic_at_renewal',
      rounding: 'floor_to_atomic_unit',
    });
    expect(costFor('bond.renewal_burn').snapshot.proposed).toBe('action_execution');
    expect(costFor('bond.renewal_protocol_fee').snapshot.proposed).toBe('action_execution');
    expect(costFor('bond.top_up_collateral_shortfall')).toMatchObject({
      rule: {
        kind: 'required_collateral_shortfall',
        formula: 'max(0,applicable_required_lock_atomic-current_slashable_collateral_atomic)',
      },
    });
    expect(costFor('bond.claim_filing_fee').rule).toMatchObject({
      kind: 'fixed_atomic',
      initial_atomic: '15000000000000000000',
    });
    expect(costFor('bond.claim_processing_fee').rule).toMatchObject({
      kind: 'fixed_atomic',
      initial_atomic: '30000000000000000000',
    });
    expect(costFor('bond.renewal_burn').disposition).toMatchObject({
      burn: 'burned_from_new_renewal_payment_never_from_locked_collateral',
      slash: 'never_reduces_existing_slashable_collateral',
    });
    expect(costFor('bond.claim_processing_fee').disposition).toMatchObject({
      lock: 'claimant_prepays_and_locks_processing_fee_at_claim_filing',
      slash: 'respondent_collateral_is_never_charged_on_dismissal_expiry_or_frivolous_claim',
    });
    expect(costFor('bond.slash_burn_share').rule).toMatchObject({ kind: 'basis_points', initial_bps: 2_000 });
    expect(costFor('bond.slash_claimant_share').rule).toMatchObject({ kind: 'basis_points', initial_bps: 8_000 });
    expect(costFor('bond.minimum_slash_amount_share').rule).toMatchObject({ kind: 'basis_points', initial_bps: 5_000 });
  });

  test('captures exact proposed lifecycle periods, grace windows, and velocity limits', () => {
    expect(costFor('escrow.dispute_resolution_timeout').rule).toMatchObject({
      kind: 'duration_seconds', current_seconds: null, proposed_initial_seconds: 2_592_000,
    });
    expect(costFor('promise.default_grace_period').rule).toMatchObject({
      kind: 'duration_seconds', current_seconds: null, proposed_initial_seconds: 86_400,
    });
    expect(costFor('bond.renewal_period').rule).toEqual({
      kind: 'duration_seconds',
      current_seconds: null,
      proposed_initial_seconds: 7_776_000,
      minimum_seconds: 2_592_000,
      maximum_seconds: 31_536_000,
    });
    expect(costFor('bond.renewal_grace_period').rule).toMatchObject({
      kind: 'duration_seconds', current_seconds: null, proposed_initial_seconds: 1_209_600,
    });
    expect(costFor('bond.abandonment_period').rule).toEqual({
      kind: 'duration_seconds',
      current_seconds: null,
      proposed_initial_seconds: 15_552_000,
      minimum_seconds: 7_776_000,
      maximum_seconds: 63_072_000,
    });
    expect(costFor('bond.claim_resolution_timeout').rule).toMatchObject({
      kind: 'duration_seconds', current_seconds: null, proposed_initial_seconds: 5_184_000,
    });
    expect(costFor('bond.parameter_change_window')).toMatchObject({
      rule: {
        kind: 'duration_seconds', current_seconds: null, proposed_initial_seconds: 2_592_000,
      },
    });
    expect(costFor('membership.fee_change_delay').rule).toMatchObject({
      kind: 'duration_seconds',
      current_seconds: null,
      proposed_initial_seconds: 172_800,
      minimum_seconds: 172_800,
    });
  });

  test('keeps the proposed Court evidence period explicit without a live claim', () => {
    expect(costFor('court.general_dispute_evidence_period')).toMatchObject({
      rule: {
        kind: 'duration_seconds',
        current_seconds: null,
        proposed_initial_seconds: 604_800,
        minimum_seconds: 86_400,
        maximum_seconds: 2_592_000,
      },
      approval: { status: 'requires_frank_approval' },
    });
  });

  test('proposes explicit seven-day Court notice, appeal, and bootstrap evidence windows', () => {
    const expectedMinimum = new Map<string, number>([
      ['court.arbitrator_misconduct_notice_period', 172_800],
      ['court.arbitrator_misconduct_appeal_period', 172_800],
      ['court.bootstrap_escrow_result_appeal_period', 86_400],
      ['court.bootstrap_bond_claim_evidence_period', 172_800],
    ]);
    for (const [id, minimumSeconds] of expectedMinimum) {
      expect(costFor(id)).toMatchObject({
        rule: {
          kind: 'duration_seconds',
          current_seconds: null,
          proposed_initial_seconds: 604_800,
          minimum_seconds: minimumSeconds,
          maximum_seconds: 2_592_000,
        },
        approval: { status: 'requires_frank_approval' },
      });
    }
    expect(costFor('court.bootstrap_escrow_result_appeal_period').disposition.slash).toBe(
      'bootstrap_without_a_panel_never_slashes',
    );
    expect(costFor('court.bootstrap_bond_claim_evidence_period').disposition.slash).toBe(
      'bootstrap_without_a_panel_never_slashes',
    );
  });

  test('keeps paired slash schedules internally consistent', () => {
    const bps = (id: string): number => {
      const rule = costFor(id).rule;
      if (rule.kind !== 'basis_points') throw new Error(`${id} is not a basis-point rule`);
      return rule.initial_bps;
    };
    expect(bps('bond.slash_burn_share') + bps('bond.slash_claimant_share')).toBe(10_000);
    expect(
      bps('court.generic_reputation_slash_burn_share')
      + bps('court.generic_reputation_slash_recipient_share'),
    ).toBe(10_000);
    expect(bps('court.generic_reputation_maximum_slash_share')).toBe(10_000);
    expect(bps('court.proposed_case_collateral_maximum_slash_share')).toBe(10_000);
  });

  test('defines exact objective CourtStake misconduct slashes and explicit non-offenses', () => {
    const exactBps = (id: string): number => {
      const entry = costFor(id);
      if (entry.rule.kind !== 'basis_points') throw new Error(`${id} is not a slash rule`);
      expect(entry.rule.minimum_bps).toBe(entry.rule.initial_bps);
      expect(entry.rule.maximum_bps).toBe(entry.rule.initial_bps);
      expect(entry.approval.status).toBe('requires_frank_approval');
      return entry.rule.initial_bps;
    };

    expect(exactBps('court.case_collateral_slash_equivocation')).toBe(10_000);
    expect(exactBps('court.case_collateral_slash_accepted_duty_nonresponse')).toBe(2_500);
    expect(exactBps('court.case_collateral_slash_finalized_ineligible_vote_acceptance')).toBe(10_000);

    for (const id of [
      'court.case_collateral_slash_rejected_attempt',
      'court.case_collateral_slash_minority_vote',
      'court.case_collateral_slash_adverse_verdict',
      'court.case_collateral_slash_unproven_collusion',
      'court.bootstrap_case_collateral_maximum_slash_share',
    ]) {
      expect(exactBps(id)).toBe(0);
    }
    expect(costFor('court.case_collateral_slash_equivocation').disposition.slash).toContain(
      'conflicting_cryptographically_signed_votes',
    );
    expect(costFor('court.case_collateral_slash_accepted_duty_nonresponse').disposition.slash).toContain(
      'accepted_duty_valid_notice_and_expired_response_deadline',
    );
    expect(
      costFor('court.case_collateral_slash_finalized_ineligible_vote_acceptance').disposition.slash,
    ).toContain('accepted_into_a_finalized_round');
    expect(costFor('court.bootstrap_case_collateral_maximum_slash_share').disposition.slash).toBe(
      'bootstrap_without_a_panel_never_slashes',
    );
  });

  test('keeps the agent-operational voting cap at the constitutional one-percent ceiling', () => {
    expect(costFor('governance.agent_operational_voter_weight_cap').rule).toEqual({
      kind: 'basis_points',
      initial_bps: 100,
      minimum_bps: 1,
      maximum_bps: 100,
      calculation_basis: 'total_raw_agent_weight_at_proposal_snapshot',
      rounding: 'floor_to_basis_unit',
    });
  });

  test('uses valid atomic, basis-point, duration, and integer bounds with explicit policy metadata', () => {
    const ids = new Set(PROPOSED_PVT_COST_ENTRIES.map((entry) => entry.cost_id));
    for (const entry of PROPOSED_PVT_COST_ENTRIES) {
      expect(entry.authority.current).toBe('unverified_not_an_approval_basis');
      expect(entry.authority.proposed.length).toBeGreaterThan(0);
      expect(entry.activation.current_delay_seconds).toBeNull();
      expect(entry.activation.proposed_minimum_delay_seconds).toBeGreaterThan(0);
      expect(entry.activation.effective_policy_version_required).toBe(true);
      expect(entry.activation.effective_boundary).toBe('effective_at');
      expect(entry.activation.prospective_only).toBe(true);
      expect(entry.snapshot.current).toBe('unverified');
      expect(entry.snapshot.proposed.length).toBeGreaterThan(0);
      expect(entry.disposition.cost_pe_mint_disposition).toBe('record_only');

      if (entry.rule.kind === 'basis_points') {
        expect(Number.isInteger(entry.rule.initial_bps)).toBe(true);
        expect(entry.rule.minimum_bps).toBeLessThanOrEqual(entry.rule.initial_bps);
        expect(entry.rule.initial_bps).toBeLessThanOrEqual(entry.rule.maximum_bps);
        expect(entry.rule.maximum_bps).toBeLessThanOrEqual(10_000);
        expect(entry.rule.calculation_basis.length).toBeGreaterThan(0);
        expect([
          'floor_to_atomic_unit',
          'floor_to_basis_unit',
          'ceil_to_basis_unit',
        ]).toContain(entry.rule.rounding);
      } else if (entry.rule.kind === 'fixed_atomic') {
        expect(entry.rule.initial_atomic).toMatch(ATOMIC_PATTERN);
        expect(entry.rule.minimum_atomic).toMatch(ATOMIC_PATTERN);
        expect(entry.rule.maximum_atomic).toMatch(ATOMIC_PATTERN);
        expect(BigInt(entry.rule.minimum_atomic)).toBeLessThanOrEqual(BigInt(entry.rule.initial_atomic));
        expect(BigInt(entry.rule.initial_atomic)).toBeLessThanOrEqual(BigInt(entry.rule.maximum_atomic));
      } else if (entry.rule.kind === 'duration_seconds') {
        if (entry.rule.current_seconds !== null) {
          expect(Number.isSafeInteger(entry.rule.current_seconds)).toBe(true);
          expect(entry.rule.current_seconds).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isSafeInteger(entry.rule.proposed_initial_seconds)).toBe(true);
        expect(Number.isSafeInteger(entry.rule.minimum_seconds)).toBe(true);
        expect(Number.isSafeInteger(entry.rule.maximum_seconds)).toBe(true);
        expect(entry.rule.minimum_seconds).toBeGreaterThanOrEqual(0);
        expect(entry.rule.minimum_seconds).toBeLessThanOrEqual(entry.rule.proposed_initial_seconds);
        expect(entry.rule.proposed_initial_seconds).toBeLessThanOrEqual(entry.rule.maximum_seconds);
      } else if (entry.rule.kind === 'integer_limit') {
        expect(Number.isSafeInteger(entry.rule.initial_value)).toBe(true);
        expect(Number.isSafeInteger(entry.rule.minimum_value)).toBe(true);
        expect(Number.isSafeInteger(entry.rule.maximum_value)).toBe(true);
        expect(entry.rule.minimum_value).toBeGreaterThanOrEqual(0);
        expect(entry.rule.minimum_value).toBeLessThanOrEqual(entry.rule.initial_value);
        expect(entry.rule.initial_value).toBeLessThanOrEqual(entry.rule.maximum_value);
      } else if (entry.rule.kind === 'required_collateral_shortfall') {
        expect(entry.rule.formula).toBe(
          'max(0,applicable_required_lock_atomic-current_slashable_collateral_atomic)',
        );
        expect(entry.rule.requirement_cost_ids).toEqual([
          'bond.level_2_base_lock',
          'bond.level_3_base_lock',
        ]);
        expect(ids.has(entry.rule.maximum_cost_id)).toBe(true);
      } else {
        expect(ids.has(entry.rule.inherited_cost_id)).toBe(true);
        expect(entry.rule.inherited_cost_id).not.toBe(entry.cost_id);
      }
    }
  });

  test('keeps every quantity PVT-native with no cross-asset derivation', () => {
    const serialized = JSON.stringify(PROPOSED_PVT_COST_CATALOG).toLowerCase();
    expect(serialized).not.toMatch(/usd|dollar|price|conversion|equivalent_value/);
  });

  test('narrowly labels all 81 rows as proposal choices, not generic source-verified live claims', () => {
    for (const entry of PROPOSED_PVT_COST_ENTRIES) {
      expect(entry.evidence.verification_method).toBe(
        'proposal_only_not_source_verified',
      );
      expect(entry.evidence.reviewed_git_commit).toBeNull();
      expect(entry.evidence.source_paths).toEqual([]);
      expect(entry.evidence.semantic_claim_scope).toBe('proposed_parameter_choice_only');
      expect(entry.evidence.current_live_behavior_status)
        .toBe('unverified_not_an_approval_basis');
      expect(Object.prototype.hasOwnProperty.call(entry, 'current_live_behavior')).toBe(false);
      if (entry.rule.kind === 'duration_seconds') {
        expect(entry.rule.current_seconds).toBeNull();
      }
    }
  });

  test('Court case collateral is an affordability-gated proposal with no verified current claim', () => {
    expect(costFor('court.proposed_arbitrator_case_collateral')).toMatchObject({
      snapshot: { current: 'unverified', proposed: 'action_execution' },
      approval: { status: 'requires_affordability_and_frank_approval' },
      disposition: {
        cost_pe_mint_disposition: 'record_only',
        slash: 'case_outcome_alone_never_proves_arbitrator_misconduct',
      },
    });
  });
});

// Exact compatibility with the activation-bound manifest predates the source cleanup.
describe('frozen Genesis manifest data', () => {
  it('keeps the existing activation and reservation hash', () => {
    expect(hashGenesisCampaignPolicyManifest(PROPOSED_GENESIS_CAMPAIGN_POLICY))
      .toBe('sha256:63b94b743e39bf96efe8d4c10a5c1fa57c2cc8b6f2b35d71d9b244c55fee13d7');
    expect(() => assertFrozenGenesisManifest(PROPOSED_GENESIS_CAMPAIGN_POLICY)).not.toThrow();
  });
  it('refuses an altered field or a malformed manifest before exposing typed policy data', () => {
    expect(() => assertFrozenGenesisManifest({ ...PROPOSED_GENESIS_CAMPAIGN_POLICY, chain_id: 1 }))
      .toThrow('frozen_genesis_manifest_mismatch');
    expect(() => assertFrozenGenesisManifest({})).toThrow('frozen_genesis_manifest_mismatch');
    expect(() => assertFrozenGenesisManifest(null)).toThrow('frozen_genesis_manifest_mismatch');
  });
});
