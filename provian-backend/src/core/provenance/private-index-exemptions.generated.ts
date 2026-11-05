// Generated from firestore.indexes.json; run scripts/generate-private-index-exemptions.mjs.
export const PRIVATE_LOOKUP_EXEMPTIONS: Readonly<Record<string, readonly string[]>> = {
  "actor_meter_days_v1": [
    "actor_id",
    "agent_actions",
    "corroborated",
    "day",
    "expire_at"
  ],
  "actor_meter_totals_v1": [
    "actor_id",
    "beneficiary_acts_by_agent",
    "by_attestation_tier",
    "corroborated",
    "financial",
    "financial_by_address",
    "schema",
    "updated_at_ms"
  ],
  "actor_stats_applied": [
    "body"
  ],
  "actor_stats_v1": [
    "body"
  ],
  "agent_author_mappings": [
    "body"
  ],
  "agent_bank_event_outbox_v1": [
    "body"
  ],
  "agent_inbox_heads_v1": [
    "body"
  ],
  "archive_days_v1": [
    "body",
    "parts"
  ],
  "archive_payments_v1": [
    "payment"
  ],
  "artifact_novelty_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "owner_user_id",
    "schema_version",
    "scope_id",
    "subject_id"
  ],
  "commit_mint_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "schema_version",
    "scope_id"
  ],
  "commons_human_job_applications": [
    "body"
  ],
  "commons_human_jobs": [
    "body"
  ],
  "commons_publication_consents": [
    "body"
  ],
  "commons_published_pes": [
    "body"
  ],
  "commons_thread_messages": [
    "body"
  ],
  "commons_threads": [
    "body"
  ],
  "completion_mint_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "schema_version",
    "scope_id"
  ],
  "device_occurrence_mint_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "schema_version",
    "scope_id",
    "subject_id"
  ],
  "devices": [
    "body"
  ],
  "escrows": [
    "body"
  ],
  "financial_settlement_mint_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "schema_version",
    "scope_id"
  ],
  "general_disputes": [
    "body"
  ],
  "github_webhook_inbox_v1": [
    "*",
    "expire_at"
  ],
  "human_approval_requests_v1": [
    "body"
  ],
  "human_promises": [
    "body"
  ],
  "identity_acts_v1": [
    "act",
    "body"
  ],
  "identity_pes_legacy_v1": [
    "body"
  ],
  "inbox_v1": [
    "body"
  ],
  "jobs": [
    "body"
  ],
  "meter_act_keys_v1": [
    "_meter_key_page",
    "batch_hash",
    "body",
    "client_pe_id",
    "created_at_ms",
    "device_id",
    "expire_at",
    "facts",
    "held_reason",
    "legs",
    "pe_hash",
    "pending_retention_v1",
    "prev_hash",
    "relay_pe_id",
    "row",
    "schema",
    "side",
    "unit"
  ],
  "meter_anchor_days_v1": [
    "expire_at"
  ],
  "meter_batch_acts_v1": [
    "act_count",
    "acts",
    "body",
    "device_id",
    "expire_at",
    "min_ts",
    "page",
    "schema",
    "type_counts",
    "witness_class_counts"
  ],
  "meter_batches_v1": [
    "act_leaves",
    "anchor",
    "body",
    "claim_keys",
    "economic_claim_keys",
    "economic_paid_claim_keys",
    "economic_totals",
    "expire_at",
    "retained_act_ids",
    "settlement_complete",
    "transit_recipients",
    "work_summary"
  ],
  "meter_day_counters_v1": [
    "actions",
    "body",
    "daily",
    "day",
    "schema"
  ],
  "meter_device_tips_v1": [
    "body"
  ],
  "meter_held_acts_v1": [
    "body",
    "key"
  ],
  "meter_key_pages_v1": [
    "body",
    "expire_at",
    "keys"
  ],
  "meter_occurrence_sets_v1": [
    "body",
    "fingerprints",
    "members"
  ],
  "meter_occurrence_states_v1": [
    "body"
  ],
  "meter_pair_counts_v1": [
    "body",
    "counted",
    "edges",
    "kind",
    "last_at_ms",
    "pe_approvals_cited",
    "pe_approvals_cited_witnessed",
    "pe_consumption",
    "pe_ring_excluded",
    "pe_unwitnessed"
  ],
  "meter_pending_claims_v1": [
    "act_identity",
    "actor_id",
    "acts",
    "beneficiary_class",
    "body",
    "claim_id",
    "created_at_ms",
    "device_id",
    "expire_at",
    "inlet_indexed_v1",
    "integrity_sha256",
    "leg",
    "moved",
    "parent_key",
    "ready_at_ms",
    "record_points_atomic",
    "registered_at_ms",
    "schema",
    "settled_at_ms",
    "settled_batch_id",
    "settled_tx_hash",
    "settled_via",
    "unit",
    "voided_at_ms",
    "voided_by",
    "window_part"
  ],
  "meter_pending_payees_v1": [
    "body"
  ],
  "meter_pending_ready_v1": [
    "body"
  ],
  "meter_relay_acts_v1": [
    "accrual",
    "act",
    "body",
    "expire_at",
    "sealed"
  ],
  "network_meter_hours_v1": [
    "count",
    "expire_at",
    "hour"
  ],
  "occurrence_mint_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "schema_version",
    "scope_id"
  ],
  "origin_reference_graph_v1": [
    "body",
    "cited_action_type",
    "cited_signer",
    "expire_at",
    "hash",
    "origin_identifier",
    "pair_folded",
    "pe_id",
    "reason",
    "recorded_at_ms",
    "schema_version",
    "scheme"
  ],
  "pe_accrual_failures": [
    "body"
  ],
  "pe_chain_tips": [
    "body"
  ],
  "pe_daily_anchor_batches": [
    "body"
  ],
  "pe_daily_anchor_days_v1": [
    "body"
  ],
  "pe_daily_anchor_segments_v1": [
    "body"
  ],
  "pe_hash_index": [
    "body"
  ],
  "pe_mailbox_acks_v1": [
    "body",
    "ns"
  ],
  "pe_mailbox_v1": [
    "body",
    "box",
    "expire_at",
    "items"
  ],
  "pe_submit_idempotency": [
    "expire_at"
  ],
  "presentation_requests_v1": [
    "body"
  ],
  "promises": [
    "body"
  ],
  "pvt9_bug_demotions_v1": [
    "body"
  ],
  "pvt9_claim_inlet_state_v1": [
    "body"
  ],
  "pvt9_claim_ledger_v1": [
    "beneficiary_class",
    "body",
    "bug_demoted_at_ms",
    "bug_demotion_id",
    "chain_settlement_evidence",
    "claim_kind",
    "expire_at",
    "genesis_anchor_key",
    "grant_type",
    "hold",
    "leg",
    "one_time_anchor",
    "pe_id",
    "qualified_at",
    "record_points_atomic",
    "reserved_batch_id",
    "reserved_gross_atomic",
    "schema_version",
    "settled_tx_hash",
    "settled_via",
    "topup_attestation_tier",
    "topup_observed_at_ms",
    "topup_of_claim_key",
    "wallet_id"
  ],
  "pvt9_payee_settlement_clocks_v1": [
    "body"
  ],
  "pvt9_pe_split_v1": [
    "body"
  ],
  "pvt9_reconciliation_reports_v1": [
    "body"
  ],
  "pvt9_settlement_batches_v1": [
    "body"
  ],
  "pvt9_settlement_cycles_v1": [
    "body"
  ],
  "pvt_accrual_effects": [
    "body"
  ],
  "pvt_held_act_sweep_cursor_v1": [
    "body"
  ],
  "pvt_mint_batch_snapshots": [
    "body"
  ],
  "pvt_mint_batches": [
    "body"
  ],
  "pvt_novelty_counters_v1": [
    "body"
  ],
  "pvt_ordinary_accrual_intake_v1": [
    "body"
  ],
  "pvt_payout_requests_v1": [
    "payment"
  ],
  "pvt_pending_evidence_resolution_v1": [
    "body"
  ],
  "pvt_pending_evidence_resolver_cursor_v1": [
    "body"
  ],
  "pvt_pending_policy_observations": [
    "body"
  ],
  "pvt_pending_policy_queue": [
    "body"
  ],
  "pvt_pending_policy_recovery_state": [
    "body"
  ],
  "pvt_registry_hold_resolution_v1": [
    "body"
  ],
  "pvt_registry_hold_resolver_cursor_v1": [
    "body"
  ],
  "pvt_registry_hold_resolver_run_v1": [
    "body"
  ],
  "service_installs": [
    "body"
  ],
  "speech_window_acts_v1": [
    "expire_at",
    "refs"
  ],
  "speech_window_reservations": [
    "body"
  ],
  "wallet_jurisdiction_sessions_v1": [
    "expire_at"
  ],
  "watch_registry_marks_v1": [
    "m",
    "p"
  ],
  "watch_registry_v1": [
    "e"
  ],
  "webhook_subscriptions": [
    "body"
  ],
  "witness_webhook_deliveries": [
    "expire_at"
  ],
  "x402_tx_mint_claims": [
    "body",
    "claim_id",
    "claim_kind",
    "created_at_ms",
    "event_id",
    "expire_at",
    "owner_pe_id",
    "schema_version",
    "scope_id"
  ]
};
