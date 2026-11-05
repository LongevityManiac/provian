/**
 * Provian institution state vocabulary — the SDK/CLI mirror of the relay's
 * single receipt-driven institution state machine.
 *
 * SOURCE OF TRUTH: provian-backend/src/core/agent-bank/institution-state-machine.ts.
 * This module MUST mirror that machine's state sets and transition
 * classification byte-for-byte. A backend test
 * (institution-state-machine.sdk-mirror.test.ts) reads THIS file and fails if
 * the two ever drift, so keep them in lockstep (same pattern as the shared
 * session-file record with @provian/cli).
 *
 * It is intentionally dependency-free and LOGIC-ONLY: an agent, the CLI, or a UI
 * uses it to know whether an institution transition is a record-only DRAFT (no
 * on-chain receipt, no money) or an AUTHORITATIVE ECONOMIC transition (which
 * will require a Base-final on-chain receipt at the relay and is idempotent by
 * tx hash). The relay owns the receipt gate, the agent-wallet status check
 * (a suspended wallet is refused), and the idempotency ledger; the SDK owns none
 * of that authority and this module deliberately carries no receipt or status
 * logic.
 */

export type InstitutionKind =
  | 'escrow'
  | 'promise'
  | 'pool'
  | 'bond'
  | 'bond_claim'
  | 'job'
  | 'human_job'
  | 'court_dispute'
  | 'general_dispute';

export const INSTITUTION_KINDS: readonly InstitutionKind[] = [
  'escrow',
  'promise',
  'pool',
  'bond',
  'bond_claim',
  'job',
  'human_job',
  'court_dispute',
  'general_dispute',
];

/** Full state set per institution (mirrors the relay status enums). */
export const INSTITUTION_STATES: Readonly<Record<InstitutionKind, readonly string[]>> = {
  escrow: ['created', 'funded', 'completed', 'disputed', 'resolved', 'cancelled'],
  promise: ['open', 'funded', 'settled', 'defaulted', 'cancelled'],
  pool: ['open', 'funded', 'executed', 'refunded', 'cancelled'],
  bond: ['active', 'expired', 'withdrawn', 'abandoned'],
  bond_claim: ['filed', 'upheld', 'dismissed', 'expired'],
  job: ['open', 'assigned', 'delivered', 'completed', 'cancelled', 'refunded'],
  human_job: ['open', 'in_progress', 'completed', 'disputed', 'cancelled', 'refunded'],
  court_dispute: ['pending', 'resolved', 'escalated'],
  general_dispute: ['filed', 'panel_assigned', 'evidence_period', 'voting', 'resolved', 'escalated'],
};

/**
 * Synthetic pre-existence source for a record's first transition (bond post,
 * claim filing, job posting). Never a member of any state set.
 */
export const INITIAL = '__initial__' as const;

/**
 * `record_only` — a draft / non-value-moving record (no receipt, no money).
 * `economic` — an authoritative on-chain-settled outcome (Base-final receipt
 * required at the relay; idempotent by tx hash).
 */
export type TransitionClass = 'record_only' | 'economic';

/**
 * The canonical transition table as flat `[kind, from, to, class]` rows — the
 * exact edges the relay machine declares. Flat + quoted so the backend mirror
 * test can regex-extract and set-compare it. Downstream WPs extend the relay
 * table; this mirror moves with it.
 */
export const INSTITUTION_TRANSITIONS: readonly [InstitutionKind, string, string, TransitionClass][] = [
  ['escrow', INITIAL, 'created', 'record_only'],
  ['escrow', 'created', 'funded', 'economic'],
  ['escrow', 'created', 'cancelled', 'record_only'],
  ['escrow', 'funded', 'completed', 'economic'],
  ['escrow', 'funded', 'disputed', 'record_only'],
  ['escrow', 'disputed', 'resolved', 'economic'],
  ['promise', INITIAL, 'open', 'record_only'],
  ['promise', 'open', 'funded', 'economic'],
  ['promise', 'open', 'cancelled', 'record_only'],
  ['promise', 'funded', 'settled', 'economic'],
  ['pool', INITIAL, 'open', 'record_only'],
  ['pool', 'open', 'funded', 'economic'],
  ['pool', 'open', 'cancelled', 'record_only'],
  ['pool', 'funded', 'executed', 'economic'],
  // bond lifecycle — non-adjudicative bond lifecycle. Backend 'expired' is an OFF-CHAIN
  // autonomy-privilege drop (record_only; the on-chain bond stays Active);
  // renew/top-up (active→active), late renewal (expired→active), withdrawal,
  // the abandonment burn, and claim filing/expiry are all receipt-gated
  // economic edges. Court outcomes (filed→upheld|dismissed) are agent directory wiring.
  ['bond', INITIAL, 'active', 'economic'],
  ['bond', 'active', 'active', 'economic'],
  ['bond', 'active', 'expired', 'record_only'],
  ['bond', 'active', 'withdrawn', 'economic'],
  ['bond', 'expired', 'active', 'economic'],
  ['bond', 'expired', 'withdrawn', 'economic'],
  ['bond', 'expired', 'abandoned', 'economic'],
  ['bond_claim', INITIAL, 'filed', 'economic'],
  ['bond_claim', 'filed', 'upheld', 'economic'],
  ['bond_claim', 'filed', 'dismissed', 'economic'],
  ['bond_claim', 'filed', 'expired', 'economic'],
  ['job', INITIAL, 'open', 'record_only'],
  ['job', 'open', 'assigned', 'record_only'],
  ['job', 'assigned', 'delivered', 'record_only'],
  ['job', 'open', 'cancelled', 'record_only'],
  ['job', 'assigned', 'cancelled', 'record_only'],
  // linked-job settlement settlement truth: a job terminates ONLY off its linked escrow's
  // on-chain settlement. 'completed' = escrow released to the worker;
  // 'refunded' = the disputed escrow refunded the poster (worker NOT paid).
  ['job', 'assigned', 'completed', 'economic'],
  ['job', 'delivered', 'completed', 'economic'],
  ['job', 'assigned', 'refunded', 'economic'],
  ['job', 'delivered', 'refunded', 'economic'],
  // linked-job settlement — Commons human jobs ride the same auto-escrow receipts. 'completed'
  // is written only by the relay's receipt-gated settlement path (the poster's
  // confirmation is a record, not a status flip while payment is pending).
  ['human_job', INITIAL, 'open', 'record_only'],
  ['human_job', 'open', 'in_progress', 'record_only'],
  ['human_job', 'in_progress', 'disputed', 'record_only'],
  ['human_job', 'in_progress', 'completed', 'economic'],
  ['human_job', 'disputed', 'completed', 'economic'],
  ['human_job', 'in_progress', 'refunded', 'economic'],
  ['human_job', 'disputed', 'refunded', 'economic'],
  // agent directory — Court process records. Recording an escrow-dispute VERDICT requires
  // the underlying escrow's Base-final settlement receipt, so court_dispute
  // pending→resolved is economic; every other Court edge is record-only
  // process truth (a general-dispute resolution moves no funds itself — its
  // money legs are the separately-gated bond_claim / escrow edges).
  // 'panel_assigned' and court_dispute escalated→resolved are writer-less
  // behind Unknown = Block at the relay.
  ['court_dispute', INITIAL, 'pending', 'record_only'],
  ['court_dispute', 'pending', 'resolved', 'economic'],
  ['court_dispute', 'pending', 'escalated', 'record_only'],
  ['general_dispute', INITIAL, 'filed', 'record_only'],
  ['general_dispute', 'filed', 'evidence_period', 'record_only'],
  ['general_dispute', 'evidence_period', 'voting', 'record_only'],
  ['general_dispute', 'voting', 'resolved', 'record_only'],
  ['general_dispute', 'filed', 'escalated', 'record_only'],
  ['general_dispute', 'voting', 'escalated', 'record_only'],
];

/**
 * Classify a transition: `'economic'`, `'record_only'`, or `null` (illegal /
 * unknown). Mirrors the relay guard's classification (without its receipt /
 * wallet-status gate, which is relay-only authority).
 */
export function classifyTransition(
  kind: InstitutionKind,
  from: string,
  to: string,
): TransitionClass | null {
  const row = INSTITUTION_TRANSITIONS.find((t) => t[0] === kind && t[1] === from && t[2] === to);
  return row ? row[3] : null;
}

/** True iff the transition is a declared ECONOMIC (receipt-driven) edge. */
export function isEconomicTransition(kind: InstitutionKind, from: string, to: string): boolean {
  return classifyTransition(kind, from, to) === 'economic';
}

/** True iff (kind, from, to) is a declared legal edge (economic or record-only). */
export function isLegalTransition(kind: InstitutionKind, from: string, to: string): boolean {
  return classifyTransition(kind, from, to) !== null;
}
