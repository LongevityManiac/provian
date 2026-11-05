/**
 * Shared, PRODUCTION-FAITHFUL fixture builders for the two PE document shapes.
 *
 * The escrow/promise/job corroboration bug, the forge-webhook corroboration bug,
 * and the court general-dispute standing bug all had the SAME root cause: test
 * fixtures that hand-rolled a pe_history or provenance_envelopes document with the
 * WRONG shape (hash under `hash` instead of `peHash`, a `metadata` map that
 * pe_history never has, snake_case identity fields on pe_history, etc.). The
 * fixtures gave green tests while the production read silently returned undefined.
 *
 * Use these builders instead of hand-rolling PE docs. The canonical field sets
 * below mirror the REAL writers; the contract test (pe-doc-shape-contract.test.ts)
 * invokes those writers and asserts their output matches, so if a writer changes
 * shape the contract test fails and these builders must be updated in lockstep.
 *
 *   pe_history          ← writePEHistory()  in src/pe-history.ts (+ pvt-accrual backfill)
 *   provenance_envelopes ← buildStoredDoc()  in src/core/agent-bank/pe-utils.ts
 *                          (+ buildMobileStoredDoc/buildSubmitStoredDoc variants)
 *
 * CRITICAL DISTINCTIONS (the exact things the bugs got wrong):
 *   pe_history          : hash field is **peHash**; identity is **userId**; action is **actionType**;
 *                         id is **peId**; has **NO `metadata`** and **NO top-level `hash`**.
 *   provenance_envelopes: hash field is **hash**; HAS a **metadata** map; identity is snake_case
 *                         **user_id / wallet_id / agent_id**; action is **action_type**; id is **id**.
 */

/** Canonical field names written by writePEHistory() (src/pe-history.ts). */
export const PE_HISTORY_FIELDS: readonly string[] = [
  'peId', 'userId', 'timestamp', 'actionType', 'category', 'attestationDepth',
  'contributionValue', 'estimatedPVT', 'peHash', 'inputSummary', 'outputSummary',
  'hidden', 'mint_status', 'jurisdiction_context', 'jurisdiction_region', 'jurisdiction_compliance_reason', 'jurisdiction_mint_held', 'deferred_since', 'tx_hash',
  'commit_sha',
  // the completion witness marker (on-chain rows at seal; the resolver
  // writes the off-chain marker on promotion).
  'completion_canonical_id', 'completion_witness',
  'mint_disposition', 'disposition_reason_code', 'policy_review_state',
  'policy_review_reason_code', 'economic_policy_version', 'economic_snapshot',
  'economic_snapshot_hash', 'economic_eligibility_projection',
  'record_points_atomic', 'estimated_pvt_atomic',
  'audit_hold', 'audit_window_expires_at', 'attestation_verified',
  'corroboration_status', 'corroboration_source', 'corroboration_received_at',
  'replication_pack', 'beneficiary_wallet_id', 'pvt_split',
  'beneficiary_routing_snapshot', 'beneficiary_routing_snapshot_hash',
  'mint_once_claim_evidence', 'mint_once_claim_evidence_hash',
  'fixed_estimated_pvt_override', 'is_genesis_grant', 'farm_cap_reason',
  'activity_mint_reservation', 'activity_mint_reservation_hash',
  'genesis_wallet_id', 'genesis_funding_source_address', 'genesis_reserved_pvt',
  'deferred_epoch',
  'attestation_multiplier_at_anchor', 'cited_pe_ids', 'parent_goal_pe_id',
  // M5: born marked — the seal applies the row to its aggregates.
  'economic_aggregate_applied',
  // H5: the write-time index shard leading the sharded composite indexes.
  'index_shard',
  // D-OPS (2026-09-14): which capture lane produced the PE (core/pvt/capture-lane.ts).
  'capture_lane',
  // Trust Layer build (2026-09-16): citable outputs, witness class, relay receipt time.
  'output_digests', 'witness_class', 'witnessed_at_ms',
];

/** Canonical field names written by buildStoredDoc() (src/core/agent-bank/pe-utils.ts). */
export const PROVENANCE_ENVELOPE_FIELDS: readonly string[] = [
  'id', 'wallet_id', 'agent_id', 'action_type', 'actor_address', 'timestamp',
  'prev_hash', 'attestation_type', 'metadata', 'compute', 'geo', 'execution_env',
  'cited_pe_ids', 'parent_goal_pe_id', 'hash', 'user_id', 'counterparty_address',
  'counterparty_type', 'session_lineage', 'self_referencing',
  'trust_level_at_creation', 'created_at', 'policy_action_type',
  'integration_source', 'durability',
  // Trust Layer build (2026-09-16): relay-assigned, UNHASHED mirrors on the stored envelope.
  'witness_class', 'witnessed_at_ms',
];

export interface PeHistoryOverrides {
  peId?: string;
  userId?: string;
  peHash?: string;
  actionType?: string;
  corroboration_status?: string;
  corroboration_source?: string | null;
  corroboration_received_at?: number | null;
  mint_status?: string;
  tx_hash?: string;
  [k: string]: unknown;
}

/**
 * Build a PRODUCTION-shaped pe_history document. Every key here is a real
 * writePEHistory field; there is NO `hash`, NO `metadata`, NO snake_case identity.
 */
export function makePeHistoryDoc(overrides: PeHistoryOverrides = {}): Record<string, unknown> {
  const peId = overrides.peId ?? 'pe_test';
  return {
    peId,
    userId: 'agent-1',
    timestamp: 1_700_000_000_000,
    actionType: 'coding_session',
    category: 'agent', // PVTCategory: 'wallet' | 'agent' | 'x402' | 'promises' | 'other'
    attestationDepth: 'software',
    contributionValue: 1.0,
    estimatedPVT: 1,
    peHash: 'pehash_test',
    inputSummary: null,
    outputSummary: null,
    hidden: false,
    mint_status: 'eligible',
    mint_disposition: 'eligible',
    disposition_reason_code: 'policy_eligible',
    policy_review_state: 'not_required',
    policy_review_reason_code: 'known_policy_entry',
    economic_policy_version: 'legacy-live-policy-at-wp1-cut-line-2026-07-11',
    economic_snapshot: null,
    economic_snapshot_hash: null,
    economic_eligibility_projection: null,
    record_points_atomic: '0',
    estimated_pvt_atomic: '0',
    jurisdiction_context: 'US',
    deferred_since: null,
    audit_hold: true,
    audit_window_expires_at: null,
    attestation_verified: false,
    corroboration_status: 'none',
    corroboration_source: null,
    corroboration_received_at: null,
    replication_pack: null,
    beneficiary_wallet_id: null,
    pvt_split: null,
    beneficiary_routing_snapshot: null,
    beneficiary_routing_snapshot_hash: null,
    mint_once_claim_evidence: [],
    mint_once_claim_evidence_hash: null,
    fixed_estimated_pvt_override: false,
    is_genesis_grant: false,
    farm_cap_reason: null,
    activity_mint_reservation: null,
    activity_mint_reservation_hash: null,
    genesis_wallet_id: null,
    genesis_funding_source_address: null,
    genesis_reserved_pvt: null,
    deferred_epoch: null,
    attestation_multiplier_at_anchor: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
    ...overrides,
  };
}

export interface ProvenanceEnvelopeOverrides {
  id?: string;
  user_id?: string;
  wallet_id?: string;
  agent_id?: string;
  hash?: string;
  action_type?: string;
  actor_address?: string;
  counterparty_address?: string | null;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Build a PRODUCTION-shaped provenance_envelopes document. Hash is under `hash`,
 * there is a `metadata` map, and identity is snake_case.
 */
export function makeProvenanceEnvelopeDoc(
  overrides: ProvenanceEnvelopeOverrides = {},
): Record<string, unknown> {
  const id = overrides.id ?? 'pe_test';
  const owner = overrides.user_id ?? overrides.agent_id ?? 'agent-1';
  return {
    id,
    wallet_id: overrides.wallet_id ?? 'wallet-1',
    agent_id: overrides.agent_id ?? owner,
    action_type: 'coding_session',
    actor_address: '0xactor',
    timestamp: 1_700_000_000_000,
    prev_hash: 'prev_test',
    attestation_type: 'software',
    metadata: {},
    compute: null,
    geo: null,
    execution_env: null,
    cited_pe_ids: null,
    parent_goal_pe_id: null,
    hash: 'envhash_test',
    user_id: owner,
    counterparty_address: null,
    counterparty_type: null,
    session_lineage: null,
    self_referencing: false,
    trust_level_at_creation: null,
    created_at: 1_700_000_000_000,
    policy_action_type: overrides.action_type ?? 'coding_session',
    integration_source: 'agent_bank_generate_pe',
    durability: 'final',
    ...overrides,
  };
}

/**
 * Build the matching pair of docs for a single PE that participates in
 * cross-witness / backend corroboration: the immutable envelope carries the
 * canonical `hash` (+ optional `metadata.commit_sha`), and the derived
 * pe_history mirror carries the SAME value under `peHash` plus the
 * corroboration_status the writeback will mutate. This is exactly the
 * production relationship (hash === peHash; commit_sha only on the envelope).
 */
export function makeCorroborationTargetDocs(opts: {
  peId: string;
  userId: string;
  hash: string;
  agentId?: string;
  walletId?: string;
  commitSha?: string;
  counterpartyAddress?: string | null;
  corroboration_status?: string;
}): { history: Record<string, unknown>; envelope: Record<string, unknown> } {
  const agentId = opts.agentId ?? opts.userId;
  return {
    history: makePeHistoryDoc({
      peId: opts.peId,
      userId: opts.userId,
      peHash: opts.hash,
      corroboration_status: opts.corroboration_status ?? 'none',
    }),
    envelope: makeProvenanceEnvelopeDoc({
      id: opts.peId,
      user_id: opts.userId,
      agent_id: agentId,
      wallet_id: opts.walletId ?? opts.userId,
      hash: opts.hash,
      ...(opts.counterpartyAddress !== undefined
        ? { counterparty_address: opts.counterpartyAddress }
        : {}),
      ...(opts.commitSha ? { metadata: { commit_sha: opts.commitSha } } : {}),
    }),
  };
}

// ─── PE METER ─────────────────────────────────────────────────────
//
// The relay no longer writes `provenance_envelopes` or `pe_history` for a relay-authored PE (the
// two builders above now describe PRE-METER rows only, still read by legacy fallbacks until the
// migration). What the relay keeps, and what its owner receives:
//
//   the relay PE v2      ← generatePE → relayPeOf (src/core/meter/meter-relay-authored.ts): the
//                          object whose `peHashOf` is the chain-tip hash; the OWNER receives it
//                          sealed (never stored readable). Identity is pe_id/device_id/prev_hash/
//                          timestamp/action_type/schema; everything else is hashed content.
//   the act record       ← actRecordOf (src/core/meter/meter-wire.ts): pe_id, pe_hash, prev_hash,
//                          timestamp, action_type + `pricing` (the PE minus identity/free text).
//   meter_relay_acts_v1  ← stageRelayActInTransaction: the transient intake (act + accrual inputs
//                          + sealed copies), committed with the chain tip.
//   meter_act_keys_v1    ← commitMeterBatch: the 31-day act key; `.row` is the pe_history-shaped
//                          priced row (PE_HISTORY_FIELDS), `.pe_hash` the canonical hash,
//                          `.actor_id` the chain owner. Cross-witness lookups read `row.commit_sha`.
//
// The contract test pins the PE v2 / act record / intake field sets against the live writer and
// the act-key / intake field sets against their TypeScript interfaces, so a writer change fails
// the contract instead of silently drifting these builders.

/** Identity slots of a relay-authored PE v2 (`relayPeOf`). */
export const RELAY_PE_V2_IDENTITY_FIELDS: readonly string[] = [
  'schema', 'pe_id', 'device_id', 'prev_hash', 'timestamp', 'action_type',
];

/**
 * Hashed content of a relay-authored PE v2 when the emitter observed no input origins / output
 * digests (both forward-only optional keys).
 */
export const RELAY_PE_V2_CONTENT_FIELDS: readonly string[] = [
  'wallet_id', 'agent_id', 'actor_address', 'attestation_type', 'metadata', 'compute', 'geo',
  'execution_env', 'cited_pe_ids', 'parent_goal_pe_id',
];

/** Canonical fields of an act record (`ActRecord`, meter-wire.ts). */
export const ACT_RECORD_FIELDS: readonly string[] = [
  'pe_id', 'pe_hash', 'prev_hash', 'timestamp', 'action_type', 'pricing',
];

/** Canonical fields of a relay-act intake (`RelayActIntake`, meter-relay-authored.ts). */
export const RELAY_ACT_INTAKE_FIELDS: readonly string[] = [
  'schema', 'pe_id', 'actor_id', 'act', 'accrual', 'durable', 'sealed', 'created_at_ms', 'expire_at',
];

/** Canonical fields of a meter act key (`MeterActKeyDoc`, meter-act-key.ts). */
export const METER_ACT_KEY_FIELDS: readonly string[] = [
  'schema', 'relay_pe_id', 'client_pe_id', 'pe_hash', 'prev_hash', 'device_id', 'batch_hash',
  'actor_id', 'timestamp', 'action_type', 'row', 'legs', 'unit', 'held_reason', 'side',
  'created_at_ms', 'facts', 'beneficiary_id', 'expire_at', 'pending_retention_v1',
];

export interface MeterActKeyOverrides {
  peId: string;
  actorId: string;
  peHash: string;
  actionType?: string;
  prevHash?: string;
  timestamp?: number;
  commitSha?: string | null;
  /** Extra fields on the priced row (e.g. corroboration_status). */
  row?: PeHistoryOverrides;
}

/**
 * Build a PRODUCTION-shaped meter act key (`meter_act_keys_v1/{peId}`): the priced row is a
 * pe_history-shaped row (`makePeHistoryDoc`) carrying `commit_sha`; the identity an act's claims
 * derive from sits at the top level. Use this to seed a prior metered act.
 */
export function makeMeterActKeyDoc(opts: MeterActKeyOverrides): Record<string, unknown> {
  const timestamp = opts.timestamp ?? 1_700_000_000_000;
  const actionType = opts.actionType ?? 'coding_session';
  return {
    pending_retention_v1: true,
    schema: 'provian.meter-act-key.v1',
    relay_pe_id: opts.peId,
    client_pe_id: opts.peId,
    pe_hash: opts.peHash,
    prev_hash: opts.prevHash ?? 'prev_test',
    device_id: `relay:${opts.actorId}`,
    batch_hash: 'batchhash_test',
    actor_id: opts.actorId,
    timestamp,
    action_type: actionType,
    row: makePeHistoryDoc({
      peId: opts.peId,
      userId: opts.actorId,
      peHash: opts.peHash,
      actionType,
      timestamp,
      commit_sha: opts.commitSha ?? null,
      ...(opts.row ?? {}),
    }),
    legs: null,
    unit: 'none',
    held_reason: null,
    side: {
      statsBump: null,
      delegation: null,
      corroborateIncumbentPeId: null,
      outputDigestsIndexed: false,
      effect: null,
      commitOrigins: null,
    },
    created_at_ms: timestamp,
    facts: null,
    beneficiary_id: typeof opts.row?.beneficiary_wallet_id === 'string' ? opts.row.beneficiary_wallet_id : null,
    expire_at: null,
  };
}
