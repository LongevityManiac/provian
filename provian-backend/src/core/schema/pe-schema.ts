/**
 * THE ONE VERSIONED PE SCHEMA (Trust Layer pass 2, §2.10).
 *
 * A single machine-readable description of what a Provenance Envelope is: every
 * field with its assignment (relay-assigned vs submitter) and privacy rule (clear
 * vs hash-only + type tag); output_digests; every input_origins class including
 * `pe:`; the six witness/evidence classes and their bases; how a never-seen type is
 * recorded and when it earns; the hardware-attestation schemes and their pinned roots; the one-field
 * signals; the presentation vocabulary, the challenge predicate grammar, and the
 * co-signed result shape; the human-approval PE shape.
 *
 * GENERATED, NEVER HAND-WRITTEN as JSON. `buildPeSchema()` assembles the document
 * from the RELAY'S OWN constants — the evidence-class bases, the hardware schemes
 * and pinned roots, the predicate grammar, the origin schemes, the vocabulary keys,
 * the human-approval shape, and the signed monetary-template digest — plus one
 * declarative field registry (`PE_FIELD_REGISTRY`) co-located with the PE types.
 * A drift test (`pe-schema-drift.test.ts`, §2.12) regenerates this and refuses a
 * lag, so the published schema can never fall behind the types it describes.
 *
 * The document is deterministic (stable field order, no timestamps) so the drift
 * test compares byte-for-byte. `PE_SCHEMA_VERSION` is bumped by hand on a shape
 * change; `pricing_template_sha256` ties the pricing half to the SIGNED template so
 * a pricing move is visible in the schema without this pass moving that digest.
 */
import { WITNESS_CLASSES, PROPOSED_EVIDENCE_CLASS_BASES_BPS, type WitnessClass } from '../pvt/policy/evidence-class';
import { COMMONS_SPEECH_ACTION_TYPES } from '../pvt/policy/proposed-action-policy';
import { hashProposedMonetaryPolicyTemplate, PROPOSED_MONETARY_POLICY_TEMPLATE } from '../pvt/policy/proposed-monetary-policy';
import {
  DISCLOSURE_CONTENT_ELECTIONS, DISCLOSURE_REQUESTS_MAX, DISCLOSURE_FIELDS_MAX, DISCLOSURE_FIELD_PATH_MAX_DEPTH,
  DISCLOSURE_RECORDS_DEFAULT_LIMIT, DISCLOSURE_RECORDS_MAX_LIMIT, DISCLOSURE_RECORDS_MAX_TOTAL,
} from '../presentation/disclosure-request';
import { PINNED_ROOT_FINGERPRINTS, HARDWARE_SCHEMES, GCP_CONFIDENTIAL_ISSUER } from '../hardware/roots';
import { PREDICATE_OPS, PREDICATE_SET_MAX } from '../presentation/types';
import {
  DYNAMIC_FIELD_PATTERNS,
  NEVER_SEEN_KEY_RULE,
  PAYMENT_VOLUME_FIELD,
  PREDICATE_ONLY_FIELDS,
  PREDICATE_ONLY_OPS,
  VOCABULARY_WINDOWS,
  WINDOWED_FACT_BASES,
  windowSuffix,
} from '../presentation/vocabulary-fields';
import {
  MAX_ACTS_PER_BATCH,
  METER_GENESIS_PREV_HASH,
  METER_MINT_WINDOW_MS,
  NON_PRICING_PE_FIELDS,
  PE_BATCH_SCHEMA,
  PE_V2_SCHEMA,
} from '../meter/meter-wire';
import type { MeterActReceipt } from '../meter/meter-store';
import {
  METER_KEY_LIFETIME_MS,
  METER_MIN_BATCH_INTERVAL_MS,
  PE_MAILBOX_LIFETIME_MS,
  meterAnchorBatchIdPreimage,
} from '../meter/meter-constants';

/** Bumped by hand on a SHAPE change to the schema (not a pricing move — that rides pricing_template_sha256).
 * 2.0.0 (PE meter,): the PE is v2 and lives with its owner; the relay prices act
 * records from signed daily batches and keeps no PE.
 * 2.1.0 (signed outputs,): an input_origins entry may carry `signature` (the
 * producer's signature over an output's hash, class `out:`); consumption counts signed citations
 * only, and the relay keeps no output-digest index. */
export const PE_SCHEMA_VERSION = '2.3.2';

type FieldAssignment = 'relay_assigned' | 'submitter';
type FieldPrivacy = 'clear' | 'hash_only' | 'coarse';
/**
 * Where a PE v2 field goes. `identity` fields ride in the act record as named slots; `pricing`
 * fields ride in `act.pricing` (every field that is not identity, free text or hash-excluded);
 * `free_text` never leaves the device (covered only by `pe_hash`); `hash_excluded` is the hash
 * itself and the signature over it.
 */
type FieldRole = 'identity' | 'pricing' | 'free_text' | 'hash_excluded';

export interface PeFieldSpec {
  readonly name: string;
  readonly assignment: FieldAssignment;
  readonly privacy: FieldPrivacy;
  readonly role: FieldRole;
  readonly type: string;
  readonly note: string;
}

/**
 * The declarative source of truth for the PE v2 fields — the one place a human authors; the
 * role split is checked against the wire's own `NON_PRICING_PE_FIELDS` by the drift test. Every
 * PE field is `submitter` (the owner's device builds, hashes and keeps the PE). What the relay
 * assigns is never in the PE: it is the per-act receipt (`receipt_fields`), and a submitter
 * pricing value that names a relay-assigned field is ignored. A `hash_only` field carries a digest
 * + type tag, never content (§3 privacy).
 */
export const PE_FIELD_REGISTRY: readonly PeFieldSpec[] = [
  { name: 'schema', assignment: 'submitter', privacy: 'clear', role: 'identity', type: `"${PE_V2_SCHEMA}"`, note: 'The PE version tag.' },
  { name: 'pe_id', assignment: 'submitter', privacy: 'clear', role: 'identity', type: 'string', note: 'The device’s own unique id for the PE (`pe_` + 24 hex on the SDK). The relay keys on pe_hash, never on this id.' },
  { name: 'device_id', assignment: 'submitter', privacy: 'clear', role: 'identity', type: 'string', note: 'The registered device whose chain the PE extends (the relay’s own acts use `relay:<actor>`).' },
  { name: 'prev_hash', assignment: 'submitter', privacy: 'clear', role: 'identity', type: 'string', note: `The pe_hash of this device’s previous PE, or "${METER_GENESIS_PREV_HASH}" for its first. The relay checks the chain across batches.` },
  { name: 'timestamp', assignment: 'submitter', privacy: 'clear', role: 'identity', type: 'number', note: 'When the act happened (unix ms). An act older than the mint window when it arrives is recorded and does not mint.' },
  { name: 'action_type', assignment: 'submitter', privacy: 'clear', role: 'identity', type: 'string', note: 'The observed act’s type. The device lane admits only observation-lane types.' },
  { name: 'description', assignment: 'submitter', privacy: 'clear', role: 'free_text', type: 'string', note: 'Free text. Covered by pe_hash; never sent to the relay (the act record omits it).' },
  { name: 'intent_text', assignment: 'submitter', privacy: 'clear', role: 'free_text', type: 'string', note: 'Free text. Covered by pe_hash; never sent to the relay.' },
  { name: 'pe_hash', assignment: 'submitter', privacy: 'clear', role: 'hash_excluded', type: 'hex64', note: 'sha256 over the canonical JSON of the complete PE minus pe_hash and signature.' },
  {name:'private_commitment',assignment:'submitter',privacy:'hash_only',role:'free_text',type:'string',note:'Owner-local blinding material committed by the complete PE; never a pricing input.'},
  {name:'private_owner_view',assignment:'submitter',privacy:'clear',role:'free_text',type:'object',note:'Owner-local original detail; omitted from the act and encrypted in any owner-selected publication request.'},
  {name:'detail_commitment',assignment:'submitter',privacy:'hash_only',role:'free_text',type:'string',note:'Owner-local blinded detail commitment; never a pricing field.'},
  { name: 'signature', assignment: 'submitter', privacy: 'clear', role: 'hash_excluded', type: 'string', note: 'Optional signature over pe_hash. The batch, not each PE, is what the relay authenticates.' },
  { name: 'metadata', assignment: 'submitter', privacy: 'clear', role: 'pricing', type: 'object', note: 'Structured, allowlisted fields per type (turn ids, counts, commit sha); never content.' },
  { name: 'compute', assignment: 'submitter', privacy: 'clear', role: 'pricing', type: 'object | null', note: 'Optional compute telemetry; null when unavailable.' },
  { name: 'geo', assignment: 'submitter', privacy: 'coarse', role: 'pricing', type: 'object | null', note: 'Coarse region, never a precise location; null when unavailable.' },
  { name: 'execution_env', assignment: 'submitter', privacy: 'coarse', role: 'pricing', type: 'object | null', note: 'Environment class (sandbox/container/bare host, OS class) — coarse, never a hostname (§2.11).' },
  { name: 'parent_goal_pe_id', assignment: 'submitter', privacy: 'clear', role: 'pricing', type: 'string | null', note: 'Optional parent PE id on the same device.' },
  { name: 'output_digests', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'OutputDigest[]', note: 'What this PE produced, as {hash, kind}; content never leaves the device.' },
  { name: 'input_origins', assignment: 'submitter', privacy: 'coarse', role: 'pricing', type: 'InputOrigin[]', note: 'What this PE consumed, by origin class (see input_origins). `out:` cites a SIGNED output (the entry carries the producer’s `signature`); `pe:` is an unsigned citation of another PE.' },
  { name: 'economic_session_lineage', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'object', note: 'The observer’s session lineage (ordinals + digests) for mint-once across a session.' },
  { name: 'hardware_witness', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'HardwareWitness | null', note: 'Optional non-actor-signed attestation over the act’s hardware nonce (see hardware).' },
  { name: 'replication_pack', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'object', note: 'replication_pack only: {input_hash, output_hash, model_id, pack_hash}.' },
  { name: 'ai_conversation_metadata', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'object', note: 'Phone ai_conversation only: the session fingerprint (mint-once anchor) and counts.' },
  { name: 'approval_metadata', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'object', note: 'Phone human_approval only: {agent_wallet_id, decision, subject_pe_id?, subject_hash?, request_id?} — the action text is a hash, never the text (§2.1); request_id is the mint-once anchor.' },
  { name: 'corroboration_metadata', assignment: 'submitter', privacy: 'hash_only', role: 'pricing', type: 'object', note: 'Phone corroboration_signal only: target and evidence hash.' },
  { name: 'chain_id', assignment: 'submitter', privacy: 'clear', role: 'pricing', type: 'number', note: 'Phone send/swap only: the chain of tx_hash. A Base hash is queued for the chain-record lane, which re-reads it.' },
  { name: 'tx_hash', assignment: 'submitter', privacy: 'clear', role: 'pricing', type: 'string', note: 'Phone send/swap only: a pointer the chain-record lane re-verifies; never trusted as evidence.' },
  { name: 'counterparty_address', assignment: 'submitter', privacy: 'clear', role: 'pricing', type: 'string', note: 'Phone send/receive only: the counterparty address.' },
];

/**
 * What the relay assigns to each act, in the batch receipt (never in the PE). Keyed by the
 * receipt type itself, so a receipt field the schema does not describe is a compile error.
 */
const RECEIPT_FIELD_NOTES: Readonly<Record<keyof MeterActReceipt, string>> = {
  pe_id: 'The act’s pe_id, echoed.',
  pe_hash: 'The act’s pe_hash, echoed.',
  relay_pe_id: 'The relay’s id for the priced act (a key into running totals, never a stored PE). Empty when refused.',
  leaf_index: 'The act’s index in the batch (its leaf in acts_root).',
  disposition: 'eligible | record_only | held | duplicate | refused | ineligible.',
  reason: 'Why the act was priced as it was.',
  note: 'Present when the device should act on something (e.g. `lineage_rejected:…`).',
  record_points_atomic: 'The act’s sealed record points (the mint basis). Record points are not PVT.',
  mint_status: 'Relay-assigned settlement state; a submitter value is ignored.',
};

export interface PeSchemaDocument {
  readonly schema_version: string;
  readonly pricing_template_sha256: string;
  readonly summary: string;
  readonly pe_fields: readonly PeFieldSpec[];
  /** PE meter: where PEs live, the act record, the batch, the receipt, sealed copies, proofs. */
  readonly meter: MeterSchemaSection;
  readonly output_digests: { readonly shape: string; readonly privacy: string; readonly note: string };
  readonly input_origins: {
    readonly note: string;
    readonly classes: readonly { readonly scheme: string; readonly pattern: string; readonly resolves_to: string; readonly note: string }[];
  };
  readonly witness_classes: readonly { readonly class: WitnessClass; readonly base_bps: number; readonly note: string }[];
  readonly class_admission: { readonly rule: string; readonly unknown_action: string; readonly rejection: string; readonly read_failure: string };
  readonly hardware: {
    readonly admission: string;
    /** Measured observer (2026-10-10): which schemes reach hardware_rooted through a pinned release measurement. */
    readonly measured_observer: { readonly rule: string; readonly schemes: readonly string[]; readonly pinned_from: string; readonly never: string };
    readonly schemes: readonly { readonly scheme: string; readonly root_subject: string; readonly root_fingerprint_sha256: string }[];
    readonly slots: readonly string[];
    readonly privacy: string;
  };
  readonly presentation: {
    readonly tiers: readonly string[];
    readonly burn: string;
    readonly predicate_grammar: { readonly ops: readonly string[]; readonly set_op: string; readonly set_max: number; readonly note: string };
    readonly vocabulary: {
      readonly note: string;
      readonly groups: readonly { readonly group: string; readonly fields: readonly string[]; readonly note: string }[];
      readonly windows: { readonly days: readonly number[]; readonly suffix: string; readonly rule: string; readonly fields: readonly string[] };
      readonly dynamic_patterns: readonly { readonly pattern: string; readonly regex: string; readonly note: string }[];
      readonly never_seen_key_rule: string;
      readonly predicate_only: { readonly fields: readonly string[]; readonly ops: readonly string[]; readonly max_predicates_per_field: number; readonly rule: string };
      readonly fail_closed: string;
    };
    /** Requester-named disclosure (2026-10-10): what a signed challenge may name beyond predicates. */
    readonly disclosure: {
      readonly rule: string;
      readonly requests: { readonly pe: string; readonly witness: string; readonly max_requests: number; readonly max_fields: number; readonly field_path: string; readonly content_elections: readonly string[]; readonly records_limit: { readonly default: number; readonly max: number; readonly max_total: number } };
      readonly election: string;
      readonly floor: string;
      readonly verification: string;
      readonly tier: string;
      readonly verify_refusals: readonly string[];
    };
    readonly verify_result: { readonly reputation: readonly string[]; readonly pe_fact: readonly string[]; readonly never: string };
    readonly floor_query: string;
  };
  readonly human_approval: { readonly action_type: string; readonly metadata_keys: readonly string[]; readonly privacy: string; readonly earning: string };
  /** Commons communication — speech, threads, challenges, featured placement. */
  readonly commons_communication: {
    readonly rule: string;
    readonly speech_action_types: readonly string[];
    readonly window: { readonly audience: string; readonly floors_pvt: { readonly pe_fact: number; readonly reputation: number }; readonly duration_ms: number; readonly budget_rule: string };
    readonly thread_message: { readonly action_type: string; readonly metadata_keys: readonly string[]; readonly privacy: string; readonly delivery: string };
    readonly challenge: { readonly action_types: readonly string[]; readonly stake_floor_pvt: number; readonly window_ms: number; readonly outcomes: readonly string[]; readonly privacy: string };
    readonly featured_placement: { readonly action_type: string; readonly floor_pvt: number; readonly term_ms: number; readonly rule: string };
  };
}

export interface MeterSchemaSection {
  readonly custody: string;
  readonly private_transport: {readonly logical_bytes:string;readonly batch_wire:string;readonly authenticated_request_wire:string;readonly authentication:string;readonly retained:string};
  readonly canonical_json: string;
  readonly pe: {
    readonly schema: string;
    readonly identity_fields: readonly string[];
    readonly non_pricing_fields: readonly string[];
    readonly hash_excluded_fields: readonly string[];
    readonly pe_hash: string;
    readonly pricing_rule: string;
  };
  readonly act_record: {
    readonly keys: readonly string[];
    readonly leaf_domain: string;
    readonly leaf: string;
    readonly hardware_nonce: string;
  };
  readonly batch: {
    readonly schema: string;
    readonly fields: readonly string[];
    readonly max_acts: number;
    readonly genesis_prev: string;
    readonly acts_root: string;
    readonly batch_hash: string;
    readonly chain_rule: string;
    readonly replay_rule: string;
    readonly cadence: string;
    readonly min_interval_ms: number;
    readonly mint_window_ms: number;
    readonly transport: readonly { readonly path: string; readonly auth: string; readonly binding: string }[];
  };
  readonly receipt: {
    readonly schema: string;
    readonly act_fields: readonly { readonly name: string; readonly assignment: FieldAssignment; readonly note: string }[];
    readonly totals: string;
  };
  readonly sealed_copy: {
    readonly fields: readonly string[];
    readonly recipients: string;
    readonly box: string;
    readonly mailbox: string;
    readonly mailbox_lifetime_ms: number;
    readonly mailbox_lifetime_note: string;
  };
  readonly inclusion_proof: {
    readonly endpoint: string;
    readonly batch_leaf_domain: string;
    readonly batch_leaf: string;
    readonly hop1: string;
    readonly hop2: string;
    readonly anchor_batch_id: string;
    readonly anchor_segment: string;
    readonly presentation: string;
  };
  readonly retention: {
    readonly relay_keeps: readonly string[];
    readonly relay_never_keeps: string;
    readonly mint_once_key_lifetime_ms: number;
    readonly mint_once_key_lifetime_note: string;
    readonly permanent: string;
    readonly keep_your_pes: string;
  };
}

/** The disclosable reputation vocabulary, grouped as §2.5 named it. Fixed keys plus the dynamic
 *  patterns (listed from `DYNAMIC_FIELD_PATTERNS`, the one table the relay resolves them with) and the
 *  window-suffixed variants (`<fact>_30d|_90d|_365d`, listed from `WINDOWED_FACT_BASES`). */
const windowed = (base: string): string[] => VOCABULARY_WINDOWS.map((w) => `${base}${windowSuffix(w)}`);
const patternsFor = (prefix: string): string[] => DYNAMIC_FIELD_PATTERNS.filter((p) => p.pattern.startsWith(prefix)).map((p) => p.pattern);
const windowedIn = (prefix: string): string[] => WINDOWED_FACT_BASES.filter((b) => b.startsWith(prefix)).flatMap(windowed);
const VOCABULARY_GROUPS: readonly { readonly group: string; readonly fields: readonly string[]; readonly note: string }[] = [
  { group: 'continuity', fields: ['continuity.first_seen_ms', 'continuity.last_seen_ms', 'continuity.chain_depth', 'continuity.active_days', 'continuity.streak_days', 'continuity.registered_devices', 'continuity.highest_attestation_rank', ...windowedIn('continuity.')], note: 'How long and how steadily the actor has been present. Chain-continuity records (an idle `compute_session` sealed `skipped_no_output`) count here — chain depth, active days, streak, first / last seen — and nowhere else.' },
  { group: 'work', fields: [...patternsFor('work.'), 'work.total', 'work.witnessed', 'work.hardware_rooted', 'work.witnessed_compute_tokens', ...windowedIn('work.')], note: 'Acts of work by action family split by witness class; totals, witnessed, hardware-rooted and witnessed compute. A chain-continuity record is continuity, not work: it counts in no work.*, share.* or composition.* fact.' },
  { group: 'share', fields: patternsFor('share.'), note: 'Share of work in bps (floor of count×10000 / work.total over the same window; 0 when that total is 0), lifetime or `_30d|_90d|_365d`, materialized for keys that occurred.' },
  { group: 'coupling', fields: ['coupling.independent_origins_cited', 'coupling.distinct_owners', 'coupling.independent_owners'], note: 'Independent origins this actor consumed.' },
  { group: 'consumption', fields: ['consumption.independent_parties', 'consumption.edges', 'consumption.ring_excluded'], note: 'Independent parties whose witnessed acts cited an output this actor SIGNED (per-pair counts; unsigned citations count zero; ring-flagged excluded).' },
  { group: 'money', fields: ['money.witnessed_financial', 'money.witnessed_inbound', 'money.independent_payers', 'money.escrows_completed_as_provider', 'money.promises_fulfilled', 'money.promises_defaulted', 'money.promise_fulfillment_rate_bps', PAYMENT_VOLUME_FIELD, ...windowedIn('money.')], note: 'Money witnessed from independent parties. money.witnessed_inbound counts witnessed INBOUND payments (`receive` acts, which only the chain lanes derive from a transaction the recipient did not sign); money.independent_payers counts the DISTINCT parties that paid — the counterparty of every chain-witnessed receive the same-owner / shared-beneficial-owner fence passed, so an operator moving money between its own wallets adds nothing (address-distinct beyond that fence). Both carry `_30d|_90d|_365d` windows from the landing of 2026-10-10 forward (earlier history reads an observed 0 in the windows; the lifetime inbound count is complete). money.witnessed_payment_volume_usd* is chain-witnessed Base USDC volume (inbound + outbound transfers the relay’s watchers verified), in USD — PREDICATE-ONLY (see predicate_only).' },
  { group: 'standing', fields: ['standing.adverse_events', 'standing.bond_active', 'standing.open_bond_claims_against', 'standing.invalidation_active', 'standing.<adverse_type>', ...windowedIn('standing.')], note: 'ALWAYS PRESENT and non-redactable (windowed standing fields included); adverse events by type + bond status.' },
  { group: 'accountability', fields: ['accountability.human_beneficiary', 'accountability.linked_agents', 'accountability.human_directed_turn_share_bps', 'accountability.supervised_turns', 'accountability.human_approvals_cited', 'accountability.human_approvals_given'], note: 'Human linkage and human-approval PEs cited (§2.1).' },
  { group: 'composition', fields: ['composition.model_families', 'composition.environment_classes', 'composition.attested_regions', 'composition.measurements', 'composition.attested_issuers', ...patternsFor('composition.')], note: 'Model families, environment classes, and — from witnessed PEs whose SEALED hardware report was admitted — attested regions, launch measurements and issuer roots (composition.issuer.<fingerprint>: the pinned root the report chained to, one of hardware.schemes; counted from 2026-10-10 forward). A mission-critical gate names the facts, not the class: issuer root + measurement + region + standing.' },
  { group: 'presentations', fields: ['presentations.produced', 'presentations.produced_recent', ...windowedIn('presentations.')], note: 'Produced count only — there is NO verified-presentation counter (§2.7). `produced_recent` is the rolling 30×24h window; `_30d|_90d|_365d` are UTC-day windows.' },
  { group: 'actor', fields: ['actor.is_agent'], note: '1 for an agent, 0 for a human; identical key set otherwise.' },
];

/** Assemble the versioned schema document from the relay's own constants. Pure and
 *  deterministic — no fs, no clock — so the drift test and the served route agree. */
export function buildPeSchema(): PeSchemaDocument {
  const witness_classes = WITNESS_CLASSES.map((c) => ({
    class: c,
    base_bps: PROPOSED_EVIDENCE_CLASS_BASES_BPS[c],
    note: witnessClassNote(c),
  }));
  // The scheme spine is the authoritative HARDWARE_SCHEMES list; each cert-rooted
  // scheme carries its pinned root, and the two issuer-based schemes (gcp/azure)
  // carry their pinned OIDC issuer instead of a cert fingerprint.
  const rootByScheme = new Map(PINNED_ROOT_FINGERPRINTS.map((r) => [r.scheme, r] as const));
  const schemes = [...HARDWARE_SCHEMES].map((s) => {
    const r = rootByScheme.get(s);
    if (r) return { scheme: s, root_subject: r.subject, root_fingerprint_sha256: r.fingerprint };
    if (s === 'gcp_confidential_space') return { scheme: s, root_subject: `OIDC issuer ${GCP_CONFIDENTIAL_ISSUER} (pinned + discovered JWKS)`, root_fingerprint_sha256: '' };
    if (s === 'azure_attestation') return { scheme: s, root_subject: 'OIDC issuer https://*.*.attest.azure.net (pinned pattern + /certs)', root_fingerprint_sha256: '' };
    return { scheme: s, root_subject: '(issuer-based)', root_fingerprint_sha256: '' };
  });
  return {
    schema_version: PE_SCHEMA_VERSION,
    pricing_template_sha256: hashProposedMonetaryPolicyTemplate(),
    summary: 'A Provenance Envelope (v2) is metadata-only, witnessed, and kept by its owner: the device that observed the act builds, hashes, chains and keeps it, and sends the relay only its act record inside one signed batch per day (and right before any presentation or on-demand payout). The relay prices the acts, mints, keeps running totals and the daily on-chain fingerprint, and keeps no PE. This document is the single source for building or reading one on any path.',
    pe_fields: PE_FIELD_REGISTRY,
    meter: buildMeterSection(),
    output_digests: {
      shape: '{ hash: string (sha256/git/evmtx/… with a scheme tag), kind: string }',
      privacy: 'hash_only — output identifiers disclose hashes, not content; small output trust rows support signed citations and independence, and permanent occurrence digests prevent repeat minting.',
      note: 'Populated by every lane from what it already observes (commit SHA, artifact/file hashes, response digest, tx/receipt hash, sensor digest). Empty when nothing is observable; never a placeholder.',
    },
    input_origins: {
      note: 'What this PE consumed. CONSUMPTION (who built on your work) counts SIGNED citations only : an `out:` origin carries the producer’s `signature` over the output’s hash ({hash, signer:{kind,id}, scheme, sig}; message `provian-output:v1:<sha256 hex>`); the relay verifies it at intake against the signer’s registered key and resolves the producer through its identity registries — a wallet address through the native wallet index and the proven-address registries, a device through the devices collection (its Secure Enclave key, or its registered output key), a phone through its registered device key — never through a per-output record. The signature only names who MADE the output: a signed citation counts once per citing PE, folded into the per-pair count, only when the citing act is itself witnessed (the consumer’s observer device or wallet-auth phone saw the signed output arrive), and never across the citer’s own identity set (its own keys, its linked agent or human) or a citation ring. Unsigned citations — a `pe:` origin, a bare output hash, a bad signature, an unknown signer — are recorded and count zero, matching the unsigned-origin rule. Citations add ZERO to the citer’s multiplier and the cited party earns nothing from them. A non-citation origin counts toward independence (+0.5× each) only when it is witnessed — derived by the relay’s own index, observed by the relay itself (the GitHub App webhook, a chain watcher, a chain-verified transfer record), or carried by a verified submission witness — and its owner resolves outside the actor’s identity set; closed-loop (ring) origins are excluded. Actor-authored origins on the sovereign and relay/action lanes are recorded and count zero.',
      classes: [
        { scheme: 'out:', pattern: 'out:<wallet|device|app>:<signer id> + signature', resolves_to: 'signer:<producer actor id> (the signer’s registered identity: native wallet index / proven addresses / devices collection / app_output_keys_v1)', note: 'A SIGNED citation of an output. The only class that counts toward the producer’s consumption — when the citing act is witnessed and the pair is independent (not self, not linked, not a ring). Carried by a `Provian-Output-Signature` header or a `provian_output_signature` JSON field on the output.' },
        { scheme: 'pe:', pattern: 'pe:<pe_id>', resolves_to: 'signer:<cited PE’s actor id> (retained act trust metadata, when available)', note: 'An unsigned citation of another PE: recorded (and an approval citation still counts toward accountability) but adds nothing to consumption.' },
        { scheme: 'evm:', pattern: 'evm:0x<40 hex>', resolves_to: 'the address itself (the chain is the public authority)', note: 'An on-chain address origin. The address maps to a Provian signer only for closed-loop (ring) detection.' },
        { scheme: 'pkg:', pattern: 'pkg:<coordinate>', resolves_to: 'npm-user:<publisher> (registry lookup)', note: 'A package dependency (§2.11 owner resolution).' },
        { scheme: 'repo:', pattern: 'repo:<host/owner/name[@ref]>', resolves_to: 'the repo owner (external party, never a signer)', note: 'A source repository.' },
        { scheme: 'domain:', pattern: 'domain:<registrable domain>', resolves_to: 'the registrable domain (external party)', note: 'A web origin.' },
        { scheme: 'doi:', pattern: 'doi:10.<registrant>/<suffix>', resolves_to: 'the DOI registrant (external party)', note: 'A published work.' },
        { scheme: 'private_*', pattern: 'origin_identifier = a bare type tag (e.g. `private_file`); hash = a purpose-separated MAC under the existing device secret, using the compatible sha256:<hex> digest tag', resolves_to: 'private identifier; no public dictionary-testable digest', note: 'Private identifiers remain device-secret-bound; signed output citations preserve their original producer signature and hash inside encrypted transport.' },
      ],
    },
    witness_classes,
    class_admission: {
      rule: 'The type of work is never the gate: any action_type may be submitted. A witness is the gate on RECORDING, and the policy setter signature on a named row of the signed matrix is the gate on EARNING. The class bases price only the hardware-rooted lift of an eligible named row.',
      unknown_action: 'A never-seen action_type earns nothing until the operator signs a named row for it, on every lane: it is sealed record_only (0 PVT) and earns only from that row’s activation forward, mint-once on its witnessed occurrence; nothing sealed before the signature is repriced. Where it can be recorded: (1) the sovereign route with an admitted hardware_witness, and (2) the device batch from a registered observer’s gateway plugin (metadata.source `observer_plugin` + metadata.observer_plugin, stamped by the observer) — both queued for review in the pending-policy queue under their lane (`sovereign_hardware_witness`, `device_gateway_observer`); (3) the relay’s own witness lanes, which name types at runtime (a forge webhook’s `service:github_<event>`), queued under that lane at its witness class; (4) the phone batch, which records an unnamed type as the person’s own declaration (actor_declared) and does NOT queue it. A queued type shows on the public proposals dashboard (GET /v1/pe/earning-proposals). The intake lanes (1, 2) never record a type in a relay-owned namespace (`service:`, `git_`) or a named type unless the operator signed it for that intake lane (a signing lists it in INTAKE_SIGNED_ACTION_TYPES beside its matrix row); with no witness at all a submission is refused.',
      rejection: 'A rejection always wins: a rejected type records and never mints.',
      read_failure: 'A read failure never admits (Unknown = Block).',
    },
    hardware: {
      admission: 'A report verifies iff its nonce equals the act’s hardware nonce (meter.act_record.hardware_nonce: the act’s identity and every pricing input except the witness slot), its signing chain terminates at the SCHEME’s pinned public root, and the signer is not an actor key. The hardware_rooted class (and its price factor) pays when the attestation proves Provian’s own genuine software produced the record: verified App Attest, and a verified TPM / AWS Nitro / GCP Confidential Space / Azure / NVIDIA attestation whose launch measurement / PCR digest is one the relay pins for a signed observer release (see measured_observer). Every other verified attestation remains a presentation fact at the normal lane class, including device_tier for bare attested submissions. No manufacturer/device catalog. A present-but-unverifiable report is RECORDED at the lane’s class, never lifted. Sealed PEs are never repriced.',
      measured_observer: {
        rule: 'An admitted report of one of these schemes lifts the act to hardware_rooted iff its launch measurement / PCR digest (hardware.slots: “launch measurement / PCR digest”) equals a measurement the relay pins for a signed observer release. The platform produces the measurement at launch, so the operator cannot choose it; a report carrying any other measurement stays at the lane’s class with its facts recorded.',
        schemes: [...PROPOSED_MONETARY_POLICY_TEMPLATE.hardwarePricingMeasuredSchemes],
        pinned_from: 'The signed release channel only: the release manifest (signed with the release key the relay pins) carries `measurements[]` = {scheme, measurement}; the relay reads them through that signature and nothing else. No environment variable, no operator setting, no per-device catalog.',
        never: 'A measurement the relay does not pin, an unsigned or stale manifest, a report whose nonce does not bind the act, or a signer that is an actor key — none lifts; App Attest is unchanged.',
      },
      schemes,
      slots: ['tee_type/version', 'launch measurement / PCR digest', 'attestation report digest + issuer root', 'hashed serial + firmware/driver digest', 'attested region/jurisdiction (coarse)', 'attested time + source', 'model weights digest', 'container image + runtime + SBOM digest', 'attested power + grid region', 'calibration cert + date', 'reliability telemetry', 'continuity (same device cert/key)'],
      privacy: 'Fields are hash_only or coarse; never a raw serial (§2.2).',
    },
    presentation: {
      tiers: ['pe_fact', 'reputation'],
      burn: 'Every presentation, both tiers, consumes a single-use on-chain PVT burn. Predicate results are computed only for a burn-backed presentation.',
      predicate_grammar: {
        ops: [...PREDICATE_OPS].filter((o) => o !== 'in'),
        set_op: 'in',
        set_max: PREDICATE_SET_MAX,
        note: 'A requester names predicates over any vocabulary field; the relay computes the presenter’s live vocabulary and evaluates the predicates server-side, Provian co-signs, the verifier returns results — never the chain.',
      },
      vocabulary: {
        note: 'The reputation tier’s disclosable set, computed live, identical shape for agents and humans.',
        groups: VOCABULARY_GROUPS.map((g) => ({ group: g.group, fields: [...g.fields], note: g.note })),
        windows: {
          days: [...VOCABULARY_WINDOWS],
          suffix: '_<days>d',
          rule: 'UTC-day granular: `_30d` covers the last 30 UTC days including today (likewise 90, 365), evaluated by the relay at issuance against the actor’s live seal-time history.',
          fields: WINDOWED_FACT_BASES.flatMap(windowed),
        },
        dynamic_patterns: DYNAMIC_FIELD_PATTERNS.map((p) => ({ pattern: p.pattern, regex: p.regex.source, note: p.note })),
        never_seen_key_rule: NEVER_SEEN_KEY_RULE,
        predicate_only: {
          fields: [...PREDICATE_ONLY_FIELDS].sort(),
          ops: [...PREDICATE_ONLY_OPS],
          max_predicates_per_field: 1,
          rule: 'Never disclosed as a raw fact (not in the default facts, not in `disclosed`); answerable only through ONE order predicate per field per presentation. `eq`/`in` and a second predicate on the same field are refused — an exact-match probe or a ladder of thresholds would disclose the amount.',
        },
        fail_closed: 'Every vocabulary source is read or the presentation is refused (vocabulary_source_unavailable). A zero in any fact, every standing.* field included, is an observed zero, never a read failure.',
      },
      disclosure: {
        rule: 'A signed challenge may name, beyond predicates, specific RECORDS: one PE by one of its output digests, or PEs witnessed by a named issuer (a pinned hardware root fingerprint from hardware.schemes, `chain:base`, or a device id) or a named signer (a device id, or sha256(SPKI) of the attestation report key); plus specific fields of the record and elected content the PE carries. The predicate grammar is unchanged; disclosure requests are a distinct part of the challenge (`disclosures[]`, whose canonical digest joins the signing string as `disclosures=` only when present).',
        requests: {
          pe: '{kind:"pe", output_digest:<64 hex>, issuer?, fields?, content?} — the one record carrying that digest (a PE’s own hash is also addressable).',
          witness: '{kind:"witness", issuer?, signer?, limit?, fields?, content?} — the presenter’s most recent records under that witness, up to limit.',
          max_requests: DISCLOSURE_REQUESTS_MAX,
          max_fields: DISCLOSURE_FIELDS_MAX,
          field_path: `1..${DISCLOSURE_FIELD_PATH_MAX_DEPTH} dotted segments of [A-Za-z0-9_-]{1,64} into the act’s pricing projection (meter.act_record.pricing); prototype-chain names are refused.`,
          content_elections: [...DISCLOSURE_CONTENT_ELECTIONS],
          records_limit: { default: DISCLOSURE_RECORDS_DEFAULT_LIMIT, max: DISCLOSURE_RECORDS_MAX_LIMIT, max_total: DISCLOSURE_RECORDS_MAX_TOTAL },
        },
        election: 'The presenter elects per request — `disclosed` with the matching records it holds (possibly none), or `declined`. Nothing is disclosed without election; a declined request is signed as declined and the gate decides. The human presenter sees exactly what is about to be disclosed before the biometric burn. Standing is always present regardless.',
        floor: 'A disclosed record carries only its metadata floor — pe_id, pe_hash, action_type, timestamp, and the RELAY-derived witness {kind: hardware|chain|device, scheme?, issuer?, signer?, measurement?, region?, ref?} — plus the requested fields at their paths (an absent path reports null) and the elected content (description, intent, artifacts = the output digests, fact_tier = the anchored act record). An unrequested field is never carried; free text travels only under an election.',
        verification: 'The presenter’s proof of possession commits to its elections and the record identities (pe_id + pe_hash); the Provian signature covers the relay-derived records; every verifier re-checks each record’s hash, fields and content against the ANCHORED act record (the two-hop proof to PEAnchor on Base, carried as disclosure_proofs[]) and refuses a mismatch — neither side can forge a value. The relay retains nothing from a disclosure; nothing surfaces in the Commons.',
        tier: 'Reputation tier only — one presentation, one burn at the reputation floor, both the predicate answers and the disclosures inside it. A challenge naming disclosures refuses a pe_fact presentation.',
        verify_refusals: ['disclosures_unanswered', 'disclosure_record_invalid', 'disclosures_require_reputation_tier'],
      },
      verify_result: {
        reputation: ['valid', 'tier', 'presentation_id (= burn_id; dedupe key)', 'presenter_address', 'sub', 'requester ({type,id} verified at issuance, or null)', 'challenge_expires_at', 'predicates[] ({field, op, threshold|set, result})', 'standing (always present)', 'disclosed', 'redacted', 'disclosures[] ({request, election, records[]} — the requester-named disclosure answers, each record checked against its anchored act)'],
        pe_fact: ['valid', 'tier', 'presentation_id', 'presenter_address', 'sub', 'requester', 'challenge_expires_at', 'onchain_checked', 'payload (the claimed PE ids + envelope hashes)'],
        never: 'Reputation verify returns predicate results, standing and disclosed facts — never the PE chain. pe_fact verify returns only the claimed PE ids and envelope hashes, never other PEs. A pe_fact presenter supplies each PE and its inclusion proof (meter.inclusion_proof): the relay keeps no PE to look up. Verify is public and stateless; the verifier must accept a presentation once (the SDK does by default).',
      },
      floor_query: 'GET /v1/present/floor?tier=<pe_fact|reputation> — the effective minimum burn, so a presenter burns exactly the fee.',
    },
    human_approval: {
      action_type: 'human_approval',
      metadata_keys: ['agent_wallet_id', 'decision', 'subject_pe_id', 'subject_hash', 'request_id'],
      privacy: 'The approved action is carried as a hash-only digest (subject_hash), never the text; keys are allowlisted and the parser fails closed.',
      earning: 'eligible — a biometric-signed human approval mints at its witness-class base (device_tier at minimum, hardware_rooted 4.0× on App Attest), mint-once on the approval request id. The agent’s subsequent PE cites it as a `pe:` origin and Accountability counts it.',
    },
    commons_communication: {
      rule: 'The gate handshake applied to Provian’s own room: a presentation opens a voice, a claim is answered with a presentation, and nothing is paid to Provian. A Commons write (forum post/reply/vote/flag, want post, job post, opening a thread with a stranger) needs a live presentation window opened by ONE burn at the presentation floors; inside an open relationship (a live handshake either way, or a shared job/escrow/promise/dispute) sending needs nothing further. A speech PE mints only while the speaker holds a live pass (a presentation to provian:commons within its window) and only inside that pass’s budget; with no live pass it records and seals record_only (speech_no_live_pass_record_only). The challenge answer is budgeted against the answer presentation. Humans and agents identically.',
      speech_action_types: [...COMMONS_SPEECH_ACTION_TYPES],
      window: {
        audience: 'provian:commons',
        floors_pvt: { pe_fact: 5, reputation: 15 },
        duration_ms: 7 * 24 * 60 * 60 * 1000,
        budget_rule: 'Every speech PE reserves its record points against the window’s burn in one transaction; a PE that would carry the sum to or past the burn seals record_only (speech_window_budget_exhausted). Σ minted speech < the burn, strictly, at 10_000 bps.',
      },
      thread_message: {
        action_type: 'commons_thread_message',
        metadata_keys: ['thread_id', 'message_id', 'kind', 'anchor_kind', 'anchor_id', 'content_sha256', 'request_id'],
        privacy: 'The content is E2E ciphertext (sealed box to each party’s published x25519 message key) the relay stores and cannot read; the PE seals only its sha256. Headers show only profile-published info; nothing from the presentation vocabulary renders on a message.',
        delivery: 'Agents: per-wallet inbox + targeted webhook `thread_message`; humans: push + attention center. Never the content.',
      },
      challenge: {
        action_types: ['commons_claim_challenged', 'commons_challenge_answered', 'commons_challenge_resolved'],
        stake_floor_pvt: 15,
        window_ms: 7 * 24 * 60 * 60 * 1000,
        outcomes: ['answered (predicate true → the stake burned)', 'upheld (predicate false → the stake returned; the post flagged)', 'upheld (no presentation inside the window → the challenge stands; the stake returned)'],
        privacy: 'Only the outcome surfaces on the Commons; the predicate is the parties’ alone. Resolved by burn-to-present, never by Court.',
      },
      featured_placement: {
        action_type: 'commons_featured_placement',
        floor_pvt: 15,
        term_ms: 7 * 24 * 60 * 60 * 1000,
        rule: 'A burn auction on the global single-use ledger: one burn = one bid of its verified amount (any amount from the floor, no ceiling), live for the term; bids on one item stack and the item ranks by their sum; only an open item is featured; nothing refunds; record_only (a PVT-cost event mints nothing).',
      },
    },
  };
}

const IDENTITY_FIELDS = PE_FIELD_REGISTRY.filter((f) => f.role === 'identity').map((f) => f.name);
const HASH_EXCLUDED_FIELDS = PE_FIELD_REGISTRY.filter((f) => f.role === 'hash_excluded').map((f) => f.name);

/** The PE meter half of the schema (wire constants read from `meter-wire.ts` / `meter-store.ts`). */
function buildMeterSection(): MeterSchemaSection {
  return {
    private_transport:{
      logical_bytes:'PE fields and act records below are owner-local logical values. Hashes of private content are not anonymity proofs.',
      batch_wire:'Send {private_batch:<provian.private-pricing.v1 AES-256-GCM box>} containing {batch:<unchanged logical batch>,openings:<per-act original opening secrets>}; encrypt under the existing device or wallet credential with context provian-private-batch:v1. Each private act uses pricing.private_pricing with context pe_id.',
      authenticated_request_wire:'Private approval, presentation, thread, job, archive-part and batch-proof requests use {private_request:<box>} containing {request:<original request>}, context provian-private-request:v1:<path>. Private mailbox query uses private_query=<JSON box>. No clear overrides. Bare attested work uses private_relay_request sealed to the existing relay presentation identity derived capability /v1/present/privacy-key.',
      authentication:'Authenticate/sign/HMAC the original outer wire bytes under the existing credential first, then decrypt, verify original hardware or producer signatures and price original inputs. Per-act openings travel only inside the authenticated encrypted wrapper.',
      retained:'Private-capable relay records, physical IDs, Redis claim aliases and diagnostics use the existing relay secret. Owner copies and selected public disclosures retain their original meaning; public PE references are keyed aliases. Previously sealed values never reprice.',
    },
    custody: 'Every PE lives with its owner and no lifecycle deletes it: the daemon/SDK keeps it in its local PE store (an operator may mirror it to its own storage), the phone backs it up encrypted to the owner’s own iCloud / Google Drive. A linked agent’s PEs (and a person’s other devices’ PEs) are also sealed to that person; the relay holds each new sealed-copy page until the phone acknowledges durable receipt, then deletes it; new pages have no time expiry. The relay never stores a readable PE.',
    canonical_json: 'Object keys sorted by UTF-16 code unit, no whitespace, undefined members dropped (undefined array members written as null), strings and numbers exactly as ECMAScript JSON.stringify writes them, non-finite numbers refused (a PE that cannot be hashed canonically is never recorded).',
    pe: {
      schema: PE_V2_SCHEMA,
      identity_fields: IDENTITY_FIELDS,
      non_pricing_fields: [...NON_PRICING_PE_FIELDS],
      hash_excluded_fields: HASH_EXCLUDED_FIELDS,
      pe_hash: 'sha256 hex of canonical_json(the complete PE minus pe_hash and signature) — free text included, so a presented PE is checked byte for byte.',
      pricing_rule: 'act.pricing = the PE minus every non_pricing_field. Any field a builder adds beyond those listed in pe_fields is a pricing input; a pricing object that names a non_pricing field is refused.',
    },
    act_record: {
      keys: ['action_type', 'pe_hash', 'pe_id', 'prev_hash', 'pricing', 'timestamp'],
      leaf_domain: 'provian.meter.act.v1\n',
      leaf: 'sha256 hex of utf8(leaf_domain ‖ canonical_json(act record)).',
      hardware_nonce: 'sha256 hex of canonical_json({action_type, pe_id, prev_hash, pricing: pricing minus hardware_witness, timestamp}) — the act’s identity and pricing inputs, not pe_hash (which covers the witness itself).',
    },
    batch: {
      schema: PE_BATCH_SCHEMA,
      fields: ['schema', 'device_id', 'seq', 'prev_batch_hash', 'created_at_ms', 'acts', 'acts_root', 'sealed?'],
      max_acts: MAX_ACTS_PER_BATCH,
      genesis_prev: METER_GENESIS_PREV_HASH,
      acts_root: 'Merkle root over the act leaves in order: leaf node = sha256(0x00 ‖ leaf bytes), inner node = sha256(0x01 ‖ min(a,b) ‖ max(a,b)) (bytewise sorted pair), padded to a power of two with sha256(empty). The relay recomputes it and refuses a mismatch.',
      batch_hash: 'sha256 hex of canonical_json(the batch minus `sealed`). Sealed copies are delivery payload, not part of the record.',
      chain_rule: 'seq starts at 1 and increases by one; prev_batch_hash is the previous accepted batch’s batch_hash (genesis_prev for the first). The first act’s prev_hash is the last pe_hash the relay accepted from this device; every later act’s prev_hash is its predecessor’s pe_hash. A PE appears in exactly one accepted batch.',
      replay_rule: 'Replay validation compares against each device’s latest accepted tip. The same tip batch re-sent is answered 200 with the stored receipt; a stale seq is refused 409 batch_replay; anything that does not extend the tip is refused. A batch is re-sent byte for byte until answered, and rebuilt only after a definitive 4xx.',
      cadence: 'One batch per device per day, plus one immediately before any presentation or on-demand payout so those reflect the latest acts (sooner while a backlog drains). An offline device keeps its PEs and sends them when it reconnects.',
      min_interval_ms: METER_MIN_BATCH_INTERVAL_MS,
      mint_window_ms: METER_MINT_WINDOW_MS,
      transport: [
        { path: 'POST /v1/meter/batch', auth: 'Authorization: DeviceKey <pdk_…>:<pds_…> (or DeviceSignature on a Secure Enclave device)', binding: 'X-Provian-Body-HMAC: hex(hmac_sha256(device_secret, exact wire body)); a batch that is not body-bound has every act refused.' },
        { path: 'POST /v1/meter/batch/mobile', auth: 'The phone’s wallet auth (request-bound token)', binding: 'The wallet token binds method, path and body hash.' },
      ],
    },
    receipt: {
      schema: 'provian.pe-batch-receipt.v1',
      act_fields: (Object.keys(RECEIPT_FIELD_NOTES) as (keyof MeterActReceipt)[]).map((name) => ({
        name, assignment: 'relay_assigned' as const, note: RECEIPT_FIELD_NOTES[name],
      })),
      totals: '{eligible_points_atomic, acts, eligible} for the batch, plus device_id, actor_id, seq, batch_hash, acts_root, batch_leaf, accepted_at_ms. The device files the receipt beside its PEs.',
    },
    sealed_copy: {
      fields: ['to', 'pe_id', 'box'],
      recipients: '`to` is a role the relay resolves: `linked_human` (an agent’s linked human) or `owner` (a person’s own device). GET /v1/meter/seal-targets names them with their published message keys; no key → no copy yet.',
      box: 'base64url sealed box of canonical_json(PE) to the recipient’s x25519 message key: 0x01 ‖ ephemeral public key ‖ XChaCha20-Poly1305(key, nonce from HKDF-SHA256(shared, ephemeral ‖ recipient), aad 0x01 ‖ recipient). The relay cannot open it.',
      mailbox: 'GET /v1/meter/mailbox (device) and /v1/meter/mobile/mailbox (phone) list sealed copies addressed to the owner; POST …/mailbox/ack drops what the owner filed. Pre-meter PEs handed back arrive here too.',
      mailbox_lifetime_ms: PE_MAILBOX_LIFETIME_MS,
      mailbox_lifetime_note: 'Legacy mailbox TTL only. New sealed-copy pages have no time expiry: they remain until the recipient acknowledges durable receipt, then are deleted; the owner retains its PE and retries unacknowledged copies.',
    },
    inclusion_proof: {
      endpoint: 'GET /v1/meter/proofs?after_seq=<n> (device) and /v1/meter/mobile/proofs (phone): each anchored batch with its path into that day’s on-chain root, handed out in sequence.',
      batch_leaf_domain: 'provian.meter.batch-leaf.v1\n',
      batch_leaf: 'sha256 hex of utf8(batch_leaf_domain ‖ canonical_json({actor_id, acts_root, batch_hash, device_id, seq})).',
      hop1: 'act leaf → acts_root by the sorted-pair sha256 path (the holder builds it from the batch’s own PEs), then batch_leaf from the batch identity.',
      hop2: 'keccak256(0x00 ‖ batch_leaf) → the day root by its keccak path: PEAnchor.verifyPE(anchor_batch_id, leaf, proof) on Base.',
      anchor_batch_id: `keccak256(0xff ‖ utf8("${meterAnchorBatchIdPreimage('<YYYY-MM-DD>')}")) — one anchor per closed UTC day.`,
      anchor_segment: `2026-10-10: an operator-run intra-day anchor (a SEGMENT) commits the open day’s accepted-but-unanchored batches NOW under keccak256(0xff ‖ utf8("${meterAnchorBatchIdPreimage('<YYYY-MM-DD>', 1).replace(':1', ':<n>')}")), n ≥ 1; such a batch’s proof carries anchor.segment = n and every verifier derives the on-chain batch id from (day, segment). The day’s close anchors only the batches no segment took, under the plain day id. Never scheduled; a PE sealed today is presentable the moment its segment lands.`,
      presentation: 'A pe_fact presentation carries pe_facts[i] = {pe_id, envelope_hash (= pe_hash), pe, inclusion: {act_index, act_proof, acts_root, batch: {device_id, actor_id, seq, batch_hash}, anchor: {day, proof}}}. Provian checks both hops and that batch.actor_id is the presenter, and embeds the proof so the counterparty repeats both hops against Base.',
    },
    retention: {
      relay_keeps: ['identity, links, escrows and recovery state', 'running totals for the reputation vocabulary (adverse facts included)', 'citation relationships as per-pair counts', 'earnings not yet minted', 'each device’s latest accepted batch (its tip)', 'permanent packed occurrence membership shared across every device of an actor; dormant membership is archived after 90 days and restored before pricing the next batch', 'output trust and cross-witness facts while claims are unpaid, then at least 30 days after payment', 'sealed delivery copies until the owner acknowledges durable receipt', 'compact batch records until settlement, anchoring and sealed-copy delivery complete, then for 30 days'],
      relay_never_keeps: 'A readable PE, a PE listing or a PE export. A full listing is the owner’s local store.',
      mint_once_key_lifetime_ms: METER_KEY_LIFETIME_MS,
      mint_once_key_lifetime_note: 'Compatibility baseline for retained evidence keys, not the lifetime of occurrence membership. Packed actor-wide occurrence digests have no time expiry and the same occurrence never mints again from another device.',
      permanent: 'Minted PVT, the on-chain fingerprint and packed occurrence digests are permanent; running totals last while the relay operates.',
      keep_your_pes: 'Proving a specific act later requires keeping its PE: only its holder can rebuild the proof.',
    },
  };
}

function witnessClassNote(c: WitnessClass): string {
  switch (c) {
    case 'hardware_rooted': return 'A hardware attestation report signed by a non-actor key, verified to a pinned root (4.0×).';
    case 'chain_witnessed': return 'The relay re-read the canonical event from Base (a watcher or an on-chain-gated route).';
    case 'forge_witnessed': return 'An HMAC-verified forge webhook (GitHub / GitLab / Bitbucket).';
    case 'relay_verified': return 'The relay’s own verified institution / genesis logic stamped the row.';
    case 'device_tier': return 'A registered device cryptographically bound this exact body (SE signature or body-HMAC).';
    case 'actor_declared': return 'The actor’s own key/session is the only voucher — records, never mints (base 0).';
    default: return '';
  }
}
