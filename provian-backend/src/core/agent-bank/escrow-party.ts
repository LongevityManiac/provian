/**
 * Escrow party resolution — agent OR human.
 *
 * (human PVT spendability): escrow parties were previously resolved from
 * the `agent_wallets` collection ONLY, so a human wallet (which never has an
 * `agent_wallets` doc) could be neither depositor nor recipient — the
 * human-jobs → PVT escrow leg was broken in both directions. A human wallet
 * resolves its on-chain address from the `wallets` collection (keyed by
 * `user_id`, the same source `commons-auth.resolveActorAddress` uses) or the
 * `users` doc, exactly as the rest of the relay does. A human's `agentId` is
 * its own wallet id (the `agentId === walletId` convention commons-auth already
 * applies to humans), so PE attribution stays coherent.
 *
 * Lives in its own module so both `escrow.ts` and `job-settlement.ts` can import
 * it without an escrow ↔ job-settlement cycle (escrow.ts already imports
 * job-settlement.ts).
 */

import type { AgentBankDeps } from './types';
import type { AgentWalletDocument } from '../agent-wallet/types';
import { NotFoundError } from './errors';

/** An escrow party — agent OR human. Both may be a depositor or a recipient. */
export interface EscrowParty {
  address: string;
  agentId: string;
  ownerType: 'agent' | 'human';
}

/**
 * Resolve a wallet id to its on-chain address + PE-attribution identity,
 * checking `agent_wallets` first, then the human `wallets`/`users` records.
 * Throws NotFoundError when no on-chain address can be resolved — the same
 * fail-closed posture a missing agent wallet always had (never invent an
 * address).
 */
export async function resolveEscrowParty(
  deps: AgentBankDeps,
  walletId: string,
  role: 'Depositor' | 'Recipient',
): Promise<EscrowParty> {
  // Agents first: an agent wallet carries its own address + agent_id.
  const agentDoc = await deps.db.collection('agent_wallets').doc(walletId).get();
  if (agentDoc.exists) {
    const wallet = agentDoc.data() as AgentWalletDocument;
    if (!wallet.address) {
      throw new NotFoundError(`${role} agent wallet has no on-chain address`);
    }
    return { address: wallet.address, agentId: wallet.agent_id, ownerType: 'agent' };
  }

  // Human wallet: resolve the on-chain address from `wallets` (by user_id) and
  // fall back to the `users` doc. Never invent an address — an unresolved human
  // wallet fails closed with NotFound, the same posture as a missing agent.
  const walletsSnap = await deps.db
    .collection('wallets')
    .where('user_id', '==', walletId)
    .limit(1)
    .get();
  if (!walletsSnap.empty) {
    const data = walletsSnap.docs[0].data() as { address?: string };
    if (data.address) {
      return { address: data.address, agentId: walletId, ownerType: 'human' };
    }
  }

  const userDoc = await deps.db.collection('users').doc(walletId).get();
  if (userDoc.exists) {
    const data = userDoc.data() as { wallet_address?: string; address?: string };
    const address = data.wallet_address || data.address;
    if (address) {
      return { address, agentId: walletId, ownerType: 'human' };
    }
  }

  throw new NotFoundError(`${role} wallet not found`);
}

/**
 * Soft variant for background/settlement paths that must not crash on an
 * unresolvable party: returns null instead of throwing, so the caller can skip
 * that party's PE while still settling the rest (mirrors `readParties`' prior
 * "missing wallet skips its PE" behavior, now human-aware).
 */
export async function tryResolveEscrowParty(
  deps: AgentBankDeps,
  walletId: string,
  role: 'Depositor' | 'Recipient',
): Promise<EscrowParty | null> {
  try {
    return await resolveEscrowParty(deps, walletId, role);
  } catch {
    return null;
  }
}
