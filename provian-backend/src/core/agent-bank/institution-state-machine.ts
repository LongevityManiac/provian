/**
 * beneficiary routing — the single receipt-driven institution state machine.
 *
 * Every Agent Bank institution (escrow, promise, pool, bond, bond claim, job)
 * follows ONE model, which this module is the single source of truth for:
 *
 * - a DRAFT (record-only) state is written by the relay with a self-asserted
 * Provenance Envelope. It moves NO money and confers NO economic effect.
 * Entering it needs no on-chain receipt (escrow `created`; promise/pool
 * `open`; a raised-but-unsettled `disputed`; a `cancelled` draft; the job
 * `open`/`assigned`/`delivered` and human-job `open`/`in_progress`/
 * `disputed` lifecycles).
 *
 * - an ECONOMIC transition is AUTHORITATIVE: it may fire only when a
 * Base-FINAL on-chain receipt (the 12-confirmation floor, quorum-2 verified
 * see `tx-verifier.ts` / `economic-finality.ts` or the relay's own
 * confirmed settle()/settleDispute() gateway outcome, the same trust root
 * the escrow record itself is flipped on) proves the underlying
 * transfer/settlement, AND it is idempotent by `tx_hash` so a retry can
 * never record a duplicate economic PE (escrow `funded`/`completed`/
 * `resolved`; promise `funded`/`settled`; pool `funded`/`executed`; bond
 * `active`/`withdrawn`; a bond claim `filed`/`upheld`/`dismissed`; a job or
 * human job settling `completed`/`refunded` off its linked escrow — linked-job settlement).
 *
 * The relay's per-institution paths already implement this split ad hoc — a
 * create endpoint writes a record-only status, a later tx-bearing endpoint runs
 * a one-shot verifier and flips to an authoritative status, and the `tx_hash`
 * idempotency guard is reimplemented independently in several places. This
 * module unifies the decision into one fail-closed guard so every path (and the
 * downstream linked-job settlement/bond lifecycle/agent directory wirings) shares one classification and one gate.
 *
 * DESIGN — this module is PURE. It performs NO Firestore read/write, NO RPC, and
 * NO authorization. It CONSUMES the boolean OUTCOME of a receipt verification
 * (`ReceiptEvidence`, structurally the shape of `TxVerificationResult` plus the
 * tx hash), never performs one. It NEVER grants authorization: the wallet-auth
 * vs agent-credential boundary, the agent-wallet status read, and the SSRF gates
 * all live upstream and are passed in as inputs. It fails closed — an unknown institution
 * kind or a transition not declared in the table is BLOCKED (Unknown = Block),
 * so the downstream WPs extend the table as they wire each route rather than the
 * guard silently permitting an unmodeled transition.
 */

// =============================================================================
// Institution kinds and their state sets
//
// Each `*_STATES` tuple is the FULL state set of that institution and is bound —
// at compile time, in institution-state-machine.conformance.test.ts — to the
// live `EscrowStatus` / `PromiseStatus` / `PoolStatus` / `BondStatus` /
// `BondClaimStatus` / `JobStatus` union in `types.ts` (and `HumanJobStatus` in
// `../commons/types.ts`), so the one machine can never silently drift from the
// institutions it governs.
// =============================================================================

export const ESCROW_STATES = [
  'created',
  'funded',
  'completed',
  'disputed',
  'resolved',
  'cancelled',
] as const;
export const PROMISE_STATES = [
  'open',
  'funded',
  'settled',
  'defaulted',
  'cancelled',
] as const;
export const POOL_STATES = [
  'open',
  'funded',
  'executed',
  'refunded',
  'cancelled',
] as const;
export const BOND_STATES = [
  'active',
  'expired',
  'withdrawn',
  'abandoned',
] as const;
export const BOND_CLAIM_STATES = [
  'filed',
  'upheld',
  'dismissed',
  'expired',
] as const;
export const JOB_STATES = [
  'open',
  'assigned',
  'delivered',
  'completed',
  'cancelled',
  'refunded',
] as const;
/**
 * linked-job settlement — Commons human jobs (agents hiring humans). Bound to the live
 * `HumanJobStatus` union in `../commons/types.ts` by the conformance test, the
 * same way the agent-board tuple binds to `JobStatus`. Payment rides the SAME
 * auto-escrow (pitfalls #25/#35 — no parallel escrow path), so its economic
 * edges consume the escrow settlement receipt exactly like the agent board's.
 */
export const HUMAN_JOB_STATES = [
  'open',
  'in_progress',
  'completed',
  'disputed',
  'cancelled',
  'refunded',
] as const;
/**
 * agent directory — Court process records. `court_dispute` is the escrow-dispute panel
 * record (`court_disputes/`, bound to `CourtDisputeStatus`); `general_dispute`
 * is the Court-mandate-expansion record (`general_disputes/`, bound to
 * `GeneralDisputeStatus`). The Court's MONEY truth rides the institutions it
 * adjudicates — escrow `disputed`→`resolved` and bond_claim
 * `filed`→`upheld`|`dismissed` but recording a COURT VERDICT on an escrow
 * dispute itself requires the underlying escrow's Base-final settlement
 * receipt (Pass-3 #1, now machine-enforced), so court_dispute
 * pending→resolved is economic. Every other declared edge is record-only
 * process truth: panel assignment, evidence-window advance, deadline
 * escalations, and the general-dispute verdict record (a general-dispute
 * resolution moves no funds itself; its bond-claim/forum legs are gated
 * separately on their own kinds).
 */
export const COURT_DISPUTE_STATES = [
  'pending',
  'resolved',
  'escalated',
] as const;
export const GENERAL_DISPUTE_STATES = [
  'filed',
  'panel_assigned',
  'evidence_period',
  'voting',
  'resolved',
  'escalated',
] as const;

export type EscrowMachineState = (typeof ESCROW_STATES)[number];
export type PromiseMachineState = (typeof PROMISE_STATES)[number];
export type PoolMachineState = (typeof POOL_STATES)[number];
export type BondMachineState = (typeof BOND_STATES)[number];
export type BondClaimMachineState = (typeof BOND_CLAIM_STATES)[number];
export type JobMachineState = (typeof JOB_STATES)[number];
export type HumanJobMachineState = (typeof HUMAN_JOB_STATES)[number];
export type CourtDisputeMachineState = (typeof COURT_DISPUTE_STATES)[number];
export type GeneralDisputeMachineState = (typeof GENERAL_DISPUTE_STATES)[number];

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

export const INSTITUTION_KINDS: readonly InstitutionKind[] = Object.freeze([
  'escrow',
  'promise',
  'pool',
  'bond',
  'bond_claim',
  'job',
  'human_job',
  'court_dispute',
  'general_dispute',
]);

/**
 * A synthetic pre-existence source for a record's very first transition (bond
 * `postBond`, bond-claim `fileClaim`, job `post`). It is deliberately NOT a
 * member of any state set — a record is never AT `__initial__` — so the state
 * tuples above stay byte-equal to the live status enums for the conformance
 * binding, while creation transitions still have a source to classify.
 */
export const INITIAL: '__initial__' = '__initial__';
export type InitialSource = typeof INITIAL;

// =============================================================================
// Transition classification
// =============================================================================

/**
 * `record_only` — a draft / a non-value-moving record. Entering it needs no
 * on-chain receipt and moves no money.
 * `economic` — an authoritative, on-chain-settled outcome. It may fire ONLY
 * behind a Base-final verified receipt and is idempotent by tx hash.
 */
export type TransitionClass = 'record_only' | 'economic';

export interface InstitutionTransition {
  readonly from: string;
  readonly to: string;
  readonly class: TransitionClass;
  /** One-line note on which on-chain fact an economic transition requires. */
  readonly note?: string;
}

/**
 * The declared legal transitions per institution. beneficiary routing seeds the CORE,
 * unambiguous lifecycle edges; a transition NOT in this table fails closed
 * (Unknown = Block). Downstream WPs (linked-job settlement jobs, bond lifecycle bonds, agent directory court) EXTEND —
 * never relax — this table as they wire each route's settlement paths.
 *
 * Classification rule: a transition is `economic` iff entering its target state
 * requires a Base-final on-chain settlement receipt; otherwise `record_only`.
 */
const TRANSITIONS: Readonly<Record<InstitutionKind, readonly InstitutionTransition[]>> = {
  escrow: [
    { from: INITIAL, to: 'created', class: 'record_only', note: 'draft escrow, unfunded' },
    { from: 'created', to: 'funded', class: 'economic', note: 'verifyOnchainEscrowFunding — EscrowFunded to agreed recipient' },
    { from: 'created', to: 'cancelled', class: 'record_only', note: 'cancel an unfunded draft' },
    { from: 'funded', to: 'completed', class: 'economic', note: 'on-chain release receipt (escrow-release)' },
    { from: 'funded', to: 'disputed', class: 'record_only', note: 'a dispute is raised; no settlement yet' },
    { from: 'disputed', to: 'resolved', class: 'economic', note: 'admin resolution settles on-chain to recipient or refunds depositor' },
  ],
  promise: [
    { from: INITIAL, to: 'open', class: 'record_only', note: 'draft promise' },
    { from: 'open', to: 'funded', class: 'economic', note: 'verifyTransfer — collateral funded on-chain' },
    { from: 'open', to: 'cancelled', class: 'record_only', note: 'cancel an unfunded draft' },
    { from: 'funded', to: 'settled', class: 'economic', note: 'verifyTransfer — repayment settled on-chain' },
  ],
  pool: [
    { from: INITIAL, to: 'open', class: 'record_only', note: 'draft pool' },
    { from: 'open', to: 'funded', class: 'economic', note: 'verified contributions crossed the on-chain threshold' },
    { from: 'open', to: 'cancelled', class: 'record_only', note: 'cancel an unfunded draft' },
    { from: 'funded', to: 'executed', class: 'economic', note: 'verifyEvmContractCall — on-chain execution receipt' },
  ],
  // bond lifecycle — the non-adjudicative bond lifecycle. The backend 'expired' status is
  // an OFF-CHAIN autonomy-privilege drop (the on-chain bond stays Active and
  // collateral does not move), so entering it is record_only; every transition
  // that reflects on-chain value movement (post, renew/top-up, withdraw,
  // abandonment burn, claim filing/expiry) is economic and receipt-gated.
  // Late renewal (expired→active) and late withdrawal (expired→withdrawn)
  // mirror chain truth: ProvianBondPool keeps a past-deadline bond renewable
  // and withdrawable until the abandonment burn. Court outcomes (bond_claim
  // filed→upheld|dismissed) are declared here since beneficiary routing but their route wiring
  // is agent directory scope.
  bond: [
    { from: INITIAL, to: 'active', class: 'economic', note: 'verifyEvmBondPosted — BondPosted at required collateral' },
    { from: 'active', to: 'active', class: 'economic', note: 'verifyEvmBondRenewed / verifyEvmBondToppedUp — renewal or collateral top-up' },
    { from: 'active', to: 'expired', class: 'record_only', note: 'grace lapse: off-chain autonomy drop; on-chain bond still Active, no value moves' },
    { from: 'active', to: 'withdrawn', class: 'economic', note: 'verifyEvmBondWithdrawn — BondWithdrawn to the agent' },
    { from: 'expired', to: 'active', class: 'economic', note: 'verifyEvmBondRenewed — late renewal reinstates (chain kept the bond Active)' },
    { from: 'expired', to: 'withdrawn', class: 'economic', note: 'verifyEvmBondWithdrawn — exit stays open until the abandonment burn' },
    { from: 'expired', to: 'abandoned', class: 'economic', note: 'BondAbandoned burn receipt — keeper tx or recovered on-chain log' },
  ],
  bond_claim: [
    { from: INITIAL, to: 'filed', class: 'economic', note: 'verifyEvmClaimFiled — on-chain ClaimFiled' },
    { from: 'filed', to: 'upheld', class: 'economic', note: 'verifyEvmBondClaimResolved — BondSlashed' },
    { from: 'filed', to: 'dismissed', class: 'economic', note: 'verifyEvmBondClaimResolved — ClaimDismissed' },
    { from: 'filed', to: 'expired', class: 'economic', note: 'ClaimExpired receipt — permissionless 60d timeout, filing fee burned' },
  ],
  job: [
    { from: INITIAL, to: 'open', class: 'record_only', note: 'draft job posting' },
    { from: 'open', to: 'assigned', class: 'record_only', note: 'applicant accepted; funding rides the auto-escrow ' },
    { from: 'assigned', to: 'delivered', class: 'record_only', note: 'work delivered; settlement is the linked escrow ' },
    { from: 'open', to: 'cancelled', class: 'record_only', note: 'cancel an unassigned draft' },
    { from: 'assigned', to: 'cancelled', class: 'record_only', note: 'cancel before delivery' },
    // linked-job settlement settlement truth: a job terminates ONLY off the linked escrow's
    // on-chain settlement. 'completed' = the escrow released to the worker
    // (settle(); auto-release can land before a deliver, hence assigned→).
    // 'refunded' = the disputed escrow resolved by refunding the poster
    // (settleDispute()) — the worker was NOT paid, so it is never 'completed'.
    // A dispute itself is an ESCROW record event (funded→disputed above); the
    // job mirrors it as a field, not a status.
    { from: 'assigned', to: 'completed', class: 'economic', note: 'escrow release receipt (escrow-release settle)' },
    { from: 'delivered', to: 'completed', class: 'economic', note: 'escrow release receipt (escrow-release settle)' },
    { from: 'assigned', to: 'refunded', class: 'economic', note: 'escrow dispute resolution refunded the depositor (settleDispute)' },
    { from: 'delivered', to: 'refunded', class: 'economic', note: 'escrow dispute resolution refunded the depositor (settleDispute)' },
  ],
  // linked-job settlement — Commons human jobs. Same auto-escrow settlement receipts as the agent
  // board. 'completed' is written ONLY by the receipt-gated settlement path
  // the poster's completeHumanJob confirmation is a RECORD (PE +
  // poster_confirmed_at), never a status flip while payment is pending.
  // 'cancelled' is a declared state with no writer yet — an undeclared edge into
  // it fails closed (Unknown = Block), same as bond 'expired'/'abandoned'.
  human_job: [
    { from: INITIAL, to: 'open', class: 'record_only', note: 'draft human-job posting' },
    { from: 'open', to: 'in_progress', class: 'record_only', note: 'applicant accepted; funding rides the auto-escrow' },
    { from: 'in_progress', to: 'disputed', class: 'record_only', note: 'linked escrow disputed; no settlement yet' },
    { from: 'in_progress', to: 'completed', class: 'economic', note: 'escrow release receipt (escrow-release settle)' },
    { from: 'disputed', to: 'completed', class: 'economic', note: 'dispute resolved: released to the worker (settleDispute)' },
    { from: 'in_progress', to: 'refunded', class: 'economic', note: 'escrow dispute resolution refunded the poster (settleDispute)' },
    { from: 'disputed', to: 'refunded', class: 'economic', note: 'dispute resolved: refunded the poster (settleDispute)' },
  ],
  // agent directory — the escrow-dispute Court panel record. Recording a VERDICT requires
  // the underlying escrow's Base-final settlement receipt (the on-chain
  // CourtV2 majority vote / claimDisputeTimeout / admin resolution the relay
  // observed via settleDispute), so pending→resolved is economic and
  // idempotent by the resolution tx hash. escalated→resolved has NO writer —
  // an escalated dispute's escrow settles through the escrow kind's own
  // disputed→resolved edge and the court process record stays 'escalated'
  // as historical truth (Unknown = Block guards the undeclared edge).
  court_dispute: [
    { from: INITIAL, to: 'pending', class: 'record_only', note: 'panel assigned to a disputed escrow; party exclusion enforced' },
    { from: 'pending', to: 'resolved', class: 'economic', note: 'escrow dispute settlement receipt (settleDispute resolved/already_resolved)' },
    { from: 'pending', to: 'escalated', class: 'record_only', note: 'voting deadline lapsed without a settled majority' },
  ],
  // agent directory — the general-dispute (Court mandate expansion) record. Every edge is
  // record-only process truth: the dispute record itself never moves funds.
  // Its money legs are gated on their OWN kinds (bond_claim
  // filed→upheld|dismissed via the receipt-gated resolveBondClaim bridge; a
  // forum challenge is a Commons record). 'panel_assigned' is a declared
  // state with NO writer (assignment enters 'evidence_period' directly) —
  // an undeclared edge into it fails closed (Unknown = Block).
  general_dispute: [
    { from: INITIAL, to: 'filed', class: 'record_only', note: 'dispute filed; respondent notice PE recorded' },
    { from: 'filed', to: 'evidence_period', class: 'record_only', note: 'panel assigned (party exclusion enforced); evidence window opens' },
    { from: 'evidence_period', to: 'voting', class: 'record_only', note: 'evidence window elapsed; voting opens' },
    { from: 'voting', to: 'resolved', class: 'record_only', note: 'panel majority verdict recorded; money legs gated on their own kinds' },
    { from: 'filed', to: 'escalated', class: 'record_only', note: 'no panel assigned within the window' },
    { from: 'voting', to: 'escalated', class: 'record_only', note: 'voting deadline lapsed without a majority' },
  ],
};

/**
 * Look up a declared transition. Returns the transition (with its class) or
 * `null` when the (kind, from, to) triple is not a declared legal edge.
 */
export function findTransition(
  kind: InstitutionKind,
  from: string,
  to: string,
): InstitutionTransition | null {
  const table = TRANSITIONS[kind];
  if (!table) return null;
  return table.find((t) => t.from === from && t.to === to) ?? null;
}

/**
 * Classify a transition without evaluating a receipt: `'economic'`,
 * `'record_only'`, or `null` (illegal / unknown). This is the pure vocabulary
 * shared with the SDK mirror (`provian-agent-sdk/src/institution-state.ts`);
 * the receipt/suspension gate is `evaluateInstitutionTransition` below.
 */
export function classifyTransition(
  kind: InstitutionKind,
  from: string,
  to: string,
): TransitionClass | null {
  return findTransition(kind, from, to)?.class ?? null;
}

/**
 * Every declared transition as a canonical, sorted `${kind}|${from}|${to}|${class}`
 * key. This is the exact edge set the SDK mirror
 * (`provian-agent-sdk/src/institution-state.ts`) must reproduce; the mirror test
 * set-compares against it, so a drift in either direction fails closed.
 */
export function canonicalTransitionKeys(): string[] {
  const keys: string[] = [];
  for (const kind of INSTITUTION_KINDS) {
    for (const t of TRANSITIONS[kind]) {
      keys.push(`${kind}|${t.from}|${t.to}|${t.class}`);
    }
  }
  return keys.sort();
}

// =============================================================================
// The receipt-driven guard
// =============================================================================

/**
 * The outcome of an on-chain receipt verification, structurally the fields of
 * `TxVerificationResult` (tx-verifier.ts) that this guard needs, plus the tx
 * hash the verification was run against. `ok` is true ONLY when the verifier
 * confirmed the receipt at the Base 12-confirmation finality floor (or 1 conf
 * off Base) — so an `ok: true` receipt IS a Base-final receipt. Kept as a local
 * shape so this pure module never imports the ethers-heavy verifier.
 */
export interface ReceiptEvidence {
  readonly ok: boolean;
  /** The verifier's failure reason when `ok` is false (surfaced to the caller). */
  readonly reason?: string;
  /** The tx hash the receipt was verified against (required for idempotency). */
  readonly txHash?: string;
  /** Confirmations the verifier observed (diagnostic; the gate is `ok`). */
  readonly confirmations?: number;
}

/**
 * Adapt a `TxVerificationResult` (or any `{ ok, reason?, confirmations? }`) plus
 * the tx hash it was verified against into `ReceiptEvidence`, so a caller can
 * pass a verifier result straight through without restating the shape.
 */
export function receiptFromVerification(
  result: { ok: boolean; reason?: string; confirmations?: number },
  txHash: string,
): ReceiptEvidence {
  return { ok: result.ok, reason: result.reason, confirmations: result.confirmations, txHash };
}

export interface EvaluateTransitionInput {
  readonly kind: InstitutionKind;
  readonly from: string;
  readonly to: string;
  /**
   * The verified receipt backing an economic transition. Required (and must be
   * `ok`) for an `economic` transition; ignored for a `record_only` one. Pass
   * `null`/omit for a draft.
   */
  readonly receipt?: ReceiptEvidence | null;
  /**
   * Tx hashes that have ALREADY driven an economic transition for this record
   * (its settled-tx-hash ledger). A receipt whose tx hash is present is an
   * idempotent retry — allowed, but flagged so the caller records NO second
   * economic PE. Compared case-insensitively.
   */
  readonly priorEconomicTxHashes?: readonly string[];
  /**
   * Whether the acting agent wallet is suspended (its `status` is not
   * `active`), read UPSTREAM by the caller. When `true` the guard blocks FIRST,
   * before any other check. The field name predates there is no kill
   * switch on an agent's actions, only this wallet-status check. Paths on the
   * agent's own funds pass `false`.
   */
  readonly killSwitchActive?: boolean;
}

export type EvaluateTransitionDecision =
  | {
      readonly allowed: true;
      /** True for an authoritative economic transition; false for a draft. */
      readonly economic: boolean;
      /** True when the receipt's tx hash already drove this transition. */
      readonly idempotent: boolean;
      /** The settled tx hash (lowercased) for an economic transition. */
      readonly txHash?: string;
    }
  | {
      readonly allowed: false;
      readonly reason: EvaluateTransitionBlockReason;
      /** Whether the blocked transition was classified economic (when known). */
      readonly economic?: boolean;
    };

export type EvaluateTransitionBlockReason =
  | 'kill_switch_active'
  | 'unknown_institution_kind'
  | 'illegal_transition'
  | 'receipt_required'
  | 'unverified_receipt'
  | 'receipt_missing_tx_hash';

/**
 * The single fail-closed guard every institution transition routes through.
 *
 * Order is load-bearing:
 *   1. suspension check FIRST — a suspended (non-active) agent wallet blocks
 *      before anything else is evaluated.
 *   2. unknown institution kind → BLOCK (Unknown = Block).
 *   3. transition not declared in the table → BLOCK (Unknown = Block); an
 *      unmodeled edge is never silently permitted.
 *   4. a `record_only` (draft) transition → ALLOW with no receipt, no money.
 *   5. an `economic` transition requires a receipt with `ok === true` — i.e. a
 *      Base-final verified on-chain settlement. A missing receipt →
 *      `receipt_required`; a present-but-unverified one (including
 *      insufficient-confirmations, the finality gate) → `unverified_receipt`.
 *   6. the receipt's tx hash is required (idempotency key). If it already drove
 *      an economic transition for this record, the call is an idempotent retry
 *      — ALLOWED but flagged `idempotent: true` so the caller records NO second
 *      economic PE (Common Pitfall: no duplicate economic PE on retry).
 */
export function evaluateInstitutionTransition(
  input: EvaluateTransitionInput,
): EvaluateTransitionDecision {
  // 1. The suspension check runs FIRST — no early return may precede it.
  if (input.killSwitchActive === true) {
    return { allowed: false, reason: 'kill_switch_active' };
  }

  // 2. Unknown institution kind → block.
  const table = TRANSITIONS[input.kind];
  if (!table) {
    return { allowed: false, reason: 'unknown_institution_kind' };
  }

  // 3. Undeclared transition → block (fail closed).
  const transition = findTransition(input.kind, input.from, input.to);
  if (!transition) {
    return { allowed: false, reason: 'illegal_transition' };
  }

  // 4. Record-only (draft) transition: no receipt, no money.
  if (transition.class === 'record_only') {
    return { allowed: true, economic: false, idempotent: false };
  }

  // 5. Economic transition: require a Base-final verified receipt.
  if (!input.receipt) {
    return { allowed: false, reason: 'receipt_required', economic: true };
  }
  if (input.receipt.ok !== true) {
    return { allowed: false, reason: 'unverified_receipt', economic: true };
  }
  const txHash = input.receipt.txHash;
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { allowed: false, reason: 'receipt_missing_tx_hash', economic: true };
  }

  // 6. Idempotency by tx hash — a retry of a settled tx records no second PE.
  const normalized = txHash.toLowerCase();
  const prior = input.priorEconomicTxHashes ?? [];
  const idempotent = prior.some((h) => h.toLowerCase() === normalized);
  return { allowed: true, economic: true, idempotent, txHash: normalized };
}
