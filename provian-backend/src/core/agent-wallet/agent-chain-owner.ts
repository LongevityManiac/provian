/**
 * Agent PE-chain owner resolution.
 *
 * THE FORK THIS CLOSES. An agent's canonical identity in `pe_history` is its
 * `agent_id` every lifecycle PE (`wallet_created`, `genesis_signup`,
 * `agent_linked_to_human`) and every sovereign-work PE keys `user_id == agent_id`
 * and advances `pe_chain_tips/{agent_id}` (via `generatePE`). But an agent-owned
 * DEVICE registers with `owner_user_id == owner_wallet_id == <wallet doc id>`
 * (routes/devices.ts sets `ownerId = agentWallet.id`), so `POST /v1/pe/submit`
 * keyed the daemon's witnessed work under the WALLET id — a SECOND, separate hash
 * chain, invisible to `GET /v1/relay/agent/:agentId/pe-activity` (which queries
 * `userId == agent_id`) and to the human who owns the agent.
 *
 * an agent's activity BELONGS TO THE AGENT and must be
 * visible to the linked human. So agent-owned-device PEs must key under the
 * SAME canonical identity as the agent's other PEs — its `agent_id` which both
 * unifies the chain (same `pe_chain_tips/{agent_id}`) and surfaces the work
 * through the ownership-guarded read. The beneficiary split is unaffected:
 * `resolveBeneficiary` and the streak resolver both look the wallet up by
 * `agent_id` OR doc-id, so either identity resolves the same agent wallet and the
 * same split.
 *
 * A HUMAN-owned device is untouched: its `owner_user_id` IS the human, which is
 * the correct chain owner.
 *
 * Fail-SAFE, not fail-closed: if the agent wallet cannot be read, it returns the
 * device's `owner_user_id` (the pre- behavior) so the PE still records. This
 * is a keying/visibility concern, not a security gate — a missed lookup must not
 * drop the record.
 */

import type { Firestore } from 'firebase-admin/firestore';

export interface AgentChainOwnerDeps {
  readonly db: Firestore;
  readonly cache: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: string, ttlSeconds: number): Promise<unknown>;
  };
}

export interface ChainOwnerDeviceFields {
  readonly owner_type?: string | null;
  readonly owner_user_id: string;
  readonly owner_wallet_id: string;
}

const CACHE_TTL_S = 3600;

/**
 * Resolve the canonical `pe_history` chain-owner id for a device's submissions.
 *
 *   - human device → `device.owner_user_id` (unchanged).
 *   - agent device → the agent wallet's `agent_id` (cached by wallet id),
 *     falling back to `owner_user_id` if the wallet cannot be resolved.
 */
export async function resolveAgentChainOwnerId(
  deps: AgentChainOwnerDeps,
  device: ChainOwnerDeviceFields,
): Promise<string> {
  if (device.owner_type !== 'agent') return device.owner_user_id;
  const walletId = device.owner_wallet_id;
  if (!walletId) return device.owner_user_id;

  const cacheKey = `agent_chain_owner:${walletId}`;
  try {
    const cached = await deps.cache.get<string>(cacheKey);
    if (typeof cached === 'string' && cached.length > 0) return cached;
  } catch {
    /* cache miss/outage → fall through to a Firestore read */
  }

  try {
    const snap = await deps.db.collection('agent_wallets').doc(walletId).get();
    const agentId = snap.exists ? (snap.data()?.agent_id as unknown) : null;
    if (typeof agentId === 'string' && agentId.length > 0) {
      deps.cache.set(cacheKey, agentId, CACHE_TTL_S).catch(() => {});
      return agentId;
    }
  } catch {
    /* read failure → fail-safe below */
  }

  // Fail-safe: keep recording under the pre- identity rather than dropping.
  return device.owner_user_id;
}
