/**
 * resolveEscrowParty / tryResolveEscrowParty (, human PVT spendability).
 *
 * The fix: escrow parties resolve for HUMAN wallets (via `wallets` by user_id,
 * or the `users` doc), not just `agent_wallets`. Before this, a human could be
 * neither depositor nor recipient.
 *
 * Every assertion here ships with its RED negative control:
 * - the human-resolution assertions are paired with the fail-closed leg (a
 * wallet in NONE of the three sources REJECTS, and the soft variant returns
 * null) so a resolver hard-wired to "always resolve" would be caught;
 * - the empty-population trap is avoided by asserting concrete resolved values
 * (address + agentId + ownerType), not merely "did not throw".
 */

import { resolveEscrowParty, tryResolveEscrowParty } from './escrow-party';
import { NotFoundError } from './errors';
import type { AgentBankDeps } from './types';

interface Sources {
  agentWallets?: Record<string, { agent_id?: string; address?: string }>;
  wallets?: Array<{ user_id: string; address?: string }>;
  users?: Record<string, { wallet_address?: string; address?: string }>;
}

function makeDeps(sources: Sources): AgentBankDeps {
  const { agentWallets = {}, wallets = [], users = {} } = sources;
  const db = {
    collection: (name: string) => {
      if (name === 'agent_wallets') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: id in agentWallets, data: () => agentWallets[id] }),
          }),
        };
      }
      if (name === 'wallets') {
        return {
          where: (_f: string, _op: string, value: string) => ({
            limit: () => ({
              get: async () => {
                const match = wallets.filter((w) => w.user_id === value).slice(0, 1);
                return { empty: match.length === 0, docs: match.map((m) => ({ data: () => m })) };
              },
            }),
          }),
        };
      }
      if (name === 'users') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: id in users, data: () => users[id] }),
          }),
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
  };
  return { db } as unknown as AgentBankDeps;
}

describe('resolveEscrowParty — agent path (unchanged)', () => {
  it('resolves an agent wallet from agent_wallets', async () => {
    const deps = makeDeps({ agentWallets: { wallet_a: { agent_id: 'agent_1', address: '0xAgent' } } });
    const party = await resolveEscrowParty(deps, 'wallet_a', 'Depositor');
    expect(party).toEqual({ address: '0xAgent', agentId: 'agent_1', ownerType: 'agent' });
  });

  // RED control: an agent doc WITHOUT an address must reject, not invent one.
  it('rejects an agent wallet with no on-chain address', async () => {
    const deps = makeDeps({ agentWallets: { wallet_a: { agent_id: 'agent_1' } } });
    await expect(resolveEscrowParty(deps, 'wallet_a', 'Depositor')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('resolveEscrowParty — human path (the fix)', () => {
  it('resolves a human wallet from the `wallets` collection by user_id', async () => {
    const deps = makeDeps({ wallets: [{ user_id: 'human_1', address: '0xHuman' }] });
    const party = await resolveEscrowParty(deps, 'human_1', 'Recipient');
    // agentId === walletId for humans (the commons-auth convention), ownerType human.
    expect(party).toEqual({ address: '0xHuman', agentId: 'human_1', ownerType: 'human' });
  });

  it('falls back to the `users` doc (wallet_address, then address)', async () => {
    const deps = makeDeps({ users: { human_2: { wallet_address: '0xUserWA' } } });
    const p1 = await resolveEscrowParty(deps, 'human_2', 'Depositor');
    expect(p1).toEqual({ address: '0xUserWA', agentId: 'human_2', ownerType: 'human' });

    const deps2 = makeDeps({ users: { human_3: { address: '0xUserAddr' } } });
    const p2 = await resolveEscrowParty(deps2, 'human_3', 'Depositor');
    expect(p2.address).toBe('0xUserAddr');
  });

  it('prefers an agent record over a human one when both somehow exist', async () => {
    const deps = makeDeps({
      agentWallets: { dup: { agent_id: 'agent_dup', address: '0xAgent' } },
      wallets: [{ user_id: 'dup', address: '0xHuman' }],
    });
    const party = await resolveEscrowParty(deps, 'dup', 'Depositor');
    expect(party.ownerType).toBe('agent');
    expect(party.address).toBe('0xAgent');
  });
});

describe('resolveEscrowParty — fail-closed (RED controls for the human path)', () => {
  // This is the negative control the human-resolution tests depend on: without
  // it, a resolver that returned a fixed party for ANY id would pass the happy
  // paths above. An id present in NONE of the three sources must REJECT.
  it('rejects a wallet present in none of agent_wallets / wallets / users', async () => {
    const deps = makeDeps({});
    await expect(resolveEscrowParty(deps, 'ghost', 'Recipient')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects a `wallets` row / `users` doc that carries no address', async () => {
    const noAddrWallet = makeDeps({ wallets: [{ user_id: 'h' }] });
    await expect(resolveEscrowParty(noAddrWallet, 'h', 'Depositor')).rejects.toBeInstanceOf(NotFoundError);

    const noAddrUser = makeDeps({ users: { h: {} } });
    await expect(resolveEscrowParty(noAddrUser, 'h', 'Depositor')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tryResolveEscrowParty — soft variant for settlement paths', () => {
  it('returns the party when resolvable', async () => {
    const deps = makeDeps({ wallets: [{ user_id: 'human_1', address: '0xHuman' }] });
    expect(await tryResolveEscrowParty(deps, 'human_1', 'Recipient')).toEqual({
      address: '0xHuman', agentId: 'human_1', ownerType: 'human',
    });
  });

  // RED control: unresolvable → null (skips the PE), never a throw that would
  // abort a whole settlement transaction.
  it('returns null (does not throw) for an unresolvable wallet', async () => {
    const deps = makeDeps({});
    await expect(tryResolveEscrowParty(deps, 'ghost', 'Recipient')).resolves.toBeNull();
  });
});
