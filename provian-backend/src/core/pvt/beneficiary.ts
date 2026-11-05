/**
 * Beneficiary Resolution - Shared module
 *
 * Determines whether an agent wallet has a linked human beneficiary.
 * Used by pvt-accrual.ts (real-time). (The retired PVTv8 minting engine was its
 * batch-time caller.)
 *
 * Economic reads are authoritative Firestore reads on every record. Redis is
 * write-only advisory state here: a stale negative after link (or stale
 * positive after unlink) must never change a sealed beneficiary snapshot.
 * Missing or contradictory agent/human bindings throw so the accrual caller
 * can seal `linkageState: unverifiable` and keep the record out of settlement.
 */

import { relayDb } from '../../firestore-db';
import type { DocumentSnapshot, Firestore } from 'firebase-admin/firestore';
import type { RedisCache } from '../../cache';
import {
  BeneficiaryRelationshipIntegrityError,
  isPreRelationshipUnlinkedWallet,
  readValidatedBeneficiaryRelationship,
  type AgentBeneficiaryShareBps,
} from '../agent-wallet/beneficiary-relationship';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BeneficiaryCacheEntry {
  linked: boolean;
  humanWalletId: string | null;
  humanUserId: string | null;
  humanAddress: string | null;
  /** Exact configured agent share for a linked relationship. */
  agentShareBps: AgentBeneficiaryShareBps | null;
}

/** Unlinked result for an authoritative, well-formed no-agent/no-link read. */
const UNLINKED: BeneficiaryCacheEntry = {
  linked: false,
  humanWalletId: null,
  humanUserId: null,
  humanAddress: null,
  agentShareBps: null,
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve beneficiary status for a given userId.
 *
 * Redis is deliberately not read. A five-minute cached beneficiary decision
 * is not strong enough to price a PE because links, unlinks, and ratio changes
 * are prospective record-time boundaries.
 */
export async function resolveBeneficiary(
  userId: string,
  cache: RedisCache,
  db: Firestore = relayDb(),
): Promise<BeneficiaryCacheEntry> {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('beneficiary_registry_actor_invalid');
  }

  const byAgentId = await db.collection('agent_wallets')
    .where('agent_id', '==', userId)
    .limit(2)
    .get();
  if (byAgentId.docs.length > 1) {
    throw new Error('beneficiary_registry_duplicate_agent_identity');
  }

  let walletDoc: DocumentSnapshot | null = byAgentId.docs[0] ?? null;
  if (!walletDoc && userId.startsWith('wallet_aw_')) {
    const direct = await db.collection('agent_wallets').doc(userId).get();
    if (!direct.exists) {
      throw new Error('beneficiary_registry_expected_agent_missing');
    }
    walletDoc = direct;
  }

  if (!walletDoc) {
    // An authoritative query proved this actor is not an agent wallet (the
    // ordinary human path). Cache only as an advisory projection.
    await cache.setBeneficiaryStatus(userId, UNLINKED);
    return UNLINKED;
  }

  const wallet = walletDoc.data() as Record<string, unknown>;
  if (wallet.id !== walletDoc.id
    || typeof wallet.agent_id !== 'string' || wallet.agent_id.length === 0
    || typeof wallet.address !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(wallet.address)
    || (byAgentId.docs.length === 1 && wallet.agent_id !== userId)
    || (userId.startsWith('wallet_aw_') && walletDoc.id !== userId)
    || wallet.status !== 'active') {
    throw new Error('beneficiary_registry_agent_identity_invalid');
  }

  let relationship: Awaited<ReturnType<typeof readValidatedBeneficiaryRelationship>>;
  try {
    relationship = await readValidatedBeneficiaryRelationship({ db, wallet });
  } catch (error) {
    // A wallet born before relationship documents existed has none. It is unlinked only when its
    // own birth certificate, wallet document and identity history prove it; otherwise the
    // integrity failure stands and the act is held (Unknown = Block).
    if (error instanceof BeneficiaryRelationshipIntegrityError && error.reason === 'missing'
      && await isPreRelationshipUnlinkedWallet({ db, wallet })) {
      await cache.setBeneficiaryStatus(userId, UNLINKED);
      return UNLINKED;
    }
    throw error;
  }
  if (relationship.state === 'unlinked') {
    await cache.setBeneficiaryStatus(userId, UNLINKED);
    return UNLINKED;
  }

  const entry: BeneficiaryCacheEntry = {
    linked: true,
    humanWalletId: relationship.human_wallet_id,
    humanUserId: relationship.human_user_id,
    humanAddress: relationship.human_address,
    agentShareBps: relationship.agent_share_bps,
  };
  await cache.setBeneficiaryStatus(userId, entry);
  return entry;
}
