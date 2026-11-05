import {readGenesisActivation} from './genesis-activation-store';
import { accrualEndedAt } from './accrual-end-line';
import {hasGenesisMonetaryBinding} from './policy/genesis-monetary-binding';
import { privateRetentionCollection } from '../provenance/private-retention';
/**
 * Crash-safe atomic accounting Genesis qualification -> reservation -> PE -> pe_history flow.
 *
 * The qualifying act writes a deterministic outbox document in the SAME
 * Firestore commit as the wallet/proof/device record. Processing is resumable:
 * reservation + wallet ledger + global dedupe are atomic; PE + chain tip +
 * outbox transition are atomic; completion requires the exact pe_history
 * snapshot commitment. No rollback ever destroys a valid reservation.
 *
 * Immediate callers invoke processGenesisQualification best-effort;
 * drainGenesisQualifications is the bounded recovery entry point, scheduled by
 * the `provian-genesis-drain` cron (F-A1-1) so a grant stranded by a Cloud Run
 * instance reclaim during the fire-and-forget advance still reaches complete and
 * mints.
 */

import {
  METER_RELAY_ACTS_COLLECTION,
  priceRelayAct,
  type RelayActIntake,
} from '../meter/meter-relay-authored';
import { METER_ACT_KEYS_COLLECTION } from '../meter/meter-store';
import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import {
  FieldPath,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
  type WriteBatch,
} from 'firebase-admin/firestore';

import { generatePE, type GeneratePEParams, type GeneratedPE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import {
  buildGenesisDedupeKey,
  createEmptyGenesisLedgerState,
  hashGenesisCampaignPolicyManifest,
  reserveGenesisCampaignGrant,
  validateGenesisCampaignActivation,
  verifyGenesisCampaignActivationApproval,
  type GenesisActivationApprovalVerifier,
  type GenesisCampaignActivation,
  type GenesisCampaignLedgerState,
  type GenesisReservationLedgerEntry,
} from './policy/genesis-policy-engine';
import {
  PROPOSED_GENESIS_CAMPAIGN_POLICY,
  SUPERSEDED_GENESIS_POLICY_BINDINGS,
  type ProposedGenesisBountyPolicy,
} from './policy/proposed-genesis-policy';
import {
  computeRecordSnapshot,
  hashRecordEconomicSnapshot,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V1,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V2,
  MONETARY_ACCOUNTING_SCHEMA_VERSION_V3,
  type RecordEconomicSnapshot,
} from './policy/monetary-accounting';
import {
  materializeProposedMonetaryPolicy,
} from './policy/runtime-monetary-policy';
import { PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256 } from './policy/pvt9-approval-manifest.generated';
import { isWitnessClass } from './policy/evidence-class';
import { isGenesisForcedOff } from './genesis-force-off';

export const GENESIS_ACTIVATION_COLLECTION = 'pvt_policy_activations';
export const GENESIS_ACTIVATION_DOCUMENT = 'genesis';
export const GENESIS_QUALIFICATION_COLLECTION = 'genesis_qualification_outbox_v2';
/**
 * The still-in-flight qualification states the bounded recovery drain re-drives.
 * A row in any OTHER state — a terminal `denied`/`complete` row (which carries the
 * null lease fields the full live-qualification guard rejects), an unrecognized
 * status, or anything `isQualification` cannot parse — is not a recovery candidate
 * and is SKIPPED by the drain scan, never thrown on (landing). One module
 * source, read by both the scan and the transactional re-check, so the two can
 * never drift (single-source).
 */
export const RECOVERABLE_QUALIFICATION_STATUSES = Object.freeze(
  ['pending_reservation', 'reserved', 'emitting', 'pe_recorded'] as const,
);
/**
 * Durable retention for an in-window qualifying act whose persist gate refused
 * (activation doc absent, invalid, or killed). This is NOT the mint-readable
 * outbox: no reservation, settlement, or mint path reads this collection. It is
 * read only by the explicitly-invoked retention backfill, which re-runs the
 * FULL persist gate before promoting a record into GENESIS_QUALIFICATION_COLLECTION.
 * A retained record alone is not a grant. See genesis-retention-backfill.ts.
 */
export const GENESIS_QUALIFICATION_RETENTION_COLLECTION =
  'genesis_qualification_retained_v1';
export const GENESIS_RESERVATION_COLLECTION = 'genesis_reservations_v2';
export const GENESIS_WALLET_LEDGER_COLLECTION = 'genesis_wallet_ledgers_v2';
export const GENESIS_ADMISSION_EVENT_COLLECTION = 'genesis_admission_events_v1';
export const GENESIS_EMISSION_LEASE_MS = 5 * 60 * 1000;

/**
 * The `platform` value that marks a smoke/integration-test wallet (human OR
 * agent). ONE declaration: the award-path guard, its tests, and any future
 * reader must bind to this, never to a re-typed `'test'` literal (
 * self-referential-control rule — a test carrying its own copy of the value
 * proves nothing about the value the code reads).
 */
export const TEST_PLATFORM_VALUE = 'test';

/**
 * Named denial for a `platform: 'test'` wallet reaching the Genesis award path.
 * A distinct reason on purpose: a refusal that borrowed an upstream reason
 * (`invalid_request`, `replay`) would make the RED control pass for the wrong
 * cause, which is the exact vacuous-guard shape exists to stop.
 */
export const GENESIS_TEST_PLATFORM_DENIAL = 'test_platform_wallet';

/**
 * The single test-platform predicate. Mirrors the seven other economic surfaces
 * (`pvt-accrual` ×3, leaderboard, commons feed, genesis-milestones,
 * institution-funding-watcher), all of which early-return on
 * `data.platform === 'test'`.
 *
 * Takes `unknown` deliberately: the violating case must be constructible by a
 * test (unreachable-branch rule). A missing document — the human-signup
 * and non-agent legs, whose `wallet_id` is not in `agent_wallets` is NOT a
 * test wallet and is not refused.
 */
export function isTestPlatformWallet(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  return (data as { platform?: unknown }).platform === TEST_PLATFORM_VALUE;
}

export type GenesisQualificationAction =
  | 'genesis_human_signup'
  | 'genesis_signup'
  | 'genesis_device_link';

export type GenesisQualificationStatus =
  | 'pending_reservation'
  | 'reserved'
  | 'emitting'
  | 'pe_recorded'
  | 'complete'
  | 'denied';

export interface GenesisQualificationDocument {
  readonly schema_version: 'pvt-genesis-qualification/v2';
  readonly qualification_id: string;
  readonly pe_id: string;
  readonly action_type: GenesisQualificationAction;
  readonly wallet_id: string;
  readonly economic_actor_id: string;
  readonly actor_address: string;
  readonly immutable_anchor: {
    readonly anchor_kind: ProposedGenesisBountyPolicy['dedupe']['required_anchor'];
    readonly anchor_id: string;
  };
  readonly qualifying_act_evidence: {
    readonly verification_status: 'verified';
    readonly evidence_id: string;
    readonly evidence_hash: string;
    readonly subject_wallet_id: string;
    readonly canonical_bounty_key: GenesisQualificationAction;
    readonly qualifying_act: string;
    readonly immutable_anchor_kind: string;
    readonly immutable_anchor_id: string;
    readonly qualifying_act_at_ms: number;
  };
  readonly observation_context: {
    readonly verification_status: 'verified';
    readonly observed_at_ms: number;
    readonly wallet_created: {
      readonly wallet_id: string;
      readonly created_at_ms: number;
      readonly evidence_id: string;
      readonly evidence_hash: string;
      readonly source: 'authoritative_wallet_record';
    };
  };
  readonly status: GenesisQualificationStatus;
  readonly reservation_id: string | null;
  readonly reserved_atomic: string;
  readonly economic_snapshot: RecordEconomicSnapshot | null;
  readonly economic_snapshot_hash: string | null;
  readonly pe_hash: string | null;
  readonly prev_hash: string | null;
  readonly emission_lease_token: string | null;
  readonly emission_lease_expires_at_ms: number | null;
  readonly denial_reason: string | null;
  readonly attempts: number;
  /** Recovery-drain fairness counter; absent on pre-corrective rows means 0. */
  readonly recovery_attempts?: number;
  readonly last_recovery_attempt_at_ms?: number | null;
  readonly last_error?: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly completed_at_ms: number | null;
}

/**
 * A qualifying act that happened inside the armed Genesis window but whose
 * persist gate refused. It carries the FULL, frozen qualification document
 * (including its original `qualifying_act_at_ms`) so a later backfill can settle
 * it indistinguishably from one that persisted on the first try. Fail-closed:
 * `promoted_at_ms` is set only by the backfill, and only after the full persist
 * gate re-admits the record against the current activation.
 */
export interface RetainedGenesisQualification {
  readonly schema_version: 'pvt-genesis-retained-qualification/v1';
  readonly retained_at_ms: number;
  readonly retention_reason: 'persist_gate_refused_in_window';
  readonly promoted_at_ms: number | null;
  readonly qualification: GenesisQualificationDocument;
}

export interface BuildGenesisQualificationParams {
  readonly actionType: GenesisQualificationAction;
  readonly walletId: string;
  readonly economicActorId: string;
  readonly actorAddress: string;
  readonly immutableAnchorId: string;
  readonly qualifyingActEvidenceId: string;
  readonly qualifyingActAtMs: number;
  readonly walletCreatedAtMs: number;
  readonly walletCreatedEvidenceId: string;
}

export interface GenesisStateMachineDeps extends AgentBankDeps {
  /** Test/recovery injection; production uses generatePE. */
  emitGenesisPE?: (
    deps: AgentBankDeps,
    params: GeneratePEParams,
  ) => Promise<GeneratedPE>;
  /** Explicit test seam. Production always verifies the configured SSHSIG. */
  verifyGenesisActivationApproval?: GenesisActivationApprovalVerifier;
}

export interface GenesisProcessHooks {
  /** Fault-injection hook used to prove restart after the reservation commit. */
  afterReservation?: (qualification: GenesisQualificationDocument) => void | Promise<void>;
  /** Fault-injection hook used to prove restart after PE + accrual commit. */
  afterPERecorded?: (qualificationId: string) => void | Promise<void>;
}

export interface GenesisProcessResult {
  readonly qualificationId: string;
  readonly status:
    | GenesisQualificationStatus
    | 'pending_activation'
    | 'in_progress';
  readonly reason: string;
  readonly peId: string | null;
  readonly reservedAtomic: string;
}

interface PersistedGenesisReservation {
  readonly schema_version: 'pvt-genesis-reservation/v2';
  readonly qualification_id: string;
  readonly dedupe_key: string;
  readonly reservation: GenesisReservationLedgerEntry;
  readonly economic_snapshot: RecordEconomicSnapshot;
  readonly economic_snapshot_hash: string;
  readonly state: 'reserved' | 'pe_recorded' | 'ready_for_settlement';
  readonly pe_hash: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

type AtomicWriter = Pick<Transaction, 'create'> | Pick<WriteBatch, 'create'>;

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashGenesisEvidence(value: unknown): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Genesis evidence number is not canonical');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object' || value === null) {
    throw new Error('Genesis evidence value is not canonical');
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/**
 * The manifest's bounty for an action, and the ONLY way to read one.
 *
 * Exported so tests bind to the same source `buildGenesisQualification` reads instead of
 * redeclaring a bounty's fields as fixtures. Four suites carried their own copy of
 * `qualifying_act`, so re-scoping the act broke them for a reason that had nothing to do
 * with what they were testing — the self-referential-control shape the run contract names.
 */
export function genesisBountyFor(
  actionType: GenesisQualificationAction,
): ProposedGenesisBountyPolicy {
  return bountyFor(actionType);
}

function bountyFor(actionType: GenesisQualificationAction): ProposedGenesisBountyPolicy {
  const bounty = PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.find(
    (candidate) => candidate.canonical_bounty_key === actionType,
  );
  if (!bounty) throw new Error(`Unknown Genesis qualification action: ${actionType}`);
  return bounty;
}

function assertIdentifier(value: string, field: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value)) {
    throw new Error(`${field} is not a canonical identifier`);
  }
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} is not a non-negative safe integer`);
  }
}

const QUALIFICATION_REQUIRED_KEYS = Object.freeze([
  'schema_version',
  'qualification_id',
  'pe_id',
  'action_type',
  'wallet_id',
  'economic_actor_id',
  'actor_address',
  'immutable_anchor',
  'qualifying_act_evidence',
  'observation_context',
  'status',
  'reservation_id',
  'reserved_atomic',
  'economic_snapshot',
  'economic_snapshot_hash',
  'pe_hash',
  'prev_hash',
  'emission_lease_token',
  'emission_lease_expires_at_ms',
  'denial_reason',
  'attempts',
  'created_at_ms',
  'updated_at_ms',
  'completed_at_ms',
] as const);

const QUALIFICATION_OPTIONAL_KEYS = Object.freeze([
  'recovery_attempts',
  'last_recovery_attempt_at_ms',
  'last_error',
] as const);

const PERSISTED_RESERVATION_KEYS = Object.freeze([
  'schema_version',
  'qualification_id',
  'dedupe_key',
  'reservation',
  'economic_snapshot',
  'economic_snapshot_hash',
  'state',
  'pe_hash',
  'created_at_ms',
  'updated_at_ms',
] as const);

const GENESIS_PE_KEYS = Object.freeze([
  'id',
  'wallet_id',
  'agent_id',
  'action_type',
  'actor_address',
  'timestamp',
  'prev_hash',
  'attestation_type',
  'metadata',
  'compute',
  'geo',
  'execution_env',
  'cited_pe_ids',
  'parent_goal_pe_id',
  'hash',
  'user_id',
  'policy_action_type',
  'integration_source',
  'counterparty_address',
  'counterparty_type',
  'session_lineage',
  'self_referencing',
  'trust_level_at_creation',
  'created_at',
  'durability',
] as const);

// The Trust Layer build (e6803336,) stamps these two relay-assigned, UNHASHED storage
// fields on every PE `generatePE` writes. A Genesis PE sealed before it carries neither; one
// sealed after carries both. Leaving them out of the binding stranded every Genesis grant from
// 2026-09-16 at `pe_recorded`, so they are allowed as a pair, never alone.
const GENESIS_PE_WITNESS_KEYS = Object.freeze(['witness_class', 'witnessed_at_ms'] as const);

const GENESIS_PE_METADATA_KEYS = Object.freeze([
  'genesis_qualification_id',
  'genesis_reservation_id',
  'genesis_reserved_atomic',
  'genesis_policy_manifest_hash',
  'evidence_hash',
  'immutable_anchor_kind',
  'verified',
  'canonical_event_id',
] as const);

const CANONICAL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/;
const CANONICAL_ATOMIC = /^(0|[1-9][0-9]*)$/;
const SHA256_COMMITMENT = /^sha256:[a-f0-9]{64}$/;
const PE_HASH = /^[a-f0-9]{64}$/;
const EVM_ADDRESS = /^0x[a-f0-9]{40}$/;

function hasExactRequiredAndOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && actual.every((key) => allowed.has(key));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function proposedArmedGenesisWindow(): { startMs: number; endMs: number } | null {
  const startMs = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.start_ms;
  const endMs = PROPOSED_GENESIS_CAMPAIGN_POLICY.window.end_ms;
  if (!isNonNegativeSafeInteger(startMs)
    || !isNonNegativeSafeInteger(endMs)
    || startMs > endMs
    || PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.state
      !== 'armed_by_explicit_pvt9_activation'
    || PROPOSED_GENESIS_CAMPAIGN_POLICY.arming.grants_enabled !== true
    || PROPOSED_GENESIS_CAMPAIGN_POLICY.window.approval.status
      !== 'wp12_launch_dates_explicitly_approved'
    || PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.some(
      (bounty) => bounty.launch_armed !== true
        || bounty.activation !== 'explicit_pvt9_launch_activation',
    )) return null;
  return { startMs, endMs };
}

export function shouldEnqueueGenesisQualification(
  actionType: string,
  qualifyingActAtMs: number,
): actionType is GenesisQualificationAction {
  const window = proposedArmedGenesisWindow();
  if (window === null) return false;
  return PROPOSED_GENESIS_CAMPAIGN_POLICY.bounties.some(
    (bounty) => bounty.canonical_bounty_key === actionType,
  )
    && Number.isSafeInteger(qualifyingActAtMs)
    && qualifyingActAtMs >= window.startMs
    && qualifyingActAtMs <= window.endMs;
}

/**
 * Decide whether an in-window qualifying act may receive a new durable outbox
 * under the activation state read in the SAME transaction as the act.
 *
 * A missing, malformed, unsigned, non-signable, inert, or killed activation
 * fails closed and writes no Genesis outbox. A valid close admits only acts at
 * or before its evented cutoff; later wallet/device/proof operations may still
 * succeed as product actions but receive no Genesis outbox.
 */
export function shouldPersistGenesisQualification(
  actionType: string,
  qualifyingActAtMs: number,
  activationValue: unknown,
  approvalVerifier: GenesisActivationApprovalVerifier =
    verifyGenesisCampaignActivationApproval,
): boolean {
  // Shutdown coverage (2026-10-20): from the accrual end line Genesis admits nothing, exactly as
  // an admission close at that instant would. The Terms (Section 24.3) say acts received on or
  // after the shutdown date do not mint; a reservation made before it stays payable.
  if (accrualEndedAt(qualifyingActAtMs)) return false;
  return genesisActivationAdmits(actionType, qualifyingActAtMs, activationValue, approvalVerifier);
}

/**
 * The activation half of the persist gate: everything `shouldPersistGenesisQualification` checks
 * except the accrual end line. The startup probe (`isGenesisGrantPersistenceLive`) reads THIS, so
 * a relay past the end line still boots (the final settlement runs on it) while admission stays
 * refused.
 */
function genesisActivationAdmits(
  actionType: string,
  qualifyingActAtMs: number,
  activationValue: unknown,
  approvalVerifier: GenesisActivationApprovalVerifier,
): boolean {
  // THE DEPLOY-LEVEL BREAK-GLASS, CHECKED FIRST.
  //
  // M10: `GENESIS_CAMPAIGN_FORCE_OFF` was documented as the Genesis kill switch and gated nothing
  // on this path — its only refusal lived in `reserveGenesisIssuance`, which has no production
  // callers. Every armed fixed-grant leg passes through THIS predicate, so this is where the
  // switch has to be read for the name to mean anything. See `genesis-force-off.ts`.
  if (isGenesisForcedOff()) return false;
  if (!shouldEnqueueGenesisQualification(actionType, qualifyingActAtMs)) return false;
  if (activationValue === undefined || activationValue === null) return false;
  if (!isActivation(activationValue)) return false;
  const activation = activationValue as GenesisCampaignActivation;
  if (activation.genesis_kill_switch_active === true) return false;
  if (activation.approval_manifest_sha256 !== PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
    || !hasGenesisMonetaryBinding(activation)
    || validateGenesisCampaignActivation(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
      activation,
      approvalVerifier,
    ) !== null) {
    return false;
  }
  if (activation.grants_enabled) return true;
  return typeof activation.admission_closed_at_ms === 'number'
    && qualifyingActAtMs <= activation.admission_closed_at_ms;
}

/** True when the armed enqueue window would admit an in-window Genesis act. */
export function genesisEnqueueArmed(): boolean {
  return proposedArmedGenesisWindow() !== null;
}

/**
 * The armed campaign window `{startMs, endMs}`, or null when Genesis is not armed.
 * Public read for discovery surfaces that must report the LIVE window (2026-08-03 through
 * 2026-12-31 since; end_ms 2027-01-01T00:00:00Z) from the campaign manifest — NOT the runtime boundary generated config, whose
 * `genesis.armed/window_approved/start_at/end_at` are deliberately fail-closed nulls
 * that do not reflect the armed on-chain reality.
 */
export function genesisArmedWindow(): { readonly startMs: number; readonly endMs: number } | null {
  return proposedArmedGenesisWindow();
}

/**
 * Whether the launch dates are approved in the campaign manifest — a WEAKER condition
 * than armed (arming additionally requires `grants_enabled` and every bounty
 * launch-armed). Sourced from the manifest, never the runtime boundary generated config.
 */
export function genesisWindowApproved(): boolean {
  return PROPOSED_GENESIS_CAMPAIGN_POLICY.window.approval.status
    === 'wp12_launch_dates_explicitly_approved';
}

/**
 * True when grant PERSISTENCE is live right now: the enqueue window is armed AND
 * the current activation doc admits a representative in-window act through the
 * persist gate's activation half (every check but the accrual end line). Reuses the
 * exact gate, so it can never drift from it.
 */
export async function isGenesisGrantPersistenceLive(
  db: Firestore,
  approvalVerifier: GenesisActivationApprovalVerifier =
    verifyGenesisCampaignActivationApproval,
): Promise<boolean> {
  const window = proposedArmedGenesisWindow();
  if (window === null) return false;
  // Deliberately NOT judged by the accrual end line (the activation half of the gate only): this
  // feeds the public-launch startup guard, which exits the process when Genesis is armed but
  // persistence is not live. Past the end line the relay must still boot (the final settlement
  // runs on it); admission itself is refused in `shouldPersistGenesisQualification`.
  const snap = await readGenesisActivation(db);
  const activationValue: unknown = snap.exists ? snap.data() : undefined;
  return genesisActivationAdmits(
    'genesis_human_signup',
    window.startMs,
    activationValue,
    approvalVerifier,
  );
}

/**
 * Whether Genesis is admitting new grants right now, for READ surfaces that tell a person or an
 * agent whether a new act would earn a grant (`genesis_grants_live`): persistence is live AND the
 * accrual end line has not passed (from it, admission refuses every act). Never the startup guard,
 * which must read `isGenesisGrantPersistenceLive` so a relay past the end line still boots.
 */
export async function isGenesisAdmittingNow(
  db: Firestore,
  approvalVerifier: GenesisActivationApprovalVerifier =
    verifyGenesisCampaignActivationApproval,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (accrualEndedAt(nowMs)) return false;
  return isGenesisGrantPersistenceLive(db, approvalVerifier);
}

export interface CloseGenesisAdmissionParams {
  readonly admissionCloseAuditId: string;
  readonly closedBy: string;
  /** Test injection only. Production records the operation's wall-clock time. */
  readonly now?: number;
  /** Test injection only. Production always verifies the configured SSHSIG. */
  readonly approvalVerifier?: GenesisActivationApprovalVerifier;
}

export interface GenesisAdmissionCloseResult {
  readonly eventId: string;
  readonly cutoffAtMs: number;
  readonly idempotent: boolean;
  readonly priorActivationHash: string;
  readonly closedActivationHash: string;
}

interface GenesisAdmissionCloseEvent {
  readonly schema_version: 'pvt-genesis-admission-event/v1';
  readonly event_id: string;
  readonly event_type: 'admission_closed';
  readonly cutoff_at_ms: number;
  readonly admission_close_audit_id: string;
  readonly closed_by: string;
  readonly prior_activation_sha256: string;
  readonly closed_activation_sha256: string;
  readonly preserves_pre_cutoff_outboxes: true;
  readonly kill_switch_changed: false;
  readonly recorded_at_ms: number;
}

const GENESIS_ADMISSION_CLOSE_EVENT_KEYS = Object.freeze([
  'schema_version',
  'event_id',
  'event_type',
  'cutoff_at_ms',
  'admission_close_audit_id',
  'closed_by',
  'prior_activation_sha256',
  'closed_activation_sha256',
  'preserves_pre_cutoff_outboxes',
  'kill_switch_changed',
  'recorded_at_ms',
] as const);

function activationCommitment(value: GenesisCampaignActivation): string {
  return `sha256:${sha256(canonicalJson(value))}`;
}

function readBoundGenesisAdmissionCloseEvent(
  value: unknown,
  eventId: string,
  activation: GenesisCampaignActivation,
  admissionCloseAuditId: string,
  closedBy: string,
): GenesisAdmissionCloseEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !hasExactRequiredAndOptionalKeys(
      value as Record<string, unknown>,
      GENESIS_ADMISSION_CLOSE_EVENT_KEYS,
    )) return null;
  const event = value as Partial<GenesisAdmissionCloseEvent>;
  if (event.schema_version !== 'pvt-genesis-admission-event/v1'
    || event.event_id !== eventId
    || event.event_type !== 'admission_closed'
    || event.admission_close_audit_id !== admissionCloseAuditId
    || event.closed_by !== closedBy
    || event.cutoff_at_ms !== activation.admission_closed_at_ms
    || event.recorded_at_ms !== event.cutoff_at_ms
    || event.preserves_pre_cutoff_outboxes !== true
    || event.kill_switch_changed !== false
    || typeof event.prior_activation_sha256 !== 'string'
    || !SHA256_COMMITMENT.test(event.prior_activation_sha256)
    || typeof event.closed_activation_sha256 !== 'string'
    || !SHA256_COMMITMENT.test(event.closed_activation_sha256)
    || event.closed_activation_sha256 !== activationCommitment(activation)) return null;
  const priorActivation: GenesisCampaignActivation = {
    ...activation,
    grants_enabled: true,
    admission_closed_at_ms: null,
    admission_close_audit_id: null,
  };
  if (event.prior_activation_sha256 !== activationCommitment(priorActivation)) return null;
  return event as GenesisAdmissionCloseEvent;
}

/**
 * Atomically append the local admission-close event and flip only the admission
 * fields. It deliberately does NOT activate the kill switch: already-durable
 * pre-cutoff outboxes remain reservable and processable after the close.
 */
export async function closeGenesisAdmission(
  db: Firestore,
  params: CloseGenesisAdmissionParams,
): Promise<GenesisAdmissionCloseResult> {
  assertIdentifier(params.admissionCloseAuditId, 'admissionCloseAuditId');
  assertIdentifier(params.closedBy, 'closedBy');
  const cutoffAtMs = params.now ?? Date.now();
  assertTimestamp(cutoffAtMs, 'now');
  const eventId = `genesis_close_${sha256(params.admissionCloseAuditId)}`;
  const activationRef = db.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT);
  const eventRef = db.collection(GENESIS_ADMISSION_EVENT_COLLECTION).doc(eventId);

  return db.runTransaction(async (txn) => {
    const [activationSnap, eventSnap] = await Promise.all([
      readGenesisActivation(db, txn),
      txn.get(eventRef),
    ]);
    const raw: unknown = activationSnap.data();
    if (!activationSnap.exists || !isActivation(raw)) {
      throw new Error('genesis_activation_missing_or_invalid');
    }
    const activation = raw as GenesisCampaignActivation;
    const validation = validateGenesisCampaignActivation(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
      activation,
      params.approvalVerifier ?? verifyGenesisCampaignActivationApproval,
    );
    const exactApprovalBindings = activation.approval_manifest_sha256
      === PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
      && hasGenesisMonetaryBinding(activation);
    if (!exactApprovalBindings || validation !== null) {
      throw new Error(
        `genesis_admission_close_rejected:${validation ?? 'proposal_not_approved'}`,
      );
    }

    if (!activation.grants_enabled) {
      const event = eventSnap.exists
        ? readBoundGenesisAdmissionCloseEvent(
          eventSnap.data(),
          eventId,
          activation,
          params.admissionCloseAuditId,
          params.closedBy,
        )
        : null;
      if (activation.admission_close_audit_id !== params.admissionCloseAuditId
        || event === null) {
        throw new Error('genesis_admission_already_closed_with_different_event');
      }
      return {
        eventId,
        cutoffAtMs: event.cutoff_at_ms,
        idempotent: true,
        priorActivationHash: event.prior_activation_sha256,
        closedActivationHash: event.closed_activation_sha256,
      };
    }

    if (eventSnap.exists) throw new Error('genesis_admission_event_collision');
    const window = proposedArmedGenesisWindow();
    if (window === null
      || activation.effective_at_ms === null
      || cutoffAtMs < activation.effective_at_ms
      || cutoffAtMs > window.endMs) {
      throw new Error('genesis_admission_cutoff_outside_armed_window');
    }

    const closedActivation: GenesisCampaignActivation = {
      ...activation,
      grants_enabled: false,
      admission_closed_at_ms: cutoffAtMs,
      admission_close_audit_id: params.admissionCloseAuditId,
    };
    const priorActivationHash = activationCommitment(activation);
    const closedActivationHash = activationCommitment(closedActivation);
    txn.set(activationRef, closedActivation);
    txn.create(eventRef, {
      schema_version: 'pvt-genesis-admission-event/v1',
      event_id: eventId,
      event_type: 'admission_closed',
      cutoff_at_ms: cutoffAtMs,
      admission_close_audit_id: params.admissionCloseAuditId,
      closed_by: params.closedBy,
      prior_activation_sha256: priorActivationHash,
      closed_activation_sha256: closedActivationHash,
      preserves_pre_cutoff_outboxes: true,
      kill_switch_changed: false,
      recorded_at_ms: cutoffAtMs,
    });
    return {
      eventId,
      cutoffAtMs,
      idempotent: false,
      priorActivationHash,
      closedActivationHash,
    };
  });
}

export function genesisQualificationId(
  actionType: GenesisQualificationAction,
  immutableAnchorId: string,
): string {
  return `gq_${sha256(`${actionType}\n${immutableAnchorId}`)}`;
}

export function genesisQualificationRef(
  db: Firestore,
  actionType: GenesisQualificationAction,
  immutableAnchorId: string,
): DocumentReference {
  return db.collection(GENESIS_QUALIFICATION_COLLECTION)
    .doc(genesisQualificationId(actionType, immutableAnchorId));
}

export function buildGenesisQualification(
  params: BuildGenesisQualificationParams,
): GenesisQualificationDocument {
  const bounty = bountyFor(params.actionType);
  for (const [field, value] of Object.entries({
    walletId: params.walletId,
    economicActorId: params.economicActorId,
    immutableAnchorId: params.immutableAnchorId,
    qualifyingActEvidenceId: params.qualifyingActEvidenceId,
    walletCreatedEvidenceId: params.walletCreatedEvidenceId,
  })) assertIdentifier(value, field);
  const actorAddress = typeof params.actorAddress === 'string'
    ? params.actorAddress.trim().toLowerCase()
    : '';
  if (!EVM_ADDRESS.test(actorAddress)) throw new Error('actorAddress must be a canonical EVM address');
  assertTimestamp(params.qualifyingActAtMs, 'qualifyingActAtMs');
  assertTimestamp(params.walletCreatedAtMs, 'walletCreatedAtMs');
  if (params.walletCreatedAtMs > params.qualifyingActAtMs) {
    throw new Error('wallet creation cannot follow the qualifying act');
  }

  const qualificationId = genesisQualificationId(
    params.actionType,
    params.immutableAnchorId,
  );
  const peId = `pe_genesis_${sha256(qualificationId)}`;
  const anchor = {
    anchor_kind: bounty.dedupe.required_anchor,
    anchor_id: params.immutableAnchorId,
  } as const;
  const evidenceHash = hashGenesisEvidence({
    action_type: params.actionType,
    evidence_id: params.qualifyingActEvidenceId,
    wallet_id: params.walletId,
    economic_actor_id: params.economicActorId,
    anchor,
    qualifying_act_at_ms: params.qualifyingActAtMs,
  });
  const walletEvidenceHash = hashGenesisEvidence({
    wallet_id: params.walletId,
    evidence_id: params.walletCreatedEvidenceId,
    created_at_ms: params.walletCreatedAtMs,
  });

  const qualification: GenesisQualificationDocument = {
    schema_version: 'pvt-genesis-qualification/v2',
    qualification_id: qualificationId,
    pe_id: peId,
    action_type: params.actionType,
    wallet_id: params.walletId,
    economic_actor_id: params.economicActorId,
    actor_address: actorAddress,
    immutable_anchor: anchor,
    qualifying_act_evidence: {
      verification_status: 'verified',
      evidence_id: params.qualifyingActEvidenceId,
      evidence_hash: evidenceHash,
      subject_wallet_id: params.walletId,
      canonical_bounty_key: params.actionType,
      qualifying_act: bounty.qualifying_act,
      immutable_anchor_kind: anchor.anchor_kind,
      immutable_anchor_id: anchor.anchor_id,
      qualifying_act_at_ms: params.qualifyingActAtMs,
    },
    observation_context: {
      verification_status: 'verified',
      observed_at_ms: params.qualifyingActAtMs,
      wallet_created: {
        wallet_id: params.walletId,
        created_at_ms: params.walletCreatedAtMs,
        evidence_id: params.walletCreatedEvidenceId,
        evidence_hash: walletEvidenceHash,
        source: 'authoritative_wallet_record',
      },
    },
    status: 'pending_reservation',
    reservation_id: null,
    reserved_atomic: '0',
    economic_snapshot: null,
    economic_snapshot_hash: null,
    pe_hash: null,
    prev_hash: null,
    emission_lease_token: null,
    emission_lease_expires_at_ms: null,
    denial_reason: null,
    attempts: 0,
    created_at_ms: params.qualifyingActAtMs,
    updated_at_ms: params.qualifyingActAtMs,
    completed_at_ms: null,
  };
  return Object.freeze(qualification);
}

export function writeGenesisQualification(
  writer: AtomicWriter,
  db: Firestore,
  qualification: GenesisQualificationDocument,
): void {
  const expected = genesisQualificationId(
    qualification.action_type,
    qualification.immutable_anchor.anchor_id,
  );
  if (qualification.qualification_id !== expected) {
    throw new Error('Genesis qualification id does not match its immutable anchor');
  }
  writer.create(
    db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(expected),
    qualification,
  );
}

export function retainedGenesisQualificationRef(
  db: Firestore,
  actionType: GenesisQualificationAction,
  immutableAnchorId: string,
): DocumentReference {
  return db.collection(GENESIS_QUALIFICATION_RETENTION_COLLECTION)
    .doc(genesisQualificationId(actionType, immutableAnchorId));
}

/**
 * Persist an in-window qualifying act whose persist gate refused, so it survives
 * and can be settled later with its ORIGINAL qualifying timestamp. Keyed by the
 * same id as the outbox, so promotion and dedup are 1:1. Uses `create`, so a
 * second write over the same anchor fails closed rather than silently
 * overwriting a prior retention.
 */
export function writeRetainedGenesisQualification(
  writer: AtomicWriter,
  db: Firestore,
  qualification: GenesisQualificationDocument,
  retainedAtMs: number,
): void {
  const expected = genesisQualificationId(
    qualification.action_type,
    qualification.immutable_anchor.anchor_id,
  );
  if (qualification.qualification_id !== expected) {
    throw new Error('Genesis qualification id does not match its immutable anchor');
  }
  assertTimestamp(retainedAtMs, 'retainedAtMs');
  const record: RetainedGenesisQualification = {
    schema_version: 'pvt-genesis-retained-qualification/v1',
    retained_at_ms: retainedAtMs,
    retention_reason: 'persist_gate_refused_in_window',
    promoted_at_ms: null,
    qualification,
  };
  writer.create(
    db.collection(GENESIS_QUALIFICATION_RETENTION_COLLECTION).doc(expected),
    record,
  );
}

export function isRetainedGenesisQualification(
  value: unknown,
): value is RetainedGenesisQualification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc = value as Partial<RetainedGenesisQualification>;
  return hasExactRequiredAndOptionalKeys(
    value as Record<string, unknown>,
    [
      'schema_version',
      'retained_at_ms',
      'retention_reason',
      'promoted_at_ms',
      'qualification',
    ],
  )
    && doc.schema_version === 'pvt-genesis-retained-qualification/v1'
    && isNonNegativeSafeInteger(doc.retained_at_ms)
    && doc.retention_reason === 'persist_gate_refused_in_window'
    && (doc.promoted_at_ms === null || isNonNegativeSafeInteger(doc.promoted_at_ms))
    && isQualification(doc.qualification);
}

function isQualification(value: unknown): value is GenesisQualificationDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc = value as Partial<GenesisQualificationDocument>;
  const record = value as Record<string, unknown>;
  if (!hasExactRequiredAndOptionalKeys(
    record,
    QUALIFICATION_REQUIRED_KEYS,
    QUALIFICATION_OPTIONAL_KEYS,
  )
    || doc.schema_version !== 'pvt-genesis-qualification/v2'
    || typeof doc.qualification_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(doc.qualification_id)
    || typeof doc.pe_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(doc.pe_id)
    || typeof doc.action_type !== 'string'
    || !['genesis_human_signup', 'genesis_signup', 'genesis_device_link'].includes(doc.action_type)
    || typeof doc.wallet_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(doc.wallet_id)
    || typeof doc.economic_actor_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(doc.economic_actor_id)
    || typeof doc.actor_address !== 'string'
    || !EVM_ADDRESS.test(doc.actor_address)
    || typeof doc.immutable_anchor !== 'object'
    || doc.immutable_anchor === null
    || Array.isArray(doc.immutable_anchor)
    || !hasExactRequiredAndOptionalKeys(
      doc.immutable_anchor as unknown as Record<string, unknown>,
      ['anchor_kind', 'anchor_id'],
    )
    || typeof doc.qualifying_act_evidence !== 'object'
    || doc.qualifying_act_evidence === null
    || Array.isArray(doc.qualifying_act_evidence)
    || !hasExactRequiredAndOptionalKeys(
      doc.qualifying_act_evidence as unknown as Record<string, unknown>,
      [
        'verification_status',
        'evidence_id',
        'evidence_hash',
        'subject_wallet_id',
        'canonical_bounty_key',
        'qualifying_act',
        'immutable_anchor_kind',
        'immutable_anchor_id',
        'qualifying_act_at_ms',
      ],
    )
    || typeof doc.observation_context !== 'object'
    || doc.observation_context === null
    || Array.isArray(doc.observation_context)
    || !hasExactRequiredAndOptionalKeys(
      doc.observation_context as unknown as Record<string, unknown>,
      ['verification_status', 'observed_at_ms', 'wallet_created'],
    )) return false;

  const bounty = bountyFor(doc.action_type as GenesisQualificationAction);
  const anchor = doc.immutable_anchor;
  const evidence = doc.qualifying_act_evidence;
  const observation = doc.observation_context;
  const walletCreated = observation.wallet_created;
  if (typeof walletCreated !== 'object' || walletCreated === null
    || Array.isArray(walletCreated)
    || !hasExactRequiredAndOptionalKeys(
      walletCreated as unknown as Record<string, unknown>,
      ['wallet_id', 'created_at_ms', 'evidence_id', 'evidence_hash', 'source'],
    )
    || anchor.anchor_kind !== bounty.dedupe.required_anchor
    || typeof anchor.anchor_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(anchor.anchor_id)
    || evidence.verification_status !== 'verified'
    || typeof evidence.evidence_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(evidence.evidence_id)
    || typeof evidence.evidence_hash !== 'string'
    || !SHA256_COMMITMENT.test(evidence.evidence_hash)
    || evidence.subject_wallet_id !== doc.wallet_id
    || evidence.canonical_bounty_key !== doc.action_type
    || evidence.qualifying_act !== bounty.qualifying_act
    || evidence.immutable_anchor_kind !== anchor.anchor_kind
    || evidence.immutable_anchor_id !== anchor.anchor_id
    || !isNonNegativeSafeInteger(evidence.qualifying_act_at_ms)
    || observation.verification_status !== 'verified'
    || observation.observed_at_ms !== evidence.qualifying_act_at_ms
    || walletCreated.wallet_id !== doc.wallet_id
    || !isNonNegativeSafeInteger(walletCreated.created_at_ms)
    || walletCreated.created_at_ms > evidence.qualifying_act_at_ms
    || typeof walletCreated.evidence_id !== 'string'
    || !CANONICAL_IDENTIFIER.test(walletCreated.evidence_id)
    || typeof walletCreated.evidence_hash !== 'string'
    || !SHA256_COMMITMENT.test(walletCreated.evidence_hash)
    || walletCreated.source !== 'authoritative_wallet_record'
    || doc.qualification_id !== genesisQualificationId(doc.action_type, anchor.anchor_id)
    || doc.pe_id !== `pe_genesis_${sha256(doc.qualification_id)}`
    || !CANONICAL_ATOMIC.test(doc.reserved_atomic ?? '')
    || !isNonNegativeSafeInteger(doc.attempts)
    || !isNonNegativeSafeInteger(doc.created_at_ms)
    || doc.created_at_ms !== evidence.qualifying_act_at_ms
    || !isNonNegativeSafeInteger(doc.updated_at_ms)
    || doc.updated_at_ms < doc.created_at_ms
    || (doc.completed_at_ms !== null
      && (!isNonNegativeSafeInteger(doc.completed_at_ms)
        || doc.completed_at_ms < doc.created_at_ms))
    || (doc.recovery_attempts !== undefined
      && !isNonNegativeSafeInteger(doc.recovery_attempts))
    || (doc.last_recovery_attempt_at_ms !== undefined
      && doc.last_recovery_attempt_at_ms !== null
      && !isNonNegativeSafeInteger(doc.last_recovery_attempt_at_ms))
    || (doc.last_error !== undefined
      && (typeof doc.last_error !== 'string' || doc.last_error.length > 2_000))) return false;

  const expectedEvidenceHash = hashGenesisEvidence({
    action_type: doc.action_type,
    evidence_id: evidence.evidence_id,
    wallet_id: doc.wallet_id,
    economic_actor_id: doc.economic_actor_id,
    anchor,
    qualifying_act_at_ms: evidence.qualifying_act_at_ms,
  });
  const expectedWalletEvidenceHash = hashGenesisEvidence({
    wallet_id: doc.wallet_id,
    evidence_id: walletCreated.evidence_id,
    created_at_ms: walletCreated.created_at_ms,
  });
  if (evidence.evidence_hash !== expectedEvidenceHash
    || walletCreated.evidence_hash !== expectedWalletEvidenceHash) return false;

  const status = doc.status;
  const hasReservation = typeof doc.reservation_id === 'string'
    && CANONICAL_IDENTIFIER.test(doc.reservation_id)
    && BigInt(doc.reserved_atomic ?? '0') > 0n
    && doc.economic_snapshot !== null
    && typeof doc.economic_snapshot_hash === 'string'
    && SHA256_COMMITMENT.test(doc.economic_snapshot_hash);
  const noReservation = doc.reservation_id === null
    && doc.reserved_atomic === '0'
    && doc.economic_snapshot === null
    && doc.economic_snapshot_hash === null;
  const hasEmissionLease = typeof doc.emission_lease_token === 'string'
    && CANONICAL_IDENTIFIER.test(doc.emission_lease_token)
    && isNonNegativeSafeInteger(doc.emission_lease_expires_at_ms);
  const noEmissionLease = doc.emission_lease_token === null
    && doc.emission_lease_expires_at_ms === null;
  const hasPE = typeof doc.pe_hash === 'string'
    && PE_HASH.test(doc.pe_hash)
    && typeof doc.prev_hash === 'string'
    && PE_HASH.test(doc.prev_hash);
  const noPE = doc.pe_hash === null && doc.prev_hash === null;
  if (hasReservation) {
    try {
      if (doc.economic_snapshot_hash !== hashRecordEconomicSnapshot(doc.economic_snapshot!)
        || !isQualificationEconomicSnapshotBound(doc)) return false;
    } catch {
      return false;
    }
  }
  switch (status) {
    case 'pending_reservation':
      return noReservation && noEmissionLease && noPE
        && doc.denial_reason === null && doc.completed_at_ms === null;
    case 'reserved':
      return hasReservation && noEmissionLease && noPE
        && doc.denial_reason === null && doc.completed_at_ms === null;
    case 'emitting':
      return hasReservation && hasEmissionLease && noPE
        && doc.denial_reason === null && doc.completed_at_ms === null;
    case 'pe_recorded':
      return hasReservation && noEmissionLease && hasPE
        && doc.denial_reason === null && doc.completed_at_ms === null;
    case 'complete':
      return hasReservation && noEmissionLease && hasPE
        && doc.denial_reason === null && doc.completed_at_ms !== null;
    case 'denied':
      return noReservation && noEmissionLease && noPE
        && typeof doc.denial_reason === 'string'
        && doc.denial_reason.length > 0
        && doc.completed_at_ms !== null;
    default:
      return false;
  }
}

type GenesisSourceGet = (ref: DocumentReference) => Promise<DocumentSnapshot>;

function sourceRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function lowerAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return EVM_ADDRESS.test(normalized) ? normalized : null;
}

function genesisSourceIntegrityFailure(): never {
  throw new Error('genesis_qualification_source_integrity_invalid');
}

/**
 * Rebind a durable qualification to the authoritative product records that
 * created it. The outbox hash is an integrity commitment, not an authority
 * substitute: recovery must not mint from a self-consistently rewritten
 * wallet/proof/device identity.
 *
 * Returns the authoritative subject-wallet record it validated, resolved from
 * the OWNER-TYPE-CORRECT collection (`wallets` for a human leg, `agent_wallets`
 * for an agent leg — the device-link leg keys off `device.owner_type`). The
 * caller reuses this for the `platform: 'test'` denial so the guard checks the
 * SAME wallet, in the SAME transactional read, from the SAME correct collection
 * — never a hardcoded one that misses a test HUMAN wallet.
 */
async function assertGenesisQualificationSourceIntegrity(
  db: Firestore,
  qualification: GenesisQualificationDocument,
  get: GenesisSourceGet = (ref) => ref.get(),
): Promise<Record<string, unknown>> {
  const actAt = qualification.qualifying_act_evidence.qualifying_act_at_ms;
  const walletCreated = qualification.observation_context.wallet_created;

  if (qualification.action_type === 'genesis_human_signup') {
    const walletSnap = await get(db.collection('wallets').doc(qualification.wallet_id));
    const wallet = sourceRecord(walletSnap.data());
    if (!walletSnap.exists || wallet === null
      || wallet.id !== qualification.wallet_id
      || wallet.type !== 'human'
      || wallet.user_id !== qualification.economic_actor_id
      || lowerAddress(wallet.address) !== qualification.actor_address
      || wallet.created_at !== actAt
      || wallet.created_at !== walletCreated.created_at_ms
      || qualification.immutable_anchor.anchor_id !== qualification.wallet_id
      || qualification.qualifying_act_evidence.evidence_id
        !== `human-wallet:${qualification.wallet_id}`
      || walletCreated.evidence_id !== `human-wallet:${qualification.wallet_id}`) {
      genesisSourceIntegrityFailure();
    }
    return wallet;
  }

  if (qualification.action_type === 'genesis_signup') {
    // the qualifying act is AGENT WALLET CREATION itself, emitted inside the
    // one atomic creation transaction — never proving an external address. The sole
    // payout leg, and the actor, is the agent's OWN native wallet address, so there is
    // no `proven_addresses` record to rebind against on this path. The canonical key,
    // the 75 PVT grant, and the one-time `agent_id` anchor are all unchanged; only the
    // act moved, so this re-check must read the create-only shape the route emits.
    const walletSnap = await get(
      db.collection('agent_wallets').doc(qualification.wallet_id),
    );
    const wallet = sourceRecord(walletSnap.data());
    if (!walletSnap.exists || wallet === null
      || wallet.id !== qualification.wallet_id
      || wallet.agent_id !== qualification.economic_actor_id
      // The actor address IS the wallet's own native address, checked against the
      // authoritative record — not merely required to be some valid address.
      || lowerAddress(wallet.address) !== qualification.actor_address
      // Creation and the qualifying act are the same instant, sealed together.
      || wallet.created_at !== actAt
      || wallet.created_at !== walletCreated.created_at_ms
      || qualification.immutable_anchor.anchor_id !== qualification.economic_actor_id
      || qualification.qualifying_act_evidence.evidence_id
        !== `agent-wallet:${qualification.wallet_id}`
      || walletCreated.evidence_id !== `agent-wallet:${qualification.wallet_id}`) {
      genesisSourceIntegrityFailure();
    }
    return wallet;
  }

  const deviceSnap = await get(db.collection('devices')
    .doc(qualification.immutable_anchor.anchor_id));
  const device = sourceRecord(deviceSnap.data());
  if (!deviceSnap.exists || device === null) genesisSourceIntegrityFailure();
  if (device.device_id !== qualification.immutable_anchor.anchor_id
    || device.owner_wallet_id !== qualification.wallet_id
    || device.owner_user_id !== qualification.economic_actor_id
    || (device.owner_type !== 'human' && device.owner_type !== 'agent')
    || lowerAddress(device.owner_address) !== qualification.actor_address
    || device.created_at !== actAt
    || qualification.qualifying_act_evidence.evidence_id
      !== `registered-device:${qualification.immutable_anchor.anchor_id}`) {
    genesisSourceIntegrityFailure();
  }
  const ownerType = device.owner_type as 'human' | 'agent';
  const walletCollection = ownerType === 'human' ? 'wallets' : 'agent_wallets';
  const walletSnap = await get(db.collection(walletCollection).doc(qualification.wallet_id));
  const wallet = sourceRecord(walletSnap.data());
  if (!walletSnap.exists || wallet === null
    || wallet.id !== qualification.wallet_id
    || (ownerType === 'human'
      ? wallet.type !== 'human' || wallet.user_id !== qualification.economic_actor_id
      : qualification.economic_actor_id !== qualification.wallet_id
        || typeof wallet.agent_id !== 'string'
        || !CANONICAL_IDENTIFIER.test(wallet.agent_id))
    || lowerAddress(wallet.address) !== qualification.actor_address
    || wallet.created_at !== walletCreated.created_at_ms
    || walletCreated.evidence_id !== `${ownerType}-wallet:${qualification.wallet_id}`) {
    genesisSourceIntegrityFailure();
  }
  return wallet;
}

/**
 * A Genesis PE carries the policy identity it was built under. It is the CURRENT
 * manifest's hash, or — for a qualification whose PE was written before a policy
 * change and resumes after it — a hash in SUPERSEDED_GENESIS_POLICY_BINDINGS
 * (the window close moved; nothing about pricing did). Any other value is
 * a PE this relay did not write.
 */
export function isRecognizedGenesisPolicyManifestHash(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (value === hashGenesisCampaignPolicyManifest(PROPOSED_GENESIS_CAMPAIGN_POLICY)) return true;
  return SUPERSEDED_GENESIS_POLICY_BINDINGS.some(
    (binding) => binding.policy_version === PROPOSED_GENESIS_CAMPAIGN_POLICY.policy_version
      && binding.policy_manifest_hash === value,
  );
}

/** Neither witness field, or both: a recognized class and a non-negative safe-integer stamp. */
function genesisPEWitnessFieldsValid(pe: Record<string, unknown>): boolean {
  const hasClass = Object.prototype.hasOwnProperty.call(pe, 'witness_class');
  const hasStamp = Object.prototype.hasOwnProperty.call(pe, 'witnessed_at_ms');
  if (!hasClass && !hasStamp) return true;
  return hasClass && hasStamp
    && isWitnessClass(pe.witness_class)
    && isNonNegativeSafeInteger(pe.witnessed_at_ms);
}

function assertGenesisPEBinding(
  value: unknown,
  qualification: GenesisQualificationDocument,
): Record<string, unknown> {
  const pe = sourceRecord(value);
  const metadata = sourceRecord(pe?.metadata);
  if (pe === null || metadata === null
    || !hasExactRequiredAndOptionalKeys(pe, GENESIS_PE_KEYS, GENESIS_PE_WITNESS_KEYS)
    || !genesisPEWitnessFieldsValid(pe)
    || !hasExactRequiredAndOptionalKeys(metadata, GENESIS_PE_METADATA_KEYS)
    || pe.id !== qualification.pe_id
    || pe.wallet_id !== qualification.wallet_id
    || pe.agent_id !== qualification.economic_actor_id
    || pe.user_id !== qualification.economic_actor_id
    || pe.action_type !== qualification.action_type
    || pe.policy_action_type !== qualification.action_type
    || pe.actor_address !== qualification.actor_address
    || pe.timestamp !== qualification.observation_context.observed_at_ms
    || pe.created_at !== qualification.observation_context.observed_at_ms
    || pe.prev_hash !== qualification.prev_hash
    || pe.hash !== qualification.pe_hash
    || typeof pe.prev_hash !== 'string'
    || !PE_HASH.test(pe.prev_hash)
    || typeof pe.hash !== 'string'
    || !PE_HASH.test(pe.hash)
    || pe.attestation_type !== 'software'
    || pe.compute !== null
    || pe.geo !== null
    || pe.execution_env !== null
    || pe.cited_pe_ids !== null
    || pe.parent_goal_pe_id !== null
    || pe.integration_source !== 'agent_bank_generate_pe'
    || pe.counterparty_address !== null
    || pe.counterparty_type !== null
    || pe.session_lineage !== null
    || pe.self_referencing !== false
    || pe.trust_level_at_creation !== null
    || (pe.durability !== 'provisional' && pe.durability !== 'final')
    || metadata.genesis_qualification_id !== qualification.qualification_id
    || metadata.genesis_reservation_id !== qualification.reservation_id
    || metadata.genesis_reserved_atomic !== qualification.reserved_atomic
    || !isRecognizedGenesisPolicyManifestHash(metadata.genesis_policy_manifest_hash)
    || metadata.evidence_hash !== qualification.qualifying_act_evidence.evidence_hash
    || metadata.immutable_anchor_kind !== qualification.immutable_anchor.anchor_kind
    || metadata.verified !== true
    || metadata.canonical_event_id !== qualification.reservation_id) {
    throw new Error('genesis_pe_integrity_invalid');
  }
  const canonicalContent = {
    id: pe.id,
    wallet_id: pe.wallet_id,
    agent_id: pe.agent_id,
    action_type: pe.action_type,
    actor_address: pe.actor_address,
    timestamp: pe.timestamp,
    prev_hash: pe.prev_hash,
    attestation_type: pe.attestation_type,
    metadata,
    compute: pe.compute,
    geo: pe.geo,
    execution_env: pe.execution_env,
    cited_pe_ids: pe.cited_pe_ids,
    parent_goal_pe_id: pe.parent_goal_pe_id,
  };
  const expectedHash = crypto.createHash('sha256')
    .update(stableStringify(canonicalContent) || '')
    .digest('hex');
  if (pe.hash !== expectedHash) throw new Error('genesis_pe_integrity_invalid');
  return pe;
}

function isQualificationEconomicSnapshotBound(
  qualification: Partial<GenesisQualificationDocument>,
): boolean {
  const snapshot = qualification.economic_snapshot as RecordEconomicSnapshot | null | undefined;
  const factors = snapshot?.recordTimeFactors;
  const adjustments = snapshot?.allowedSettlementAdjustments;
  if (!snapshot || !factors || !adjustments) return false;
  let dedupeKey: string;
  try {
    dedupeKey = buildGenesisDedupeKey(
      qualification.action_type!,
      qualification.immutable_anchor!,
    );
  } catch {
    return false;
  }
  // a Genesis fixed-grant snapshot is valid whether it was sealed under the
  // v1 schema (before the money-layer pricing bump) or v2 (after). The schema
  // version never changes the exact fixed grant — Genesis is never multiplied — so
  // both reconcile identically; pinning v1 alone would reject every post-bump
  // Genesis qualification. Mirrors SUPPORTED_MONETARY_ACCOUNTING_SCHEMA_VERSIONS.
  return (snapshot.schemaVersion === MONETARY_ACCOUNTING_SCHEMA_VERSION_V1
      || snapshot.schemaVersion === MONETARY_ACCOUNTING_SCHEMA_VERSION_V2
      || snapshot.schemaVersion === MONETARY_ACCOUNTING_SCHEMA_VERSION_V3)
    && snapshot.peId === qualification.pe_id
    && snapshot.economicActorId === qualification.economic_actor_id
    && snapshot.actionType === qualification.action_type
    && snapshot.recordedAtMs === qualification.observation_context?.observed_at_ms
    && snapshot.mintDisposition === 'eligible'
    && snapshot.recordPointsAtomic === qualification.reserved_atomic
    && factors.beneficiaryAgentShareBps === 10_000
    && factors.fixedGrantSource === 'genesis_campaign_reservation'
    && factors.fixedGrantAtomic === qualification.reserved_atomic
    && factors.genesisReservationId === qualification.reservation_id
    && factors.genesisCanonicalBountyKey === qualification.action_type
    && factors.genesisDedupeKey === dedupeKey
    && factors.canonicalEventId === qualification.reservation_id
    && adjustments.verifiedAttestationUpgrade === false
    && adjustments.globalMintRate === false;
}

function isActivation(value: unknown): value is GenesisCampaignActivation {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPersistedGenesisReservation(
  value: unknown,
  qualification: GenesisQualificationDocument,
  ledgerState: GenesisCampaignLedgerState,
  activation: GenesisCampaignActivation,
  approvalVerifier: GenesisActivationApprovalVerifier,
): PersistedGenesisReservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !hasExactRequiredAndOptionalKeys(
      value as Record<string, unknown>,
      PERSISTED_RESERVATION_KEYS,
    )) return null;
  const persisted = value as Partial<PersistedGenesisReservation>;
  let dedupeKey: string;
  try {
    dedupeKey = buildGenesisDedupeKey(
      qualification.action_type,
      qualification.immutable_anchor,
    );
  } catch {
    return null;
  }
  if (persisted.schema_version !== 'pvt-genesis-reservation/v2'
    || persisted.qualification_id !== qualification.qualification_id
    || persisted.dedupe_key !== dedupeKey
    || typeof persisted.reservation !== 'object'
    || persisted.reservation === null
    || typeof persisted.economic_snapshot !== 'object'
    || persisted.economic_snapshot === null
    || typeof persisted.economic_snapshot_hash !== 'string'
    || !SHA256_COMMITMENT.test(persisted.economic_snapshot_hash)
    || !['reserved', 'pe_recorded', 'ready_for_settlement'].includes(persisted.state ?? '')
    || !isNonNegativeSafeInteger(persisted.created_at_ms)
    || !isNonNegativeSafeInteger(persisted.updated_at_ms)
    || persisted.updated_at_ms < persisted.created_at_ms
    || (persisted.pe_hash !== null
      && (typeof persisted.pe_hash !== 'string' || !PE_HASH.test(persisted.pe_hash)))) {
    return null;
  }
  try {
    if (persisted.economic_snapshot_hash
      !== hashRecordEconomicSnapshot(persisted.economic_snapshot)) return null;
  } catch {
    return null;
  }
  const replay = reserveGenesisCampaignGrant({
    manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
    activation,
    state: ledgerState,
    input: {
      pe_id: qualification.pe_id,
      action_type: qualification.action_type,
      wallet_id: qualification.wallet_id,
      economic_actor_id: qualification.economic_actor_id,
      immutable_anchor: qualification.immutable_anchor,
      qualifying_act_evidence: qualification.qualifying_act_evidence,
    },
    observation_context: qualification.observation_context,
    activation_approval_verifier: approvalVerifier,
  });
  const ledgerReservation = ledgerState.reservations_by_dedupe_key[dedupeKey];
  if (replay.allowed || replay.reason !== 'replay' || ledgerReservation === undefined) return null;
  try {
    if (canonicalJson(ledgerReservation) !== canonicalJson(persisted.reservation)) return null;
  } catch {
    return null;
  }
  const snapshotQualification: GenesisQualificationDocument = {
    ...qualification,
    reservation_id: persisted.reservation.reservation_id,
    reserved_atomic: persisted.reservation.reserved_atomic,
    economic_snapshot: persisted.economic_snapshot,
    economic_snapshot_hash: persisted.economic_snapshot_hash,
  };
  if (!isQualificationEconomicSnapshotBound(snapshotQualification)) return null;

  const stateBindingValid = qualification.status === 'pending_reservation'
    ? persisted.state === 'reserved' && persisted.pe_hash === null
    : qualification.status === 'reserved' || qualification.status === 'emitting'
      ? persisted.state === 'reserved' && persisted.pe_hash === null
      : qualification.status === 'pe_recorded'
        ? persisted.state === 'pe_recorded'
          && persisted.pe_hash === qualification.pe_hash
        : qualification.status === 'complete'
          ? persisted.state === 'ready_for_settlement'
            && persisted.pe_hash === qualification.pe_hash
          : false;
  if (!stateBindingValid) return null;

  if (qualification.status !== 'pending_reservation') {
    if (qualification.reservation_id !== persisted.reservation.reservation_id
      || qualification.reserved_atomic !== persisted.reservation.reserved_atomic
      || qualification.economic_snapshot_hash !== persisted.economic_snapshot_hash) return null;
    try {
      if (canonicalJson(qualification.economic_snapshot)
        !== canonicalJson(persisted.economic_snapshot)) return null;
    } catch {
      return null;
    }
  }
  return persisted as PersistedGenesisReservation;
}

function assertDurableGenesisReservationValues(
  qualification: GenesisQualificationDocument,
  activationValue: unknown,
  ledgerValue: unknown,
  reservationValue: unknown,
  approvalVerifier: GenesisActivationApprovalVerifier,
): PersistedGenesisReservation {
  if (!isActivation(activationValue)
    || activationValue.approval_manifest_sha256 !== PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
    || !hasGenesisMonetaryBinding(activationValue)
    || validateGenesisCampaignActivation(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
      activationValue,
      approvalVerifier,
    ) !== null
    || typeof ledgerValue !== 'object'
    || ledgerValue === null
    || Array.isArray(ledgerValue)) {
    throw new Error('genesis_reservation_integrity_invalid');
  }
  const persisted = readPersistedGenesisReservation(
    reservationValue,
    qualification,
    ledgerValue as GenesisCampaignLedgerState,
    activationValue,
    approvalVerifier,
  );
  if (persisted === null) throw new Error('genesis_reservation_integrity_invalid');
  return persisted;
}

async function assertDurableGenesisReservationIntegrity(
  db: Firestore,
  qualification: GenesisQualificationDocument,
  approvalVerifier: GenesisActivationApprovalVerifier,
): Promise<void> {
  await assertGenesisQualificationSourceIntegrity(db, qualification);
  const dedupeKey = buildGenesisDedupeKey(
    qualification.action_type,
    qualification.immutable_anchor,
  );
  const [activationSnap, ledgerSnap, reservationSnap] = await Promise.all([
    readGenesisActivation(db),
    db.collection(GENESIS_WALLET_LEDGER_COLLECTION)
      .doc(walletLedgerDocumentId(qualification.wallet_id)).get(),
    db.collection(GENESIS_RESERVATION_COLLECTION)
      .doc(reservationDocumentId(dedupeKey)).get(),
  ]);
  if (!activationSnap.exists || !ledgerSnap.exists || !reservationSnap.exists) {
    throw new Error('genesis_reservation_integrity_invalid');
  }
  assertDurableGenesisReservationValues(
    qualification,
    activationSnap.data(),
    ledgerSnap.data(),
    reservationSnap.data(),
    approvalVerifier,
  );
}

function walletLedgerDocumentId(walletId: string): string {
  return `wallet_${sha256(walletId)}`;
}

function reservationDocumentId(dedupeKey: string): string {
  return `reservation_${sha256(dedupeKey)}`;
}

function resultFor(
  qualificationId: string,
  status: GenesisProcessResult['status'],
  reason: string,
  doc?: GenesisQualificationDocument,
): GenesisProcessResult {
  return {
    qualificationId,
    status,
    reason,
    peId: doc?.pe_id ?? null,
    reservedAtomic: doc?.reserved_atomic ?? '0',
  };
}

async function reserveQualification(
  db: Firestore,
  qualificationId: string,
  approvalVerifier: GenesisActivationApprovalVerifier,
): Promise<GenesisProcessResult> {
  const outboxRef = db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qualificationId);
  return db.runTransaction(async (txn) => {
    const outboxSnap = await txn.get(outboxRef);
    if (!outboxSnap.exists || !isQualification(outboxSnap.data())) {
      return resultFor(qualificationId, 'denied', 'qualification_missing_or_invalid');
    }
    const qualification = outboxSnap.data() as GenesisQualificationDocument;
    if (qualification.qualification_id !== qualificationId) {
      return resultFor(qualificationId, 'denied', 'qualification_id_mismatch', qualification);
    }
    // A terminal replay must be revalidated by finalizeQualification. Do not
    // let a missing or rewritten activation turn a corrupt completed award into
    // a benign pending-activation response before its other bindings are read.
    if (qualification.status === 'complete') {
      return resultFor(
        qualificationId,
        'complete',
        'reservation_stage_already_processed',
        qualification,
      );
    }
    const activationRef = db.collection(GENESIS_ACTIVATION_COLLECTION)
      .doc(GENESIS_ACTIVATION_DOCUMENT);
    const activationSnap = await readGenesisActivation(db, txn);
    const activationData: unknown = activationSnap.data();
    if (!activationSnap.exists || !isActivation(activationData)) {
      return resultFor(qualificationId, 'pending_activation', 'genesis_activation_missing', qualification);
    }
    const activation = activationData;
    if (activation.approval_manifest_sha256 !== PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256) {
      return resultFor(
        qualificationId,
        'pending_activation',
        'formal_approval_manifest_hash_mismatch',
        qualification,
      );
    }
    if (!hasGenesisMonetaryBinding(activation)) {
      return resultFor(
        qualificationId,
        'pending_activation',
        'monetary_policy_hash_not_approved',
        qualification,
      );
    }
    const activationValidation = validateGenesisCampaignActivation(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
      activation,
      approvalVerifier,
    );
    if (activationValidation !== null) {
      return resultFor(
        qualificationId,
        'pending_activation',
        `genesis_activation_${activationValidation}`,
        qualification,
      );
    }
    if (qualification.status !== 'pending_reservation') {
      return resultFor(
        qualificationId,
        qualification.status,
        'reservation_stage_already_processed',
        qualification,
      );
    }
    const subjectWallet = await assertGenesisQualificationSourceIntegrity(
      db,
      qualification,
      (ref) => txn.get(ref),
    );

    // ECONOMIC-SURFACE PARITY. Seven economic surfaces already exclude
    // `platform: 'test'` wallets; the Genesis award path did not, which is why the
    // one existing mainnet grant sits on a test wallet. surfaced that gap and
    // the design requires NO on closing it; he has since given the word, so THIS SUPERSEDES
    // the residual ruling — see.
    //
    // Placed HERE, in the award transaction, rather than at the emission sites: there
    // are five Genesis entry points and adding a guard to each is the same
    // two-emission-sites shape warns about. One gate, read in the SAME
    // transaction as the reservation, so a platform flip cannot be raced by an award
    // already in flight.
    //
    // The subject wallet is the one `assertGenesisQualificationSourceIntegrity` just
    // validated, resolved from the OWNER-TYPE-CORRECT collection (`wallets` for the
    // human legs, `agent_wallets` for the agent leg). The prior code read a HARDCODED
    // `agent_wallets` doc here, so a `platform: 'test'` HUMAN wallet — whose id lives
    // in `wallets`, never `agent_wallets` — read a missing doc and was never denied
    // (how `0x903c` reserved 75 PVT). Reusing the integrity read closes that gap and
    // spends no extra transactional read.
    //
    // Denial is durable and named, not a silent skip: the outbox row records WHY, so a
    // refused test wallet is auditable rather than invisible.
    if (isTestPlatformWallet(subjectWallet)) {
      const refusedAt = Date.now();
      txn.set(outboxRef, {
        status: 'denied',
        denial_reason: GENESIS_TEST_PLATFORM_DENIAL,
        updated_at_ms: refusedAt,
        completed_at_ms: refusedAt,
      }, { merge: true });
      return resultFor(
        qualificationId,
        'denied',
        GENESIS_TEST_PLATFORM_DENIAL,
        qualification,
      );
    }

    let dedupeKey: string;
    try {
      dedupeKey = buildGenesisDedupeKey(
        qualification.action_type,
        qualification.immutable_anchor,
      );
    } catch {
      txn.set(outboxRef, {
        status: 'denied',
        denial_reason: 'invalid_immutable_anchor',
        updated_at_ms: Date.now(),
        completed_at_ms: Date.now(),
      }, { merge: true });
      return resultFor(qualificationId, 'denied', 'invalid_immutable_anchor', qualification);
    }
    const reservationRef = db.collection(GENESIS_RESERVATION_COLLECTION)
      .doc(reservationDocumentId(dedupeKey));
    const walletLedgerRef = db.collection(GENESIS_WALLET_LEDGER_COLLECTION)
      .doc(walletLedgerDocumentId(qualification.wallet_id));
    const [reservationSnap, walletLedgerSnap] = await Promise.all([
      txn.get(reservationRef),
      txn.get(walletLedgerRef),
    ]);

    const state = walletLedgerSnap.exists
      ? walletLedgerSnap.data() as GenesisCampaignLedgerState
      : createEmptyGenesisLedgerState(activation.ledger_namespace);

    if (reservationSnap.exists) {
      const persisted = readPersistedGenesisReservation(
        reservationSnap.data(),
        qualification,
        state,
        activation,
        approvalVerifier,
      );
      if (persisted === null) throw new Error('genesis_reservation_integrity_invalid');
      txn.set(outboxRef, {
        status: 'reserved',
        reservation_id: persisted.reservation.reservation_id,
        reserved_atomic: persisted.reservation.reserved_atomic,
        economic_snapshot: persisted.economic_snapshot,
        economic_snapshot_hash: persisted.economic_snapshot_hash,
        updated_at_ms: Date.now(),
      }, { merge: true });
      return resultFor(qualificationId, 'reserved', 'reservation_recovered', {
        ...qualification,
        status: 'reserved',
        reservation_id: persisted.reservation.reservation_id,
        reserved_atomic: persisted.reservation.reserved_atomic,
        economic_snapshot: persisted.economic_snapshot,
        economic_snapshot_hash: persisted.economic_snapshot_hash,
      });
    }

    const reserved = reserveGenesisCampaignGrant({
      manifest: PROPOSED_GENESIS_CAMPAIGN_POLICY,
      activation,
      state,
      input: {
        pe_id: qualification.pe_id,
        action_type: qualification.action_type,
        wallet_id: qualification.wallet_id,
        economic_actor_id: qualification.economic_actor_id,
        immutable_anchor: qualification.immutable_anchor,
        qualifying_act_evidence: qualification.qualifying_act_evidence,
      },
      observation_context: qualification.observation_context,
      activation_approval_verifier: approvalVerifier,
    });
    if (!reserved.allowed) {
      if ([
        'genesis_kill_switch_active',
        'proposal_not_approved',
        'successor_not_armed',
      ].includes(reserved.reason)) {
        return resultFor(qualificationId, 'pending_activation', reserved.reason, qualification);
      }
      const now = Date.now();
      txn.set(outboxRef, {
        status: 'denied',
        denial_reason: reserved.reason,
        updated_at_ms: now,
        completed_at_ms: now,
      }, { merge: true });
      return resultFor(qualificationId, 'denied', reserved.reason, qualification);
    }

    const policy = materializeProposedMonetaryPolicy(activation.effective_at_ms!);
    const snapshot = computeRecordSnapshot(policy, {
      peId: qualification.pe_id,
      economicActorId: qualification.economic_actor_id,
      actionType: qualification.action_type,
      recordedAtMs: reserved.reservation.reserved_at_ms,
      occurrenceOrdinal: 1,
      dailyOrdinal: 1,
      exactDuplicate: false,
      uniqueArtifact: false,
      attestationTier: 'software',
      linkageState: 'unlinked',
      evidenceState: 'verified',
      canonicalEventId: reserved.reservation.reservation_id,
      selfReferencing: false,
      sharedBeneficialOwnership: false,
      pairChurnDetected: false,
      sessionLineageId: null,
      genesisReservation: reserved.reservation,
      beneficiaryAgentShareBps: 10_000,
      operationalDispositionOverride: null,
    });
    if (snapshot.mintDisposition !== 'eligible'
      || snapshot.recordPointsAtomic !== reserved.reservation.reserved_atomic
      || snapshot.recordTimeFactors.beneficiaryAgentShareBps !== 10_000) {
      throw new Error('Genesis snapshot does not preserve the exact reservation');
    }
    const snapshotHash = hashRecordEconomicSnapshot(snapshot);
    const now = Date.now();
    if (qualification.attempts >= Number.MAX_SAFE_INTEGER) {
      throw new Error('genesis_attempt_counter_exhausted');
    }
    const persisted: PersistedGenesisReservation = {
      schema_version: 'pvt-genesis-reservation/v2',
      qualification_id: qualificationId,
      dedupe_key: reserved.reservation.dedupe_key,
      reservation: reserved.reservation,
      economic_snapshot: snapshot,
      economic_snapshot_hash: snapshotHash,
      state: 'reserved',
      pe_hash: null,
      created_at_ms: now,
      updated_at_ms: now,
    };
    txn.set(walletLedgerRef, reserved.next_state);
    txn.set(reservationRef, persisted);
    txn.set(outboxRef, {
      status: 'reserved',
      reservation_id: reserved.reservation.reservation_id,
      reserved_atomic: reserved.reservation.reserved_atomic,
      economic_snapshot: snapshot,
      economic_snapshot_hash: snapshotHash,
      attempts: qualification.attempts + 1,
      denial_reason: null,
      updated_at_ms: now,
    }, { merge: true });
    return resultFor(qualificationId, 'reserved', 'reserved', {
      ...qualification,
      status: 'reserved',
      reservation_id: reserved.reservation.reservation_id,
      reserved_atomic: reserved.reservation.reserved_atomic,
      economic_snapshot: snapshot,
      economic_snapshot_hash: snapshotHash,
    });
  });
}

async function loadQualification(
  db: Firestore,
  qualificationId: string,
): Promise<GenesisQualificationDocument> {
  const snap = await db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qualificationId).get();
  const data: unknown = snap.data();
  if (!snap.exists || !isQualification(data)) {
    throw new Error('Genesis qualification is missing or invalid');
  }
  return data;
}

async function claimEmission(
  db: Firestore,
  qualificationId: string,
  now: number,
): Promise<{ qualification: GenesisQualificationDocument; leaseToken: string } | null> {
  const outboxRef = db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qualificationId);
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAtMs = now + GENESIS_EMISSION_LEASE_MS;
  if (!Number.isSafeInteger(leaseExpiresAtMs) || leaseExpiresAtMs <= now) {
    throw new Error('genesis_emission_lease_time_invalid');
  }
  return db.runTransaction(async (txn) => {
    const snap = await txn.get(outboxRef);
    const data: unknown = snap.data();
    if (!snap.exists || !isQualification(data)) return null;
    const qualification = data;
    const expiredEmission = qualification.status === 'emitting'
      && (qualification.emission_lease_expires_at_ms ?? 0) <= now;
    if (qualification.status !== 'reserved' && !expiredEmission) return null;
    if (qualification.attempts >= Number.MAX_SAFE_INTEGER) {
      throw new Error('genesis_attempt_counter_exhausted');
    }
    txn.set(outboxRef, {
      status: 'emitting',
      emission_lease_token: leaseToken,
      emission_lease_expires_at_ms: leaseExpiresAtMs,
      attempts: qualification.attempts + 1,
      updated_at_ms: now,
    }, { merge: true });
    return {
      qualification: {
        ...qualification,
        status: 'emitting',
        emission_lease_token: leaseToken,
        emission_lease_expires_at_ms: leaseExpiresAtMs,
        attempts: qualification.attempts + 1,
        updated_at_ms: now,
      },
      leaseToken,
    };
  });
}

async function releaseEmission(
  db: Firestore,
  qualificationId: string,
  leaseToken: string,
  error: unknown,
): Promise<void> {
  const outboxRef = db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qualificationId);
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(outboxRef);
    const data: unknown = snap.data();
    if (!snap.exists || !isQualification(data)) return;
    if (data.status !== 'emitting' || data.emission_lease_token !== leaseToken) return;
    txn.set(outboxRef, {
      status: 'reserved',
      emission_lease_token: null,
      emission_lease_expires_at_ms: null,
      last_error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      updated_at_ms: Date.now(),
    }, { merge: true });
  });
}

function assertReservedQualification(
  qualification: GenesisQualificationDocument,
): asserts qualification is GenesisQualificationDocument & {
  reservation_id: string;
  economic_snapshot: RecordEconomicSnapshot;
  economic_snapshot_hash: string;
} {
  if (!qualification.reservation_id
    || !qualification.economic_snapshot
    || !qualification.economic_snapshot_hash
    || qualification.economic_snapshot_hash
      !== hashRecordEconomicSnapshot(qualification.economic_snapshot)
    || qualification.economic_snapshot.recordPointsAtomic !== qualification.reserved_atomic) {
    throw new Error('Genesis qualification reservation payload is invalid');
  }
}

function accrualParams(
  qualification: GenesisQualificationDocument & {
    economic_snapshot: RecordEconomicSnapshot;
  },
  peHash: string,
) {
  return {
    peId: qualification.pe_id,
    userId: qualification.economic_actor_id,
    actionType: qualification.action_type,
    integrationSource: 'genesis_award_state_machine_v2',
    attestationDepth: 'software' as const,
    peHash,
    timestamp: qualification.observation_context.observed_at_ms,
    economicEvidenceState: 'verified' as const,
    economicCanonicalEventId: qualification.reservation_id,
    economicSessionLineageId: null,
    economicSnapshot: qualification.economic_snapshot,
    isGenesisGrant: true,
    throwOnError: true,
  };
}

async function emitReservedQualification(
  deps: GenesisStateMachineDeps,
  qualification: GenesisQualificationDocument,
  approvalVerifier: GenesisActivationApprovalVerifier,
): Promise<GeneratedPE> {
  assertReservedQualification(qualification);
  const emitter = deps.emitGenesisPE ?? generatePE;
  const outboxRef = deps.db.collection(GENESIS_QUALIFICATION_COLLECTION)
    .doc(qualification.qualification_id);
  const dedupeKey = buildGenesisDedupeKey(
    qualification.action_type,
    qualification.immutable_anchor,
  );
  const reservationRef = deps.db.collection(GENESIS_RESERVATION_COLLECTION)
    .doc(reservationDocumentId(dedupeKey));
  const ledgerRef = deps.db.collection(GENESIS_WALLET_LEDGER_COLLECTION)
    .doc(walletLedgerDocumentId(qualification.wallet_id));
  const activationRef = deps.db.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT);
  return emitter(deps, {
    walletId: qualification.wallet_id,
    agentId: qualification.economic_actor_id,
    actorAddress: qualification.actor_address,
    actionType: qualification.action_type,
    accrualActionType: qualification.action_type,
    peIdOverride: qualification.pe_id,
    timestampOverride: qualification.observation_context.observed_at_ms,
    economicSnapshot: qualification.economic_snapshot,
    awaitAccrual: true,
    isGenesisGrant: true,
    metadata: {
      genesis_qualification_id: qualification.qualification_id,
      genesis_reservation_id: qualification.reservation_id,
      genesis_reserved_atomic: qualification.reserved_atomic,
      genesis_policy_manifest_hash: hashGenesisCampaignPolicyManifest(
        PROPOSED_GENESIS_CAMPAIGN_POLICY,
      ),
      evidence_hash: qualification.qualifying_act_evidence.evidence_hash,
      immutable_anchor_kind: qualification.immutable_anchor.anchor_kind,
      verified: true,
      canonical_event_id: qualification.reservation_id,
    },
    atomicEntityPrecondition: async (txn) => {
      const [outboxSnap, reservationSnap, ledgerSnap, activationSnap] = await Promise.all([
        txn.get(outboxRef),
        txn.get(reservationRef),
        txn.get(ledgerRef),
        readGenesisActivation(deps.db, txn),
      ]);
      const current: unknown = outboxSnap.data();
      if (!outboxSnap.exists || !isQualification(current)
        || current.status !== 'emitting'
        || current.emission_lease_token !== qualification.emission_lease_token
        || !reservationSnap.exists
        || !ledgerSnap.exists
        || !activationSnap.exists) {
        throw new Error('genesis_emission_precondition_invalid');
      }
      assertDurableGenesisReservationValues(
        current,
        activationSnap.data(),
        ledgerSnap.data(),
        reservationSnap.data(),
        approvalVerifier,
      );
      await assertGenesisQualificationSourceIntegrity(
        deps.db,
        current,
        (ref) => txn.get(ref),
      );
    },
    atomicEntityWrite: (txn, _peId, context) => {
      if (!context) throw new Error('Genesis PE atomic context is missing');
      txn.set(outboxRef, {
        status: 'pe_recorded',
        pe_hash: context.newHash,
        prev_hash: context.prevHash,
        emission_lease_token: null,
        emission_lease_expires_at_ms: null,
        updated_at_ms: Date.now(),
      }, { merge: true });
      txn.set(reservationRef, {
        state: 'pe_recorded',
        pe_hash: context.newHash,
        updated_at_ms: Date.now(),
      }, { merge: true });
    },
  });
}

async function resumeAccrual(
  deps: GenesisStateMachineDeps,
  qualification: GenesisQualificationDocument,
): Promise<void> {
  assertReservedQualification(qualification);
  await assertGenesisQualificationSourceIntegrity(deps.db, qualification);
  // PE METER: the PE's tip transaction staged its pricing intake beside the outbox flip. A process
  // that died before pricing left it staged; price it now (idempotent on the act key). An act
  // already priced has nothing to resume.
  const intakeSnap = await privateRetentionCollection(deps.db, METER_RELAY_ACTS_COLLECTION).doc(qualification.pe_id).get();
  if (intakeSnap.exists) {
    const intake = intakeSnap.data() as RelayActIntake;
    if (intake.act?.pe_hash !== qualification.pe_hash || intake.actor_id !== qualification.economic_actor_id) {
      throw new Error('genesis_pe_integrity_invalid');
    }
    await priceRelayAct(deps.db, intake, {
      record: (params) => deps.recordPEAccrual({ ...params, attestationDepth: 'software' }),
    });
    return;
  }
  const keySnap = await privateRetentionCollection(deps.db, METER_ACT_KEYS_COLLECTION).doc(qualification.pe_id).get();
  if (keySnap.exists) return;
  // A pre-meter qualification: its envelope is still the binding.
  const peSnap = await deps.db.collection('provenance_envelopes')
    .doc(qualification.pe_id)
    .get();
  if (!peSnap.exists) throw new Error('genesis_pe_integrity_invalid');
  const pe = assertGenesisPEBinding(peSnap.data(), qualification);
  await deps.recordPEAccrual(accrualParams(qualification, pe.hash as string));
}

/**
 * The accrual's acknowledgement of a Genesis grant: the priced row, from the act key (metered) or
 * `pe_history` (pre-meter). Null when the row is missing or does not match the qualification.
 */
function genesisAcknowledgement(
  current: GenesisQualificationDocument,
  key: Record<string, unknown> | undefined,
  legacy: { readonly envelope: unknown; readonly history: Record<string, unknown> | undefined } | null,
): Record<string, unknown> | null {
  let history: Record<string, unknown> | undefined;
  let peHash: unknown;
  if (key !== undefined) {
    const row = key.row as Record<string, unknown> | undefined;
    // The act key's identity is the PE the tip advanced to in the same transaction that recorded
    // `pe_hash` on the outbox, so a matching hash binds this row to this grant's exact PE.
    if (key.pe_hash !== current.pe_hash
      || key.prev_hash !== current.prev_hash
      || key.timestamp !== current.observation_context.observed_at_ms
      || key.actor_id !== current.economic_actor_id
      || key.action_type !== current.action_type
      || row?.is_genesis_grant !== true
      || key.legs !== null) {
      return null;
    }
    history = row;
    peHash = key.pe_hash;
  } else if (legacy !== null) {
    assertGenesisPEBinding(legacy.envelope, current);
    history = legacy.history;
    peHash = history?.peHash;
  } else {
    return null;
  }
  // A qualification already `complete` has handed its reservation to settlement, which flips
  // the row to `minted` once the grant lands on-chain. Replaying it (a registration replay
  // re-processes the signup qualification) must still read as complete, not 503 forever;
  // that path writes nothing (follow-up). Before completion only `eligible` is valid.
  const acknowledgedMintStatus = current.status === 'complete'
    ? history?.mint_status === 'eligible' || history?.mint_status === 'minted'
    : history?.mint_status === 'eligible';
  if (history === undefined
    || history.economic_snapshot_hash !== current.economic_snapshot_hash
    || history.record_points_atomic !== current.reserved_atomic
    || peHash !== current.pe_hash
    || history.mint_disposition !== 'eligible'
    || !acknowledgedMintStatus
    || history.actionType !== current.action_type
    || history.userId !== current.economic_actor_id) {
    return null;
  }
  return history;
}

async function finalizeQualification(
  db: Firestore,
  qualificationId: string,
  approvalVerifier: GenesisActivationApprovalVerifier,
): Promise<GenesisProcessResult> {
  const qualification = await loadQualification(db, qualificationId);
  assertReservedQualification(qualification);
  const dedupeKey = buildGenesisDedupeKey(
    qualification.action_type,
    qualification.immutable_anchor,
  );
  const outboxRef = db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(qualificationId);
  const reservationRef = db.collection(GENESIS_RESERVATION_COLLECTION)
    .doc(reservationDocumentId(dedupeKey));
  const ledgerRef = db.collection(GENESIS_WALLET_LEDGER_COLLECTION)
    .doc(walletLedgerDocumentId(qualification.wallet_id));
  const activationRef = db.collection(GENESIS_ACTIVATION_COLLECTION)
    .doc(GENESIS_ACTIVATION_DOCUMENT);
  const keyRef = privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(qualification.pe_id);
  const peRef = db.collection('provenance_envelopes').doc(qualification.pe_id);
  const peHistoryRef = db.collection('pe_history').doc(qualification.pe_id);
  const now = Date.now();
  const finalized = await db.runTransaction(async (txn) => {
    const [outboxSnap, reservationSnap, ledgerSnap, activationSnap, keySnap, peSnap, historySnap] =
      await Promise.all([
      txn.get(outboxRef),
      txn.get(reservationRef),
      txn.get(ledgerRef),
      readGenesisActivation(db, txn),
      txn.get(keyRef),
      txn.get(peRef),
      txn.get(peHistoryRef),
    ]);
    const current: unknown = outboxSnap.data();
    if (!outboxSnap.exists || !isQualification(current)) {
      throw new Error('Genesis outbox disappeared before completion');
    }
    if (!['pe_recorded', 'complete'].includes(current.status)
      || !reservationSnap.exists
      || !ledgerSnap.exists
      || !activationSnap.exists) {
      throw new Error('Genesis outbox is not ready for completion');
    }
    assertDurableGenesisReservationValues(
      current,
      activationSnap.data(),
      ledgerSnap.data(),
      reservationSnap.data(),
      approvalVerifier,
    );
    await assertGenesisQualificationSourceIntegrity(db, current, (ref) => txn.get(ref));
    // A completed grant whose records are all retired (its act key expired 31 days after the mint,
    // or the migration removed its pre-meter rows) was acknowledged and handed to settlement long
    // ago; a replay of it writes nothing. A partial set is inconsistent and refused below.
    if (current.status === 'complete' && !keySnap.exists && !peSnap.exists && !historySnap.exists) {
      return current;
    }
    if (!keySnap.exists && !peSnap.exists) throw new Error('genesis_pe_integrity_invalid');
    const acknowledged = genesisAcknowledgement(
      current,
      keySnap.exists ? (keySnap.data() as Record<string, unknown>) : undefined,
      keySnap.exists ? null : { envelope: peSnap.data(), history: historySnap.data() as Record<string, unknown> | undefined },
    );
    if (acknowledged === null) {
      throw new Error('Genesis pe_history acknowledgement is missing or mismatched');
    }
    if (current.status === 'complete') return current;
    txn.set(outboxRef, {
      status: 'complete',
      completed_at_ms: now,
      updated_at_ms: now,
    }, { merge: true });
    txn.set(reservationRef, {
      state: 'ready_for_settlement',
      updated_at_ms: now,
    }, { merge: true });
    return { ...current, status: 'complete' as const, completed_at_ms: now, updated_at_ms: now };
  });
  return resultFor(
    qualificationId,
    'complete',
    finalized.completed_at_ms === qualification.completed_at_ms ? 'already_complete' : 'complete',
    finalized,
  );
}

export async function processGenesisQualification(
  deps: GenesisStateMachineDeps,
  qualificationId: string,
  options: { now?: number; hooks?: GenesisProcessHooks } = {},
): Promise<GenesisProcessResult> {
  const now = options.now ?? Date.now();
  assertTimestamp(now, 'process now');
  const approvalVerifier = deps.verifyGenesisActivationApproval
    ?? verifyGenesisCampaignActivationApproval;
  const reservationStage = await reserveQualification(
    deps.db,
    qualificationId,
    approvalVerifier,
  );
  if (reservationStage.status === 'complete') {
    return finalizeQualification(deps.db, qualificationId, approvalVerifier);
  }
  if (reservationStage.status === 'pending_activation'
    || reservationStage.status === 'denied') {
    return reservationStage;
  }

  let qualification = await loadQualification(deps.db, qualificationId);
  await assertDurableGenesisReservationIntegrity(
    deps.db,
    qualification,
    approvalVerifier,
  );
  if (qualification.status === 'reserved') {
    await options.hooks?.afterReservation?.(qualification);
  }
  if (qualification.status === 'pe_recorded') {
    await resumeAccrual(deps, qualification);
    return finalizeQualification(deps.db, qualificationId, approvalVerifier);
  }
  if (qualification.status === 'emitting'
    && (qualification.emission_lease_expires_at_ms ?? 0) > now) {
    return resultFor(qualificationId, 'in_progress', 'emission_lease_active', qualification);
  }

  const claim = await claimEmission(deps.db, qualificationId, now);
  if (!claim) {
    qualification = await loadQualification(deps.db, qualificationId);
    if (qualification.status === 'pe_recorded') {
      await resumeAccrual(deps, qualification);
      return finalizeQualification(deps.db, qualificationId, approvalVerifier);
    }
    return resultFor(qualificationId, 'in_progress', 'emission_not_claimed', qualification);
  }

  try {
    await emitReservedQualification(deps, claim.qualification, approvalVerifier);
  } catch (error) {
    await releaseEmission(deps.db, qualificationId, claim.leaseToken, error);
    throw error;
  }
  await options.hooks?.afterPERecorded?.(qualificationId);
  return finalizeQualification(deps.db, qualificationId, approvalVerifier);
}

/**
 * Bounded Genesis recovery drain. Re-drives every stranded qualification (a
 * grant whose fire-and-forget advance was killed by a Cloud Run instance reclaim)
 * to `complete` so the settlement inlet mints it. Scheduled via the
 * `provian-genesis-drain` cron (F-A1-1, `/v1/internal/scheduler/genesis-drain`);
 * lease-guarded and resumable, so a scheduler retry cannot double-grant.
 */
export async function drainGenesisQualifications(
  deps: GenesisStateMachineDeps,
  options: {
    limit?: number;
    now?: number;
    /** Pure test/recovery seam; production always uses processGenesisQualification. */
    processQualification?: typeof processGenesisQualification;
  } = {},
): Promise<GenesisProcessResult[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const recoveryNow = options.now ?? Date.now();
  assertTimestamp(recoveryNow, 'recovery now');
  const approvalVerifier = deps.verifyGenesisActivationApproval
    ?? verifyGenesisCampaignActivationApproval;
  const activationSnap = await readGenesisActivation(deps.db);
  const activationValue: unknown = activationSnap.data();
  if (!activationSnap.exists || !isActivation(activationValue)
    || activationValue.approval_manifest_sha256 !== PROPOSED_PVT9_APPROVAL_MANIFEST_SHA256
    || !hasGenesisMonetaryBinding(activationValue)
    || validateGenesisCampaignActivation(
      PROPOSED_GENESIS_CAMPAIGN_POLICY,
      activationValue,
      approvalVerifier,
    ) !== null) {
    throw new Error('genesis_recovery_activation_not_approved');
  }
  const candidates = new Map<string, {
    recoveryAttempts: number;
    attempts: number;
    updatedAtMs: number;
  }>();
  let cursorId: string | null = null;
  // only rows still in a recoverable status are read, so a run costs what is stranded,
  // not one read per Genesis row ever recorded (it paged the whole outbox every 30 minutes).
  // Every other row was skipped below anyway; the per-row guard still runs on what is read.
  for (;;) {
    let query = deps.db.collection(GENESIS_QUALIFICATION_COLLECTION)
      .where('status', 'in', [...RECOVERABLE_QUALIFICATION_STATUSES])
      .orderBy(FieldPath.documentId(), 'asc')
      .limit(100);
    if (cursorId !== null) query = query.startAfter(cursorId);
    const snap = await query.get();
    if (snap.empty) break;
    for (const doc of snap.docs) {
      const data: unknown = doc.data();
      // A recovery candidate is a WELL-FORMED qualification, bound to its own id, in a
      // still-in-flight state. Every other row is SKIPPED, never thrown on: this bounded
      // drain runs on a 30-minute cron, and throwing here 500s every run forever and
      // starves every genuinely-stranded grant behind the offending row. The query reads
      // only recoverable statuses; before that it saw the WHOLE collection and met
      // terminal rows — a `denied`/`complete` row legitimately carries null lease fields the
      // live-qualification guard rejects
      // (landing: the first live run threw on a correctly-denied test-wallet row) —
      // and it may meet an unparseable or unknown-status row. None of those can be advanced
      // by `processGenesisQualification`, so skipping is fail-closed (an unrecoverable grant
      // stays un-minted; "Unknown = Block" means do-not-mint, not halt-the-batch), never a
      // mint risk. `||` short-circuits, so `data.status` is only read once the guard has
      // narrowed the type.
      if (!isQualification(data)
        || data.qualification_id !== doc.id
        || !(RECOVERABLE_QUALIFICATION_STATUSES as readonly string[]).includes(data.status)) {
        continue;
      }
      candidates.set(doc.id, {
        recoveryAttempts: data.recovery_attempts ?? 0,
        attempts: data.attempts,
        updatedAtMs: data.updated_at_ms,
      });
    }
    cursorId = snap.docs[snap.docs.length - 1].id;
    if (snap.size < 100) break;
  }
  const ids = [...candidates.entries()]
    .sort((a, b) =>
      a[1].recoveryAttempts - b[1].recoveryAttempts
      || a[1].attempts - b[1].attempts
      || a[1].updatedAtMs - b[1].updatedAtMs
      || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([id]) => id);
  const results: GenesisProcessResult[] = [];
  const processor = options.processQualification ?? processGenesisQualification;
  for (const id of ids) {
    try {
      const marked = await deps.db.runTransaction(async (txn) => {
        const ref = deps.db.collection(GENESIS_QUALIFICATION_COLLECTION).doc(id);
        const snap = await txn.get(ref);
        const data: unknown = snap.data();
        if (!snap.exists || !isQualification(data)
          || !(RECOVERABLE_QUALIFICATION_STATUSES as readonly string[]).includes(data.status)) {
          return false;
        }
        const recoveryAttempts = data.recovery_attempts ?? 0;
        if (!Number.isSafeInteger(recoveryAttempts)
          || recoveryAttempts < 0
          || recoveryAttempts >= Number.MAX_SAFE_INTEGER) {
          throw new Error('genesis_recovery_attempt_counter_invalid');
        }
        txn.set(ref, {
          recovery_attempts: recoveryAttempts + 1,
          last_recovery_attempt_at_ms: recoveryNow,
        }, { merge: true });
        return true;
      });
      if (!marked) continue;
      results.push(await processor(deps, id, { now: recoveryNow }));
    } catch (error) {
      results.push(resultFor(
        id,
        'in_progress',
        error instanceof Error ? error.message : String(error),
      ));
    }
  }
  return results;
}
