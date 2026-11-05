/**
 * Build the {@link PresenterPrincipal} for each auth path — the ONE place the
 * server-authenticated presenter identity + reputation snapshot is assembled, so
 * a presenter can never inflate its own standing or present a foreign address.
 *
 *  - Agent: from `req.agentWallet` (the auth middleware read it from `agent_wallets`).
 *  - Human: from the caller's own first-party `wallets/` doc (type='human',
 *    user_id=req.user.id), with a counted pe_count as the reputation snapshot.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { PresenterPrincipal } from './service';

/** The agent-wallet fields the principal needs (a structural subset of AgentWalletDocument). */
export interface AgentPrincipalSource {
  readonly id: string;
  readonly agent_id: string;
  readonly address: string;
  readonly public_key: string;
}

/**
 * Build an agent presenter principal from the authenticated agent wallet. Trust Layer build §2.5:
 * a principal carries IDENTITY only — the disclosable facts are the live vocabulary
 * (`vocabulary.ts`), computed at presentation time from `actor_stats_v1` + the reference graph +
 * the institutions, identical shape for agents and humans. `governance_score` is gone.
 */
export function buildAgentPrincipal(aw: AgentPrincipalSource): PresenterPrincipal {
  return {
    kind: 'agent',
    walletId: aw.id,
    address: aw.address.toLowerCase(),
    peOwnerUserId: aw.agent_id,
    publicKeyHex: aw.public_key,
    standing: {},
  };
}

export type ResolveHumanWalletResult =
  | { ok: true; walletId: string; address: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve the caller's OWN first-party human wallet (type='human', user_id=userId).
 * Never client-supplied. Fail-closed: no wallet / no valid EVM address → refuse.
 * Shared by the human burn-record and present paths so both bind the same address.
 */
export async function resolveHumanWallet(
  db: Firestore,
  userId: string,
): Promise<ResolveHumanWalletResult> {
  const snap = await db
    .collection('wallets')
    .where('user_id', '==', userId)
    .where('type', '==', 'human')
    .limit(1)
    .get();
  if (snap.empty) {
    return { ok: false, status: 404, error: 'no first-party human wallet found for this account' };
  }
  const doc = snap.docs[0];
  const data = doc.data() as { address?: unknown };
  const address = typeof data.address === 'string' ? data.address : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { ok: false, status: 409, error: 'human wallet has no valid first-party EVM address' };
  }
  return { ok: true, walletId: doc.id, address: address.toLowerCase() };
}

export type ResolveHumanPrincipalResult =
  | { ok: true; principal: PresenterPrincipal }
  | { ok: false; status: number; error: string };

/**
 * Resolve the human presenter principal from the authenticated user id. Looks up
 * the caller's own first-party human wallet (never client-supplied) and counts
 * their PEs as the reputation snapshot. Fail-closed: no wallet / no address → refuse.
 */
export async function resolveHumanPrincipal(
  db: Firestore,
  userId: string,
): Promise<ResolveHumanPrincipalResult> {
  const wallet = await resolveHumanWallet(db, userId);
  if (!wallet.ok) return wallet;

  // §2.5: the human's `pe_count`-only disclosure is replaced by the full live vocabulary,
  // computed at presentation time (`vocabulary.ts`) — the principal carries identity only.
  return {
    ok: true,
    principal: {
      kind: 'human',
      walletId: wallet.walletId,
      address: wallet.address,
      peOwnerUserId: userId,
      standing: {},
    },
  };
}
