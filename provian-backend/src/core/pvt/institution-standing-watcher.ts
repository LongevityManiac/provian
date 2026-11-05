/**
 * Institution STANDING watcher — Bonds + Court chain witness (Trust Layer build §2.12, the operator
 * 2026-09-16; run-log ).
 *
 * The third sibling of the institution funding / completion watchers, on the same pattern:
 * quorum-2 head, safe-head-bounded scan, per-canonical-log emission lock, checkpoint cursor,
 * `verified` earned from the finality witness never asserted. What it watches is different:
 * every BondPool / CourtV2 lifecycle event that names an actor — the adverse ones (a slash, an
 * abandonment burn, an autonomy downgrade, a verdict against a party, a forfeited seat, slashed
 * arbitrator collateral, a dismissed claim) and the neutral / positive ones (a bond posted,
 * renewed, topped up, withdrawn; a claim filed / expired / closed; a vote; a collateral post; a
 * reward paid). Standing (§2.5) is a live query over these rows.
 *
 * EVERY ROW IS RECORD_ONLY BY CONSTRUCTION. Each spec's `actionType` is a NAMED record_only row of
 * the signed matrix (pinned by the suite against the generated matrix), so no row here can mint —
 * class-based admission (§2.8) never sees an unnamed type from this module. That is why this
 * watcher, unlike its minting siblings, admits `platform:'test'` wallets: a record with weight 0
 * is not throwaway supply (§3), and the pre-settlement purge still removes the test rows.
 *
 * Metadata-only privacy invariant: hashes, addresses, amounts, enum codes and block coordinates
 * only — never a claim's evidence, a case's content, or any free text.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { ethers } from 'ethers';
import type { CanonicalEconomicLog } from '../onchain/economic-discovery';
import {
  INSTITUTION_WATCHER_CHAIN_ID,
  INSTITUTION_CONFIRMATION_FLOOR,
  normalizeBlockChunk,
  INSTITUTION_ADDRESSES,
  canonicalLogIdentity,
  decodeStructAddressWord,
  topicToAddress,
  finalizedThroughBlock,
  evaluateInstitutionFinalityVerdict,
  type InstitutionFinalityWitness,
  type InstitutionCycleFinality,
  type StampRefusalReason,
} from './institution-funding-watcher';

export const INSTITUTION_STANDING_CHECKPOINT_COLLECTION =
  'pvt_institution_standing_watcher_checkpoints_v1';

export const INSTITUTION_STANDING_EMISSION_LOCK_COLLECTION =
  'institution_standing_emission_locks';

/** successor institutions (contracts/deployments/base-pvt9-institutions.json), lowercased. */
export const STANDING_INSTITUTION_ADDRESSES = Object.freeze({
  bond_pool: '0x6b09e9c72316de9d62d63f09b187d4c86bbf787e',
  court: '0x9a326d1ff5ec97ce466cf6fc71ba6f5372e41d7f',
} as const);

export type StandingInstitution = keyof typeof STANDING_INSTITUTION_ADDRESSES;

/** Standing polarity of the event for the ACTOR the row is attributed to. */
export type StandingPolarity = 'adverse' | 'neutral' | 'positive';

export type InstitutionStandingActionType =
  | 'bond_posted' | 'bond_renewed' | 'bond_topped_up' | 'bond_withdrawn' | 'bond_slashed'
  | 'bond_abandoned' | 'bond_autonomy_downgraded'
  | 'bond_claim_filed' | 'bond_claim_dismissed' | 'bond_claim_expired'
  | 'bond_claim_closed_unadjudicated' | 'bond_claim_resolved'
  | 'court_vote_cast' | 'court_verdict' | 'court_escalated'
  | 'court_arbitrator_collateral_posted' | 'court_arbitrator_seat_forfeited'
  | 'court_arbitrator_collateral_slashed' | 'court_arbitrator_reward_paid';

/**
 * Who the row is attributed to, read from the event itself — never a guess.
 *  - `indexed`: the actor is an indexed address topic (optionally the counterparty too).
 *  - `claim_struct`: the actor/counterparty are the BondPool `claims(bytes32)` struct's
 *    claimant (word 0) / agent (word 1), selected by role.
 *  - `escrow_loser`: a Court verdict lands on the party it went AGAINST — the escrow struct's
 *    depositor (word 0) when the verdict released to the recipient, else the recipient (word 1).
 *  - `escrow_depositor`: an escalation is attributed to the escrow's depositor, counterparty the
 *    recipient (both parties are affected; the depositor opened the escrow).
 */
export type StandingAttribution =
  | { readonly kind: 'indexed'; readonly actorTopic: number; readonly counterpartyTopic: number | null }
  | { readonly kind: 'claim_struct'; readonly claimTopic: number; readonly actorRole: 'claimant' | 'agent' }
  | { readonly kind: 'escrow_loser'; readonly escrowTopic: number; readonly verdictWord: number }
  | { readonly kind: 'escrow_depositor'; readonly escrowTopic: number };

export type StandingDataKind = 'uint' | 'bool' | 'u8';

export interface StandingDataField {
  readonly name: string;
  readonly kind: StandingDataKind;
}

export interface InstitutionStandingEventSpec {
  readonly institution: StandingInstitution;
  readonly address: string;
  readonly signature: string;
  readonly event: string;
  readonly topic0: string;
  readonly actionType: InstitutionStandingActionType;
  readonly polarity: StandingPolarity;
  readonly attribution: StandingAttribution;
  /** The NON-indexed ABI words in order, named for the metadata. */
  readonly data: readonly StandingDataField[];
  /** Which topic (if any) carries the bytes32 entity id (claimId / escrowId / caseKey). */
  readonly entityTopic: number | null;
}

function spec(
  institution: StandingInstitution,
  signature: string,
  actionType: InstitutionStandingActionType,
  polarity: StandingPolarity,
  attribution: StandingAttribution,
  data: readonly StandingDataField[],
  entityTopic: number | null,
): InstitutionStandingEventSpec {
  return Object.freeze({
    institution,
    address: STANDING_INSTITUTION_ADDRESSES[institution],
    signature,
    event: signature.slice(0, signature.indexOf('(')),
    topic0: ethers.id(signature),
    actionType,
    polarity,
    attribution,
    data,
    entityTopic,
  });
}

const u = (name: string): StandingDataField => ({ name, kind: 'uint' });
const u8 = (name: string): StandingDataField => ({ name, kind: 'u8' });
const b = (name: string): StandingDataField => ({ name, kind: 'bool' });

const CLAIM_CLAIMANT: StandingAttribution = Object.freeze({ kind: 'claim_struct', claimTopic: 1, actorRole: 'claimant' });
const CLAIM_AGENT: StandingAttribution = Object.freeze({ kind: 'claim_struct', claimTopic: 1, actorRole: 'agent' });

/** The registry — bound to the deployed contracts' event signatures (pinned by the suite). */
export const INSTITUTION_STANDING_EVENTS: readonly InstitutionStandingEventSpec[] = Object.freeze([
  // ---- ProvianBondPool --------------------------------------------------------------------
  spec('bond_pool', 'BondPosted(address,uint256,uint256,uint8)', 'bond_posted', 'positive',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: null },
    [u('total_deposit_atomic'), u('locked_amount_atomic'), u8('autonomy_level')], null),
  spec('bond_pool', 'BondRenewed(address,uint256)', 'bond_renewed', 'positive',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: null },
    [u('new_deadline')], null),
  spec('bond_pool', 'BondToppedUp(address,uint256,uint256)', 'bond_topped_up', 'positive',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: null },
    [u('amount_atomic'), u('new_bond_amount_atomic')], null),
  spec('bond_pool', 'BondSlashed(address,bytes32,address,uint256,uint256)', 'bond_slashed', 'adverse',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: 3 },
    [u('claimant_amount_atomic'), u('burned_amount_atomic')], 2),
  spec('bond_pool', 'BondWithdrawn(address,uint256)', 'bond_withdrawn', 'neutral',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: null },
    [u('returned_amount_atomic')], null),
  spec('bond_pool', 'ClaimFiled(bytes32,address,address)', 'bond_claim_filed', 'neutral',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: 3 },
    [], 1),
  // A dismissed claim is adverse to the CLAIMANT (a meritless claim; the filing fee is burned).
  spec('bond_pool', 'ClaimDismissed(bytes32,address)', 'bond_claim_dismissed', 'adverse',
    CLAIM_CLAIMANT, [], 1),
  spec('bond_pool', 'ClaimExpired(bytes32,address)', 'bond_claim_expired', 'neutral',
    CLAIM_CLAIMANT, [], 1),
  spec('bond_pool', 'ClaimClosedUnadjudicated(bytes32,address,address,uint256)', 'bond_claim_closed_unadjudicated', 'neutral',
    { kind: 'indexed', actorTopic: 3, counterpartyTopic: 2 },
    [u('refunded_fee_atomic')], 1),
  spec('bond_pool', 'BondAbandoned(address,uint256)', 'bond_abandoned', 'adverse',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: null },
    [u('burned_amount_atomic')], null),
  spec('bond_pool', 'AutonomyDowngrade(address,uint256,uint256)', 'bond_autonomy_downgraded', 'adverse',
    { kind: 'indexed', actorTopic: 1, counterpartyTopic: null },
    [u('remaining_bond_atomic'), u('required_bond_atomic')], null),
  // ---- ProvianCourtV2 ---------------------------------------------------------------------
  spec('court', 'VoteCast(bytes32,address,bool)', 'court_vote_cast', 'positive',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: null },
    [b('release_to_recipient')], 1),
  spec('court', 'Verdict(bytes32,bool,uint8,uint8)', 'court_verdict', 'adverse',
    { kind: 'escrow_loser', escrowTopic: 1, verdictWord: 0 },
    [b('release_to_recipient'), u8('votes_for_release'), u8('votes_for_refund')], 1),
  spec('court', 'Escalated(bytes32)', 'court_escalated', 'neutral',
    { kind: 'escrow_depositor', escrowTopic: 1 }, [], 1),
  spec('court', 'BondVoteCast(bytes32,address,uint8)', 'court_vote_cast', 'positive',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: null },
    [u8('bond_verdict_vote')], 1),
  // The adjudication record on the AGENT; the money-moving BondSlashed / ClaimDismissed rows
  // above are the Standing events. verdict: 1 Dismiss, 2 SlashPartial, 3 SlashFull.
  spec('court', 'BondClaimResolved(bytes32,address,uint8,uint256)', 'bond_claim_resolved', 'neutral',
    CLAIM_AGENT, [u8('bond_verdict'), u('slash_amount_atomic')], 1),
  spec('court', 'ArbitratorCollateralPosted(bytes32,address,uint8,uint256)', 'court_arbitrator_collateral_posted', 'positive',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: null },
    [u8('seat'), u('amount_atomic')], 1),
  spec('court', 'ArbitratorSeatForfeited(bytes32,address,uint8,uint8)', 'court_arbitrator_seat_forfeited', 'adverse',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: null },
    [u8('seat'), u8('round')], 1),
  spec('court', 'ArbitratorCollateralSlashed(bytes32,address,uint8,uint256)', 'court_arbitrator_collateral_slashed', 'adverse',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: null },
    [u8('seat'), u('amount_atomic')], 1),
  spec('court', 'ArbitratorRewardPaid(bytes32,address,uint8,uint256)', 'court_arbitrator_reward_paid', 'positive',
    { kind: 'indexed', actorTopic: 2, counterpartyTopic: null },
    [u8('seat'), u('amount_atomic')], 1),
]);

export const INSTITUTION_STANDING_ACTION_TYPES: readonly InstitutionStandingActionType[] =
  Object.freeze(Array.from(new Set(INSTITUTION_STANDING_EVENTS.map((s) => s.actionType))));

/** The action types Standing counts AGAINST an actor (the adverse polarity), for §2.5. */
export const STANDING_ADVERSE_ACTION_TYPES: ReadonlySet<string> = new Set(
  INSTITUTION_STANDING_EVENTS.filter((s) => s.polarity === 'adverse').map((s) => s.actionType),
);

// =============================================================================
// Decoding
// =============================================================================

export type StandingDataValue = string | number | boolean;

export interface DecodedInstitutionStanding {
  readonly spec: InstitutionStandingEventSpec;
  readonly canonicalEventId: string;
  readonly entityId: string | null;
  readonly topics: readonly string[];
  readonly dataWords: readonly bigint[];
  /** The named, metadata-ready data fields (amounts as decimal strings). */
  readonly fields: Readonly<Record<string, StandingDataValue>>;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  /**
   * set on an `AutonomyDowngrade` whose transaction also carries a `BondSlashed` for the same
   * agent — the downgrade is that slash's own consequence. Sealed as `paired_bond_slash`, and
   * Standing counts the pair as ONE adverse event (the slash).
   */
  readonly pairedBondSlash?: boolean;
}

const BYTES32_RE = /^0x[0-9a-f]{64}$/;

function decodeWord(word: bigint, kind: StandingDataKind): StandingDataValue | null {
  switch (kind) {
    case 'uint': return word.toString();
    case 'bool': return word === 0n ? false : word === 1n ? true : null;
    case 'u8': return word <= 255n ? Number(word) : null;
  }
}

export function decodeInstitutionStandingLog(
  log: CanonicalEconomicLog,
  chainId: number = INSTITUTION_WATCHER_CHAIN_ID,
): DecodedInstitutionStanding | null {
  if (log.removed) return null;
  const topic0 = log.topics[0];
  if (typeof topic0 !== 'string') return null;
  const matched = INSTITUTION_STANDING_EVENTS.find(
    (s) => s.topic0 === topic0 && s.address === log.address.toLowerCase(),
  );
  if (!matched) return null;

  const topics = log.topics.map((t) => (typeof t === 'string' ? t.toLowerCase() : ''));
  let entityId: string | null = null;
  if (matched.entityTopic !== null) {
    const t = topics[matched.entityTopic];
    if (typeof t !== 'string' || !BYTES32_RE.test(t)) return null;
    entityId = t;
  }

  const data = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (data.length < matched.data.length * 64) return null;
  const dataWords: bigint[] = [];
  const fields: Record<string, StandingDataValue> = {};
  for (let i = 0; i < matched.data.length; i += 1) {
    let word: bigint;
    try {
      word = BigInt(`0x${data.slice(i * 64, i * 64 + 64)}`);
    } catch {
      return null;
    }
    const value = decodeWord(word, matched.data[i].kind);
    if (value === null) return null;
    dataWords.push(word);
    fields[matched.data[i].name] = value;
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
    topics,
    dataWords,
    fields,
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(),
  };
}

// =============================================================================
// Attribution — the party the event names, never a guess
// =============================================================================

export interface StandingParties {
  readonly actorAddress: string;
  readonly counterpartyAddress: string | null;
}

export interface InstitutionStandingWatcherReport {
  logsRead: number;
  eventsDecoded: number;
  emitted: number;
  duplicatesSkipped: number;
  unattributed: number;
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
  emittedByType: Record<string, number>;
  emittedByPolarity: Record<StandingPolarity, number>;
}

export function emptyInstitutionStandingWatcherReport(): InstitutionStandingWatcherReport {
  return {
    logsRead: 0,
    eventsDecoded: 0,
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
    emittedByPolarity: { adverse: 0, neutral: 0, positive: 0 },
  };
}

export interface InstitutionStandingWatcherDeps {
  readonly db: Firestore;
  readonly chainId: number;
  readonly readHead: () => Promise<number>;
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
  readonly emitStandingPE: (
    emission: InstitutionStandingEmission,
  ) => Promise<{ emitted: boolean; peId?: string }>;
  readonly now?: () => number;
}

async function callStruct(
  deps: InstitutionStandingWatcherDeps,
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

const ZERO = ethers.ZeroAddress.toLowerCase();

function nonZero(address: string | null): string | null {
  return address === null || address === ZERO ? null : address;
}

export async function resolveStandingParties(
  deps: InstitutionStandingWatcherDeps,
  decoded: DecodedInstitutionStanding,
  report: InstitutionStandingWatcherReport,
): Promise<StandingParties | null> {
  const attr = decoded.spec.attribution;

  if (attr.kind === 'indexed') {
    const actorTopic = decoded.topics[attr.actorTopic];
    const actorAddress = typeof actorTopic === 'string' ? nonZero(topicToAddress(actorTopic)) : null;
    if (actorAddress === null) {
      report.attributionFailures += 1;
      return null;
    }
    if (attr.counterpartyTopic === null) return { actorAddress, counterpartyAddress: null };
    const cpTopic = decoded.topics[attr.counterpartyTopic];
    const counterpartyAddress = typeof cpTopic === 'string' ? nonZero(topicToAddress(cpTopic)) : null;
    if (counterpartyAddress === null) report.counterpartyReadFailures += 1;
    return { actorAddress, counterpartyAddress };
  }

  if (attr.kind === 'claim_struct') {
    const claimId = decoded.topics[attr.claimTopic];
    if (typeof claimId !== 'string' || !BYTES32_RE.test(claimId)) {
      report.attributionFailures += 1;
      return null;
    }
    const raw = await callStruct(deps, STANDING_INSTITUTION_ADDRESSES.bond_pool, 'claims(bytes32)', claimId);
    if (raw === null) {
      report.attributionFailures += 1;
      return null;
    }
    const claimant = nonZero(decodeStructAddressWord(raw, 0));
    const agent = nonZero(decodeStructAddressWord(raw, 1));
    const actorAddress = attr.actorRole === 'claimant' ? claimant : agent;
    const counterpartyAddress = attr.actorRole === 'claimant' ? agent : claimant;
    if (actorAddress === null) {
      report.attributionFailures += 1;
      return null;
    }
    if (counterpartyAddress === null) report.counterpartyReadFailures += 1;
    return { actorAddress, counterpartyAddress };
  }

  // escrow_loser / escrow_depositor — the CourtV2 escrowId IS the EscrowV4 escrow id.
  const escrowId = decoded.topics[attr.escrowTopic];
  if (typeof escrowId !== 'string' || !BYTES32_RE.test(escrowId)) {
    report.attributionFailures += 1;
    return null;
  }
  const raw = await callStruct(deps, INSTITUTION_ADDRESSES.escrow, 'escrows(bytes32)', escrowId);
  if (raw === null) {
    report.attributionFailures += 1;
    return null;
  }
  const depositor = nonZero(decodeStructAddressWord(raw, 0));
  const recipient = nonZero(decodeStructAddressWord(raw, 1));
  let actorAddress: string | null;
  let counterpartyAddress: string | null;
  if (attr.kind === 'escrow_loser') {
    const releaseToRecipient = decoded.dataWords[attr.verdictWord];
    if (releaseToRecipient !== 0n && releaseToRecipient !== 1n) {
      report.attributionFailures += 1;
      return null;
    }
    // The verdict went AGAINST the depositor when the funds released to the recipient.
    actorAddress = releaseToRecipient === 1n ? depositor : recipient;
    counterpartyAddress = releaseToRecipient === 1n ? recipient : depositor;
  } else {
    actorAddress = depositor;
    counterpartyAddress = recipient;
  }
  if (actorAddress === null) {
    report.attributionFailures += 1;
    return null;
  }
  if (counterpartyAddress === null) report.counterpartyReadFailures += 1;
  return { actorAddress, counterpartyAddress };
}

// =============================================================================
// The verdict — earned from the finality witness, never asserted
// =============================================================================

export interface InstitutionStandingEmission {
  readonly decoded: DecodedInstitutionStanding;
  readonly actorAddress: string;
  readonly walletId: string;
  readonly agentId: string;
  readonly counterpartyAddress?: string;
  readonly finalityWitness?: InstitutionFinalityWitness;
}

/**
 * The funding/completion verdict refuses a row with no counterparty because THOSE rows mint and
 * the same-owner fence needs the second party. A Standing row is record_only by construction
 * (every action type here is a named record_only matrix row — pinned), so the stamp attests the
 * chain finality checks alone; a counterparty-less event (an abandonment burn, a seat forfeit)
 * passes this sentinel in place of the fence input. Every finality refusal is unchanged.
 */
export const STANDING_NO_COUNTERPARTY_SENTINEL = 'standing:no_counterparty';

export function evaluateStandingVerdict(
  emission: InstitutionStandingEmission,
): { verified: true } | { verified: false; reason: StampRefusalReason } {
  return evaluateInstitutionFinalityVerdict({
    blockNumber: emission.decoded.blockNumber,
    counterpartyAddress: emission.counterpartyAddress ?? STANDING_NO_COUNTERPARTY_SENTINEL,
    finalityWitness: emission.finalityWitness,
  });
}

export function buildStandingEvidenceMetadata(
  emission: InstitutionStandingEmission,
  chainId: number,
): Record<string, unknown> {
  const { decoded } = emission;
  const verdict = evaluateStandingVerdict(emission);
  return {
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
    canonical_event_id: decoded.canonicalEventId,
    tx_hash: decoded.txHash,
    log_index: decoded.logIndex,
    block_number: decoded.blockNumber,
    block_hash: decoded.blockHash,
    chain: 'base',
    chain_id: chainId,
    institution: decoded.spec.institution,
    event: decoded.spec.event,
    standing: decoded.spec.polarity,
    ...(decoded.pairedBondSlash === true ? { paired_bond_slash: true } : {}),
    entity_id: decoded.entityId,
    ...decoded.fields,
    actor_address: emission.actorAddress,
    counterparty_address: emission.counterpartyAddress ?? null,
    finality_confirmations: INSTITUTION_CONFIRMATION_FLOOR,
    observed_by: 'institution_standing_watcher',
  };
}

// =============================================================================
// Processing
// =============================================================================

export async function processDecodedStanding(
  deps: InstitutionStandingWatcherDeps,
  decoded: DecodedInstitutionStanding,
  report: InstitutionStandingWatcherReport,
  finality?: InstitutionCycleFinality,
): Promise<void> {
  const parties = await resolveStandingParties(deps, decoded, report);
  if (parties === null) return;

  const wallet = await deps.resolveWalletByAddress(parties.actorAddress);
  if (wallet === null) {
    report.unattributed += 1;
    return;
  }

  const emission: InstitutionStandingEmission = {
    decoded,
    actorAddress: parties.actorAddress,
    walletId: wallet.walletId,
    agentId: wallet.agentId,
    ...(parties.counterpartyAddress === null
      ? {}
      : { counterpartyAddress: parties.counterpartyAddress }),
    ...(finality === undefined ? {} : {
      finalityWitness: {
        head: finality.head,
        finalizedThrough: finality.finalizedThrough,
        observedBlock: decoded.blockNumber,
        ...(finality.safeHead === undefined ? {} : { safeHead: finality.safeHead }),
      },
    }),
  };

  if (!evaluateStandingVerdict(emission).verified) report.stampRefusals += 1;

  try {
    const result = await deps.emitStandingPE(emission);
    if (result.emitted) {
      report.emitted += 1;
      const t = decoded.spec.actionType;
      report.emittedByType[t] = (report.emittedByType[t] ?? 0) + 1;
      report.emittedByPolarity[decoded.spec.polarity] += 1;
    } else report.duplicatesSkipped += 1;
  } catch {
    report.emissionFailures += 1;
  }
}

/**
 * mark every `AutonomyDowngrade` that shares its transaction AND its agent with a
 * `BondSlashed`. One getLogs chunk is a whole block range, so a transaction's logs are never split
 * across chunks — the pair is always decided together.
 */
export function markPairedBondSlashes<T extends { decoded: DecodedInstitutionStanding | null }>(rows: readonly T[]): T[] {
  const key = (d: DecodedInstitutionStanding) => `${d.txHash}:${d.topics[1] ?? ''}`;
  const slashed = new Set<string>();
  for (const { decoded } of rows) {
    if (decoded !== null && decoded.spec.actionType === 'bond_slashed') slashed.add(key(decoded));
  }
  return rows.map((row) => (
    row.decoded !== null && row.decoded.spec.actionType === 'bond_autonomy_downgraded' && slashed.has(key(row.decoded))
      ? { ...row, decoded: { ...row.decoded, pairedBondSlash: true } }
      : row
  ));
}

export function institutionStandingLogFilters(): {
  readonly addresses: readonly string[];
  readonly topic0s: readonly string[];
} {
  const addresses = Array.from(new Set(INSTITUTION_STANDING_EVENTS.map((s) => s.address)));
  const topic0s = Array.from(new Set(INSTITUTION_STANDING_EVENTS.map((s) => s.topic0)));
  return Object.freeze({ addresses: Object.freeze(addresses), topic0s: Object.freeze(topic0s) });
}

export async function scanInstitutionStandingRange(
  deps: InstitutionStandingWatcherDeps,
  args: {
    readonly fromBlock: number;
    readonly toBlock: number;
    readonly blockChunk: number;
    readonly report: InstitutionStandingWatcherReport;
    readonly finality?: InstitutionCycleFinality;
  },
): Promise<number> {
  const { report } = args;
  let minFailedBlock = Number.MAX_SAFE_INTEGER;
  const { addresses, topic0s } = institutionStandingLogFilters();

  for (let start = args.fromBlock; start <= args.toBlock; start += args.blockChunk) {
    const end = Math.min(start + args.blockChunk - 1, args.toBlock);
    let logs: readonly CanonicalEconomicLog[];
    try {
      logs = await deps.getLogs({ address: addresses, topics: [topic0s], fromBlock: start, toBlock: end });
    } catch {
      minFailedBlock = Math.min(minFailedBlock, start);
      continue;
    }
    report.logsRead += logs.length;

    const decodedLogs = markPairedBondSlashes(
      logs.map((log) => ({ log, decoded: decodeInstitutionStandingLog(log, deps.chainId) })),
    );
    for (const { log, decoded } of decodedLogs) {
      if (decoded === null) continue;
      report.eventsDecoded += 1;
      const before = report.emissionFailures + report.attributionFailures;
      await processDecodedStanding(deps, decoded, report, args.finality);
      const after = report.emissionFailures + report.attributionFailures;
      if (after > before) minFailedBlock = Math.min(minFailedBlock, log.blockNumber);
    }
  }
  return minFailedBlock;
}

export async function corroborateStandingLockPopulation(
  deps: InstitutionStandingWatcherDeps,
  expectedDelta: number,
  populationBefore: number | null,
): Promise<{ count: number | null; agrees: boolean | null }> {
  let after: number | null = null;
  try {
    const coll = deps.db.collection(INSTITUTION_STANDING_EMISSION_LOCK_COLLECTION);
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

// =============================================================================
// The cycle (checkpointed, safe-head bounded — the completion watcher's shape)
// =============================================================================

export async function runInstitutionStandingWatcherCycle(
  deps: InstitutionStandingWatcherDeps,
  options: { readonly blockChunk?: number; readonly maxBlocksPerCycle?: number } = {},
): Promise<InstitutionStandingWatcherReport> {
  const report = emptyInstitutionStandingWatcherReport();
  const now = deps.now ?? (() => Date.now());
  const blockChunk = normalizeBlockChunk(options.blockChunk);

  const head = await deps.readHead();
  report.head = head;
  const finalized = finalizedThroughBlock(head);
  report.finalizedThrough = finalized;
  if (finalized === null) return report;

  if (deps.readSafeHead === undefined) return report;
  let safeHead: { readonly number: number; readonly hash: string } | null;
  try {
    safeHead = await deps.readSafeHead();
  } catch {
    return report;
  }
  if (safeHead === null || !Number.isSafeInteger(safeHead.number) || safeHead.number < 0) return report;
  report.safeHead = safeHead.number;

  const ceiling = Math.min(finalized, safeHead.number);
  report.safeHeadBoundedScan = safeHead.number < finalized;
  if (ceiling < 0) return report;

  const { readWatcherCheckpointSnapshot, commitWatcherCheckpoint } =
    require('./watcher-address-admission') as typeof import('./watcher-address-admission');

  const checkpoint = await readWatcherCheckpointSnapshot(
    deps.db, INSTITUTION_STANDING_CHECKPOINT_COLLECTION, deps.chainId,
  );

  const fromBlock = checkpoint.lastProcessedBlock === null ? ceiling : checkpoint.lastProcessedBlock + 1;
  let toBlock = ceiling;
  if (options.maxBlocksPerCycle !== undefined
    && Number.isSafeInteger(options.maxBlocksPerCycle)
    && options.maxBlocksPerCycle > 0) {
    toBlock = Math.min(toBlock, fromBlock + options.maxBlocksPerCycle - 1);
  }
  report.cursorFrom = fromBlock;
  if (fromBlock > toBlock) {
    report.cursorTo = checkpoint.lastProcessedBlock;
    return report;
  }

  const populationBefore = (await corroborateStandingLockPopulation(deps, 0, null)).count;

  const commitStride = blockChunk * 20;
  let expected = checkpoint;
  let segmentStart = fromBlock;
  let committedThrough: number | null = checkpoint.lastProcessedBlock;

  while (segmentStart <= toBlock) {
    const segmentEnd = Math.min(segmentStart + commitStride - 1, toBlock);
    const minFailed = await scanInstitutionStandingRange(deps, {
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
        deps.db, INSTITUTION_STANDING_CHECKPOINT_COLLECTION, deps.chainId, expected, processedThrough, now(),
      );
      committedThrough = processedThrough;
    }
    if (minFailed !== Number.MAX_SAFE_INTEGER) break;
    segmentStart = segmentEnd + 1;
  }

  report.cursorTo = committedThrough;
  report.cursorAdvanced = committedThrough !== null && committedThrough !== checkpoint.lastProcessedBlock;

  const corroboration = await corroborateStandingLockPopulation(deps, report.emitted, populationBefore);
  report.lockPopulationCount = corroboration.count;
  report.lockPopulationAgrees = corroboration.agrees;
  return report;
}

// =============================================================================
// Emitter — one PE per canonical log, locked; the verdict rides the metadata
// =============================================================================

export function makeStandingTransactionalEmitter(
  db: Firestore,
  chainId: number,
  generate: typeof import('../agent-bank/pe-utils').generatePE,
  deps: Parameters<typeof import('../agent-bank/pe-utils').generatePE>[0],
): InstitutionStandingWatcherDeps['emitStandingPE'] {
  return async (emission) => {
    const lockRef = db
      .collection(INSTITUTION_STANDING_EMISSION_LOCK_COLLECTION)
      .doc(emission.decoded.canonicalEventId);
    const ALREADY = 'institution_standing_emission_lock_exists';
    try {
      const { peId } = await generate(deps, {
        walletId: emission.walletId,
        agentId: emission.agentId,
        actorAddress: emission.actorAddress,
        actionType: emission.decoded.spec.actionType,
        metadata: buildStandingEvidenceMetadata(emission, chainId),
        counterpartyAddress: emission.counterpartyAddress ?? null,
        durableViaOrdinaryIntake: true,
        observedCanonicalEventId: emission.decoded.canonicalEventId,
        atomicEntityPrecondition: async (txn) => {
          const snap = await txn.get(lockRef);
          if (snap.exists) throw new Error(ALREADY);
        },
        atomicEntityWrite: (txn, newPeId) => {
          txn.create(lockRef, {
            canonical_event_id: emission.decoded.canonicalEventId,
            chain_id: chainId,
            institution: emission.decoded.spec.institution,
            event: emission.decoded.spec.event,
            action_type: emission.decoded.spec.actionType,
            standing: emission.decoded.spec.polarity,
            entity_id: emission.decoded.entityId,
            tx_hash: emission.decoded.txHash,
            log_index: emission.decoded.logIndex,
            block_number: emission.decoded.blockNumber,
            actor_address: emission.actorAddress,
            pe_id: newPeId,
          });
        },
      });
      return { emitted: true, peId };
    } catch (err) {
      if ((err as Error).message === ALREADY) return { emitted: false };
      throw err;
    }
  };
}

export function buildBaseInstitutionStandingWatcherDeps(
  deps: Pick<InstitutionStandingWatcherDeps, 'db'> & {
    generate: typeof import('../agent-bank/pe-utils').generatePE;
    peDeps: Parameters<typeof import('../agent-bank/pe-utils').generatePE>[0];
  },
): InstitutionStandingWatcherDeps {
  const discovery = require('../onchain/economic-discovery') as typeof import('../onchain/economic-discovery');
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
    // Unlike the minting siblings this does NOT exclude `platform:'test'` wallets: every row is
    // record_only by construction (see the module header), so a test identity's Standing row is
    // a record, not supply — and the pre-settlement purge still removes it.
    resolveWalletByAddress: async (address) => {
      const snap = await deps.db.collection('agent_wallets')
        .where('address', '==', address.toLowerCase())
        .limit(1)
        .get();
      if (snap.empty) return null;
      const doc = snap.docs[0];
      const data = doc.data() as { agent_id?: string; id?: string };
      const agentId = typeof data.agent_id === 'string' ? data.agent_id : null;
      if (agentId === null) return null;
      return { walletId: typeof data.id === 'string' ? data.id : doc.id, agentId };
    },
    emitStandingPE: makeStandingTransactionalEmitter(deps.db, INSTITUTION_WATCHER_CHAIN_ID, deps.generate, deps.peDeps),
  };
}
