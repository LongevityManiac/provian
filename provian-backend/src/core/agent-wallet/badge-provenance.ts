import crypto from 'crypto';
import stableStringify from 'json-stable-stringify';
import { FieldPath, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { generatePE } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import type { BadgeId, EarnedBadge } from './types';
import {
  identityPeRefs,
  readIdentityPe,
  validateIdentityPeSnapshots,
} from './canonical-agent-pe-chain';
import {
  AgentAddressLineageError,
  agentWalletRotationCount,
  readAgentAddressLineagePes,
  readAgentRotationHistoryRaw,
  resolveAgentAddressLineage,
  type AgentAddressLineage,
} from './agent-address-lineage';
import {
  NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION,
  nativeAgentRegistrationIndexId,
} from '../pvt/native-wallet-registration';

export const AGENT_BADGE_AWARD_OUTBOX_COLLECTION =
  'agent_badge_award_outbox_v1' as const;

export const ALL_BADGE_IDS: readonly BadgeId[] = [
  'genesis_agent',
  'chain_builder',
  'architect',
  'constellation',
  'governed',
  'linked',
  'x402_pioneer',
  'signal',
  'seven_day_streak',
  'thirty_day_streak',
  'pvt_minter',
  'governance_participant',
  'insured_agent',
] as const;

const BADGE_ID_SET = new Set<string>(ALL_BADGE_IDS);
const ADDRESS = /^0x[0-9a-f]{40}$/;
const PE_ID = /^pe_[A-Za-z0-9_-]{1,240}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type BadgeQualificationTrigger =
  | 'registration'
  | 'link_human'
  | 'governance'
  | 'agent_bank_event';

export interface AgentBadgeAwardOutboxDocument {
  schema_version: 'agent-badge-award-outbox/v1';
  outbox_id: string;
  wallet_id: string;
  agent_id: string;
  actor_address: string;
  badge_id: BadgeId;
  trigger: BadgeQualificationTrigger;
  earned_at_ms: number;
  source_pe_id: string;
  source_pe_hash: string;
  state: 'pending' | 'complete';
  badge_pe_id: string | null;
  badge_pe_hash: string | null;
  created_at_ms: number;
  completed_at_ms: number | null;
}

interface SnapshotLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export class BadgeProvenanceIntegrityError extends Error {
  constructor(readonly reason: string) {
    super(`badge_provenance_integrity:${reason}`);
    this.name = 'BadgeProvenanceIntegrityError';
  }
}

function fail(reason: string): never {
  throw new BadgeProvenanceIntegrityError(reason);
}

function exactKeys(raw: Record<string, unknown>, expected: readonly string[], reason: string): void {
  const actual = Object.keys(raw).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length
    || actual.some((key, index) => key !== sortedExpected[index])) {
    fail(reason);
  }
}

export function badgeAwardOutboxDocumentId(walletId: string, badgeId: BadgeId): string {
  return crypto.createHash('sha256')
    .update(`agent-badge-award-outbox/v1\n${walletId}\n${badgeId}`, 'utf8')
    .digest('hex');
}

export function badgeAwardOutboxRef(
  db: Firestore,
  walletId: string,
  badgeId: BadgeId,
): DocumentReference {
  return db.collection(AGENT_BADGE_AWARD_OUTBOX_COLLECTION)
    .doc(badgeAwardOutboxDocumentId(walletId, badgeId));
}

export function badgeEarnedPeId(walletId: string, badgeId: BadgeId): string {
  return `pe_badge_${crypto.createHash('sha256')
    .update(`agent-badge-earned/v1\n${walletId}\n${badgeId}`, 'utf8')
    .digest('hex')}`;
}

export function createPendingBadgeAward(params: {
  walletId: string;
  agentId: string;
  actorAddress: string;
  badgeId: BadgeId;
  trigger: BadgeQualificationTrigger;
  earnedAtMs: number;
  sourcePeId: string;
  sourcePeHash: string;
}): AgentBadgeAwardOutboxDocument {
  return {
    schema_version: 'agent-badge-award-outbox/v1',
    outbox_id: badgeAwardOutboxDocumentId(params.walletId, params.badgeId),
    wallet_id: params.walletId,
    agent_id: params.agentId,
    actor_address: params.actorAddress.toLowerCase(),
    badge_id: params.badgeId,
    trigger: params.trigger,
    earned_at_ms: params.earnedAtMs,
    source_pe_id: params.sourcePeId,
    source_pe_hash: params.sourcePeHash,
    state: 'pending',
    badge_pe_id: null,
    badge_pe_hash: null,
    created_at_ms: params.earnedAtMs,
    completed_at_ms: null,
  };
}

export function parseBadgeAwardOutbox(snapshot: SnapshotLike): AgentBadgeAwardOutboxDocument {
  if (!snapshot.exists) fail('outbox_missing');
  const raw = snapshot.data();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('outbox_shape');
  exactKeys(raw, [
    'schema_version', 'outbox_id', 'wallet_id', 'agent_id', 'actor_address',
    'badge_id', 'trigger', 'earned_at_ms', 'source_pe_id', 'source_pe_hash',
    'state', 'badge_pe_id', 'badge_pe_hash', 'created_at_ms', 'completed_at_ms',
  ], 'outbox_keys');
  if (raw.schema_version !== 'agent-badge-award-outbox/v1'
    || typeof raw.outbox_id !== 'string' || !SHA256.test(raw.outbox_id)
    || typeof raw.wallet_id !== 'string' || raw.wallet_id.length === 0
    || typeof raw.agent_id !== 'string' || raw.agent_id.length === 0
    || typeof raw.actor_address !== 'string' || !ADDRESS.test(raw.actor_address)
    || typeof raw.badge_id !== 'string' || !BADGE_ID_SET.has(raw.badge_id)
    || (raw.trigger !== 'registration'
      && raw.trigger !== 'link_human'
      && raw.trigger !== 'governance'
      && raw.trigger !== 'agent_bank_event')
    || !Number.isSafeInteger(raw.earned_at_ms) || (raw.earned_at_ms as number) < 0
    || typeof raw.source_pe_id !== 'string' || !PE_ID.test(raw.source_pe_id)
    || typeof raw.source_pe_hash !== 'string' || !SHA256.test(raw.source_pe_hash)
    || (raw.state !== 'pending' && raw.state !== 'complete')
    || !Number.isSafeInteger(raw.created_at_ms) || raw.created_at_ms !== raw.earned_at_ms
    || raw.outbox_id !== badgeAwardOutboxDocumentId(
      raw.wallet_id as string,
      raw.badge_id as BadgeId,
    )) {
    fail('outbox_fields');
  }
  if (raw.state === 'pending') {
    if (raw.badge_pe_id !== null
      || raw.badge_pe_hash !== null
      || raw.completed_at_ms !== null) {
      fail('pending_fields');
    }
  } else if (raw.badge_pe_id !== badgeEarnedPeId(
    raw.wallet_id as string,
    raw.badge_id as BadgeId,
  )
    || typeof raw.badge_pe_hash !== 'string' || !SHA256.test(raw.badge_pe_hash)
    || !Number.isSafeInteger(raw.completed_at_ms)
    || (raw.completed_at_ms as number) < (raw.earned_at_ms as number)) {
    fail('complete_fields');
  }
  return raw as unknown as AgentBadgeAwardOutboxDocument;
}

export function validateBadgeQualificationSource(
  outbox: AgentBadgeAwardOutboxDocument,
  sourcePe: Record<string, unknown>,
): void {
  // Event-derived badges are armed by the canonical PE that is committed in
  // the same transaction as the verified primary entity. All other badge
  // paths retain their explicit policy-qualification PE. This distinction is
  // load-bearing: a process crash after the primary commit must leave a
  // durable award outbox, not require a best-effort listener to rediscover the
  // event later.
  const directEventSource = outbox.badge_id === 'insured_agent'
    ? 'bond_posted'
    : outbox.badge_id === 'governance_participant'
      ? 'governance_vote_cast'
      : null;
  const expectedAction = directEventSource
    ?? (outbox.trigger === 'registration'
      ? 'agent_wallet_created'
      : outbox.trigger === 'link_human'
        ? 'agent_linked_to_human'
        : 'policy_updated');
  const metadata = sourcePe.metadata;
  const metadataRecord = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  const qualified = directEventSource
    ? [outbox.badge_id]
    : metadataRecord?.[
      outbox.trigger === 'registration' ? 'badges' : 'qualified_badges'
    ];
  const directSourceBound = outbox.badge_id === 'insured_agent'
    ? typeof metadataRecord?.bond_id === 'string'
      && typeof metadataRecord.tx_hash === 'string'
    : outbox.badge_id === 'governance_participant'
      ? Number.isSafeInteger(metadataRecord?.proposal_id)
        && typeof metadataRecord?.tx_hash === 'string'
        && metadataRecord.governance_layer === 'operational'
      : true;
  if (sourcePe.id !== outbox.source_pe_id
    || sourcePe.wallet_id !== outbox.wallet_id
    || sourcePe.agent_id !== outbox.agent_id
    || sourcePe.user_id !== outbox.agent_id
    || sourcePe.actor_address !== outbox.actor_address
    || sourcePe.action_type !== expectedAction
    || sourcePe.hash !== outbox.source_pe_hash
    || sourcePe.timestamp !== outbox.earned_at_ms
    || !directSourceBound
    || !Array.isArray(qualified)
    || !qualified.includes(outbox.badge_id)) {
    fail('qualification_source_binding');
  }
}

export function validateCompletedBadgePe(
  outbox: AgentBadgeAwardOutboxDocument,
  badgePe: Record<string, unknown>,
): void {
  const metadata = badgePe.metadata;
  if (outbox.state !== 'complete'
    || badgePe.id !== outbox.badge_pe_id
    || badgePe.hash !== outbox.badge_pe_hash
    || badgePe.wallet_id !== outbox.wallet_id
    || badgePe.agent_id !== outbox.agent_id
    || badgePe.user_id !== outbox.agent_id
    || badgePe.actor_address !== outbox.actor_address
    || badgePe.action_type !== 'badge_earned'
    || badgePe.timestamp !== outbox.earned_at_ms
    || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || stableStringify(metadata) !== stableStringify({
      badge_id: outbox.badge_id,
      trigger: outbox.trigger,
      qualification_outbox_id: outbox.outbox_id,
      source_pe_id: outbox.source_pe_id,
      source_pe_hash: outbox.source_pe_hash,
    })) {
    fail('badge_pe_binding');
  }
}

function validateWalletBadges(value: unknown): EarnedBadge[] {
  if (!Array.isArray(value)) fail('wallet_badges_shape');
  const seen = new Set<string>();
  return value.map((badge) => {
    if (!badge || typeof badge !== 'object' || Array.isArray(badge)) {
      return fail('wallet_badge_shape');
    }
    const raw = badge as Record<string, unknown>;
    exactKeys(raw, ['id', 'earned_at'], 'wallet_badge_keys');
    if (typeof raw.id !== 'string' || !BADGE_ID_SET.has(raw.id)
      || seen.has(raw.id)
      || !Number.isSafeInteger(raw.earned_at) || (raw.earned_at as number) < 0) {
      return fail('wallet_badge_fields');
    }
    seen.add(raw.id);
    return raw as unknown as EarnedBadge;
  });
}

/**
 * The wallet still owns this outbox: same id, agent, and a known lifecycle status. The address is
 * checked separately, because a key rotation changes it.
 */
function assertOutboxWalletIdentity(
  wallet: Record<string, unknown>,
  outbox: AgentBadgeAwardOutboxDocument,
): void {
  // Wallet lifecycle changes do not erase a canonical historical award. The
  // source PE + durable outbox are the qualification authority; status is
  // checked only for a known value so corrupt/unknown lifecycle state still
  // fails closed.
  if (wallet.id !== outbox.wallet_id
    || wallet.agent_id !== outbox.agent_id
    || (wallet.status !== 'active'
      && wallet.status !== 'suspended'
      && wallet.status !== 'revoked')
    || typeof wallet.address !== 'string') {
    fail('wallet_binding');
  }
}

function outboxAddressIsCurrent(wallet: Record<string, unknown>, outbox: AgentBadgeAwardOutboxDocument): boolean {
  return typeof wallet.address === 'string' && wallet.address.toLowerCase() === outbox.actor_address;
}

/**
 *. An award is qualified under the address the agent held then; a key rotation (rotate-key
 * and the recovery re-key both run the rotation transition) moves the wallet to a new address. A
 * PRIOR address binds the outbox only when the wallet's SEALED address lineage proves the wallet
 * held it: the birth address from the `agent_wallet_created` PE the registration index pins, and
 * each rotation from its own sealed `agent_key_rotated` PE (`resolveAgentAddressLineage`, the
 * reader the watchers use). Nothing an agent credential can write (e.g. `chain_addresses`) enters
 * that proof. An address outside the lineage, or a lineage that does not prove, fails closed.
 */
async function proveOutboxAddressLineage(
  db: Firestore,
  wallet: Record<string, unknown>,
  outbox: AgentBadgeAwardOutboxDocument,
): Promise<AgentAddressLineage> {
  let lineage: AgentAddressLineage;
  try {
    const indexSnap = await db.collection(NATIVE_AGENT_REGISTRATION_INDEX_COLLECTION)
      .doc(nativeAgentRegistrationIndexId(outbox.agent_id)).get();
    const registrationIndex = indexSnap.exists ? indexSnap.data() as Record<string, unknown> : null;
    if (!registrationIndex || registrationIndex.wallet_id !== outbox.wallet_id) fail('wallet_binding');
    const rotationHistory = agentWalletRotationCount(wallet) > 0
      ? await readAgentRotationHistoryRaw(db, outbox.wallet_id)
      : [];
    const now = Date.now();
    const identityPes = await readAgentAddressLineagePes(db, {
      agentId: outbox.agent_id,
      walletId: outbox.wallet_id,
      registrationIndex,
      rotationHistory,
      maxTimestampMs: now,
    });
    lineage = resolveAgentAddressLineage({
      walletId: outbox.wallet_id,
      agentId: outbox.agent_id,
      wallet,
      registrationIndex,
      rotationHistory,
      identityPes,
      now,
    });
  } catch (error) {
    if (error instanceof AgentAddressLineageError) fail(`address_lineage:${error.reason}`);
    throw error;
  }
  if (!lineage.segments.some((segment) => segment.address === outbox.actor_address)) fail('wallet_binding');
  return lineage;
}

/** The wallet a proven lineage was read from is still the wallet now (no rotation since). */
function walletStillMatchesLineage(wallet: Record<string, unknown>, lineage: AgentAddressLineage): boolean {
  try {
    return typeof wallet.address === 'string'
      && wallet.address.toLowerCase() === lineage.currentAddress
      && agentWalletRotationCount(wallet) === lineage.rotationCount;
  } catch {
    return false;
  }
}

async function validateCompletedOutbox(
  db: Firestore,
  outbox: AgentBadgeAwardOutboxDocument,
): Promise<EarnedBadge> {
  const walletSnap = await db.collection('agent_wallets').doc(outbox.wallet_id).get();
  if (!walletSnap.exists) fail('complete_graph_missing');
  const wallet = walletSnap.data() as Record<string, unknown>;
  assertOutboxWalletIdentity(wallet, outbox);
  if (!outboxAddressIsCurrent(wallet, outbox)) await proveOutboxAddressLineage(db, wallet, outbox);
  // PE METER: the outbox pins both PEs by id + hash; each is one point read of its identity act
  // (or its pre-meter envelope) — never a walk of the agent's chain.
  const [sourcePe, badgePe] = await Promise.all([
    readIdentityPe(db, {
      peId: outbox.source_pe_id,
      peHash: outbox.source_pe_hash,
      agentId: outbox.agent_id,
      walletId: outbox.wallet_id,
    }),
    readIdentityPe(db, {
      peId: outbox.badge_pe_id as string,
      peHash: outbox.badge_pe_hash as string,
      agentId: outbox.agent_id,
      walletId: outbox.wallet_id,
    }),
  ]);
  validateBadgeQualificationSource(outbox, sourcePe);
  validateCompletedBadgePe(outbox, badgePe);
  const badges = validateWalletBadges(wallet.badges);
  const badge = badges.find((candidate) => candidate.id === outbox.badge_id);
  if (!badge || badge.earned_at !== outbox.earned_at_ms) fail('public_badge_binding');
  return badge;
}

export async function awardBadgeFromOutbox(
  deps: AgentBankDeps,
  walletId: string,
  badgeId: BadgeId,
): Promise<EarnedBadge> {
  const outboxRef = badgeAwardOutboxRef(deps.db, walletId, badgeId);
  const initial = parseBadgeAwardOutbox(await outboxRef.get());
  if (initial.wallet_id !== walletId || initial.badge_id !== badgeId) {
    fail('requested_identity');
  }
  if (initial.state === 'complete') {
    return validateCompletedOutbox(deps.db, initial);
  }

  // The qualifying source PE, pinned by the outbox (id + hash): one point read.
  await readIdentityPe(deps.db, {
    peId: initial.source_pe_id,
    peHash: initial.source_pe_hash,
    agentId: initial.agent_id,
    walletId: initial.wallet_id,
  });

  const walletRef = deps.db.collection('agent_wallets').doc(walletId);
  // A badge qualified before a key rotation: prove the prior address from the sealed lineage
  // BEFORE the transaction (its PEs are point-read identity acts); the transaction then only
  // confirms no rotation has happened since.
  const walletBefore = await walletRef.get();
  const priorLineage = walletBefore.exists
    && !outboxAddressIsCurrent(walletBefore.data() as Record<string, unknown>, initial)
    ? await proveOutboxAddressLineage(deps.db, walletBefore.data() as Record<string, unknown>, initial)
    : null;
  const sourcePeRefs = identityPeRefs(deps.db, initial.source_pe_id);
  const badgePeId = badgeEarnedPeId(walletId, badgeId);
  const badgePeRefs = identityPeRefs(deps.db, badgePeId);
  const completedAt = Date.now();
  let nextBadges: EarnedBadge[] | null = null;
  let nextUpdatedAt = initial.earned_at_ms;

  try {
    await generatePE(deps, {
      walletId,
      agentId: initial.agent_id,
      actorAddress: initial.actor_address,
      actionType: 'badge_earned',
      peIdOverride: badgePeId,
      timestampOverride: initial.earned_at_ms,
      metadata: {
        badge_id: badgeId,
        trigger: initial.trigger,
        qualification_outbox_id: initial.outbox_id,
        source_pe_id: initial.source_pe_id,
        source_pe_hash: initial.source_pe_hash,
      },
      atomicEntityPrecondition: async (txn) => {
        const [
          outboxSnap, walletSnap, sourceIdentitySnap, sourceLegacySnap,
          badgeIdentitySnap, badgeLegacySnap,
        ] = await Promise.all([
          txn.get(outboxRef),
          txn.get(walletRef),
          txn.get(sourcePeRefs.identity),
          txn.get(sourcePeRefs.legacy),
          txn.get(badgePeRefs.identity),
          txn.get(badgePeRefs.legacy),
        ]);
        const current = parseBadgeAwardOutbox(outboxSnap);
        if (stableStringify(current) !== stableStringify(initial)
          || current.state !== 'pending') {
          fail('outbox_changed');
        }
        if (!walletSnap.exists || (!sourceIdentitySnap.exists && !sourceLegacySnap.exists)) {
          fail('qualification_graph_missing');
        }
        if (badgeIdentitySnap.exists || badgeLegacySnap.exists) fail('pending_badge_pe_exists');
        const wallet = walletSnap.data() as Record<string, unknown>;
        // The qualifying action was already admitted and sealed atomically
        // with this outbox while its own policy gate held. Publication must
        // survive a later suspension/revocation — or a key rotation — without
        // mutating that status.
        assertOutboxWalletIdentity(wallet, initial);
        if (!outboxAddressIsCurrent(wallet, initial)
          && (priorLineage === null || !walletStillMatchesLineage(wallet, priorLineage))) {
          fail('wallet_binding');
        }
        const sourcePe = validateIdentityPeSnapshots(
          { identity: sourceIdentitySnap, legacy: sourceLegacySnap },
          {
            peId: initial.source_pe_id,
            peHash: initial.source_pe_hash,
            agentId: initial.agent_id,
            walletId: initial.wallet_id,
          },
        );
        validateBadgeQualificationSource(initial, sourcePe);
        const badges = validateWalletBadges(wallet.badges);
        if (badges.some((badge) => badge.id === badgeId)) fail('pending_public_badge_exists');
        nextBadges = [...badges, { id: badgeId, earned_at: initial.earned_at_ms }];
        nextUpdatedAt = typeof wallet.updated_at === 'number'
          && Number.isSafeInteger(wallet.updated_at)
          ? Math.max(wallet.updated_at, initial.earned_at_ms)
          : initial.earned_at_ms;
      },
      atomicEntityWrite: (txn, peId, context) => {
        if (!nextBadges || !context) fail('award_plan_missing');
        txn.update(walletRef, {
          badges: nextBadges,
          updated_at: nextUpdatedAt,
        });
        txn.update(outboxRef, {
          state: 'complete',
          badge_pe_id: peId,
          badge_pe_hash: context.newHash,
          completed_at_ms: completedAt,
        });
      },
    });
  } catch (error) {
    // Concurrent reconcilers may both observe `pending`; only one can commit.
    // If the other caller completed the exact graph, treat this call as the
    // same idempotent success. Any still-pending or contradictory state keeps
    // the original error and remains fail-closed.
    const latestSnap = await outboxRef.get();
    if (latestSnap.exists) {
      const latest = parseBadgeAwardOutbox(latestSnap);
      if (latest.state === 'complete') {
        return validateCompletedOutbox(deps.db, latest);
      }
    }
    throw error;
  }

  // a badge was FRESHLY awarded (an already-complete outbox returns above,
  // so this fires once per award). Notify the wallet (notify-only, single party).
  // Dynamic import breaks the static cycle event-outbox → event-listener →
  // badge-provenance; best-effort, a notify failure never undoes the award.
  try {
    const { enqueueAgentBankEvent } = await import('../agent-bank/event-outbox');
    await enqueueAgentBankEvent(deps.db, {
      walletId,
      eventType: 'badge_earned',
      transactionAmount: 0,
      entityId: badgeId,
      entityType: 'badge',
      recipients: [walletId],
      data: { badge_id: badgeId, badge_pe_id: badgePeId },
      notifyOnly: true,
    });
  } catch (err) {
    console.error('[BadgeProvenance] badge_earned event enqueue failed:', err);
  }

  return { id: badgeId, earned_at: initial.earned_at_ms };
}

export async function reconcileBadgeAwards(
  deps: AgentBankDeps,
  walletId: string,
  badgeIds: readonly BadgeId[] = ALL_BADGE_IDS,
): Promise<EarnedBadge[]> {
  const awarded: EarnedBadge[] = [];
  for (const badgeId of badgeIds) {
    const snapshot = await badgeAwardOutboxRef(deps.db, walletId, badgeId).get();
    if (!snapshot.exists) continue;
    awarded.push(await awardBadgeFromOutbox(deps, walletId, badgeId));
  }
  return awarded;
}

/**
 * Authority-complete repair pass for durable badge projections. Enumerating
 * every outbox (rather than filtering on mutable `state`) means a malformed or
 * discriminator-corrupted row blocks visibly instead of disappearing from the
 * recovery set. Pagination is ordered by Firestore document id and has no
 * arbitrary chain-depth or wallet-count ceiling.
 */
export async function reconcileAllBadgeAwards(deps: AgentBankDeps): Promise<number> {
  let cursor: string | null = null;
  let reconciled = 0;
  while (true) {
    let query = deps.db.collection(AGENT_BADGE_AWARD_OUTBOX_COLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(200);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    for (const doc of page.docs) {
      const outbox = parseBadgeAwardOutbox(doc);
      if (doc.id !== outbox.outbox_id) fail('outbox_document_id');
      await awardBadgeFromOutbox(deps, outbox.wallet_id, outbox.badge_id);
      reconciled += 1;
    }
    if (page.empty || page.docs.length < 200) return reconciled;
    cursor = page.docs[page.docs.length - 1].id;
  }
}

export function badgeIds(value: readonly string[]): BadgeId[] {
  return value.map((id) => {
    if (!BADGE_ID_SET.has(id)) return fail('unknown_badge_id');
    return id as BadgeId;
  });
}
