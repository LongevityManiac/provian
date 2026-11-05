import { retainComplianceDecision } from '../../jurisdiction/location-retention';
import { complianceForRow } from '../../jurisdiction/mint-compliance';
import type { Firestore } from 'firebase-admin/firestore';
import { privateRetentionCollection } from '../../provenance/private-retention';
/**
 * settlement runtime — the production `InletPeSource` relay records -> inlet candidates.
 *
 * This is the adapter half of the inlet. `claim-inlet.ts` owns the policy (may this PE be
 * claimed, and under what identity); this module owns the relay-data questions (which PEs are
 * unclaimed, which address does one pay, and is its hash-chain link real).
 *
 * EVERY FIELD NAME HERE IS A CLAIM ABOUT ANOTHER MODULE, AND THE FIRST VERSION GOT FIVE WRONG
 *
 * The M6 reviewer found that this module read `actor_address`, `wallet_address`,
 * `economic_snapshot.workProductHash`, and compared `corroboration_status` against
 * `'received'`/`'corroborated'` none of which exist in `PEHistoryDocument`. Every one of
 * those reads returned `undefined` forever, which meant no PE could ever resolve a payee and
 * two of the five work-evidence kinds were structurally dead. Nothing caught it because this
 * file shipped with no tests at all: the pure halves were covered, the projection was not.
 *
 * So the rule for this file is now explicit: a field read here must be traceable to a
 * declaration in `src/pe-history.ts` or to a `provenance_envelopes` writer, and
 * `claim-inlet-source.test.ts` binds the fixtures to those real shapes. The projection is
 * defined ONCE (`projectEligibility`) and used by both the inlet and the approval gate — two
 * projections of one PE is two answers to one question, and the cheaper one wins by accident.
 *
 * TWO COLLECTIONS, AND WHY BOTH
 *
 * `provenance_envelopes` is the SEALED record and the only source of claim identity — the six
 * fields `wp-ev/claim-id.ts` hashes are read from there and nowhere else. `pe_history` is the
 * ENRICHMENT record: `mint_status`, `record_points_atomic`, corroboration, and the beneficiary
 * routing snapshot all live there and all change after seal. Reading identity from the sealed
 * doc and economics from the history doc is what keeps a repriced PE from changing its own
 * claim id.
 *
 * CHAIN VERIFICATION IS A REAL READ, NOT AN ASSUMPTION
 *
 * `EligibilityCandidate.chainVerified` means the PE's `prev_hash` link was confirmed against
 * the chain. This module confirms it by finding the PREDECESSOR envelope whose `hash` equals
 * this PE's `prev_hash` (or by recognising the genesis sentinel for a chain's first PE). It
 * does not re-derive the PE hash — that computation lives at the nine relay write sites and
 * replicating it here would create a second definition that can drift.
 *
 * Fail-closed everywhere. A PE whose predecessor cannot be found is reported with
 * `chainVerified:false`, which the eligibility evaluator rejects. Nothing here writes, signs,
 * or mints.
 */

import { METER_ACT_KEYS_COLLECTION } from '../../meter/meter-store';
import { actKeyIdentity, type MeterActKeyDoc } from '../../meter/meter-act-key';
import { GENESIS_PREV_HASH } from '../../pe/constants';
import { GENESIS_HASH } from '../../../pe-chain-validator';
import type { PEHistoryDocument } from '../../../pe-history';
import {
  corroborationLiftedRecordPointsAtomic,
  verifiedSnapshot,
} from '../policy/economic-projection';
import { BeneficiaryClass } from '../wp-ev/settlement-batch';
import type { CounterpartyRef, EligibilityCandidate, WorkEvidence } from '../wp-ev/eligibility';
import { classifySubmissionProvenance } from '../wp-ev/submission-provenance';
import {
  BPS_DENOMINATOR,
  linkedAgentLegs,
  type PayoutLegRole,
} from '../wp-ev/payout-legs';
import { commitTakeoverWindowOpen } from '../commit-takeover';
import { completionTakeoverWindowOpen } from '../completion-takeover';
import {
  hashBeneficiaryRoutingSnapshot,
  type BeneficiaryRoutingSnapshot,
} from '../beneficiary-routing';
import type { SealedEnvelopeIdentity } from '../wp-ev/claim-id';
import type { InletCandidate, InletPage, InletPeSource } from './claim-inlet';
import {
  CLAIM_LEDGER_COLLECTION,
  PE_HISTORY_COLLECTION,
  claimKeyOf,
  normalizePeId,
  type SettlementDb,
} from './durable-settlement-store';
import {
  PE_SPLIT_COLLECTION,
  lateLiftFor,
  parseFrozenSplit,
  proposalFromFrozen,
  type ProposedPeSplit,
} from './pe-split';
import { speechPeWindowBurnFinal } from '../../presentation/burn-finality-state';

export const ENVELOPES_COLLECTION = 'provenance_envelopes';
export { PE_HISTORY_COLLECTION };
/** Agent wallets. `agent_id` is the economic actor id; `address` is the payee. */
export const AGENT_WALLETS_COLLECTION = 'agent_wallets';
/** Human wallets. Keyed for this purpose by `user_id` + `type == 'human'`. */
export const WALLETS_COLLECTION = 'wallets';

/** The only `mint_status` the relay uses to mean "ready to settle". */
export const RELAY_STATUS_READY = 'eligible';

const ADDRESS = /^0x[0-9a-f]{40}$/i;

/**
 * The chain-start sentinels LEGITIMATE WRITERS actually write, both of them.
 *
 * Two exist and both are real: `GENESIS_PREV_HASH` (`'genesis'`, `core/pe/constants.ts`) on
 * the server/mobile writer convention, and `GENESIS_HASH` (`'0x0000'`,
 * `pe-chain-validator.ts`) — what `advanceChainTipAtomic` puts on the FIRST PE of every
 * durable-write chain, which is why a human `wallet_created` (the first PE of a fresh
 * wallet's chain) carries `'0x0000'`. Recognizing only one of the two is the evaluator
 * disagreeing with what legitimate writers write (the 2026-08-16 seam ruling): both
 * production `wallet_created` rows refused `chain_not_verified` on exactly this. One
 * predicate, both call sites below — imported constants, never redeclared literals.
 */
export function isChainStartSentinel(prevHash: string): boolean {
  return prevHash === GENESIS_PREV_HASH || prevHash === GENESIS_HASH;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * Project the stored history doc's replication pack onto the eligibility shape.
 * Field names differ between the two (`input_hash` vs `inputHash`), and a silent
 * mismatch would drop a legitimate evidence kind, so the mapping is explicit.
 */
export function replicationPackOf(raw: unknown): WorkEvidence['replicationPack'] {
  const pack = obj(raw);
  if (pack === null) return null;
  return {
    inputHash: str(pack.input_hash) ?? str(pack.inputHash),
    outputHash: str(pack.output_hash) ?? str(pack.outputHash),
    packHash: str(pack.pack_hash) ?? str(pack.packHash),
  };
}

/**
 * The hash of the thing the PE produced.
 *
 * `PEHistoryDocument.replication_pack.output_hash` IS the work product's `artifact_hash` —
 * `/v1/relay/work-product` assigns `output_hash: artifact_hash` verbatim, and `pe-history.ts`
 * documents the field as "same as artifact_hash, duplicated here for clarity". That is the
 * only place the artifact hash durably lands, so it is what this reads.
 *
 * Deliberately DISTINCT from the replication-pack evidence kind, which requires all three
 * hashes. An artifact hash alone proves a thing was produced; it does not make the run
 * reproducible.
 */
export function workProductHashOf(history: Record<string, unknown>): string | null {
  const pack = obj(history.replication_pack);
  return pack === null ? null : str(pack.output_hash) ?? str(pack.outputHash);
}

/**
 * Corroboration that carries mint weight.
 *
 * `PEHistoryDocument.corroboration_status` is a five-member union and `'none'` is its
 * unset value; the other four are all real third-party attestations. Matching against
 * invented spellings (`'received'`, `'corroborated'`) is what made this evidence kind dead,
 * so this reads the union NEGATIVELY: anything that is a recognized non-`none` member counts,
 * and anything unrecognized does not (Unknown = block).
 */
export const CORROBORATION_STATUSES: ReadonlySet<string> = new Set([
  'on_chain_verified',
  'merchant_confirmed',
  'peer_verified',
  'service_grant_attested',
]);

export function corroborationOf(history: Record<string, unknown>): WorkEvidence['counterpartyCorroboration'] {
  const status = str(history.corroboration_status) ?? 'none';
  return {
    received: CORROBORATION_STATUSES.has(status),
    // The STATUS is the signal type. `corroboration_source` is the source identifier (a tx
    // hash, a commerce signal id) and is not a type at all.
    signalType: CORROBORATION_STATUSES.has(status) ? status : undefined,
  };
}

/**
 * The counterparty named on the SEALED PE, or null.
 *
 * This is the input to the eligibility evaluator's ghost gate: a PE that names someone who
 * should have confirmed the work, and who has not, is a ghost regardless of what else it
 * carries. Hard-coding `null` here — which the first version did — made that gate structurally
 * unable to fire, so a PE naming an unconfirmed counterparty was admitted on a replication
 * pack alone. `generatePE` writes `counterparty_address` / `counterparty_type` onto the
 * envelope; both are read from there.
 */
export function counterpartyOf(envelope: Record<string, unknown>): CounterpartyRef | null {
  const address = str(envelope.counterparty_address);
  if (address === null) return null;
  return { address, type: str(envelope.counterparty_type) ?? 'unknown' };
}

/** Project a stored envelope doc onto the sealed identity the claim id is derived from. */
export function sealedIdentityOf(
  peId: string,
  envelope: Record<string, unknown>,
): SealedEnvelopeIdentity | null {
  const prevHash = str(envelope.prev_hash);
  const hash = str(envelope.hash);
  const actionType = str(envelope.action_type);
  const timestamp = envelope.timestamp;
  if (prevHash === null || hash === null || actionType === null
    || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) {
    return null;
  }
  return {
    id: peId,
    prev_hash: prevHash,
    hash,
    timestamp,
    action_type: actionType,
    user_id: str(envelope.user_id),
  };
}

/**
 * THE single projection from stored records to `EligibilityCandidate`.
 *
 * Pure, and exported, so the inlet and the approval gate cannot drift apart and so the field
 * mapping is testable without a database. `identity` is passed in rather than re-derived so a
 * caller that already read the envelope does not read it twice.
 */
export function projectEligibility(params: {
  readonly peId: string;
  readonly history: Record<string, unknown>;
  readonly envelope: Record<string, unknown> | null;
  readonly identity: SealedEnvelopeIdentity | null;
  readonly chainVerified: boolean;
  /**
   * Genesis only. The typed one-time anchor whose uniqueness the kernel enforces on-chain.
   * Never supplied for a standard-lane PE: `settleStandardPEBatch` has no anchor concept, so
   * passing one would let an anchor stand in as work evidence where nothing enforces it.
   */
  readonly oneTimeAnchor?: string | null;
}): EligibilityCandidate {
  const { history, envelope } = params;
  // The record path's own evidence verdict, read ONLY through the single verified-read
  // (`economic-projection.ts::verifiedSnapshot`): the snapshot must re-hash to its sealed
  // `economic_snapshot_hash` and be bound to this PE, or it contributes nothing. This is
  // what makes the seal safe to trust from the mutable `pe_history` record — the same
  // discipline `resolveLinkedAgentLegs` applies to the routing snapshot. Genesis rows are
  // BYTE-UNTOUCHED by the seal (the 2026-08-16 seam ruling changes standard-lane
  // evaluation only): a Genesis PE's evidence is its one-time anchor, resolved by the
  // reservation state machine, and stays exactly that.
  const sealedSnapshot = bool(history.is_genesis_grant)
    ? null
    : verifiedSnapshot(history as unknown as PEHistoryDocument);
  const workEvidence: WorkEvidence = {
    workProductHash: workProductHashOf(history),
    replicationPack: replicationPackOf(history.replication_pack),
    counterparty: envelope === null ? null : counterpartyOf(envelope),
    counterpartyCorroboration: corroborationOf(history),
    chainVerifiedTxHash: str(history.tx_hash),
    oneTimeAnchor: params.oneTimeAnchor ?? null,
    recordTimeSeal: sealedSnapshot === null
      ? null
      : { evidenceState: sealedSnapshot.recordTimeFactors.evidenceState },
  };

  return {
    pe: params.identity ?? {
      id: params.peId, prev_hash: '', hash: '', timestamp: 0, action_type: '', user_id: null,
    },
    attestationTier: str(history.attestationDepth) ?? '',
    chainVerified: params.chainVerified,
    // HOW the act reached the relay, three-valued. Derived from what production actually
    // records — `attestation_verified` on the paths that verify an earner signature, and the
    // envelope's `integration_source` on the paths where the RELAY is the author. Never
    // re-asserted, and never coerced to `true` for a server-authored act: that claim is what
    // `classifySubmissionProvenance` reports as `contradictory`.
    submissionProvenance: classifySubmissionProvenance({
      attestationVerified: typeof history.attestation_verified === 'boolean'
        ? history.attestation_verified
        : undefined,
      integrationSource: envelope === null ? null : str(envelope.integration_source),
      recordedProvenance: str(history.submission_provenance),
    }),
    workEvidence,
    relayMintStatus: str(history.mint_status) ?? '',
  };
}

// ---------------------------------------------------------------------------
// Payee resolution
// ---------------------------------------------------------------------------

export type PayeeRefusalReason =
  /** No economic actor id on the record at all. */
  | 'actor_unresolvable'
  /** An actor id that matches neither an agent wallet nor a human wallet. */
  | 'payee_wallet_not_found'
  /** Found, but not `active` / not a usable address. */
  | 'payee_wallet_unusable'
  /** The actor id matches BOTH an agent wallet and a human wallet, or two of one kind. */
  | 'payee_identity_ambiguous'
  /** A linked-agent PE whose routing snapshot is present but unusable. */
  | 'linked_agent_routing_invalid'
  /**
   * The routing snapshot is not sealed to its own commitment, or not to this PE. `pe_history` is
   * the mutable enrichment record, so an uncommitted snapshot is an unverified instruction about
   * who gets paid and how much — never a route.
   */
  | 'linked_agent_routing_uncommitted'
  /** The split arithmetic refused — see `payout-legs.ts` (a zero leg, bad bps, bad address). */
  | 'linked_agent_split_refused';

/**
 * The legs an act pays out to, with the beneficiary class each settles under.
 *
 * A list, not a single payee. A linked-agent act resolves to TWO legs — the agent's configured
 * share and its human's remainder — which the kernel settles as two recipients carrying two
 * claim ids. M7 refused these outright on the belief that a split was inexpressible; it is not,
 * because `claimSettled` is keyed per claim item rather than per PE.
 */
export type PayeeResolution =
  | {
    readonly kind: 'resolved';
    readonly legs: readonly {
      readonly leg: PayoutLegRole;
      readonly contributor: string;
      readonly beneficiaryClass: BeneficiaryClass;
      /** This leg's share of the act (frozen into the split doc). Sums to 10,000. */
      readonly bps: number;
      readonly pointsAtomic: string;
    }[];
  }
  | { readonly kind: 'refused'; readonly reason: PayeeRefusalReason };

/**
 * The economic actor this PE pays.
 *
 * The sealed economic snapshot's `economicActorId` is preferred over the mutable `userId`
 * because it is the actor the record was PRICED for; `userId` is the fallback for records
 * written before the snapshot existed. When both are present and disagree, the record is
 * self-contradictory and nothing here guesses which one is real.
 */
export function economicActorIdOf(history: Record<string, unknown>): string | null {
  const snapshot = obj(history.economic_snapshot);
  const sealed = snapshot === null ? null : str(snapshot.economicActorId);
  const userId = str(history.userId);
  if (sealed !== null && userId !== null && sealed !== userId) return null;
  return sealed ?? userId;
}

function usableAddress(value: unknown): string | null {
  const raw = str(value);
  return raw !== null && ADDRESS.test(raw) ? raw.toLowerCase() : null;
}

/**
 * Resolve the address a standard-lane claim settles to, and its beneficiary class.
 *
 * Authoritative Firestore reads on every call, never a cache: a link, an unlink, or a wallet
 * deactivation between record time and settlement time changes who may be paid, and a
 * five-minute-stale answer to "who gets the money" is not an answer.
 */
export async function resolvePayee(
  db: SettlementDb,
  history: Record<string, unknown>,
  totalPointsAtomic: string,
  /**
   * The PE this record belongs to, passed by the caller rather than dug out of the document.
   * The routing snapshot is bound to a pe id, and that binding must be checked against the id
   * the inlet is actually processing — reading it back out of the same (mutable) record would
   * check the snapshot against itself.
   */
  peId?: string,
): Promise<PayeeResolution> {
  return resolveBasePayee(db, history, totalPointsAtomic, peId);
}

/**
 * a fresh resolution as the split the inlet will FREEZE. Called only for a PE that has
 * no split and no act rows; the result is written, with every leg, in one transaction and
 * never re-derived. `source_fields` record what the split was resolved from, for audit only.
 */
export function splitFromResolution(
  history: Record<string, unknown>,
  totalPointsAtomic: string,
  resolution: Extract<PayeeResolution, { kind: 'resolved' }>,
): ProposedPeSplit {
  return {
    totalPointsAtomic,
    basePointsAtomic: str(history.record_points_atomic),
    legs: resolution.legs.map((leg) => ({
      leg: leg.leg,
      contributor: leg.contributor,
      beneficiary_class: leg.beneficiaryClass,
      bps: leg.bps,
      record_points_atomic: leg.pointsAtomic,
    })),
    origin: 'inlet_resolution',
    sourceFields: {
      economic_actor_id: economicActorIdOf(history),
      beneficiary_routing_snapshot_hash: str(history.beneficiary_routing_snapshot_hash),
    },
    frozen: false,
  };
}

async function resolveBasePayee(
  db: SettlementDb,
  history: Record<string, unknown>,
  totalPointsAtomic: string,
  peId?: string,
): Promise<PayeeResolution> {
  // A sealed routing snapshot means the PE is split between an agent and its human. Both are
  // paid, as two legs of one act, at the share that was in force AT RECORD TIME.
  const routing = obj(history.beneficiary_routing_snapshot);
  if (routing !== null) {
    return resolveLinkedAgentLegs(db, history, routing, totalPointsAtomic, peId);
  }

  const actorId = economicActorIdOf(history);
  if (actorId === null) return { kind: 'refused', reason: 'actor_unresolvable' };

  // Agent first, mirroring `resolveBeneficiary`: an agent wallet is keyed by `agent_id`, and
  // `wallet_aw_`-prefixed actor ids are the wallet document id itself.
  const agentByField = await db.collection(AGENT_WALLETS_COLLECTION)
    .where('agent_id', '==', actorId).limit(2).get();
  if (agentByField.docs.length > 1) {
    return { kind: 'refused', reason: 'payee_identity_ambiguous' };
  }
  let agentDoc = agentByField.docs[0] ?? null;
  if (agentDoc === null && actorId.startsWith('wallet_aw_')) {
    const direct = await db.collection(AGENT_WALLETS_COLLECTION).doc(actorId).get();
    if (direct.exists) agentDoc = { id: actorId, data: () => direct.data() };
  }

  const humanSnap = await db.collection(WALLETS_COLLECTION)
    .where('user_id', '==', actorId).where('type', '==', 'human').limit(2).get();
  if (humanSnap.docs.length > 1) {
    return { kind: 'refused', reason: 'payee_identity_ambiguous' };
  }
  let humanDoc: { id: string; data: () => Record<string, unknown> | undefined } | null =
    humanSnap.docs[0] ?? null;
  // M9 (b) gave the AGENT identity its doc-id fallback; the HUMAN identity needs the exact
  // mirror (2026-08-16 seam ruling). The GitHub witness records the author's HUMAN WALLET
  // DOCUMENT id as the economic actor — `service_installs.user_id` IS a `wallets` doc id,
  // and `generatePE` seals it as `userId`/`economicActorId` verbatim — so a field-only
  // lookup refused every solo `service:*` forge row `payee_wallet_not_found` at settlement
  // while the record path had sealed it eligible. Same discipline as the agent fallback:
  // fires only when both field queries missed, and only accepts a `type === 'human'` doc.
  if (agentDoc === null && humanDoc === null && actorId.startsWith('wallet_')) {
    const direct = await db.collection(WALLETS_COLLECTION).doc(actorId).get();
    const data = direct.exists ? direct.data() ?? {} : null;
    // `data.id === actorId` mirrors `mint-recipient-resolver.ts::directWalletCandidate` —
    // the doc's own sealed id field must name the actor, so a doc reached by id alone
    // cannot stand in for an identity it does not itself claim.
    if (data !== null && data.id === actorId && data.type === 'human') {
      humanDoc = { id: actorId, data: () => data };
    }
  }

  // One actor id resolving to two different wallets is two different payees. Unknown = block.
  if (agentDoc !== null && humanDoc !== null) {
    return { kind: 'refused', reason: 'payee_identity_ambiguous' };
  }

  if (agentDoc !== null) {
    const wallet = agentDoc.data() ?? {};
    const address = usableAddress(wallet.address);
    // `status` is checked because a suspended or retired agent wallet is not a payee. The
    // address alone would still be a well-formed 20 bytes.
    if (address === null || wallet.status !== 'active') {
      return { kind: 'refused', reason: 'payee_wallet_unusable' };
    }
    return {
      kind: 'resolved',
      legs: [{
        leg: 'sole',
        contributor: address,
        beneficiaryClass: BeneficiaryClass.AutonomousAgent,
        bps: BPS_DENOMINATOR,
        pointsAtomic: totalPointsAtomic,
      }],
    };
  }

  if (humanDoc !== null) {
    const wallet = humanDoc.data() ?? {};
    const address = usableAddress(wallet.address);
    if (address === null) return { kind: 'refused', reason: 'payee_wallet_unusable' };
    return {
      kind: 'resolved',
      legs: [{
        leg: 'sole',
        contributor: address,
        beneficiaryClass: BeneficiaryClass.HumanResolving,
        bps: BPS_DENOMINATOR,
        pointsAtomic: totalPointsAtomic,
      }],
    };
  }

  return { kind: 'refused', reason: 'payee_wallet_not_found' };
}

/**
 * The two legs of a linked-agent act.
 *
 * `agent_share_bps` and `human_address` come from the SEALED routing snapshot, never a live
 * config read — the snapshot exists precisely so the split cannot be repriced after the fact.
 * The agent's own address is resolved from `agent_wallets` by the snapshot's `economic_actor_id`.
 *
 * Both legs settle as `HumanResolving`: the act terminates at a verified human, which is what
 * the kernel's beneficiary classification is asking, and the agent leg is part of the same
 * human-linked act rather than an autonomous one. Classifying the agent leg as
 * `AutonomousAgent` would price it at the agent Foundation rate — a different economic outcome
 * for the same act, decided by an accident of representation.
 */
async function resolveLinkedAgentLegs(
  db: SettlementDb,
  history: Record<string, unknown>,
  routing: Record<string, unknown>,
  totalPointsAtomic: string,
  peId: string | undefined,
): Promise<PayeeResolution> {
  // ── M9 (a): THE SNAPSHOT IS VERIFIED, NOT TRUSTED.
  // `pe_history` is the mutable enrichment record (see this module's header), so reading a payee
  // address and a share straight out of it and paying them is a forgery vector: a row carrying
  // `agent_share_bps: 9900` and an attacker-chosen `human_address` would have produced two
  // structurally valid claims and nothing downstream re-derives the split.
  // `hashBeneficiaryRoutingSnapshot` re-parses the snapshot against its schema — which is where
  // `canonicalAgentBeneficiaryShareBps` enforces the approved 500–5000 BPS domain — and returns
  // the commitment, which must equal the hash sealed beside it. The pe-id binding is checked too,
  // so a snapshot lifted from another PE cannot be replayed here.
  const sealedHash = str(history.beneficiary_routing_snapshot_hash);
  if (sealedHash === null) return { kind: 'refused', reason: 'linked_agent_routing_uncommitted' };
  let derivedHash: string;
  try {
    derivedHash = hashBeneficiaryRoutingSnapshot(
      routing as unknown as BeneficiaryRoutingSnapshot,
    );
  } catch {
    return { kind: 'refused', reason: 'linked_agent_routing_invalid' };
  }
  if (derivedHash !== sealedHash) {
    return { kind: 'refused', reason: 'linked_agent_routing_uncommitted' };
  }
  // The snapshot must be bound to the PE the inlet is processing, so one lifted from another
  // PE cannot be replayed here. `undefined` means the caller did not state which PE this is,
  // and an unstated binding is not a checked one.
  if (peId === undefined || str(routing.pe_id) !== peId) {
    return { kind: 'refused', reason: 'linked_agent_routing_invalid' };
  }

  const humanAddress = usableAddress(routing.human_address);
  const agentActorId = str(routing.economic_actor_id);
  const agentShareBps = routing.agent_share_bps;
  const humanUserId = str(routing.human_user_id);
  if (humanAddress === null || agentActorId === null || humanUserId === null
    || typeof agentShareBps !== 'number' || !Number.isInteger(agentShareBps)) {
    return { kind: 'refused', reason: 'linked_agent_routing_invalid' };
  }

  // ── M9 (b): the agent may be recorded under its wallet document id.
  // `beneficiary_routing_snapshot.economic_actor_id` is `params.userId` (`pvt-accrual.ts`), which
  // for an agent recorded under a `wallet_aw_`-prefixed id is the DOCUMENT id, not `agent_id`.
  // The sole path (above) and `core/pvt/beneficiary.ts` both handle that; this one did not, so
  // that whole class of linked-agent PEs refused `linked_agent_routing_invalid` on every pass.
  const agentByField = await db.collection(AGENT_WALLETS_COLLECTION)
    .where('agent_id', '==', agentActorId).limit(2).get();
  if (agentByField.docs.length > 1) {
    return { kind: 'refused', reason: 'payee_identity_ambiguous' };
  }
  let agentData = agentByField.docs[0]?.data() ?? null;
  if (agentData === null && agentActorId.startsWith('wallet_aw_')) {
    const direct = await db.collection(AGENT_WALLETS_COLLECTION).doc(agentActorId).get();
    if (direct.exists) agentData = direct.data() ?? {};
  }
  if (agentData === null) {
    return { kind: 'refused', reason: 'linked_agent_routing_invalid' };
  }
  const agentWallet = agentData;
  const agentAddress = usableAddress(agentWallet.address);
  if (agentAddress === null || agentWallet.status !== 'active') {
    return { kind: 'refused', reason: 'payee_wallet_unusable' };
  }

  // ── M9 (c): THE HUMAN LEG IS RE-RESOLVED, LIKE EVERY OTHER PAYEE.
  // `resolvePayee`'s own contract is that addresses are authoritative reads on every call
  // BECAUSE a link, an unlink or a deactivation between record time and settlement time changes
  // who may be paid. The sole-human path honours that; this leg paid the record-time address and
  // skipped the wallet status entirely, so a human whose address had changed would have had PVT
  // minted irreversibly to the stale one. The record-time snapshot fixes the SHARE — so the split
  // cannot be repriced — not the destination.
  const humanSnap = await db.collection(WALLETS_COLLECTION)
    .where('user_id', '==', humanUserId).where('type', '==', 'human').limit(2).get();
  if (humanSnap.docs.length > 1) {
    return { kind: 'refused', reason: 'payee_identity_ambiguous' };
  }
  const humanDoc = humanSnap.docs[0] ?? null;
  if (humanDoc === null) return { kind: 'refused', reason: 'payee_wallet_not_found' };
  const humanWallet = humanDoc.data() ?? {};
  const liveHumanAddress = usableAddress(humanWallet.address);
  if (liveHumanAddress === null) {
    return { kind: 'refused', reason: 'payee_wallet_unusable' };
  }

  const split = linkedAgentLegs({
    agentAddress, humanAddress: liveHumanAddress, agentShareBps, totalPointsAtomic,
  });
  if (split.kind !== 'legs') {
    return { kind: 'refused', reason: 'linked_agent_split_refused' };
  }
  return {
    kind: 'resolved',
    legs: split.legs.map((leg) => ({
      leg: leg.role,
      contributor: leg.address,
      beneficiaryClass: BeneficiaryClass.HumanResolving,
      bps: leg.bps,
      pointsAtomic: leg.pointsAtomic,
    })),
  };
}

export interface FirestoreInletSourceDeps {
  readonly db: SettlementDb;
  readonly log?: (message: string) => void;
  /**
   * Injectable clock, for the commit cross-witness deferral only. Production leaves it
   * unset and gets `Date.now`. It exists so the deferral can be exercised at a
   * CHOSEN instant on both sides of the window — a time-dependent guard tested only at
   * "whatever now happens to be" is a guard whose boundary nobody has ever observed.
   */
  readonly now?: () => number;
}

/**
 * Resolve a Genesis PE's one-time anchor.
 *
 * REQUIRED, not optional, and that is the whole point. A Genesis PE's work evidence is its
 * typed one-time anchor, and the anchor lives in the reservation outbox — NOT in `pe_history`.
 * The inlet's Genesis source reads it there; the approval gate re-judges every PE
 * independently and must reach the same verdict from the same facts.
 *
 * The first two-lane fork run is what proved this matters: the inlet admitted the Genesis PE,
 * the gate re-projected it WITHOUT the anchor, found no work evidence at all, and refused its
 * own batch with `ghost_pe_no_work_evidence`. Two projections of one PE, two answers. Making
 * the resolver a required parameter means no call site can quietly reintroduce the second
 * answer by leaving it out.
 *
 * Returns null for a standard-lane PE, and for a Genesis PE whose reservation cannot be read —
 * which is a refusal, correctly: an anchor nobody can look up is not evidence.
 */
export type GenesisAnchorResolver = (peId: string) => Promise<string | null>;

/** For call sites that are provably standard-lane only. Named so the choice is legible. */
export const NO_GENESIS_ANCHORS: GenesisAnchorResolver = async () => null;

/**
 * Build one `EligibilityCandidate` from the relay's records, or null when the PE has no
 * sealed envelope to derive an identity from.
 *
 * Shared by the inlet source and the batch-approval gate ON PURPOSE. The gate re-judges every
 * PE independently at approval time, and it must judge it from the SAME projection the inlet
 * admitted it under.
 */
/**
 * PE METER: the records eligibility is judged from, for an act the relay itself authored and
 * metered (in practice a Genesis grant: every other metered act settles through its meter claim,
 * never this path). It has no stored envelope; what eligibility read from one — the act's sealed
 * identity, its authorship and its counterparty — is carried by the act key. Its chain continuity
 * was enforced when it was committed (the tip advance), so it is chain-verified by construction.
 * Null when the act key is absent or names a device act.
 */
export async function readMeteredRelayRecord(
  db: SettlementDb,
  peId: string,
): Promise<{
  readonly history: Record<string, unknown>;
  readonly envelope: Record<string, unknown>;
  readonly identity: SealedEnvelopeIdentity;
  readonly chainVerified: true;
} | null> {
  const snap = await privateRetentionCollection(db, METER_ACT_KEYS_COLLECTION).doc(peId).get();
  if (!snap.exists) return null;
  const key = snap.data() as MeterActKeyDoc | undefined;
  if (!key || typeof key.device_id !== 'string' || !key.device_id.startsWith('relay:')
    || key.row === null || typeof key.row !== 'object') {
    return null;
  }
  return {
    history: key.row,
    envelope: { integration_source: 'agent_bank_generate_pe', counterparty_address: null, counterparty_type: null },
    identity: actKeyIdentity(key),
    chainVerified: true,
  };
}

export async function buildEligibilityCandidate(
  db: SettlementDb,
  peId: string,
  genesisAnchorFor: GenesisAnchorResolver,
): Promise<EligibilityCandidate | null> {
  const metered = await readMeteredRelayRecord(db, peId);
  if (metered !== null) {
    const compliance = await complianceForRow(metered.history, db as unknown as Firestore);
    if (compliance.policy !== 'immediate') {
      if (metered.history.mint_status === 'eligible') await retainComplianceDecision(db as unknown as Firestore, peId, metered.history, compliance);
      return null;
    }
    const oneTimeAnchor = bool(metered.history.is_genesis_grant) ? await genesisAnchorFor(peId) : null;
    return projectEligibility({ peId, ...metered, oneTimeAnchor });
  }
  const historySnap = await db.collection(PE_HISTORY_COLLECTION).doc(peId).get();
  if (!historySnap.exists) return null;
  const history = historySnap.data() ?? {};
  const compliance = await complianceForRow(history, db as unknown as Firestore);
  if (compliance.policy !== 'immediate') {
    if (history.mint_status === 'eligible') await retainComplianceDecision(db as unknown as Firestore, peId, history, compliance);
    return null;
  }

  const envelopeSnap = await db.collection(ENVELOPES_COLLECTION).doc(peId).get();
  if (!envelopeSnap.exists) return null;
  const envelope = envelopeSnap.data() ?? {};
  const identity = sealedIdentityOf(peId, envelope);
  if (identity === null) return null;

  const linked = isChainStartSentinel(identity.prev_hash)
    || (await db.collection(ENVELOPES_COLLECTION)
      .where('hash', '==', identity.prev_hash).limit(1).get()).docs.length > 0;

  // Asked only for a Genesis PE. A standard-lane anchor would be evidence nothing enforces:
  // `settleStandardPEBatch` has no anchor concept at all.
  const oneTimeAnchor = bool(history.is_genesis_grant) ? await genesisAnchorFor(peId) : null;

  return projectEligibility({
    peId, history, envelope, identity, chainVerified: linked, oneTimeAnchor,
  });
}

/** The production `EligibilityCandidateSource` for the batch-approval gate. */
export function createFirestoreCandidateSource(
  db: SettlementDb,
  genesisAnchorFor: GenesisAnchorResolver,
): {
  loadCandidates(peIds: readonly string[]): Promise<ReadonlyMap<string, EligibilityCandidate>>;
} {
  return {
    async loadCandidates(peIds) {
      const out = new Map<string, EligibilityCandidate>();
      for (const peId of peIds) {
        const candidate = await buildEligibilityCandidate(db, peId, genesisAnchorFor);
        // A missing candidate is deliberately ABSENT rather than a placeholder: the gate
        // refuses `candidate_missing`, and a synthesized entry would answer "fine to mint"
        // to a question nobody could look up.
        if (candidate !== null) out.set(peId, candidate);
      }
      return out;
    },
  };
}

/**
 * Build the production source.
 *
 * The selection query is `pe_history where mint_status == 'eligible' order by peId`, paged.
 * `peId` is the sort key rather than `timestamp` so the page cursor matches the claim
 * ledger's own `pe_key` ordering and a resumed page cannot skip a PE. Production needs the
 * `(mint_status, peId)` composite index — a deploy input, same as the ledger's.
 *
 * The cursor returned in `lastKey` is the RAW `peId` as stored, never normalized: it is fed
 * straight back into `startAfter` on a `peId`-ordered query, and Firestore's ordering is
 * byte-wise and case-sensitive. Lower-casing it — which the first version did — silently skips
 * every PE whose id sorts between the two spellings while the run reports `completed`.
 *
 * Already-registered PEs are filtered by a ledger existence read. That read is not a
 * correctness requirement (`registerClaim` is idempotent) — it is what keeps a steady-state
 * run from re-offering the entire settled backlog every pass. Because it filters, the page
 * reports `readCount` separately from what it offers; see `InletPage`.
 */
export function createFirestoreInletSource(deps: FirestoreInletSourceDeps): InletPeSource {
  const { db } = deps;
  const nowMs = deps.now ?? Date.now;
  /** Memo of prev_hash -> linked, so one chain's shared links are read once per run. */
  const linkageMemo = new Map<string, boolean>();

  async function isChainLinked(prevHash: string): Promise<boolean> {
    if (isChainStartSentinel(prevHash)) return true;
    const memoized = linkageMemo.get(prevHash);
    if (memoized !== undefined) return memoized;
    const snap = await db.collection(ENVELOPES_COLLECTION)
      .where('hash', '==', prevHash)
      .limit(1)
      .get();
    const linked = snap.docs.length > 0;
    linkageMemo.set(prevHash, linked);
    return linked;
  }

  return {
    async loadPage({ pageSize, startAfterKey }): Promise<InletPage> {
      let query = db.collection(PE_HISTORY_COLLECTION)
        .where('mint_status', '==', RELAY_STATUS_READY)
        .orderBy('peId', 'asc')
        .limit(pageSize);
      if (startAfterKey !== undefined) query = query.startAfter(startAfterKey);
      const page = await query.get();

      const candidates: InletCandidate[] = [];
      let lastKey: string | undefined;
      /** PEs with pre-freeze act rows and no split: offered nothing, left to the audit. */
      let legacyUnfrozen = 0;

      for (const doc of page.docs) {
        const history = doc.data() ?? {};
        const peId = str(history.peId) ?? doc.id;
        // Advanced for EVERY row read, before any filtering. A cursor that only advanced past
        // offered rows would rewind to the first filtered row on the next page, forever.
        lastKey = peId;

        // The Genesis lane has its own source (`genesis-inlet-source.ts`): its reservation
        // state machine owns which grant a wallet holds, and deriving that from `pe_history`
        // alone would bypass the owner. Skipping here rather than offering keeps a Genesis PE
        // from consuming a standard-lane claim row.
        if (bool(history.is_genesis_grant)) continue;

        // VALUE INVARIANT — do not register a commit-bearing PE while a
        // higher-base cross-witness of the same commit could still claim its slot.
        //
        // Registering inside that window is what produced the one interleaving where
        // "one commit, one mint, at BEST value" failed: the incumbent's ledger row froze
        // at its uncorroborated value, and the later, higher-base forge witness could no
        // longer take over (a takeover that demoted a registered incumbent would strand a
        // settleable claim, so `inspectPreparedCommitTakeoverInTransaction` refuses it).
        //
        // Deferring here closes it from the side that CAN move. This is a skip, not a
        // drop: the row is re-read on the next run like every other skipped row, the
        // window is bounded at 72h, and after it lapses the PE registers normally.
        if (commitTakeoverWindowOpen(history, nowMs())) continue;

        // the SAME rule for the completion kind: do not register a
        // resolver-promoted OFF-CHAIN completion witness (`human_job_delivered`
        // on the poster's confirmation) while the on-chain escrow release of
        // the same job could still claim its slot. Registering inside the
        // window would freeze the off-chain value into the ledger and refuse the
        // best-supported witness for good (a takeover that demoted a registered
        // incumbent would strand a settleable claim). Same 72h bound, same
        // skip-not-drop semantics, same re-read on the next run. On-chain rows
        // are never deferred — nothing can take them over.
        if (completionTakeoverWindowOpen(history, nowMs())) continue;

        const peKey = normalizePeId(peId);
        const splitSnap = await db.collection(PE_SPLIT_COLLECTION).doc(peKey).get();
        let frozenSplit: ProposedPeSplit | null = null;
        let frozenRefusal: string | null = null;
        const missingFrozenLegs = new Set<PayoutLegRole>();
        if (splitSnap.exists) {
          const parsed = parseFrozenSplit(splitSnap.data(), peKey);
          if (parsed.kind !== 'valid') {
            frozenRefusal = `frozen_split_invalid:${parsed.reason}`;
          } else {
            frozenSplit = proposalFromFrozen(parsed.split);
            for (const leg of parsed.split.legs) {
              const legLedger = await db.collection(CLAIM_LEDGER_COLLECTION)
                .doc(claimKeyOf(peId, leg.leg)).get();
              if (!legLedger.exists) missingFrozenLegs.add(leg.leg);
            }
            // Fully registered: the steady-state backlog costs one split read and one read
            // per leg, and resolves nothing.
            if (missingFrozenLegs.size === 0) continue;
          }
        } else {
          const existingRows = await db.collection(CLAIM_LEDGER_COLLECTION)
            .where('pe_key', '==', peKey)
            .get();
          const hasActRow = existingRows.docs
            .some((row) => (row.data() ?? {}).claim_kind !== 'attestation_topup');
          if (hasActRow) {
            legacyUnfrozen += 1;
            continue;
          }
        }

        const envelopeSnap = await db.collection(ENVELOPES_COLLECTION).doc(peId).get();
        const envelope = envelopeSnap.exists ? (envelopeSnap.data() ?? {}) : null;

        // A history row with no sealed envelope has no derivable identity. Offering it with a
        // synthesized identity would hand it a claim id derived from nothing; offering it with
        // an empty one lets the inlet report `identity_underivable` honestly.
        const identity = envelope === null ? null : sealedIdentityOf(peId, envelope);
        const chainVerified = identity === null
          ? false
          : await isChainLinked(identity.prev_hash);
        const eligibility = projectEligibility({
          peId, history, envelope, identity, chainVerified,
        });
        // the settleable TOTAL, corroboration-lifted (software→corroborated
        // for a cross-witnessed commit, within 72h) via the SAME computeSettlement
        // math the estimate uses. Verbatim for the uncorroborated common case, so
        // the split below and the ledger row carry the lifted total when — and only
        // when — a recognized corroboration earned it. Read ONLY to freeze a new split:
        // a frozen split keeps the total it was cut from (a later lift is the top-up lane's).
        const recordPoints = frozenSplit?.totalPointsAtomic
          ?? corroborationLiftedRecordPointsAtomic(history as unknown as PEHistoryDocument);

        // Payees are resolved ONLY for a PE with no split at all.
        const payee = frozenSplit !== null || frozenRefusal !== null
          ? null
          : await resolvePayee(db, history, recordPoints, peId);
        const refusal = frozenRefusal ?? (payee?.kind === 'refused' ? payee.reason : null);
        if (refusal !== null) {
          // A refusal carries no address on purpose. `''` fails the inlet's contributor test
          // and is reported as `invalid_contributor` with the refusal reason attached, rather
          // than being quietly replaced by a default payee.
          candidates.push({
            peId,
            leg: 'sole',
            lane: 'standard',
            eligibility,
            contributor: '',
            contributorRefusal: refusal,
            recordPointsAtomic: recordPoints,
            beneficiaryClass: BeneficiaryClass.Unknown,
          });
          continue;
        }

        const split: ProposedPeSplit = frozenSplit ?? splitFromResolution(
          history,
          recordPoints,
          payee as Extract<PayeeResolution, { kind: 'resolved' }>,
        );
        const offered = frozenSplit === null
          ? split.legs
          : split.legs.filter((leg) => missingFrozenLegs.has(leg.leg));

        // a Commons speech PE minted under a talking pass registers only once
        // that pass's burn is FINAL. The burn was accepted at one-block inclusion; while its
        // 12-block finality check is pending this is a skip, not a drop (re-read next run), and a
        // burn that failed finality (revoked) never registers — so a window's mint can never
        // outrun a burn that did not happen. Read only for a PE with a leg not yet registered,
        // so the settled backlog pays nothing for it. PE-level, like every deferral.
        const speechWindowFinal = await speechPeWindowBurnFinal(
          db, peId, history.actionType,
          (envelope?.metadata as Record<string, unknown> | undefined) ?? null,
        );
        if (!speechWindowFinal) continue;

        // round 2 — a frozen-at-base split whose lift has landed: the legs registering
        // late carry the lift, and get their top-ups in the same transaction.
        const lateLift = frozenSplit === null ? null : lateLiftFor(history, frozenSplit.totalPointsAtomic);

        // ONE CANDIDATE PER LEG, every one carrying the WHOLE split: the inlet judges the legs
        // together and registers them in one transaction, or registers none.
        for (const leg of offered) {
          candidates.push({
            peId,
            leg: leg.leg,
            lane: 'standard',
            eligibility,
            contributor: leg.contributor,
            recordPointsAtomic: leg.record_points_atomic,
            beneficiaryClass: leg.beneficiary_class as BeneficiaryClass,
            split,
            ...(lateLift === null ? {} : { lateLift }),
          });
        }
      }

      deps.log?.(
        `inlet-source: page read=${page.docs.length} offered=${candidates.length} legacy_unfrozen=${legacyUnfrozen}`,
      );
      return { candidates, readCount: page.docs.length, lastKey };
    },
  };
}
