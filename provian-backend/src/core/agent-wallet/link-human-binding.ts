/**
 * Shared agent→human beneficiary bind path.
 *
 * Single source of truth for writing a beneficiary link onto an agent wallet:
 * prospective wallet + canonical relationship update, beneficiary-cache
 * invalidation, and the `agent_linked_to_human` PE. Badge qualifications are
 * durably outboxed in that same transaction; each public badge is then
 * co-committed with its deterministic `badge_earned` PE. Authorization is the
 * CALLER's responsibility - this function
 * performs no signature checks. It is invoked from:
 *
 * 1. POST /:wallet_id/link-human (after EIP-191 signature verify)
 * 2. POST /v1/agent/wallet/create tail (pending invite from connect token)
 * 3. POST /v1/relay/agent/connect (RETIRED by the session channel is gone)
 * 4. POST /:wallet_id/unlink-human (after EIP-191 signature verify)
 * 5. POST /:wallet_id/human-unlink (the linked human alone, under wallet auth —
 *; unbind only)
 *
 * the three signature-authorized callers (link-human, unlink-human, the share change) pass
 * an `authorization` the verified signature's link epoch and payload hash. The helper then refuses
 * unless the relationship is still at that epoch, and consumes the payload inside the SAME
 * transaction that writes the change (`./link-signature.ts`), so each signature applies at most once
 * and never after a later state change.
 *
 * Keeping it in one place satisfies the "reuse link-human write path, do not
 * duplicate" requirement of the human-initiated linkage work.
 */
import { generatePE as generatePEAtomic } from '../agent-bank/pe-utils';
import type { AgentBankDeps } from '../agent-bank/types';
import { evaluateBadges } from './badges';
import {
  awardBadgeFromOutbox,
  badgeAwardOutboxRef,
  badgeIds,
  createPendingBadgeAward,
  reconcileBadgeAwards,
} from './badge-provenance';
import {
  beneficiaryRelationshipRef,
  beneficiaryRelationshipSnapshot,
  canonicalAgentBeneficiaryShareBps,
  createBeneficiaryRelationshipDocument,
  readValidatedBeneficiaryRelationship,
  readValidatedBeneficiaryRelationshipInTransaction,
  type AgentBeneficiaryShareBps,
  type AgentBeneficiaryRelationshipDocument,
} from './beneficiary-relationship';
import { FieldValue, type Transaction } from 'firebase-admin/firestore';
import { countVisibleAgentPEs } from './agent-pe-activity';
import {
  assertLinkEpochCurrent,
  assertLinkSignatureUnconsumed,
  recordLinkSignatureConsumption,
  type LinkSignatureAuthorization,
} from './link-signature';
import type { AgentWalletDocument } from './types';
import type { RedisCache } from '../../cache';
import { connectionTokenRef } from './fleet-code';
import { AGENT_BANK_EVENT_OUTBOX_COLLECTION, type AgentBankEventRecord } from '../agent-bank/event-outbox';

export interface BindAgentToHumanParams {
  /** The current agent wallet document (must not already be linked). */
  wallet: AgentWalletDocument;
  /** Human wallet doc id in the `wallets` collection. */
  humanWalletId: string;
  /** Human's userId for pvt_accrual lookup. */
  humanUserId: string;
  /** Human's EVM address for minting (null tolerated, mirrors link-human). */
  humanAddress: string | null;
  /** Canonical agent share, integer BPS within [500, 5000]. */
  agentShareBps: AgentBeneficiaryShareBps;
  /** the human's verified link signature (link-human route); absent on the invite binds. */
  authorization?: LinkSignatureAuthorization;
  /**
   * review 2: a FLEET-code bind (routes/agent-invite.ts). Inside the bind's
   * transaction the code must be a fleet code for this human, consumed by THIS
   * agent, with its bind not yet completed, AND the agent must never have been
   * linked (birth relationship record, no linked_human_*, no accepted invite);
   * the same transaction marks the code `bind_completed`, so the consume and
   * the bind are distinguishable on retry.
   */
  fleet?: { code: string };
  /**
   * B3 (2026-10-22): the `agent_invites` record this bind ACCEPTS (POST /accept-invite). Inside the
   * bind's transaction the invite must name this agent, may be addressed only to this human
   * (`for_human_user_id`), and must be either unaccepted or already accepted by exactly this human
   * and human wallet; the SAME transaction writes the acceptance marker on an unaccepted invite.
   * So an invite binds a beneficiary only for the human whose acceptance passes the identity check,
   * a refused acceptance writes nothing (no link, no PE, no marker), and an invite once accepted can
   * never bind a different human — including after the first human ends the link.
   */
  invite?: { inviteId: string; acceptedAtMs: number };
}

/**
 * The invite-acceptance identity check, shared by the accept-invite route's no-side-effect
 * pre-check and the bind transaction's authoritative re-check. `null` = this human may accept
 * (fresh, or a retry by the human who already accepted); otherwise the refusal.
 */
export function inviteAcceptanceRefusal(
  invite: Record<string, unknown> | null | undefined,
  expected: { agentWalletId: string; humanUserId: string; humanWalletId: string },
): 'beneficiary_link_identity_invalid' | null {
  if (!invite || invite.agent_wallet_id !== expected.agentWalletId) {
    return 'beneficiary_link_identity_invalid';
  }
  if (invite.for_human_user_id !== undefined && invite.for_human_user_id !== null
    && invite.for_human_user_id !== expected.humanUserId) {
    return 'beneficiary_link_identity_invalid';
  }
  if (invite.accepted_at === null || invite.accepted_at === undefined) return null;
  if (!Number.isSafeInteger(invite.accepted_at)
    || invite.accepted_by_user_id !== expected.humanUserId
    || invite.accepted_by_wallet_id !== expected.humanWalletId) {
    return 'beneficiary_link_identity_invalid';
  }
  return null;
}

export interface RetroTransfer {
  total_pvt_transferred: number;
  agent_retained: number;
  human_received: number;
}

export interface BindAgentToHumanResult {
  retroTransfer: RetroTransfer;
  newBadgeIds: string[];
}

export interface UnbindAgentFromHumanParams {
  /** Authenticated snapshot used only to bind the transaction to its caller. */
  wallet: AgentWalletDocument;
  /**
   * Who ended the link, recorded on the unlink PE. Absent on the bilateral route (its PE is
   * byte-identical to before); `'linked_human'` when the linked human ended it alone under wallet
   * auth. Never changes what is cleared: the unbind is the same either way.
   */
  endedBy?: 'linked_human';
  /** the human's verified unlink signature (bilateral route); absent on human-unlink. */
  authorization?: LinkSignatureAuthorization;
}

export interface UnbindAgentFromHumanResult {
  /** The sealed `agent_unlinked_from_human` PE (record_only; the relationship-change record). */
  peId: string;
}

export interface UpdateAgentBeneficiaryShareBpsParams {
  /** Authenticated snapshot used only to bind the transaction to its caller. */
  wallet: AgentWalletDocument;
  /** New prospective agent share in the configured [500, 5000] BPS range. */
  agentShareBps: AgentBeneficiaryShareBps;
  /** the human's verified share-change signature. */
  authorization?: LinkSignatureAuthorization;
}

export type BindDeps = AgentBankDeps & { cache: RedisCache };

export class BeneficiaryLinkConflictError extends Error {
  constructor(readonly code: 'agent_already_linked' | 'beneficiary_link_identity_invalid') {
    super(code);
    this.name = 'BeneficiaryLinkConflictError';
  }
}

class ExistingBeneficiaryShareBps extends Error {
  constructor() {
    super('beneficiary_share_bps_already_committed');
  }
}

async function requireBeneficiaryRelationship(
  db: BindDeps['db'],
  wallet: AgentWalletDocument,
): Promise<AgentBeneficiaryRelationshipDocument> {
  try {
    return await readValidatedBeneficiaryRelationship({ db, wallet });
  } catch {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }
}

async function requireBeneficiaryRelationshipInTransaction(params: {
  db: BindDeps['db'];
  txn: Transaction;
  wallet: Record<string, unknown>;
  expected: AgentBeneficiaryRelationshipDocument;
}): Promise<AgentBeneficiaryRelationshipDocument> {
  try {
    return await readValidatedBeneficiaryRelationshipInTransaction(params);
  } catch {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }
}

/**
 * Bind an agent wallet to a human beneficiary prospectively. Record-time
 * economic snapshots already own the recipient and split for every prior PE;
 * linking must never rewrite aggregate estimates as though those sealed
 * records had named a different beneficiary. The compatibility response keeps
 * the historical retroactive-transfer object, permanently zero-valued.
 */
export async function bindAgentToHuman(
  deps: BindDeps,
  params: BindAgentToHumanParams,
): Promise<BindAgentToHumanResult> {
  const { db, cache } = deps;
  const { wallet, humanWalletId, humanUserId, humanAddress, agentShareBps, authorization, fleet, invite } = params;
  const now = Date.now();
  if (canonicalAgentBeneficiaryShareBps({ bps: agentShareBps }) !== agentShareBps
    || typeof humanAddress !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(humanAddress)) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }

  const retroTransfer: RetroTransfer = {
    total_pvt_transferred: 0,
    agent_retained: 0,
    human_received: 0,
  };
  const agentRef = db.collection('agent_wallets').doc(wallet.id);
  const humanRef = db.collection('wallets').doc(humanWalletId);
  await reconcileBadgeAwards(deps, wallet.id);
  const [authoritativeWalletSnap, targetHumanSnap] = await Promise.all([
    agentRef.get(),
    humanRef.get(),
  ]);
  const authoritativeWallet = authoritativeWalletSnap.exists
    ? authoritativeWalletSnap.data() as AgentWalletDocument
    : null;
  const targetHuman = targetHumanSnap.exists
    ? targetHumanSnap.data() as Record<string, unknown>
    : null;
  if (!authoritativeWallet
    || authoritativeWallet.id !== wallet.id
    || authoritativeWallet.agent_id !== wallet.agent_id
    || typeof authoritativeWallet.address !== 'string'
    || authoritativeWallet.address.toLowerCase() !== wallet.address.toLowerCase()
    || authoritativeWallet.status !== 'active'
    || !targetHuman
    || targetHuman.id !== humanWalletId
    || targetHuman.type !== 'human'
    || targetHuman.user_id !== humanUserId
    || typeof targetHuman.address !== 'string'
    || targetHuman.address.toLowerCase() !== humanAddress.toLowerCase()) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }
  const currentRelationship = await requireBeneficiaryRelationship(db, authoritativeWallet);
  if (currentRelationship.state === 'linked') {
    // a signed link never takes the idempotent path — the link it names already moved the epoch.
    if (authorization) throw new BeneficiaryLinkConflictError('agent_already_linked');
    if (currentRelationship.human_wallet_id !== humanWalletId) {
      throw new BeneficiaryLinkConflictError('agent_already_linked');
    }
    if (currentRelationship.human_user_id !== humanUserId
      || currentRelationship.human_address !== humanAddress.toLowerCase()
      || currentRelationship.agent_share_bps !== agentShareBps) {
      throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
    }
    await reconcileBadgeAwards(deps, wallet.id);
    await cache.invalidateBeneficiaryStatus(wallet.agent_id);
    await cache.invalidateBeneficiaryStatus(wallet.id);
    return {
      retroTransfer,
      newBadgeIds: [],
    };
  }
  if (authorization) assertLinkEpochCurrent(authorization, currentRelationship.revision);

  // Re-evaluate badge qualifications from the authoritative linked state. Public
  // badge state is not written here; the transaction creates durable pending
  // awards that are settled PE+badge atomically below. (no governance
  // score is computed or written; the PE-count badges read the live count.)
  const updatedWallet = {
    ...authoritativeWallet,
    linked_human_wallet_id: humanWalletId,
    linked_human_user_id: humanUserId,
    linked_human_address: humanAddress.toLowerCase(),
    operational_reserve_bps: agentShareBps,
    operational_reserve_ratio: undefined,
  } as AgentWalletDocument;
  const livePeCount = await countVisibleAgentPEs(db, wallet.agent_id);
  const committedBadgeIds = badgeIds(evaluateBadges({
    wallet: updatedWallet,
    livePeCount,
  }));
  const nextRelationship = beneficiaryRelationshipSnapshot({
    humanWalletId,
    humanUserId,
    humanAddress,
    agentShareBps,
    parentWalletId: authoritativeWallet.parent_wallet_id ?? null,
    revision: currentRelationship.revision + 1,
  });
  const relationshipRef = beneficiaryRelationshipRef(db, wallet.id);
  const badgeOutboxRefs = committedBadgeIds.map((badgeId) =>
    badgeAwardOutboxRef(db, wallet.id, badgeId));
  const fleetCodeRef = fleet ? connectionTokenRef(db, fleet.code) : null;
  const inviteRef = invite ? db.collection('agent_invites').doc(invite.inviteId) : null;
  // Set by the transaction's precondition (re-run on every retry): whether THIS transaction
  // writes the acceptance marker (an unaccepted invite) or finds this human's own marker.
  let inviteNeedsMarker = false;

  // Generate link PE via atomic helper (H-3 fix).
  //
  // The link act itself is policy-sealed record-only. The compatibility zero
  // below is not economic authority. Linking is ignition, not earning: the
  // economic value of a beneficiary link is its prospectively configured
  // routing (20/80 by default, with agent share bounded to 5-50%) plus the 2x
  // human-trust bonus on the agent's FUTURE verified work. The separate Genesis
  // signup award is qualified by external-address
  // proof, never by this link gesture. A link is never a
  // reward for the bare link gesture. Previously this recorded at the standard
  // tier-3 weight (~3.2 PVT), so a link → unlink → re-link cycle re-accrued each
  // time (a farm surface damped only by novelty decay). Zeroing it closes that:
  // a bare re-link pays nothing, on first link or repeat. (Same 0-PVT provenance
  // pattern as external_address_proven.)
  const linkPe = await generatePEAtomic(deps, {
      walletId: wallet.id,
      agentId: wallet.agent_id,
      actorAddress: wallet.address,
      actionType: 'agent_linked_to_human',
      counterpartyAddress: humanAddress,
      timestampOverride: now,
      metadata: {
        human_wallet_id: humanWalletId,
        human_user_id: humanUserId,
        human_address: humanAddress.toLowerCase(),
        operational_reserve_bps: agentShareBps,
        qualified_badges: committedBadgeIds,
        beneficiary_relationship: nextRelationship,
        retroactive_pvt_transferred: 0,
        beneficiary_effect: 'prospective_only',
        no_pvt: 'link_is_ignition_not_earning',
      },
      fixedEstimatedPVT: 0,
      atomicEntityPrecondition: async (txn) => {
        if (authorization) await assertLinkSignatureUnconsumed(db, txn, authorization);
        const [agentSnap, humanSnap, badgeOutboxSnaps, fleetCodeSnap, inviteSnap] = await Promise.all([
          txn.get(agentRef),
          txn.get(humanRef),
          Promise.all(badgeOutboxRefs.map((ref) => txn.get(ref))),
          fleetCodeRef ? txn.get(fleetCodeRef) : Promise.resolve(null),
          inviteRef ? txn.get(inviteRef) : Promise.resolve(null),
        ]);
        inviteNeedsMarker = false;
        if (inviteSnap) {
          // B3: the invite binds only the human whose acceptance passes the identity check —
          // checked HERE, in the transaction that writes the link, before anything is written.
          const inviteData = inviteSnap.exists
            ? inviteSnap.data() as Record<string, unknown>
            : null;
          if (inviteAcceptanceRefusal(inviteData, {
            agentWalletId: wallet.id,
            humanUserId,
            humanWalletId,
          }) !== null) {
            throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
          }
          inviteNeedsMarker = inviteData?.accepted_at === null || inviteData?.accepted_at === undefined;
        }
        if (fleetCodeSnap) {
          // The fleet code this bind finishes: consumed by THIS agent, for THIS
          // human, and not already bound (a bound code binds nothing again).
          const code = fleetCodeSnap.exists ? fleetCodeSnap.data() as Record<string, unknown> : null;
          if (!code
            || code.kind !== 'fleet'
            || code.user_id !== humanUserId
            || code.used !== true
            || code.used_by_wallet_id !== wallet.id
            || code.bind_completed === true) {
            throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
          }
        }
        const current = agentSnap.exists
          ? agentSnap.data() as Record<string, unknown>
          : null;
        const human = humanSnap.exists
          ? humanSnap.data() as Record<string, unknown>
          : null;
        if (!current
          || current.agent_id !== wallet.agent_id
          || typeof current.address !== 'string'
          || current.address.toLowerCase() !== wallet.address.toLowerCase()
          || current.status !== 'active'
          || !Array.isArray(current.badges)
          || !human
          || human.id !== humanWalletId
          || human.type !== 'human'
          || human.released_at_ms != null
          || human.user_id !== humanUserId
          || typeof human.address !== 'string'
          || human.address.toLowerCase() !== humanAddress.toLowerCase()) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
        const txnRelationship = await requireBeneficiaryRelationshipInTransaction({
          db,
          txn,
          wallet: current,
          expected: currentRelationship,
        });
        if (current.linked_human_wallet_id !== null
          || current.linked_human_user_id !== null
          || current.linked_human_address !== null
          || badgeOutboxSnaps.some((snapshot) => snapshot.exists)) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
        if (fleetCodeSnap) {
          // review 2 #6: a fleet code reaches only a NEVER-linked agent,
          // and that precondition is re-checked HERE, inside the transaction
          // that writes the link — the route's pre-check is advisory (an X bind
          // → human unlink → Y bind interleave passes it). Never linked means:
          // the relationship is still its birth record (revision 1,
          // agent_wallet_created, unlinked), the wallet carries no linked_human_*
          // (checked above), and no accepted agent_invites record names the agent.
          const acceptedInvites = await txn.get(
            db.collection('agent_invites')
              .where('agent_wallet_id', '==', wallet.id)
              .where('status', '==', 'accepted')
              .limit(1),
          );
          if (txnRelationship.revision !== 1
            || txnRelationship.state !== 'unlinked'
            || txnRelationship.source_action_type !== 'agent_wallet_created'
            || !acceptedInvites.empty) {
            throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
          }
        }
        const currentBadges = current.badges as Array<Record<string, unknown>>;
        if (currentBadges.some((badge) => typeof badge?.id !== 'string')
          || committedBadgeIds.some((badgeId) =>
            currentBadges.some((badge) => badge.id === badgeId))) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
      },
      atomicEntityWrite: (txn, peId, context) => {
        if (!context) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
        txn.update(agentRef, {
          linked_human_wallet_id: humanWalletId,
          linked_human_user_id: humanUserId,
          linked_human_address: humanAddress.toLowerCase(),
          operational_reserve_bps: agentShareBps,
          operational_reserve_ratio: FieldValue.delete(),
          updated_at: now,
        });
        txn.set(relationshipRef, createBeneficiaryRelationshipDocument({
          walletId: wallet.id,
          agentId: wallet.agent_id,
          snapshot: nextRelationship,
          sourceActionType: 'agent_linked_to_human',
          sourcePeId: peId,
          sourcePeHash: context.newHash,
          createdAtMs: currentRelationship.created_at_ms,
          updatedAtMs: now,
        }));
        if (authorization) recordLinkSignatureConsumption(db, txn, authorization, { peId, nowMs: now });
        if (fleetCodeRef) {
          txn.update(fleetCodeRef, { bind_completed: true, bind_completed_at: now, bind_pe_id: peId });
        }
        if (inviteRef && invite && inviteNeedsMarker) {
          txn.update(inviteRef, {
            status: 'accepted',
            accepted_at: invite.acceptedAtMs,
            accepted_by_user_id: humanUserId,
            accepted_by_wallet_id: humanWalletId,
          });
        }
        committedBadgeIds.forEach((badgeId, index) => {
          txn.create(badgeOutboxRefs[index], createPendingBadgeAward({
            walletId: wallet.id,
            agentId: wallet.agent_id,
            actorAddress: wallet.address,
            badgeId,
            trigger: 'link_human',
            earnedAtMs: now,
            sourcePeId: peId,
            sourcePeHash: context.newHash,
          }));
        });
      },
    });
  if (!linkPe.peId) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }

  // Advisory cache invalidation is not economic authority: beneficiary
  // resolution re-reads Firestore for every snapshot. Clear both supported
  // actor keys so non-economic readers also converge promptly.
  await cache.invalidateBeneficiaryStatus(wallet.agent_id);
  await cache.invalidateBeneficiaryStatus(wallet.id);

  const awardedBadgeIds: string[] = [];
  for (const badgeId of committedBadgeIds) {
    try {
      await awardBadgeFromOutbox(deps, wallet.id, badgeId);
      awardedBadgeIds.push(badgeId);
    } catch (error) {
      console.warn('[AgentWallet] Link badge award remains pending:', error);
    }
  }

  return { retroTransfer, newBadgeIds: awardedBadgeIds };
}

/**
 * Remove a beneficiary link atomically with its required provenance record.
 * The authenticated route snapshot is never economic authority: the
 * transaction reloads and exact-binds both wallet documents before clearing
 * the relationship, so a concurrent relink/unlink cannot reorder state and PE
 * history or route a later record using an unexplained relationship boundary.
 */
export async function unbindAgentFromHuman(
  deps: BindDeps,
  params: UnbindAgentFromHumanParams,
): Promise<UnbindAgentFromHumanResult> {
  const { db, cache } = deps;
  const { wallet, authorization } = params;
  const humanWalletId = wallet.linked_human_wallet_id;
  const humanUserId = wallet.linked_human_user_id;
  const humanAddress = wallet.linked_human_address;
  if (typeof humanWalletId !== 'string'
    || typeof humanUserId !== 'string'
    || typeof humanAddress !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(humanAddress)) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }

  const now = Date.now();
  const agentRef = db.collection('agent_wallets').doc(wallet.id);
  const humanRef = db.collection('wallets').doc(humanWalletId);
  const currentRelationship = await requireBeneficiaryRelationship(db, wallet);
  if (currentRelationship.state !== 'linked'
    || currentRelationship.human_wallet_id !== humanWalletId
    || currentRelationship.human_user_id !== humanUserId
    || currentRelationship.human_address !== humanAddress.toLowerCase()) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }
  if (authorization) assertLinkEpochCurrent(authorization, currentRelationship.revision);
  const nextRelationship = beneficiaryRelationshipSnapshot({
    humanWalletId: null,
    humanUserId: null,
    humanAddress: null,
    agentShareBps: null,
    parentWalletId: wallet.parent_wallet_id ?? null,
    revision: currentRelationship.revision + 1,
  });
  const relationshipRef = beneficiaryRelationshipRef(db, wallet.id);

  const { peId: unlinkPeId } = await generatePEAtomic(deps, {
    walletId: wallet.id,
    agentId: wallet.agent_id,
    actorAddress: wallet.address,
    actionType: 'agent_unlinked_from_human',
    metadata: {
      former_human_wallet_id: humanWalletId,
      former_human_user_id: humanUserId,
      beneficiary_relationship: nextRelationship,
      beneficiary_effect: 'prospective_only',
      no_pvt: 'relationship_change_not_earning',
      ...(params.endedBy ? { ended_by: params.endedBy } : {}),
    },
    counterpartyAddress: humanAddress,
    fixedEstimatedPVT: 0,
    timestampOverride: now,
    atomicEntityPrecondition: async (txn) => {
      if (authorization) await assertLinkSignatureUnconsumed(db, txn, authorization);
      const [agentSnap, humanSnap] = await Promise.all([
        txn.get(agentRef),
        txn.get(humanRef),
      ]);
      const current = agentSnap.exists
        ? agentSnap.data() as Record<string, unknown>
        : null;
      const human = humanSnap.exists
        ? humanSnap.data() as Record<string, unknown>
        : null;
      if (!current
        || current.agent_id !== wallet.agent_id
        || typeof current.address !== 'string'
        || current.address.toLowerCase() !== wallet.address.toLowerCase()
        || !(current.status === 'active'
          || params.endedBy === 'linked_human' && (current.status === 'suspended' || current.status === 'revoked'))
        || current.linked_human_wallet_id !== humanWalletId
        || current.linked_human_user_id !== humanUserId
        || typeof current.linked_human_address !== 'string'
        || current.linked_human_address.toLowerCase() !== humanAddress.toLowerCase()
        || typeof current.attestation_count !== 'number'
        || !Number.isSafeInteger(current.attestation_count)
        || current.attestation_count < 0
        || typeof current.streak_days !== 'number'
        || !Number.isSafeInteger(current.streak_days)
        || current.streak_days < 0
        || !human
        || human.type !== 'human'
        || human.user_id !== humanUserId
        || typeof human.address !== 'string'
        || human.address.toLowerCase() !== humanAddress.toLowerCase()) {
        throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
      }
      await requireBeneficiaryRelationshipInTransaction({
        db,
        txn,
        wallet: current,
        expected: currentRelationship,
      });
    },
    atomicEntityWrite: (txn, peId, context) => {
      if (!context) {
        throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
      }
      txn.update(agentRef, {
        linked_human_wallet_id: null,
        linked_human_user_id: null,
        linked_human_address: null,
        operational_reserve_bps: null,
        operational_reserve_ratio: FieldValue.delete(),
        updated_at: now,
      });
      txn.set(relationshipRef, createBeneficiaryRelationshipDocument({
        walletId: wallet.id,
        agentId: wallet.agent_id,
        snapshot: nextRelationship,
        sourceActionType: 'agent_unlinked_from_human',
        sourcePeId: peId,
        sourcePeHash: context.newHash,
        createdAtMs: currentRelationship.created_at_ms,
        updatedAtMs: now,
      }));
      // The notice and unlink commit together, so a deletion retry cannot lose the notice
      // after clearing the link. The existing outbox delivers inbox + targeted webhook.
      if (params.endedBy === 'linked_human') {
        const notice: AgentBankEventRecord = {
          wallet_id: wallet.id, event_type: 'beneficiary_link_ended',
          transaction_amount: 0, amount_unit: 'usdc_whole', status: 'pending', attempts: 0,
          created_at: now, updated_at: now, recipients: [wallet.id],
          entity_id: wallet.id, entity_type: 'beneficiary_link', notify_only: true,
          data: { ended_by: 'linked_human', unlink_pe_id: peId, linked_human_wallet_id: null },
        };
        txn.set(db.collection(AGENT_BANK_EVENT_OUTBOX_COLLECTION).doc(`beneficiary_link_ended_${peId}`), notice);
      }
      if (authorization) recordLinkSignatureConsumption(db, txn, authorization, { peId, nowMs: now });
    },
  });

  await cache.invalidateBeneficiaryStatus(wallet.agent_id);
  await cache.invalidateBeneficiaryStatus(wallet.id);
  return { peId: unlinkPeId };
}

/** consume a verified share-change signature whose change was a no-op (no PE, no epoch move). */
async function consumeNoOpShareSignature(
  db: BindDeps['db'],
  wallet: AgentWalletDocument,
  expected: AgentBeneficiaryRelationshipDocument,
  authorization: LinkSignatureAuthorization,
  nowMs: number,
): Promise<void> {
  const agentRef = db.collection('agent_wallets').doc(wallet.id);
  await db.runTransaction(async (txn) => {
    await assertLinkSignatureUnconsumed(db, txn, authorization);
    const agentSnap = await txn.get(agentRef);
    const current = agentSnap.exists ? agentSnap.data() as Record<string, unknown> : null;
    if (!current || current.id !== wallet.id) {
      throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
    }
    await requireBeneficiaryRelationshipInTransaction({ db, txn, wallet: current, expected });
    recordLinkSignatureConsumption(db, txn, authorization, { peId: null, nowMs });
  });
}

/**
 * Change the prospective beneficiary split atomically with a record-only
 * policy PE. Existing PE snapshots remain immutable. The transaction rejects
 * stale relationship state so it cannot overwrite a concurrent unlink/relink.
 */
export async function updateAgentBeneficiaryShareBps(
  deps: BindDeps,
  params: UpdateAgentBeneficiaryShareBpsParams,
): Promise<void> {
  const { db, cache } = deps;
  const { wallet, agentShareBps, authorization } = params;
  const humanWalletId = wallet.linked_human_wallet_id;
  const humanUserId = wallet.linked_human_user_id;
  const humanAddress = wallet.linked_human_address;
  if (canonicalAgentBeneficiaryShareBps({ bps: agentShareBps }) !== agentShareBps
    || typeof humanWalletId !== 'string'
    || typeof humanUserId !== 'string'
    || typeof humanAddress !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(humanAddress)) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }

  const now = Date.now();
  const agentRef = db.collection('agent_wallets').doc(wallet.id);
  const humanRef = db.collection('wallets').doc(humanWalletId);
  const currentRelationship = await requireBeneficiaryRelationship(db, wallet);
  if (currentRelationship.state !== 'linked'
    || currentRelationship.human_wallet_id !== humanWalletId
    || currentRelationship.human_user_id !== humanUserId
    || currentRelationship.human_address !== humanAddress.toLowerCase()
    || currentRelationship.agent_share_bps === null) {
    throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
  }
  if (authorization) assertLinkEpochCurrent(authorization, currentRelationship.revision);
  const nextRelationship = beneficiaryRelationshipSnapshot({
    humanWalletId,
    humanUserId,
    humanAddress,
    agentShareBps,
    parentWalletId: wallet.parent_wallet_id ?? null,
    revision: currentRelationship.revision + 1,
  });
  const relationshipRef = beneficiaryRelationshipRef(db, wallet.id);
  let previousAgentShareBps: AgentBeneficiaryShareBps | null = null;
  try {
    await generatePEAtomic(deps, {
      walletId: wallet.id,
      agentId: wallet.agent_id,
      actorAddress: wallet.address,
      actionType: 'policy_updated',
      metadata: {
        policy_key: 'beneficiary_operational_reserve_bps',
        previous_agent_share_bps: currentRelationship.agent_share_bps,
        new_agent_share_bps: agentShareBps,
        beneficiary_relationship: nextRelationship,
        beneficiary_effect: 'prospective_only',
        no_pvt: 'economic_routing_policy_change_not_earning',
      },
      counterpartyAddress: humanAddress,
      fixedEstimatedPVT: 0,
      timestampOverride: now,
      atomicEntityPrecondition: async (txn) => {
        if (authorization) await assertLinkSignatureUnconsumed(db, txn, authorization);
        const [agentSnap, humanSnap] = await Promise.all([
          txn.get(agentRef),
          txn.get(humanRef),
        ]);
        const current = agentSnap.exists
          ? agentSnap.data() as Record<string, unknown>
          : null;
        const human = humanSnap.exists
          ? humanSnap.data() as Record<string, unknown>
          : null;
        if (!current
          || current.agent_id !== wallet.agent_id
          || typeof current.address !== 'string'
          || current.address.toLowerCase() !== wallet.address.toLowerCase()
          || current.status !== 'active'
          || current.linked_human_wallet_id !== humanWalletId
          || current.linked_human_user_id !== humanUserId
          || typeof current.linked_human_address !== 'string'
          || current.linked_human_address.toLowerCase() !== humanAddress.toLowerCase()
          || !human
          || human.type !== 'human'
          || human.user_id !== humanUserId
          || typeof human.address !== 'string'
          || human.address.toLowerCase() !== humanAddress.toLowerCase()) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
        await requireBeneficiaryRelationshipInTransaction({
          db,
          txn,
          wallet: current,
          expected: currentRelationship,
        });
        if (currentRelationship.agent_share_bps === agentShareBps) {
          throw new ExistingBeneficiaryShareBps();
        }
        previousAgentShareBps = currentRelationship.agent_share_bps;
      },
      atomicEntityWrite: (txn, peId, context) => {
        if (previousAgentShareBps === null || !context) {
          throw new BeneficiaryLinkConflictError('beneficiary_link_identity_invalid');
        }
        txn.update(agentRef, {
          operational_reserve_bps: agentShareBps,
          operational_reserve_ratio: FieldValue.delete(),
          updated_at: now,
        });
        txn.set(relationshipRef, createBeneficiaryRelationshipDocument({
          walletId: wallet.id,
          agentId: wallet.agent_id,
          snapshot: nextRelationship,
          sourceActionType: 'policy_updated',
          sourcePeId: peId,
          sourcePeHash: context.newHash,
          createdAtMs: currentRelationship.created_at_ms,
          updatedAtMs: now,
        }));
        if (authorization) recordLinkSignatureConsumption(db, txn, authorization, { peId, nowMs: now });
      },
    });
  } catch (error) {
    if (error instanceof ExistingBeneficiaryShareBps) {
      // a "change" to the share already in force writes nothing and moves no epoch — so the
      // signature is consumed on its own, against the same unchanged relationship, and its replay
      // is refused like any other.
      if (authorization) await consumeNoOpShareSignature(db, wallet, currentRelationship, authorization, now);
      return;
    }
    throw error;
  }

  await cache.invalidateBeneficiaryStatus(wallet.agent_id);
  await cache.invalidateBeneficiaryStatus(wallet.id);
}
