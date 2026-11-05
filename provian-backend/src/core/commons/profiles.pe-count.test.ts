/**
 * getProfile recomputes pe_count LIVE — from the actor's running total (`actor_stats_v1.pe_count`;
 * PE meter: the relay keeps no PEs to count) — and resolves the actor key correctly for BOTH
 * participant kinds:
 *   - agent  → agent_wallets.<walletId>.agent_id
 *   - human  → the walletId itself (a human has no agent_wallets doc, and their
 *              PEs key on their own user id, which IS the Commons walletId).
 *
 * Negative control for the bug this fixes: before the fix, a human profile's
 * pe_count was hard-wired to 0 (the `agentId ? ... : 0` branch), so a human with
 * real PE activity read 0. The `human counts its own PEs` case below would return
 * 0 under the old code and fails unless the human path reads the total keyed on the walletId.
 * A planted legacy `pe_history` row is never counted.
 */

import { describe, it, expect } from '@jest/globals';
import { getProfile } from './profiles';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';


function makeDeps(opts: {
  walletId: string;
  isAgent: boolean;
  agentId?: string;
  platform?: string;
  publicVisibility?: string;
  /** `actor_stats_v1.pe_count` by actor id. */
  counts: Record<string, number>;
}): CommonsDeps {
  const profile = { wallet_id: opts.walletId, participant_type: opts.isAgent ? 'agent' : 'human', pe_count: 0, public_visibility: opts.publicVisibility };
  const db = {
    collection(name: string) {
      if (name === COMMONS_COLLECTIONS.PROFILES) {
        return { doc: () => ({ get: async () => ({ exists: true, data: () => profile }) }) };
      }
      if (name === 'agent_wallets') {
        return {
          doc: () => ({
            get: async () => ({
              exists: opts.isAgent,
              data: () => (opts.isAgent ? { agent_id: opts.agentId, platform: opts.platform ?? 'sdk' } : undefined),
            }),
          }),
        };
      }
      if (name === 'actor_stats_v1') {
        return {
          doc: (id: string) => ({
            get: async () => ({
              exists: id in opts.counts,
              data: () => (id in opts.counts ? { actor_id: id, pe_count: opts.counts[id] } : undefined),
            }),
          }),
        };
      }
      if (name === 'pe_history') throw new Error('pe_history must not be read');
      return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
    },
  };
  return { db } as unknown as CommonsDeps;
}

describe('getProfile — live pe_count for both participant kinds', () => {
  it('keeps a marked prelaunch profile out of direct public reads', async () => {
    const deps = makeDeps({ walletId: 'user_test', isAgent: false, publicVisibility: 'hidden_prelaunch_test', counts: {} });
    await expect(getProfile(deps, 'user_test')).rejects.toThrow('Profile not found');
  });
  it('human counts its own PEs (keyed on walletId), NOT a hard-wired 0', async () => {
    const walletId = 'user_frank';
    const deps = makeDeps({
      walletId,
      isAgent: false,
      counts: { [walletId]: 2, user_someone_else: 9 }, // the other human's total is not this human's
    });
    const profile = await getProfile(deps, walletId);
    // 2 for this human. Under the pre-fix code this was 0.
    expect(profile.pe_count).toBe(2);
  });

  it('human with real activity never reads 0 (the exact regression guard)', async () => {
    const walletId = 'user_active';
    const deps = makeDeps({
      walletId,
      isAgent: false,
      counts: { [walletId]: 4507 },
    });
    const profile = await getProfile(deps, walletId);
    expect(profile.pe_count).toBe(4507);
    expect(profile.pe_count).not.toBe(0);
  });

  it('agent counts PEs keyed on its agent_id, not its wallet id', async () => {
    const walletId = 'wallet_aw_atlas';
    const agentId = 'agent_atlas';
    const deps = makeDeps({
      walletId,
      isAgent: true,
      agentId,
      counts: { [agentId]: 2, [walletId]: 5 }, // keyed on the wallet id, NOT the agent id → must not count
    });
    const profile = await getProfile(deps, walletId);
    expect(profile.pe_count).toBe(2);
  });

  it('test-platform agent profiles are hidden even when a stale profile document exists', async () => {
    const walletId = 'wallet_aw_test';
    const deps = makeDeps({
      walletId,
      isAgent: true,
      agentId: 'agent_test',
      platform: 'test',
      counts: { agent_test: 1 },
    });
    await expect(getProfile(deps, walletId)).rejects.toThrow('Profile not found');
  });
});
