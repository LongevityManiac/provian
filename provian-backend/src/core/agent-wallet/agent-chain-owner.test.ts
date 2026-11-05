import { resolveAgentChainOwnerId } from './agent-chain-owner';
import type { Firestore } from 'firebase-admin/firestore';

const AGENT_ID = 'agent_df7a5158';
const WALLET_ID = 'wallet_aw_3c583854';
const HUMAN_ID = 'user_6c31ec6c';

function fakeDeps(opts: {
  walletDoc?: { agent_id?: string } | null;
  cacheHit?: string | null;
  throwOnRead?: boolean;
}) {
  const setCalls: Array<[string, string, number]> = [];
  const cache = {
    get: async <T>(_k: string): Promise<T | null> =>
      (opts.cacheHit ?? null) as unknown as T | null,
    set: async (k: string, v: string, ttl: number) => { setCalls.push([k, v, ttl]); return undefined; },
  };
  const db = {
    collection: (_c: string) => ({
      doc: (_id: string) => ({
        get: async () => {
          if (opts.throwOnRead) throw new Error('firestore down');
          return {
            exists: opts.walletDoc != null,
            data: () => opts.walletDoc ?? undefined,
          };
        },
      }),
    }),
  } as unknown as Firestore;
  return { deps: { db, cache }, setCalls };
}

const agentDevice = { owner_type: 'agent', owner_user_id: WALLET_ID, owner_wallet_id: WALLET_ID };
const humanDevice = { owner_type: 'human', owner_user_id: HUMAN_ID, owner_wallet_id: '' };

describe('resolveAgentChainOwnerId', () => {
  it('maps an agent-owned device to the agent_id (and caches it)', async () => {
    const { deps, setCalls } = fakeDeps({ walletDoc: { agent_id: AGENT_ID } });
    const owner = await resolveAgentChainOwnerId(deps, agentDevice);
    expect(owner).toBe(AGENT_ID);
    expect(setCalls[0]?.[1]).toBe(AGENT_ID);
  });

  it('returns the cached agent_id without a Firestore read', async () => {
    const { deps } = fakeDeps({ cacheHit: AGENT_ID, throwOnRead: true });
    expect(await resolveAgentChainOwnerId(deps, agentDevice)).toBe(AGENT_ID);
  });

  // RED NEGATIVE CONTROLS
  it('RED: a HUMAN device keys under the human, never re-mapped', async () => {
    // throwOnRead proves no agent_wallets read is even attempted for humans.
    const { deps } = fakeDeps({ throwOnRead: true });
    expect(await resolveAgentChainOwnerId(deps, humanDevice)).toBe(HUMAN_ID);
  });

  it('RED: fail-safe to owner_user_id when the agent wallet is missing (never drops the record)', async () => {
    const { deps } = fakeDeps({ walletDoc: null });
    expect(await resolveAgentChainOwnerId(deps, agentDevice)).toBe(WALLET_ID);
  });

  it('RED: fail-safe to owner_user_id when the Firestore read throws', async () => {
    const { deps } = fakeDeps({ throwOnRead: true });
    expect(await resolveAgentChainOwnerId(deps, agentDevice)).toBe(WALLET_ID);
  });

  it('RED: fail-safe when the wallet doc has no agent_id field', async () => {
    const { deps } = fakeDeps({ walletDoc: {} });
    expect(await resolveAgentChainOwnerId(deps, agentDevice)).toBe(WALLET_ID);
  });
});
