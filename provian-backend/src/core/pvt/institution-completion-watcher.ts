import { watcherReadHold, type WatcherCycleState } from './institution-watcher-status';
/**
 * Institution COMPLETION watcher — the linked-evidence emitter for institution
 * lifecycle *completions*, the sibling of `institution-funding-watcher.ts`.
 *
 * Where the funding watcher observes value ENTERING an institution (escrow
 * funded, pool contributed, promise funded), this one observes value LEAVING it
 * on completion — the deliverer/value-receiver's earning act:
 *
 * EscrowReleased(+PVT) -> escrow_completed (recipient earns)
 * EscrowResolved(+PVT) -> escrow_resolved (dispute outcome; value-receiver earns)
 * PromiseSettled(+PVT) -> promise_settled (lender earns)
 * PoolExecuted(+PVT) -> pool_executed (target earns)
 *
 * It reads the four PVT9 institutions on Base through the SAME quorum-2 seam and
 * emits one linked-evidence Provenance Envelope per canonical completion event,
 * independent of whatever an API caller told the relay.
 *
 * =========================================================================
 * IT PAYS. The reclassification LANDED in.
 * =========================================================================
 * CORRECTED BY this block used to say, in the present
 * tense, that the watcher "pays nothing until the matrix reclassification
 * lands". It landed. The four action types this watcher emits
 * (escrow_completed / escrow_resolved / promise_settled / pool_executed) are
 * `verified_institution_lifecycle`, `financial_attestation_neutral: true`,
 * `session_lineage_policy: 'optional'` and `mint_disposition: 'eligible'` in the
 * live matrix (the row config is unchanged across every re-pin since `4aa0826f`,
 *; the current declared `content_sha256` is whatever `check:wp2` pins —
 * read `scripts/wp2/generate-pvt9-base-config.mjs`, never a transcribed hash) —
 * the funding trio's exact production config — so this watcher's verified
 * chain-finality emit MINTS, and has since the deploy. As of the Trust
 * Layer build the same seam has a THIRD sibling,
 * `institution-standing-watcher.ts` (BondPool + CourtV2 lifecycle → named
 * record_only rows that Standing counts; never mints by construction).
 * The cron `provian-institution-completion` (ENABLED, every 15 minutes) has
 * been running since the same deploy.
 *
 * The watcher was nonetheless landed BEFORE the reclassification on purpose: the
 * cursor started advancing and the population became observable before anything
 * could mint, which is what made the first real completion emission provable
 * rather than assumed (the same order used for funding).
 *
 * THE OTHER COMPLETION TYPES named (promise_fulfilled / job_delivered /
 * human_job_delivered / goal_envelope_completed / human_job_completed) are now
 * session-lineage OPTIONAL too (the completion-earning re-issue), still
 * `verified_substantive_outcome`. They have no on-chain event and so no emitter
 * here; their evidence is the COUNTERPARTY — the pending-evidence resolver's
 * `completion-verifier.ts` promotes a `human_job_delivered` on the poster's
 * verified confirmation ('s "economically inert" reading predated that
 * verifier). The two witnesses of one job meet on the `completion` mint-once
 * claim: this watcher's verified escrow release claims it in `writePEHistory`
 * (`completionCanonicalId`, resolved below), the resolver's promotion claims it
 * in its own transaction, and the release TAKES OVER an eligible, unregistered
 * off-chain incumbent so the value paid is the best-supported one, never the
 * sum (`completion-takeover.ts`).
 *
 * =========================================================================
 * THE STAMP IS EARNED, NEVER ASSERTED (shared with funding).
 * =========================================================================
 * `metadata.verified` is granted per completion by
 * `evaluateInstitutionFinalityVerdict` (imported from the funding watcher — ONE
 * copy of the counterparty + safe-head reorg-floor logic) against an
 * explicit finality witness RE-DERIVED at stamp time, and refused otherwise. A
 * refusal seals a verdict-less row carrying its reason. There is no parameter
 * anywhere that lets a caller assert "verified".
 *
 * =========================================================================
 * ATTRIBUTION — THE PARTY THE ON-CHAIN EVENT NAMES.
 * =========================================================================
 * `PromiseSettled` and `PoolExecuted` carry the value-receiver as an INDEXED
 * address (lender, target), so the log names who earns; the counterparty
 * (borrower, creator) is read from the struct getter, word 0. `EscrowReleased`
 * names the recipient indexed; counterparty (depositor) is escrow struct word 0.
 * `EscrowResolved` names NEITHER — it carries only the escrow id and a
 * `releaseToRecipient` bool — so BOTH sides are read from `escrows(bytes32)` and
 * the bool decides which is the value-receiver: released -> recipient earns,
 * counterparty depositor; refunded -> depositor is the value-receiver,
 * counterparty recipient. An entity whose struct cannot be read is SKIPPED and
 * counted, never attributed to a guess.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
import { resolveEscrowCompletionCanonicalId } from './completion-claim';
import {
  INSTITUTION_WATCHER_CHAIN_ID,
  INSTITUTION_CONFIRMATION_FLOOR,
  normalizeBlockChunk,
  INSTITUTION_ADDRESSES,
  PREDECESSOR_ESCROW_V4_ADDRESS,
  canonicalLogIdentity,
  decodeStructAddressWord,
  topicToAddress,
  finalizedThroughBlock,
  evaluateInstitutionFinalityVerdict,
  type InstitutionFinalityWitness,
  type InstitutionCycleFinality,
  type StampRefusalReason,
} from './institution-funding-watcher';

// =============================================================================
// COLLECTIONS (completion-specific — never the funding watcher's)
// =============================================================================

export const INSTITUTION_COMPLETION_CHECKPOINT_COLLECTION =
  'pvt_institution_completion_watcher_checkpoints_v1';

/**
 * One document per canonical log identity, created transactionally with the PE,
 * so a canonical completion event produces at most one linked-evidence row even
 * across concurrent workers or a replayed block range.
 */
export const INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION =
  'institution_completion_emission_locks';

// =============================================================================
// EVENT REGISTRY
// =============================================================================

export type InstitutionCompletionActionType =
  'escrow_completed' | 'escrow_resolved' | 'escrow_disputed'
  | 'promise_settled' | 'pool_executed';

/**
 * ============================ AUDIT DISCLOSURE ============================
 * Like the funding watcher, this module is ABSENT from the generated
 * action-policy matrix's `static_emitter_files`, and that absence is DELIBERATE.
 * It emits its four action types DYNAMICALLY (`spec.actionType`) via a registry
 * lookup, so `discoverStaticEmitters` — a literal `actionType: '<literal>'` scan
 * — cannot see them. Making it visible would move the matrix's declared
 * `content_sha256`, authorized ONLY for the 3b supersession that reclassifies
 * these types. `INSTITUTION_COMPLETION_ACTION_TYPES` is the local, test-enforced
 * substitute until then.
 * =========================================================================
 */
export const INSTITUTION_COMPLETION_ACTION_TYPES:
  readonly InstitutionCompletionActionType[] = Object.freeze([
    'escrow_completed', 'escrow_resolved', 'escrow_disputed',
    'promise_settled', 'pool_executed',
  ]);

/**
 * How the value-receiver and its counterparty are named for one event.
 *
 * `indexed_actor` — the log carries the value-receiver as an indexed topic; the
 * counterparty is read from a struct getter word. `escrow_resolution` — the log
 * names neither; BOTH parties come from `escrows(bytes32)` and a `releaseToRecipient`
 * bool in the log data decides which is the value-receiver.
 */
export type CompletionAttribution =
  | {
    readonly kind: 'indexed_actor';
    /** Zero-based topic index carrying the value-receiver. */
    readonly actorTopicIndex: number;
    /** Struct getter naming the counterparty, and its word index. */
    readonly counterpartyGetter: string;
    readonly counterpartyWordIndex: number;
  }
  | {
    readonly kind: 'escrow_resolution';
    /** `escrows(bytes32)`; word 0 depositor, word 1 recipient. */
    readonly getter: string;
    readonly depositorWordIndex: number;
    readonly recipientWordIndex: number;
  }
  | {
    // EscrowDisputed carries only the indexed escrowId — no amount, no
    // direction bool, no indexed actor. The disputer is the depositor
    // (`disputeEscrow` is `onlyDepositor` on-chain), so the value-receiver is the
    // depositor (struct word 0) and the counterparty is the recipient (word 1).
    readonly kind: 'escrow_dispute';
    readonly getter: string;
    readonly depositorWordIndex: number;
    readonly recipientWordIndex: number;
  };

export interface InstitutionCompletionEventSpec {
  readonly institution: 'escrow' | 'promise' | 'pool';
  /** Deployed Base address, lowercased for comparison. */
  readonly address: string;
  /** Solidity event signature. topic0 is DERIVED from this, never pasted. */
  readonly signature: string;
  readonly topic0: string;
  readonly actionType: InstitutionCompletionActionType;
  // 'none' for the currency-less shared `EscrowDisputed` event — a dispute
  // moves no value, so it carries no amount and no currency. Amount-independent
  // rows (all institution-lifecycle types) never price on currency anyway.
  readonly currency: 'usdc' | 'pvt' | 'none';
  readonly attribution: CompletionAttribution;
}

function indexedActor(
  actorTopicIndex: number,
  counterparty: { readonly getter: string; readonly wordIndex: number },
): CompletionAttribution {
  return Object.freeze({
    kind: 'indexed_actor',
    actorTopicIndex,
    counterpartyGetter: counterparty.getter,
    counterpartyWordIndex: counterparty.wordIndex,
  });
}

const ESCROW_RESOLUTION: CompletionAttribution = Object.freeze({
  kind: 'escrow_resolution',
  getter: 'escrows(bytes32)',
  depositorWordIndex: 0,
  recipientWordIndex: 1,
});

// the disputer is the depositor (`disputeEscrow` is `onlyDepositor`); the
// recipient is the counterparty. Both from `escrows(bytes32)`, no direction bool.
const ESCROW_DISPUTE: CompletionAttribution = Object.freeze({
  kind: 'escrow_dispute',
  getter: 'escrows(bytes32)',
  depositorWordIndex: 0,
  recipientWordIndex: 1,
});

function spec(
  institution: InstitutionCompletionEventSpec['institution'],
  address: string,
  signature: string,
  actionType: InstitutionCompletionActionType,
  currency: 'usdc' | 'pvt' | 'none',
  attribution: CompletionAttribution,
): InstitutionCompletionEventSpec {
  return Object.freeze({
    institution,
    address,
    signature,
    // DERIVED from the signature, never pasted. A signature edit moves the topic
    // automatically, so a watcher can never listen for a topic no contract emits.
    topic0: ethers.id(signature),
    actionType,
    currency,
    attribution,
  });
}

/** Counterparty struct reads for the indexed-actor completions. */
const ESCROW_DEPOSITOR = { getter: 'escrows(bytes32)', wordIndex: 0 } as const;
const PROMISE_BORROWER = { getter: 'promises(bytes32)', wordIndex: 0 } as const;
const POOL_CREATOR = { getter: 'pools(bytes32)', wordIndex: 0 } as const;

/**
 * The nine institution-lifecycle events: four value-settlement completion types
 * × usdc/pvt (escrow release/resolve, promise settle, pool execute), plus the
 * currency-less `EscrowDisputed`. Addresses are the deployed institution deployment
 * successors (`INSTITUTION_ADDRESSES`, imported so ONE source names them).
 */
export const INSTITUTION_COMPLETION_EVENTS:
  readonly InstitutionCompletionEventSpec[] = Object.freeze([
    // Escrow release: recipient (topic 2) earns; counterparty depositor.
    spec('escrow', INSTITUTION_ADDRESSES.escrow,
      'EscrowReleased(bytes32,address,uint256,uint256,bool)',
      'escrow_completed', 'usdc', indexedActor(2, ESCROW_DEPOSITOR)),
    spec('escrow', INSTITUTION_ADDRESSES.escrow,
      'EscrowReleasedPVT(bytes32,address,uint256,bool)',
      'escrow_completed', 'pvt', indexedActor(2, ESCROW_DEPOSITOR)),
    // Escrow resolution: no indexed actor; direction from the log's bool.
    spec('escrow', INSTITUTION_ADDRESSES.escrow,
      'EscrowResolved(bytes32,bool)',
      'escrow_resolved', 'usdc', ESCROW_RESOLUTION),
    spec('escrow', INSTITUTION_ADDRESSES.escrow,
      'EscrowResolvedPVT(bytes32,bool)',
      'escrow_resolved', 'pvt', ESCROW_RESOLUTION),
    // escrow dispute — ONE shared, currency-less event carrying only the
    // indexed escrowId. The depositor (disputer) earns; the recipient is the
    // counterparty. Parity with escrow_resolved (institution-lifecycle, amount-
    // independent). Chain-witnessed here; the relay self-report draft is retired.
    spec('escrow', INSTITUTION_ADDRESSES.escrow,
      'EscrowDisputed(bytes32)',
      'escrow_disputed', 'none', ESCROW_DISPUTE),
    // Promise settlement: lender (topic 2) earns; counterparty borrower.
    spec('promise', INSTITUTION_ADDRESSES.promise,
      'PromiseSettled(bytes32,address,uint256,uint256)',
      'promise_settled', 'usdc', indexedActor(2, PROMISE_BORROWER)),
    spec('promise', INSTITUTION_ADDRESSES.promise,
      'PromiseSettledPVT(bytes32,address,uint256,uint256)',
      'promise_settled', 'pvt', indexedActor(2, PROMISE_BORROWER)),
    // Pool execution: target (topic 2) earns; counterparty creator.
    spec('pool', INSTITUTION_ADDRESSES.pool,
      'PoolExecuted(bytes32,address,uint256,uint256)',
      'pool_executed', 'usdc', indexedActor(2, POOL_CREATOR)),
    spec('pool', INSTITUTION_ADDRESSES.pool,
      'PoolExecutedPVT(bytes32,address,uint256,uint256)',
      'pool_executed', 'pvt', indexedActor(2, POOL_CREATOR)),
    // a USDC escrow already Disputed at the migration completes on the PREDECESSOR
    // EscrowV4 (its principal cannot leave a non-custodial escrow except to its own parties).
    // Admin resolution and the permissionless timeout both emit EscrowResolved there.
    spec('escrow', PREDECESSOR_ESCROW_V4_ADDRESS,
      'EscrowResolved(bytes32,bool)',
      'escrow_resolved', 'usdc', ESCROW_RESOLUTION),
  ]);

// =============================================================================
// DECODING
// =============================================================================

export interface DecodedInstitutionCompletion {
  readonly spec: InstitutionCompletionEventSpec;
  readonly canonicalEventId: string;
  readonly entityId: string;
  /**
   * For an `indexed_actor` event, the value-receiver named in the log. For an
   * `escrow_resolution` event, null — both parties are struct-read and the
   * direction bool below decides which earns.
   */
  readonly indexedActorAddress: string | null;
  /**
   * Only meaningful for `escrow_resolution`: true when the escrow released to the
   * recipient, false when it refunded the depositor. Null otherwise.
   */
  readonly releaseToRecipient: boolean | null;
  /** Net amount when the event carries one; null for `EscrowResolved`. */
  readonly amountAtomic: bigint | null;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
}

/**
 * Decode one canonical log into a completion, or null when it is not one of the
 * eight events (or is structurally unusable). Every refusal returns null rather
 * than throwing: a watcher that dies on one malformed log stops advancing its
 * cursor for every other institution.
 */
export function decodeInstitutionCompletionLog(
  log: CanonicalEconomicLog,
  chainId: number = INSTITUTION_WATCHER_CHAIN_ID,
): DecodedInstitutionCompletion | null {
  if (log.removed) return null;
  const topic0 = log.topics[0];
  if (typeof topic0 !== 'string') return null;

  const matched = INSTITUTION_COMPLETION_EVENTS.find(
    (s) => s.topic0 === topic0 && s.address === log.address.toLowerCase(),
  );
  // Address AND topic must both match — topic alone would accept an identical
  // event emitted by an unrelated contract.
  if (!matched) return null;

  const entityId = log.topics[1];
  if (typeof entityId !== 'string' || !/^0x[0-9a-f]{64}$/.test(entityId)) return null;

  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;

  let indexedActorAddress: string | null = null;
  let releaseToRecipient: boolean | null = null;
  let amountAtomic: bigint | null = null;

  if (matched.attribution.kind === 'indexed_actor') {
    const topic = log.topics[matched.attribution.actorTopicIndex];
    if (typeof topic !== 'string') return null;
    indexedActorAddress = topicToAddress(topic);
    // The event declares an indexed actor; an unreadable one is a refusal.
    if (indexedActorAddress === null) return null;
    // First 32-byte word of `data` is the net amount for these events.
    if (data.length < 64) return null;
    try {
      amountAtomic = BigInt(`0x${data.slice(0, 64)}`);
    } catch {
      return null;
    }
  } else if (matched.attribution.kind === 'escrow_resolution') {
    // escrow_resolution: the only data word is the `releaseToRecipient` bool.
    if (data.length < 64) return null;
    let flag: bigint;
    try {
      flag = BigInt(`0x${data.slice(0, 64)}`);
    } catch {
      return null;
    }
    // A bool ABI-encodes to exactly 0 or 1; anything else is malformed.
    if (flag !== 0n && flag !== 1n) return null;
    releaseToRecipient = flag === 1n;
    // EscrowResolved carries no amount; it is amount-independent for minting.
    amountAtomic = null;
  } else {
    // escrow_dispute: EscrowDisputed(bytes32 indexed escrowId) has NO
    // non-indexed args, so `data` is empty. No amount, no direction, no indexed
    // actor — the depositor/recipient are read from the struct in attribution.
    indexedActorAddress = null;
    releaseToRecipient = null;
    amountAtomic = null;
  }

  let canonicalEventId: string;
  try {
    canonicalEventId = canonicalLogIdentity(chainId, log.transactionHash, log.logIndex);
  } catch {
    return null;
  }

  return {
    spec: matched,
    canonicalEventId,
    entityId,
    indexedActorAddress,
    releaseToRecipient,
    amountAtomic,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(),
  };
}

// =============================================================================
// ATTRIBUTION (resolve value-receiver + counterparty on chain)
// =============================================================================

export interface CompletionParties {
  /** The value-receiver — the party the completion attributes the earning to. */
  readonly actorAddress: string;
  /**
   * The other side of the value movement, for the self-dealing guard, or null
   * when its on-chain read failed. A NULL COUNTERPARTY IS NOT FATAL: the row is
   * still emitted and records its provenance, the verdict refuses (so it seals
   * `pending_evidence`/`record_only` and pays 0). This mirrors the funding
   * watcher exactly — "the refusal costs the payment, not the provenance". Only an
   * unresolvable ACTOR drops the row (a whole `CompletionParties` of null).
   */
  readonly counterpartyAddress: string | null;
}

/**
 * Read one struct getter through the quorum-2 `eth_call` seam and return the raw
 * ABI return, or null on a failed/unusable read.
 */
async function callStruct(
  deps: InstitutionCompletionWatcherDeps,
  address: string,
  getter: string,
  entityId: string,
): Promise<string | null> {
  const selector = ethers.id(getter).slice(0, 10);
  const data = selector + entityId.replace(/^0x/, '').padStart(64, '0');
  try {
    return await deps.callContract(address, data);
  } catch {
    return null;
  }
}

/**
 * Resolve the value-receiver AND its counterparty for one completion.
 *
 * TWO DISTINCT FAILURE MODES, matching the funding watcher exactly:
 * - UNRESOLVABLE ACTOR -> return `null`. The whole row DROPS, counted under
 * `attributionFailures` (which IS in the cursor-hold set), so the block is
 * RETRIED next cycle. Only `escrow_resolution` can hit this: its value-receiver
 * comes from the struct, and a struct read that fails leaves no one to
 * attribute the earning to. An `indexed_actor` event's value-receiver is named
 * in the log, so its actor is never unresolvable here.
 * - UNRESOLVABLE COUNTERPARTY -> return `{ actorAddress, counterpartyAddress: null }`.
 * The row is STILL EMITTED (provenance recorded) with the verdict refused, so
 * it seals `record_only` and pays 0 — "the refusal costs the payment, not the
 * provenance" (funding-watcher). Counted under `counterpartyReadFailures`,
 * which is NOT in the cursor-hold set, so it is not re-attempted forever.
 *
 * The earlier version dropped an `indexed_actor` row on a counterparty read
 * failure AND let the cursor advance past it, permanently losing a real
 * completion. It now emits `record_only`.
 */
export async function resolveCompletionParties(
  deps: InstitutionCompletionWatcherDeps,
  completion: DecodedInstitutionCompletion,
  report: InstitutionCompletionWatcherReport,
): Promise<CompletionParties | null> {
  const attr = completion.spec.attribution;
  const ZERO = ethers.ZeroAddress.toLowerCase();

  if (attr.kind === 'indexed_actor') {
    const actorAddress = completion.indexedActorAddress;
    if (actorAddress === null) {
      // Unreachable in practice (decode refuses a null indexed actor); a
      // defensive drop, held for retry rather than a bad attribution.
      report.attributionFailures += 1;
      return null;
    }
    // The counterparty is NON-FATAL: a failed or zero read costs the payment, not
    // the record. Emit with a null counterparty (verdict refuses -> record_only).
    const raw = await callStruct(
      deps, completion.spec.address, attr.counterpartyGetter, completion.entityId,
    );
    const counterpartyAddress = raw === null
      ? null
      : decodeStructAddressWord(raw, attr.counterpartyWordIndex);
    if (counterpartyAddress === null || counterpartyAddress === ZERO) {
      report.counterpartyReadFailures += 1;
      return { actorAddress, counterpartyAddress: null };
    }
    return { actorAddress, counterpartyAddress };
  }

  // escrow_dispute: ONE struct read gives BOTH parties; the disputer
  // (depositor, `disputeEscrow` is onlyDepositor) is the value-receiver, the
  // recipient the counterparty. No direction bool — MUST be handled before the
  // escrow_resolution branch, whose `releaseToRecipient === null` drop would
  // otherwise wrongly discard every dispute (a dispute always has null direction).
  if (attr.kind === 'escrow_dispute') {
    const raw = await callStruct(deps, completion.spec.address, attr.getter, completion.entityId);
    if (raw === null) {
      report.attributionFailures += 1;
      return null;
    }
    const depositor = decodeStructAddressWord(raw, attr.depositorWordIndex);
    const recipient = decodeStructAddressWord(raw, attr.recipientWordIndex);
    // The ACTOR (disputer/depositor) must resolve, or there is no one to attribute
    // to -> drop+retry. Counterparty (recipient) non-fatal: emit record_only.
    if (depositor === null || depositor === ZERO) {
      report.attributionFailures += 1;
      return null;
    }
    if (recipient === null || recipient === ZERO) {
      report.counterpartyReadFailures += 1;
      return { actorAddress: depositor, counterpartyAddress: null };
    }
    return { actorAddress: depositor, counterpartyAddress: recipient };
  }

  // escrow_resolution: ONE struct read gives BOTH parties. A failed read leaves no
  // value-receiver, so it DROPS and is held for retry (attributionFailures).
  if (completion.releaseToRecipient === null) {
    report.attributionFailures += 1;
    return null;
  }
  const raw = await callStruct(deps, completion.spec.address, attr.getter, completion.entityId);
  if (raw === null) {
    report.attributionFailures += 1;
    return null;
  }
  const depositor = decodeStructAddressWord(raw, attr.depositorWordIndex);
  const recipient = decodeStructAddressWord(raw, attr.recipientWordIndex);
  // released -> recipient earns, counterparty depositor.
  // refunded -> depositor is the value-receiver, counterparty recipient.
  const actor = completion.releaseToRecipient ? recipient : depositor;
  const counterparty = completion.releaseToRecipient ? depositor : recipient;
  // The ACTOR must be resolvable, or there is no one to attribute to -> drop+retry.
  if (actor === null || actor === ZERO) {
    report.attributionFailures += 1;
    return null;
  }
  // Counterparty non-fatal: emit record_only without it.
  if (counterparty === null || counterparty === ZERO) {
    report.counterpartyReadFailures += 1;
    return { actorAddress: actor, counterpartyAddress: null };
  }
  return { actorAddress: actor, counterpartyAddress: counterparty };
}

// =============================================================================
// EMISSION
// =============================================================================

export interface InstitutionCompletionEmission {
  readonly completion: DecodedInstitutionCompletion;
  readonly actorAddress: string;
  readonly walletId: string;
  readonly agentId: string;
  /**
   * The other side of the value movement, read on chain. Absent means the
   * self-dealing guard CANNOT run, so the verdict refuses. Optional for the same
   * reason as the witness.
   */
  readonly counterpartyAddress?: string;
  /**
   * Absent means NO VERDICT — the row seals `pending_evidence` and pays 0.
   * Optional ON PURPOSE : a required field would make the refusal
   * unconstructible. The cycle always supplies it; the guard decides.
   */
  readonly finalityWitness?: InstitutionFinalityWitness;
}

/** Project a completion emission down to the shared verdict's minimal input. */
export function evaluateCompletionVerdict(
  emission: InstitutionCompletionEmission,
): { verified: true } | { verified: false; reason: StampRefusalReason } {
  return evaluateInstitutionFinalityVerdict({
    blockNumber: emission.completion.blockNumber,
    counterpartyAddress: emission.counterpartyAddress,
    finalityWitness: emission.finalityWitness,
  });
}

/**
 * Metadata for the linked-evidence PE. THE STAMP is applied HERE and ONLY from
 * `evaluateCompletionVerdict` — never from a caller-supplied boolean. A refusal
 * seals the row with the reason in it.
 */
export function buildCompletionEvidenceMetadata(
  emission: InstitutionCompletionEmission,
  chainId: number,
): Record<string, unknown> {
  const { completion } = emission;
  const verdict = evaluateCompletionVerdict(emission);
  return {
    // Present ONLY on an affirmative verdict; absent — not `false` — otherwise,
    // because `pe-utils` tests `metadata.verified === true`.
    ...(verdict.verified
      ? { verified: true }
      : { evidence_verdict_refused: verdict.reason }),
    ...(verdict.verified
      ? {
        finality_witness_head: emission.finalityWitness!.head,
        finality_witness_finalized_through: emission.finalityWitness!.finalizedThrough,
        finality_witness_safe_head: emission.finalityWitness!.safeHead!.number,
        finality_witness_safe_hash: emission.finalityWitness!.safeHead!.hash,
      }
      : {}),
    canonical_event_id: completion.canonicalEventId,
    tx_hash: completion.txHash,
    log_index: completion.logIndex,
    block_number: completion.blockNumber,
    block_hash: completion.blockHash,
    chain: 'base',
    chain_id: chainId,
    institution: completion.spec.institution,
    entity_id: completion.entityId,
    currency: completion.spec.currency,
    amount_atomic: completion.amountAtomic === null
      ? null
      : completion.amountAtomic.toString(),
    // Escrow resolution outcome, sealed so a reader can see whether the payee was
    // the recipient (released) or the depositor (refunded).
    release_to_recipient: completion.releaseToRecipient,
    actor_address: emission.actorAddress,
    counterparty_address: emission.counterpartyAddress ?? null,
    finality_confirmations: INSTITUTION_CONFIRMATION_FLOOR,
    observed_by: 'institution_completion_watcher',
  };
}

// =============================================================================
// REPORT
// =============================================================================

export interface InstitutionCompletionWatcherReport extends WatcherCycleState {
  logsRead: number;
  completionsDecoded: number;
  emitted: number;
  duplicatesSkipped: number;
  unattributed: number;
  /** Struct read for the value-receiver/counterparty failed or was unusable. */
  attributionFailures: number;
  counterpartyReadFailures: number;
  emissionFailures: number;
  stampRefusals: number;
  safeHead: number | null;
  safeHeadBoundedScan: boolean;
  cursorFrom: number | null;
  cursorTo: number | null;
  cursorAdvanced: boolean;
  finalizedThrough: number | null;
  head: number | null;
  lockPopulationCount: number | null;
  lockPopulationAgrees: boolean | null;
  /**
   * Ops observability (Part D): per-event-type emitted count for this cycle, keyed by the
   * completion action type (escrow_completed / escrow_resolved / escrow_disputed /
   * promise_settled / pool_executed). A plain tally the NON-money-path caller (server.ts) reads
   * to bump `watcher.<type>` ops-counters — this file never imports ops-counters (core/pvt rule).
   */
  emittedByType: Record<string, number>;
}

export function emptyInstitutionCompletionWatcherReport(): InstitutionCompletionWatcherReport {
  return {
    status: 'held',
    hold_reason: 'head_unavailable',
    logsRead: 0,
    completionsDecoded: 0,
    emitted: 0,
    duplicatesSkipped: 0,
    unattributed: 0,
    attributionFailures: 0,
    counterpartyReadFailures: 0,
    emissionFailures: 0,
    stampRefusals: 0,
    safeHead: null,
    safeHeadBoundedScan: false,
    cursorFrom: null,
    cursorTo: null,
    cursorAdvanced: false,
    finalizedThrough: null,
    head: null,
    lockPopulationCount: null,
    lockPopulationAgrees: null,
    emittedByType: {},
  };
}

// =============================================================================
// DEPS
// =============================================================================

export interface InstitutionCompletionWatcherDeps {
  readonly db: Firestore;
  readonly chainId: number;
  readonly readHead: () => Promise<number>;
  /**. The quorum-2 L1-batched safe head. Null means no safe block yet. */
  readonly readSafeHead?: () => Promise<{ readonly number: number; readonly hash: string } | null>;
  readonly getLogs: (filter: {
    readonly address: string | readonly string[];
    readonly topics: readonly (string | readonly string[] | null)[];
    readonly fromBlock: number;
    readonly toBlock: number;
  }) => Promise<readonly CanonicalEconomicLog[]>;
  readonly callContract: (to: string, data: string) => Promise<string>;
  readonly resolveWalletByAddress: (
    address: string,
  ) => Promise<{ walletId: string; agentId: string } | null>;
  readonly emitLinkedEvidencePE: (
    emission: InstitutionCompletionEmission,
  ) => Promise<{ emitted: boolean; peId?: string }>;
  readonly now?: () => number;
}

// =============================================================================
// PER-COMPLETION PROCESSING
// =============================================================================

/**
 * Process one decoded completion: attribute (value-receiver + counterparty), then
 * emit exactly once. `finality` is OPTIONAL (a required parameter would
 * make the no-witness refusal unconstructible). Omitted, the emission is
 * verdict-less and pays 0.
 */
export async function processDecodedCompletion(
  deps: InstitutionCompletionWatcherDeps,
  completion: DecodedInstitutionCompletion,
  report: InstitutionCompletionWatcherReport,
  finality?: InstitutionCycleFinality,
): Promise<void> {
  const parties = await resolveCompletionParties(deps, completion, report);
  if (parties === null) return;

  const wallet = await deps.resolveWalletByAddress(parties.actorAddress);
  if (wallet === null) {
    // A real on-chain completion by someone who is not a registered Provian
    // wallet. Counted, not emitted — there is no chain to append it to.
    report.unattributed += 1;
    return;
  }

  const emission: InstitutionCompletionEmission = {
    completion,
    actorAddress: parties.actorAddress,
    walletId: wallet.walletId,
    agentId: wallet.agentId,
    // Absent when the counterparty read failed — the verdict then refuses
    // (`counterparty_unresolved`) and the row seals record_only, but it is still
    // EMITTED (provenance preserved). Never dropped for a counterparty failure.
    ...(parties.counterpartyAddress === null
      ? {}
      : { counterpartyAddress: parties.counterpartyAddress }),
    ...(finality === undefined ? {} : {
      finalityWitness: {
        head: finality.head,
        finalizedThrough: finality.finalizedThrough,
        observedBlock: completion.blockNumber,
        ...(finality.safeHead === undefined ? {} : { safeHead: finality.safeHead }),
      },
    }),
  };

  // Report the verdict the row will actually seal, from the SAME function the
  // metadata builder calls — an operator must see a refusal in the cycle report.
  if (!evaluateCompletionVerdict(emission).verified) report.stampRefusals += 1;

  try {
    const result = await deps.emitLinkedEvidencePE(emission);
    if (result.emitted) {
      report.emitted += 1;
      // Ops observability (Part D): per-event-type tally the non-money-path caller bumps.
      const t = completion.spec.actionType;
      report.emittedByType[t] = (report.emittedByType[t] ?? 0) + 1;
    } else report.duplicatesSkipped += 1;
  } catch {
    report.emissionFailures += 1;
  }
}

// =============================================================================
// SCAN
// =============================================================================

// One normalization, shared with the funding twin : the local copy this
// file used to carry was the self-referential shape — the env lever
// would have moved one watcher and silently not the other.

/**
 * ONE `eth_getLogs` filter across the escrow/promise/pool contracts (an address
 * ARRAY plus a topic-OR of all eight completion topic0s). Coverage is provably
 * the union of the per-contract queries: the returned addresses are exactly the
 * deduped completion addresses and topic0s exactly their deduped topics, and
 * `decodeInstitutionCompletionLog` still matches each log to its EXACT
 * `(address, topic0)` spec, so a completion topic emitted by the wrong contract
 * is rejected. Safe to batch because all contracts share ONE confirmation floor
 * and ONE chain-global cursor.
 */
export function institutionCompletionLogFilters(): {
  readonly addresses: readonly string[];
  readonly topic0s: readonly string[];
} {
  const addresses = Array.from(new Set(INSTITUTION_COMPLETION_EVENTS.map((s) => s.address)));
  const topic0s = Array.from(new Set(INSTITUTION_COMPLETION_EVENTS.map((s) => s.topic0)));
  return Object.freeze({
    addresses: Object.freeze(addresses),
    topic0s: Object.freeze(topic0s),
  });
}

/**
 * Scan an explicit, already-finality-bounded range in bounded chunks. Returns the
 * lowest block whose processing FAILED durably, or `Number.MAX_SAFE_INTEGER` when
 * everything in the range was handled. The caller must not advance the cursor past
 * a failure.
 */
export async function scanInstitutionCompletionRange(
  deps: InstitutionCompletionWatcherDeps,
  args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly blockChunk: number;
    readonly report: InstitutionCompletionWatcherReport;
    readonly finality?: InstitutionCycleFinality;
  },
): Promise<number> {
  const { report } = args;
  let minFailedBlock = Number.MAX_SAFE_INTEGER;
  const { addresses, topic0s } = institutionCompletionLogFilters();

  for (let start = args.fromBlock; start <= args.toBlock; start += args.blockChunk) {
    const end = Math.min(start + args.blockChunk - 1, args.toBlock);
    let logs: readonly CanonicalEconomicLog[];
    try {
      logs = await deps.getLogs({
        address: addresses,
        topics: [topic0s],
        fromBlock: start,
        toBlock: end,
      });
    } catch {
      minFailedBlock = Math.min(minFailedBlock, start);
      continue;
    }
    report.logsRead += logs.length;

    for (const log of logs) {
      const completion = decodeInstitutionCompletionLog(log, deps.chainId);
      if (completion === null) continue;
      report.completionsDecoded += 1;
      const before = report.emissionFailures + report.attributionFailures;
      await processDecodedCompletion(deps, completion, report, args.finality);
      const after = report.emissionFailures + report.attributionFailures;
      if (after > before) {
        minFailedBlock = Math.min(minFailedBlock, log.blockNumber);
      }
    }
  }
  return minFailedBlock;
}

// =============================================================================
// CYCLE
// =============================================================================

/**
 * Independent `count()` corroboration of the emission-lock population. Returns
 * null when the backend cannot aggregate; a null is "not corroborated", never
 * agreement. Reads the COMPLETION lock collection (not the funding one).
 */
export async function corroborateCompletionLockPopulation(
  deps: InstitutionCompletionWatcherDeps,
  expectedDelta: number,
  populationBefore: number | null,
): Promise<{ count: number | null; agrees: boolean | null }> {
  let after: number | null = null;
  try {
    const coll = deps.db.collection(INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION);
    const agg = (coll as unknown as {
      count?: () => { get: () => Promise<{ data: () => { count: number } }> };
    }).count;
    if (typeof agg === 'function') {
      const snap = await agg.call(coll).get();
      const value = snap.data().count;
      if (Number.isSafeInteger(value)) after = value;
    }
  } catch {
    after = null;
  }
  if (after === null || populationBefore === null) return { count: after, agrees: null };
  return { count: after, agrees: after - populationBefore === expectedDelta };
}

async function readCompletionLockPopulation(
  deps: InstitutionCompletionWatcherDeps,
): Promise<number | null> {
  const probe = await corroborateCompletionLockPopulation(deps, 0, null);
  return probe.count;
}

/**
 * One completion-watcher cycle. Reads head -> derives the finality ceiling ->
 * clamps to the L1-batched safe head (the reorg floor bounds the SCAN, not
 * only the stamp) -> walks from the durable cursor in bounded chunks -> commits
 * incrementally, never past a failure -> corroborates the population.
 *
 * FAIL-CLOSED on an absent safe reader or safe block: scan nothing, exactly as
 * the funding watcher does.
 */
export async function runInstitutionCompletionWatcherCycle(
  deps: InstitutionCompletionWatcherDeps,
  options: { readonly blockChunk?: number; readonly maxBlocksPerCycle?: number } = {},
): Promise<InstitutionCompletionWatcherReport> {
  const report = emptyInstitutionCompletionWatcherReport();
  const now = deps.now ?? (() => Date.now());
  const blockChunk = normalizeBlockChunk(options.blockChunk);

  let head: number;
  try { head = await deps.readHead(); } catch (error) {
    report.hold_reason = watcherReadHold(error, 'head_unavailable');
    return report;
  }
  report.head = head;
  const finalized = finalizedThroughBlock(head);
  report.finalizedThrough = finalized;
  if (finalized === null) return report;

  //. The reorg floor bounds the SCAN. A row emitted above the safe head
  // would be refused its stamp permanently yet hold the lock forever — silently
  // demonetised for arriving during the wrong minute. So the ceiling itself moves
  // to the safe head, and blocks above it are NOT YET REACHED, not skipped.
  report.hold_reason = 'safe_head_unavailable';
  if (deps.readSafeHead === undefined) return report;
  let safeHead: { readonly number: number; readonly hash: string } | null;
  try {
    safeHead = await deps.readSafeHead();
  } catch (error) {
    report.hold_reason = watcherReadHold(error, 'safe_head_unavailable');
    return report;
  }
  if (safeHead === null
    || !Number.isSafeInteger(safeHead.number)
    || safeHead.number < 0) return report;
  report.safeHead = safeHead.number;
  report.hold_reason = null;

  const ceiling = Math.min(finalized, safeHead.number);
  report.safeHeadBoundedScan = safeHead.number < finalized;
  if (ceiling < 0) return report;

  const { readWatcherCheckpointSnapshot, commitWatcherCheckpoint } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    require('./watcher-address-admission') as typeof import('./watcher-address-admission');

  const checkpoint = await readWatcherCheckpointSnapshot(
    deps.db,
    INSTITUTION_COMPLETION_CHECKPOINT_COLLECTION,
    deps.chainId,
  );

  // A watcher with no checkpoint starts at the finality ceiling, not at genesis.
  const fromBlock = checkpoint.lastProcessedBlock === null
    ? ceiling
    : checkpoint.lastProcessedBlock + 1;
  let toBlock = ceiling;
  if (options.maxBlocksPerCycle !== undefined
    && Number.isSafeInteger(options.maxBlocksPerCycle)
    && options.maxBlocksPerCycle > 0) {
    toBlock = Math.min(toBlock, fromBlock + options.maxBlocksPerCycle - 1);
  }
  report.cursorFrom = fromBlock;
  if (fromBlock > toBlock) {
    report.status = 'caught_up';
    report.cursorTo = checkpoint.lastProcessedBlock;
    return report;
  }

  const populationBefore = await readCompletionLockPopulation(deps);

  const commitStride = blockChunk * 20;
  let expected = checkpoint;
  let segmentStart = fromBlock;
  let committedThrough: number | null = checkpoint.lastProcessedBlock;

  while (segmentStart <= toBlock) {
    const segmentEnd = Math.min(segmentStart + commitStride - 1, toBlock);
    const minFailed = await scanInstitutionCompletionRange(deps, {
      fromBlock: segmentStart,
      toBlock: segmentEnd,
      blockChunk,
      report,
      finality: { head, finalizedThrough: finalized, safeHead },
    });
    const processedThrough = minFailed === Number.MAX_SAFE_INTEGER
      ? segmentEnd
      : Math.min(segmentEnd, minFailed - 1);

    if (processedThrough >= segmentStart && processedThrough >= 0) {
      expected = await commitWatcherCheckpoint(
        deps.db,
        INSTITUTION_COMPLETION_CHECKPOINT_COLLECTION,
        deps.chainId,
        expected,
        processedThrough,
        now(),
      );
      committedThrough = processedThrough;
    }
    if (minFailed !== Number.MAX_SAFE_INTEGER) { report.hold_reason = 'scan_incomplete'; break; }
    segmentStart = segmentEnd + 1;
  }

  report.status = report.hold_reason === null ? 'completed' : 'held';
  report.cursorTo = committedThrough;
  report.cursorAdvanced = committedThrough !== null
    && committedThrough !== checkpoint.lastProcessedBlock;

  const corroboration = await corroborateCompletionLockPopulation(
    deps, report.emitted, populationBefore,
  );
  report.lockPopulationCount = corroboration.count;
  report.lockPopulationAgrees = corroboration.agrees;

  return report;
}

// =============================================================================
// PRODUCTION WIRING
// =============================================================================

/**
 * The real emission: the linked-evidence PE and its emission lock commit in ONE
 * Firestore transaction, so a canonical completion event can never produce a PE
 * without a lock (which would let a replay emit it again) nor a lock without a PE
 * (which would suppress it forever). The lock is created with `txn.create`, so a
 * concurrent worker that lost the race fails rather than overwriting.
 *
 * THE VERDICT IS NOT SET HERE. The metadata comes from
 * `buildCompletionEvidenceMetadata`, which grants or refuses the stamp itself.
 */
export function makeCompletionTransactionalEmitter(
  db: Firestore,
  chainId: number,
  generate: typeof import('../agent-bank/pe-utils').generatePE,
  deps: Parameters<typeof import('../agent-bank/pe-utils').generatePE>[0],
): InstitutionCompletionWatcherDeps['emitLinkedEvidencePE'] {
  return async (emission) => {
    const lockRef = db
      .collection(INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION)
      .doc(emission.completion.canonicalEventId);

    const ALREADY = 'institution_completion_emission_lock_exists';
    // an escrow RELEASED TO THE RECIPIENT is the on-chain witness of a job
    // completion. Resolve the canonical completion id (the relay escrow this
    // bytes32 id is pinned on, else the chain-qualified id) BEFORE the emit so
    // the accrual can claim the `completion` mint-once slot the resolver-
    // promoted off-chain confirmation of the SAME job would claim. Read-only;
    // an ambiguous escrow mapping THROWS here — no lock, no PE, the block is
    // retried — because a claim keyed on a guess could pay one job's completion
    // against another's. Refunds (`escrow_resolved` to the depositor) are not a
    // completion of anyone's work and carry no id.
    const isRecipientRelease = emission.completion.spec.institution === 'escrow'
      && (emission.completion.spec.actionType === 'escrow_completed'
        || (emission.completion.spec.actionType === 'escrow_resolved'
          && emission.completion.releaseToRecipient === true));
    const completionCanonicalId = isRecipientRelease
      ? await resolveEscrowCompletionCanonicalId(db, chainId, emission.completion.entityId)
      : null;
    try {
      const { peId } = await generate(deps, {
        walletId: emission.walletId,
        agentId: emission.agentId,
        actorAddress: emission.actorAddress,
        actionType: emission.completion.spec.actionType,
        metadata: buildCompletionEvidenceMetadata(emission, chainId),
        ...(completionCanonicalId === null ? {} : { completionCanonicalId }),
        // THE SELF-DEALING GUARD'S ONLY INPUT. `pvt-accrual.ts` runs
        // `detectSameOwnerTransfer` only when this is supplied, and these action
        // types carry the beneficial-ownership policy. The verdict REFUSES
        // without it, so a missing counterparty costs the payment, not the check.
        counterpartyAddress: emission.counterpartyAddress,
        // The DURABLE inlet — one of the three conditions proved together
        // seal `eligible`. generatePE co-commits the cutover reconciliation intake row in this same
        // transaction; the accrual VERIFIES the marker against it. LOAD-BEARING:
        // remove it and a stamped row falls back to `record_only` (the RED control).
        durableViaOrdinaryIntake: true,
        // Seals the identity as the OBSERVED log identity, never the weaker
        // tx-hash family. Both this and the metadata key must go for the row to
        // degrade (the RED control).
        observedCanonicalEventId: emission.completion.canonicalEventId,
        atomicEntityPrecondition: async (txn) => {
          const snap = await txn.get(lockRef);
          if (snap.exists) throw new Error(ALREADY);
        },
        atomicEntityWrite: (txn, newPeId) => {
          txn.create(lockRef, {
            canonical_event_id: emission.completion.canonicalEventId,
            chain_id: chainId,
            institution: emission.completion.spec.institution,
            action_type: emission.completion.spec.actionType,
            entity_id: emission.completion.entityId,
            tx_hash: emission.completion.txHash,
            log_index: emission.completion.logIndex,
            block_number: emission.completion.blockNumber,
            actor_address: emission.actorAddress,
            pe_id: newPeId,
          });
        },
      });
      // Trust Layer build §2.12 : the JOBS witness is this escrow-release join. A relay
      // job whose escrow just released on-chain gets a chain-witnessed `job_completed` outcome
      // record beside the escrow row (record_only by matrix — the escrow row mints the value).
      await emitJobsJoinRecord(db, chainId, generate, deps, emission, completionCanonicalId);
      return { emitted: true, peId };
    } catch (err) {
      if ((err as Error).message === ALREADY) return { emitted: false };
      throw err;
    }
  };
}

/**
 * Wire the watcher against the live Base RPC, Firestore, and the PE pipeline.
 * Every read is quorum-2 (`getAgreedBaseLogs` / `readAgreedBaseHead` /
 * `readAgreedBaseSafeHead` / `getVerifierProvider`), so a single compromised RPC
 * cannot manufacture a completion. THIS IS THE WIRING THE STAMP RESTS ON — the
 * verdict can only check a witness is internally consistent, never that the reader
 * was quorum-2, because the reader is injected. Test asserts this factory binds
 * the quorum-2 seam; a future hand-built deps object gets no such guarantee.
 */
/** The relay escrow (if exactly one) pinning an on-chain escrow id, with its job when it has one. */
export async function resolveRelayEscrowJob(
  db: Firestore,
  onchainEscrowId: string,
): Promise<{ escrowId: string; jobId: string | null } | null> {
  const snap = await db.collection('escrows')
    .where('onchain_escrow_id', '==', onchainEscrowId.trim().toLowerCase())
    .limit(2)
    .get();
  if (snap.docs.length !== 1) return null;
  const data = snap.docs[0].data() as { escrow_id?: unknown; job_id?: unknown } | undefined;
  const escrowId = typeof data?.escrow_id === 'string' ? data.escrow_id : snap.docs[0].id;
  const jobId = typeof data?.job_id === 'string' && data.job_id.length > 0 ? data.job_id : null;
  return { escrowId, jobId };
}

export const JOBS_JOIN_LOCK_SUFFIX = ':job_completed';

/**
 * Emit the `job_completed` record for a relay job whose escrow released on-chain (§2.12,
 * run-log the Jobs watcher IS the escrow-release join). Best-effort AFTER the escrow row
 * committed (the minting row is never held hostage to bookkeeping); locked per canonical log so a
 * replay cannot land a second record. Actor = the release's value receiver (the assigned worker),
 * counterparty = the poster (the depositor). The witness IS the chain log, so the row declares
 * `chain_witnessed` explicitly (its canonical id carries a suffix the chain-id grammar does not
 * derive from). Never mints: `job_completed` is a named record_only matrix row.
 */
export async function emitJobsJoinRecord(
  db: Firestore,
  chainId: number,
  generate: typeof import('../agent-bank/pe-utils').generatePE,
  deps: Parameters<typeof import('../agent-bank/pe-utils').generatePE>[0],
  emission: InstitutionCompletionEmission,
  completionCanonicalId: string | null,
): Promise<{ emitted: boolean; peId?: string }> {
  if (completionCanonicalId === null || !completionCanonicalId.startsWith('escrow:')) return { emitted: false };
  const ALREADY = 'institution_completion_jobs_join_lock_exists';
  try {
    const relay = await resolveRelayEscrowJob(db, emission.completion.entityId);
    if (relay === null || relay.jobId === null) return { emitted: false };
    const jobSnap = await db.collection('jobs').doc(relay.jobId).get();
    if (!jobSnap.exists) return { emitted: false };
    const job = jobSnap.data() as { assigned_wallet_id?: unknown; escrow_id?: unknown } | undefined;
    if (job?.escrow_id !== relay.escrowId || job?.assigned_wallet_id !== emission.walletId) return { emitted: false };

    const lockRef = db
      .collection(INSTITUTION_COMPLETION_EMISSION_LOCK_COLLECTION)
      .doc(`${emission.completion.canonicalEventId}${JOBS_JOIN_LOCK_SUFFIX}`);
    const verdict = evaluateCompletionVerdict(emission);
    const { peId } = await generate(deps, {
      walletId: emission.walletId,
      agentId: emission.agentId,
      actorAddress: emission.actorAddress,
      actionType: 'job_completed',
      metadata: {
        ...(verdict.verified ? { verified: true } : { evidence_verdict_refused: verdict.reason }),
        job_id: relay.jobId,
        escrow_id: relay.escrowId,
        canonical_event_id: emission.completion.canonicalEventId,
        tx_hash: emission.completion.txHash,
        log_index: emission.completion.logIndex,
        block_number: emission.completion.blockNumber,
        block_hash: emission.completion.blockHash,
        chain: 'base',
        chain_id: chainId,
        currency: emission.completion.spec.currency,
        actor_address: emission.actorAddress,
        counterparty_address: emission.counterpartyAddress ?? null,
        observed_by: 'institution_completion_watcher:jobs_join',
      },
      counterpartyAddress: emission.counterpartyAddress,
      durableViaOrdinaryIntake: true,
      witnessClass: 'chain_witnessed',
      observedCanonicalEventId: `${emission.completion.canonicalEventId}${JOBS_JOIN_LOCK_SUFFIX}`,
      atomicEntityPrecondition: async (txn) => {
        const snap = await txn.get(lockRef);
        if (snap.exists) throw new Error(ALREADY);
      },
      atomicEntityWrite: (txn, newPeId) => {
        txn.create(lockRef, {
          canonical_event_id: emission.completion.canonicalEventId,
          chain_id: chainId,
          institution: 'jobs',
          action_type: 'job_completed',
          job_id: relay.jobId,
          escrow_id: relay.escrowId,
          tx_hash: emission.completion.txHash,
          log_index: emission.completion.logIndex,
          block_number: emission.completion.blockNumber,
          actor_address: emission.actorAddress,
          pe_id: newPeId,
        });
      },
    });
    return { emitted: true, peId };
  } catch (err) {
    if ((err as Error).message !== ALREADY) {
      console.warn('[InstitutionCompletion] jobs join record failed:', (err as Error).message);
    }
    return { emitted: false };
  }
}

export function buildBaseInstitutionCompletionWatcherDeps(
  deps: Pick<InstitutionCompletionWatcherDeps, 'db'> & {
    generate: typeof import('../agent-bank/pe-utils').generatePE;
    peDeps: Parameters<typeof import('../agent-bank/pe-utils').generatePE>[0];
  },
): InstitutionCompletionWatcherDeps {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const discovery = require('../onchain/economic-discovery') as
    typeof import('../onchain/economic-discovery');
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const rpc = require('../onchain/rpc-provider') as typeof import('../onchain/rpc-provider');

  return {
    db: deps.db,
    chainId: INSTITUTION_WATCHER_CHAIN_ID,
    readHead: () => discovery.readAgreedBaseHead(),
    readSafeHead: () => discovery.readAgreedBaseSafeHead(),
    getLogs: (filter) => discovery.getAgreedBaseLogs(filter),
    callContract: async (to, data) => {
      const provider = rpc.getVerifierProvider('base');
      return provider.call({ to, data });
    },
    resolveWalletByAddress: async (address) => {
      const snap = await deps.db.collection('agent_wallets')
        .where('address', '==', address.toLowerCase())
        .limit(1)
        .get();
      if (snap.empty) return null;
      const doc = snap.docs[0];
      const data = doc.data() as { agent_id?: string; id?: string; platform?: string };
      const agentId = typeof data.agent_id === 'string' ? data.agent_id : null;
      // No agent id means nothing to anchor a PE chain to. Refuse rather than
      // invent one — an invented chain owner breaks Invariant #5.
      if (agentId === null) return null;
      // Smoke-test agents never earn. Every other economic surface excludes them,
      // and a durable row + permanent emission lock for a CI agent would, once the
      // matrix reclassification lands, be the eligible one — neither re-emittable
      // nor repriceable. Same fence the funding watcher's resolver carries.
      if (data.platform === 'test') return null;
      return { walletId: typeof data.id === 'string' ? data.id : doc.id, agentId };
    },
    emitLinkedEvidencePE: makeCompletionTransactionalEmitter(
      deps.db,
      INSTITUTION_WATCHER_CHAIN_ID,
      deps.generate,
      deps.peDeps,
    ),
  };
}
