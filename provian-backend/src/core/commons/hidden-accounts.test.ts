/**
 * An account is off every public projection when ANY of its documents — the Commons profile, the
 * `wallets` doc, or the `agent_wallets` doc — carries a hidden marker or `platform: 'test'`.
 * Before, each surface read only one document: an agent hidden on its wallet still listed in the
 * Commons directory and counted as a member, and a person marked on the wallet doc (keyed by
 * wallet id, while the profile is keyed by user id) stayed fully public.
 *
 * Real code paths over the shared fake Firestore; each case seeds a violating account beside a
 * public one, so a pass over an empty population is impossible (the public one must still show).
 */
import { describe, it, expect } from '@jest/globals';
import type { Firestore } from 'firebase-admin/firestore';
import { createFakeFirestore, type FakeFirestore } from '../pvt/__test-helpers__/fake-firestore';
import { COMMONS_COLLECTIONS, type CommonsDeps } from './types';
import { browseRegistry, getProfile } from './profiles';
import { getInstitutions, getNetworkStats, NOT_OPEN_INSTITUTION_IDS } from './feed';
import { computeHiddenAccounts } from './hidden-accounts';
import { browseDirectory, getDirectoryProfile } from '../agent-bank/directory';
import { listActiveX402Sellers } from '../x402/sellers';

const P = COMMONS_COLLECTIONS.PROFILES;

function profile(id: string, type: 'agent' | 'human', joined: number): Record<string, unknown> {
  return { wallet_id: id, participant_type: type, status: 'active', display_name: id, pe_count: 0, commons_join_date: joined };
}

/** Public agent, public person, and four hidden accounts each marked on a different document. */
function seed(): FakeFirestore {
  const db = createFakeFirestore();
  // Public agent.
  db.store.set(`${P}/wallet_aw_public`, profile('wallet_aw_public', 'agent', 1));
  db.store.set('agent_wallets/wallet_aw_public', { id: 'wallet_aw_public', agent_id: 'agent_public', platform: 'sdk', status: 'active' });
  db.store.set('wallets/wallet_aw_public', { type: 'agent', agent_id: 'agent_public' });
  // Public person (profile keyed by user id; wallet keyed by wallet id).
  db.store.set(`${P}/user_public`, profile('user_public', 'human', 2));
  db.store.set('wallets/wallet_h_public', { type: 'human', user_id: 'user_public' });
  // Agent hidden ONLY on its `wallets` doc.
  db.store.set(`${P}/wallet_aw_walletmark`, profile('wallet_aw_walletmark', 'agent', 3));
  db.store.set('agent_wallets/wallet_aw_walletmark', { id: 'wallet_aw_walletmark', agent_id: 'agent_wm', platform: 'sdk', status: 'active' });
  db.store.set('wallets/wallet_aw_walletmark', { type: 'agent', agent_id: 'agent_wm', public_visibility: 'hidden_prelaunch_test' });
  // Agent hidden ONLY by `platform: 'test'` on its agent_wallets doc (a stale profile exists).
  db.store.set(`${P}/wallet_aw_testplatform`, profile('wallet_aw_testplatform', 'agent', 4));
  db.store.set('agent_wallets/wallet_aw_testplatform', { id: 'wallet_aw_testplatform', agent_id: 'agent_tp', platform: 'test', status: 'active' });
  // Agent hidden ONLY on its agent_wallets doc marker (a canary that keeps running).
  db.store.set(`${P}/wallet_aw_agentmark`, profile('wallet_aw_agentmark', 'agent', 5));
  db.store.set('agent_wallets/wallet_aw_agentmark', { id: 'wallet_aw_agentmark', agent_id: 'agent_am', platform: 'sdk', status: 'active', public_visibility: 'hidden_prelaunch_test' });
  // Person hidden ONLY on their `wallets` doc (different id from the profile).
  db.store.set(`${P}/user_hidden`, profile('user_hidden', 'human', 6));
  db.store.set('wallets/wallet_h_hidden', { type: 'human', user_id: 'user_hidden', public_visibility: 'hidden_prelaunch_test' });
  return db;
}

function deps(db: FakeFirestore): CommonsDeps {
  return {
    db: db as unknown as Firestore,
    cache: { get: async () => null, set: async () => undefined },
  } as unknown as CommonsDeps;
}

const HIDDEN_PROFILES = ['wallet_aw_walletmark', 'wallet_aw_testplatform', 'wallet_aw_agentmark', 'user_hidden'];

describe('hidden accounts — profile OR wallet document hides the account', () => {
  it('the directory lists only the public accounts', async () => {
    const { profiles, total } = await browseRegistry(deps(seed()), {});
    expect(profiles.map((p) => p.wallet_id).sort()).toEqual(['user_public', 'wallet_aw_public']);
    expect(total).toBe(2);
  });

  it('a hidden account has no public profile page; a public one does', async () => {
    const d = deps(seed());
    await expect(getProfile(d, 'wallet_aw_public')).resolves.toMatchObject({ wallet_id: 'wallet_aw_public' });
    await expect(getProfile(d, 'user_public')).resolves.toMatchObject({ wallet_id: 'user_public' });
    for (const id of HIDDEN_PROFILES) {
      await expect(getProfile(d, id)).rejects.toThrow('Profile not found');
    }
  });

  it('member, agent and network counts exclude hidden accounts', async () => {
    const stats = await getNetworkStats(deps(seed()));
    // 6 profiles, 4 hidden → 2 members: 1 agent + 1 person.
    expect(stats).toMatchObject({ commons_participants: 2, commons_agents: 1, commons_humans: 1 });
    // agent_wallets with platform != 'test': public, walletmark, agentmark → minus the 2 hidden.
    expect(stats.total_agents).toBe(1);
    const institutions = await getInstitutions(deps(seed()));
    expect(institutions.find((i) => i.id === 'registry')?.key_metric?.value).toBe(2);
  });

  it('a person keeps their profile when only a retired wallet of theirs is marked', async () => {
    const db = seed();
    db.store.set('wallets/wallet_h_live', { type: 'human', user_id: 'user_hidden' });
    const hidden = await computeHiddenAccounts(db as unknown as Firestore);
    expect(hidden.ids.has('wallet_h_hidden')).toBe(true);
    expect(hidden.ids.has('user_hidden')).toBe(false);
  });

  it('the agent directory drops an agent hidden on its profile or wallet doc', async () => {
    const db = seed();
    for (const id of ['wallet_aw_public', 'wallet_aw_walletmark']) {
      db.store.set(`agent_directory/${id}`, { wallet_id: id, capabilities: ['code'], availability: 'available', pe_count: 0 });
    }
    // An agent hidden only on its Commons profile.
    db.store.set(`${P}/wallet_aw_profilemark`, { ...profile('wallet_aw_profilemark', 'agent', 7), public_visibility: 'hidden_moderation' });
    db.store.set('agent_wallets/wallet_aw_profilemark', { id: 'wallet_aw_profilemark', agent_id: 'agent_pm', platform: 'sdk', status: 'active' });
    db.store.set('agent_directory/wallet_aw_profilemark', { wallet_id: 'wallet_aw_profilemark', capabilities: ['code'], availability: 'available', pe_count: 0 });
    const d = deps(db);
    const listed = await browseDirectory(d, {});
    expect(listed.map((e) => e.wallet_id)).toEqual(['wallet_aw_public']);
    await expect(getDirectoryProfile(d, 'wallet_aw_walletmark')).rejects.toThrow('Agent not found in directory');
    await expect(getDirectoryProfile(d, 'wallet_aw_profilemark')).rejects.toThrow('Agent not found in directory');
  });
});

describe('x402 seller list — a hidden seller is not listed', () => {
  const ADDR = (n: number): string => `0x${String(n).repeat(40)}`;
  function sellerDoc(address: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return { seller_id: `base:${address}`, chain: 'base', address, status: 'active', display_name: 's', ...over };
  }

  it('drops a seller whose doc carries any hidden marker, keeps the rest', async () => {
    const db = createFakeFirestore();
    db.store.set(`x402_sellers_v1/base:${ADDR(1)}`, sellerDoc(ADDR(1)));
    db.store.set(`x402_sellers_v1/base:${ADDR(2)}`, sellerDoc(ADDR(2), { public_visibility: 'hidden_prelaunch_test' }));
    db.store.set(`x402_sellers_v1/base:${ADDR(3)}`, sellerDoc(ADDR(3), { public_visibility: 'hidden_moderation' }));
    const page = await listActiveX402Sellers(db as unknown as Firestore);
    expect(page.sellers.map((s) => s.seller_id)).toEqual([`base:${ADDR(1)}`]);
  });
});

describe('Commons stats — unavailable institutions', () => {
  it('lists only what the catalog marks not open: never the live Escrow or Bonds', async () => {
    const stats = await getNetworkStats(deps(seed()));
    const unavailable = stats.unavailable_institutions as string[];
    expect(unavailable).toEqual([...NOT_OPEN_INSTITUTION_IDS]);
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable).not.toContain('escrow');
    expect(unavailable).not.toContain('bonds');
    const institutions = await getInstitutions(deps(seed()));
    for (const id of unavailable) expect(institutions.find((i) => i.id === id)?.status).not.toBe('live');
    for (const i of institutions.filter((row) => row.status !== 'live')) expect(unavailable).toContain(i.id);
  });
});
